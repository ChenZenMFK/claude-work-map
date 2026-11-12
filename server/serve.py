#!/usr/bin/env python3
"""Serve the work map page on this computer only: one server for every session, on an address that stays the same.

Usage:
  python3 -I serve.py --ensure --dir DIR --page DIR [--tidy-days N] [--idle-minutes N]
  python3 -I serve.py --run    --dir DIR --page DIR [--tidy-days N] [--idle-minutes N]

--ensure finds the running server or starts one detached from the caller, prints
"PORT <n> TOKEN <t>" and exits, so the caller (a Claude Code session, which may be one
short print-mode run) never waits on it. --run is that server. It keeps its port and
token in DIR/server.json and reuses them when it starts again, so an open tab
reconnects by itself. It stops after --idle-minutes with no session saving a state.

Each session saves its state as DIR/<session>.json. Every address needs the token,
and the Host header must name this computer, so no other website can read a session
through the browser. The server writes only server.json and its lock file; with
--tidy-days it deletes the saved states older than that in DIR, and nothing else.
"""
import argparse
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import threading
import time

PAGE_FILE = re.compile(r'^[a-z0-9][a-z0-9.-]*\.(html|js|css)$')
SESSION = re.compile(r'^[A-Za-z0-9_-]{1,80}$')
TOKEN = re.compile(r'^[A-Za-z0-9_-]{16,}$')
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'}
POLICY = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
          "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
# Tried first when no earlier port is known, so the address is the same even after server.json is gone.
FIRST_PORT = 47821
OWN_FILES = ('server.json',)


def states(folder: Path) -> list:
    """The saved session states in the folder, newest first."""
    found = []
    for item in folder.glob('*.json'):
        if item.name in OWN_FILES or not SESSION.match(item.stem) or item.is_symlink():
            continue
        try:
            found.append((item.stat().st_mtime, item))
        except OSError:
            pass
    return [item for _, item in sorted(found, key=lambda pair: pair[0], reverse=True)]


def make_handler(folder: Path, token: str, page: Path, stop: threading.Event):
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

        def chosen(self, query: str):
            """The state file the address asks for (?s=<session>), or the newest one."""
            wanted = dict(part.split('=', 1) for part in query.split('&') if '=' in part).get('s', '')
            if wanted not in ('', 'latest'):
                return folder / f'{wanted}.json' if SESSION.match(wanted) else None
            newest = states(folder)
            return newest[0] if newest else None

        def read(self, item) -> bytes:
            if item is None or item.name in OWN_FILES:
                return b'{}'
            try:
                return item.read_bytes() or b'{}'
            except OSError:
                return b'{}'

        def do_GET(self):
            port = self.server.server_address[1]
            if self.headers.get('Host') not in (f'127.0.0.1:{port}', f'localhost:{port}'):
                return self.reply(403, b'Forbidden')
            prefix = f'/{token}/'
            path, _, query = self.path.partition('?')
            if not path.startswith(prefix):
                return self.reply(404, b'Not found')
            name = path[len(prefix):] or 'index.html'
            if name == 'ping':
                return self.reply(200, b'work-map')
            if name == 'sessions':
                return self.reply(200, json.dumps(self.sessions()).encode(), 'application/json')
            if name == 'state':
                return self.reply(200, self.read(self.chosen(query)), 'application/json')
            if name == 'events':
                return self.stream(query)
            if PAGE_FILE.match(name) and name in os.listdir(page):
                body = (page / name).read_bytes()
                return self.reply(200, body, TYPES[Path(name).suffix])
            return self.reply(404, b'Not found')

        def sessions(self):
            """Each saved session: its id, folder and when it last saved, newest first."""
            listed = []
            for item in states(folder)[:30]:
                try:
                    data = json.loads(item.read_bytes() or b'{}')
                except (OSError, ValueError):
                    continue
                if isinstance(data, dict):
                    listed.append({'id': item.stem, 'folder': str(data.get('folder', '')), 'savedAt': data.get('savedAt', 0)})
            return listed

        def stream(self, query):
            """Server-sent events: the state now, then again each time it changes.

            Without ?s it follows whichever session saved last.
            """
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            seen, last_ping = None, time.monotonic()
            try:
                while not stop.is_set():
                    item = self.chosen(query)
                    try:
                        mark = (item, item.stat().st_mtime_ns)
                    except (OSError, AttributeError):
                        mark = None
                    if mark != seen:
                        seen = mark
                        data = self.read(item).replace(b'\n', b' ')
                        self.wfile.write(b'data: ' + data + b'\n\n')
                        self.wfile.flush()
                    elif time.monotonic() - last_ping > 15:
                        self.wfile.write(b': ping\n\n')
                        self.wfile.flush()
                        last_ping = time.monotonic()
                    time.sleep(0.2)
            except OSError:
                pass
            self.close_connection = True

    return Handler


def tidy(folder: Path, days: float) -> int:
    """Deletes saved states older than `days` in a folder named work-map, never below it, never server.json."""
    if days <= 0 or folder.name != 'work-map' or not folder.is_dir():
        return 0
    cutoff = time.time() - days * 86400
    gone = 0
    for item in folder.iterdir():
        try:
            if item.suffix == '.json' and item.name not in OWN_FILES and item.is_file() and not item.is_symlink() and item.stat().st_mtime < cutoff:
                item.unlink()
                gone += 1
        except OSError:
            pass
    return gone


def lock(folder: Path):
    """Holds server.lock for as long as this process lives; None when another server holds it."""
    handle = open(folder / 'server.lock', 'a+')
    try:
        if os.name == 'nt':
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except OSError:
        handle.close()
        return None


def known(folder: Path) -> dict:
    try:
        data = json.loads((folder / 'server.json').read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def answers(port, token) -> bool:
    """True when the work map server is listening there with that token."""
    try:
        conn = http.client.HTTPConnection('127.0.0.1', int(port), timeout=2)
        conn.request('GET', f'/{token}/ping', headers={'Host': f'127.0.0.1:{port}'})
        ok = conn.getresponse().read() == b'work-map'
        conn.close()
        return ok
    except (OSError, TypeError, ValueError, http.client.HTTPException):
        return False


def bind(handler, ports):
    for port in ports:
        try:
            return http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
        except OSError:
            continue
    raise OSError('no free port')


def run(args) -> int:
    folder = args.dir
    folder.mkdir(parents=True, exist_ok=True)
    held = lock(folder)
    if held is None:
        return 0
    before = known(folder)
    token = before['token'] if isinstance(before.get('token'), str) and TOKEN.match(before['token']) else secrets.token_urlsafe(24)
    stop = threading.Event()
    handler = make_handler(folder, token, args.page.resolve(), stop)
    ports = [p for p in (before.get('port'), args.port) if isinstance(p, int) and 0 < p < 65536] + [0]
    server = bind(handler, ports)
    server.daemon_threads = True
    fresh = folder / 'server.json.new'
    fresh.write_text(json.dumps({'port': server.server_address[1], 'token': token, 'pid': os.getpid()}))
    if os.name != 'nt':
        os.chmod(fresh, 0o600)
    os.replace(fresh, folder / 'server.json')
    started = time.time()

    def keep_house():
        # Tidies once an hour, and stops after the idle time with no session saving a state.
        tidied = 0.0
        while not stop.is_set():
            now = time.time()
            if now - tidied > 3600:
                tidy(folder, args.tidy_days)
                tidied = now
            newest = states(folder)
            try:
                last = max(newest[0].stat().st_mtime, started) if newest else started
            except OSError:
                last = started
            if args.idle_minutes > 0 and now - last > args.idle_minutes * 60:
                stop.set()
                server.shutdown()
                return
            time.sleep(min(5, max(0.2, args.idle_minutes * 60 / 4)))

    threading.Thread(target=keep_house, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    stop.set()
    held.close()
    return 0


def detached(argv):
    """Starts argv on its own: no shared output, not in the caller's process group, so ending the caller leaves it running."""
    quiet = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL, 'close_fds': True}
    if os.name == 'nt':
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        try:
            return subprocess.Popen(argv, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, **quiet)
        except OSError:
            return subprocess.Popen(argv, creationflags=flags, **quiet)
    return subprocess.Popen(argv, start_new_session=True, **quiet)


def ensure(args) -> int:
    folder = args.dir
    folder.mkdir(parents=True, exist_ok=True)
    record = known(folder)
    if not answers(record.get('port'), record.get('token')):
        detached([sys.executable, '-I', str(Path(__file__).resolve()), '--run', '--dir', str(folder), '--page', str(args.page),
                  '--tidy-days', str(args.tidy_days), '--idle-minutes', str(args.idle_minutes), '--port', str(args.port)])
        deadline = time.time() + 10
        while True:
            time.sleep(0.1)
            record = known(folder)
            if answers(record.get('port'), record.get('token')):
                break
            if time.time() > deadline:
                print('the work map server did not start', file=sys.stderr)
                return 1
    print(f"PORT {record['port']} TOKEN {record['token']}", flush=True)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--ensure', action='store_true', help='find or start the server, print its port and token')
    mode.add_argument('--run', action='store_true', help='be the server')
    parser.add_argument('--dir', type=Path, required=True, help='the folder of saved states, usually ~/.claude/work-map')
    parser.add_argument('--page', type=Path, required=True)
    parser.add_argument('--tidy-days', type=float, default=0, help='delete saved states older than this many days')
    parser.add_argument('--port', type=int, default=FIRST_PORT, help='the port to try first when no earlier one is known; 0 for any')
    parser.add_argument('--idle-minutes', type=float, default=30, help='stop after this long with no state saved; 0 never stops')
    args = parser.parse_args()
    return ensure(args) if args.ensure else run(args)


if __name__ == '__main__':
    sys.exit(main())
