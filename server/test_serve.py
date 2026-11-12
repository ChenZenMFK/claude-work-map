"""serve.py: one shared server, this computer only, the token on every address, live state, no way out of the page folder."""
import http.client
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SERVE = Path(__file__).with_name('serve.py')


class ServeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.page = root / 'page'
        self.page.mkdir()
        (self.page / 'index.html').write_text('<title>Work map</title>')
        (self.page / 'app.js').write_text('// app')
        (root / 'secret.txt').write_text('outside the page')
        self.dir = root / 'home' / '.claude' / 'work-map'
        self.dir.mkdir(parents=True)
        self.state = self.dir / 'aaa-111.json'
        self.state.write_text(json.dumps({'n': 1, 'folder': 'one', 'savedAt': 1}))
        self.port, self.token = self.ensure()

    def ensure(self, *extra):
        out = subprocess.run([sys.executable, '-I', str(SERVE), '--ensure', '--dir', str(self.dir), '--page', str(self.page), '--port', '0', *extra],
                             capture_output=True, text=True, timeout=20)
        self.assertEqual(out.returncode, 0, out.stderr)
        _, port, _, token = out.stdout.split()
        return int(port), token

    def pid(self):
        return json.loads((self.dir / 'server.json').read_text())['pid']

    def stop_server(self):
        try:
            os.kill(self.pid(), signal.SIGTERM)
        except (OSError, ValueError, KeyError):
            return
        for _ in range(50):
            try:
                os.kill(self.pid(), 0)
            except OSError:
                return
            time.sleep(0.1)

    def tearDown(self):
        self.stop_server()
        self.tmp.cleanup()

    def get(self, path, host=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        conn.request('GET', path, headers={'Host': host or f'127.0.0.1:{self.port}'})
        response = conn.getresponse()
        body = response.read()
        conn.close()
        return response.status, response.getheader('Content-Security-Policy'), body

    def test_page_and_state_need_the_token(self):
        status, policy, body = self.get(f'/{self.token}/')
        self.assertEqual((status, body), (200, b'<title>Work map</title>'))
        self.assertIn("script-src 'self'", policy)
        self.assertEqual(json.loads(self.get(f'/{self.token}/state?s=aaa-111')[2])['n'], 1)
        self.assertEqual(self.get(f'/{self.token}/app.js')[0], 200)
        for path in ('/', '/state', '/wrong-token-0000000/state', f'/{self.token}x/state'):
            self.assertEqual(self.get(path)[0], 404, path)

    def test_another_site_cannot_read_it(self):
        self.assertEqual(self.get(f'/{self.token}/state', host='evil.example')[0], 403)
        self.assertEqual(self.get(f'/{self.token}/state', host=f'localhost:{self.port}')[0], 200)

    def test_nothing_outside_the_page_folder_or_the_states(self):
        for name in ('../secret.txt', '..%2Fsecret.txt', 'secret.txt', '.hidden.js', 'index.html/../../secret.txt'):
            self.assertEqual(self.get(f'/{self.token}/{name}')[0], 404, name)
        for s in ('server', '../secret', '..%2Fsecret', 'nope'):
            self.assertEqual(self.get(f'/{self.token}/state?s={s}')[2], b'{}', s)

    def test_one_server_for_every_session_on_the_same_address(self):
        self.assertEqual(self.ensure(), (self.port, self.token), 'a second session finds the running server')
        other = self.dir / 'bbb-222.json'
        other.write_text(json.dumps({'n': 2, 'folder': 'two', 'savedAt': 2}))
        listed = json.loads(self.get(f'/{self.token}/sessions')[2])
        self.assertEqual([s['id'] for s in listed], ['bbb-222', 'aaa-111'])
        self.assertEqual(listed[0]['folder'], 'two')
        self.assertEqual(json.loads(self.get(f'/{self.token}/state')[2])['n'], 2, 'without ?s: the newest session')
        self.assertEqual(json.loads(self.get(f'/{self.token}/state?s=aaa-111')[2])['n'], 1)

    def test_it_comes_back_on_the_same_port_and_token(self):
        self.stop_server()
        self.assertEqual(self.ensure(), (self.port, self.token))

    def test_it_outlives_the_caller_and_shares_no_output(self):
        # ensure has exited; the server still answers, and its output goes nowhere a caller waits on.
        self.assertEqual(self.get(f'/{self.token}/ping')[2], b'work-map')
        if sys.platform != 'win32' and Path('/usr/sbin/lsof').exists():
            fds = subprocess.run(['/usr/sbin/lsof', '-p', str(self.pid()), '-a', '-d', '0,1,2'], capture_output=True, text=True).stdout
            self.assertNotIn('PIPE', fds.upper())
            self.assertEqual(fds.count('/dev/null'), 3, fds)

    def test_changes_are_pushed_as_they_happen(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        conn.request('GET', f'/{self.token}/events?s=aaa-111', headers={'Host': f'127.0.0.1:{self.port}'})
        response = conn.getresponse()
        self.assertEqual(response.getheader('Content-Type'), 'text/event-stream')
        self.assertEqual(json.loads(response.fp.readline()[6:])['n'], 1)
        response.fp.readline()
        time.sleep(0.05)
        self.state.write_text(json.dumps({'n': 3}))
        self.assertEqual(json.loads(response.fp.readline()[6:])['n'], 3)
        conn.close()

    def test_it_stops_when_no_session_saves(self):
        self.stop_server()
        port, token = self.ensure('--idle-minutes', '0.01')
        pid = self.pid()
        for _ in range(60):
            try:
                os.kill(pid, 0)
            except OSError:
                break
            time.sleep(0.1)
        else:
            self.fail('the idle server kept running')

    def test_tidy_deletes_old_states_in_its_own_folder_only(self):
        self.stop_server()
        old, fresh, other = self.dir / 'old.json', self.dir / 'fresh.json', self.dir / 'notes.txt'
        for f in (old, fresh, other):
            f.write_text('{}')
        week = time.time() - 8 * 86400
        for f in (old, other, self.dir / 'server.json'):
            os.utime(f, (week, week))
        (self.dir / 'below').mkdir()
        deep = self.dir / 'below' / 'deep.json'
        deep.write_text('{}')
        os.utime(deep, (week, week))
        self.ensure('--tidy-days', '7')
        time.sleep(0.5)
        self.assertFalse(old.exists(), 'an old state is deleted')
        self.assertTrue(fresh.exists(), 'a recent state stays')
        self.assertTrue((self.dir / 'server.json').exists(), "the server's own record stays")
        self.assertTrue(other.exists(), 'only .json files')
        self.assertTrue(deep.exists(), 'nothing below the folder')


if __name__ == '__main__':
    unittest.main()
