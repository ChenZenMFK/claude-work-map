#!/usr/bin/env python3
"""Serve the work map page on this computer only, and push the session's state to it as it changes.

Usage: python3 -I serve.py --state FILE --token TOKEN --page DIR

Started by the work-map mod and stopped with it. Binds 127.0.0.1 on a free
port and prints "PORT <n>". Every address needs the session's random token,
and the Host header must name this computer, so no other website can read the
session through the browser. Read-only: it never writes a file.
"""
import argparse
import http.server
import os
from pathlib import Path
import re
import sys
import threading
import time

PAGE_FILE = re.compile(r'^[a-z0-9][a-z0-9.-]*\.(html|js|css)$')
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'}
POLICY = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
          "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")


def make_handler(state: Path, token: str, page: Path, stop: threading.Event):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass

        def head(self, status, kind, length=None):
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy', POLICY)
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            if length is not None:
                self.send_header('Content-Length', str(length))
            self.end_headers()

        def reply(self, status, body: bytes, kind='text/plain; charset=utf-8'):
            self.head(status, kind, len(body))
            self.wfile.write(body)

        def read_state(self) -> bytes:
            try:
                return state.read_bytes() or b'{}'
            except OSError:
                return b'{}'

        def do_GET(self):
            port = self.server.server_address[1]
            if self.headers.get('Host') not in (f'127.0.0.1:{port}', f'localhost:{port}'):
                return self.reply(403, b'Forbidden')
            prefix = f'/{token}/'
            path = self.path.split('?', 1)[0]
            if not path.startswith(prefix):
                return self.reply(404, b'Not found')
            name = path[len(prefix):] or 'index.html'
            if name == 'state':
                return self.reply(200, self.read_state(), 'application/json')
            if name == 'events':
                return self.stream()
            if PAGE_FILE.match(name) and name in os.listdir(page):
                body = (page / name).read_bytes()
                return self.reply(200, body, TYPES[Path(name).suffix])
            return self.reply(404, b'Not found')

        def stream(self):
            """Server-sent events: the state now, then again each time the file changes."""
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            seen, last_ping = None, time.monotonic()
            try:
                while not stop.is_set():
                    try:
                        mark = state.stat().st_mtime_ns
                    except OSError:
                        mark = None
                    if mark != seen:
                        seen = mark
                        data = self.read_state().replace(b'\n', b' ')
                        self.wfile.write(b'data: ' + data + b'\n\n')
                        self.wfile.flush()
                    elif time.monotonic() - last_ping > 15:
                        self.wfile.write(b': ping\n\n')
                        self.wfile.flush()
                        last_ping = time.monotonic()
                    time.sleep(0.1)
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--token', required=True)
    parser.add_argument('--page', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,}', args.token):
        parser.error('the token must be at least 16 letters, digits, - or _')
    stop = threading.Event()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), make_handler(args.state, args.token, args.page.resolve(), stop))
    server.daemon_threads = True
    print(f'PORT {server.server_address[1]}', flush=True)
    parent = os.getppid()

    def watch_parent():
        # The mod normally stops this process; if Claude Code goes away without it, stop too.
        while not stop.is_set():
            if os.getppid() != parent:
                stop.set()
                server.shutdown()
            time.sleep(1)

    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    stop.set()
    return 0


if __name__ == '__main__':
    sys.exit(main())
