"""serve.py: this computer only, the token on every address, live state, no way out of the page folder."""
import http.client
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SERVE = Path(__file__).with_name('serve.py')
TOKEN = 'abcdefghijklmnop1234'


class ServeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.page = root / 'page'
        self.page.mkdir()
        (self.page / 'index.html').write_text('<title>Work map</title>')
        (self.page / 'app.js').write_text('// app')
        (root / 'secret.txt').write_text('outside the page')
        self.state = root / 'state.json'
        self.state.write_text(json.dumps({'n': 1}))
        self.proc = subprocess.Popen([sys.executable, '-I', str(SERVE), '--state', str(self.state), '--token', TOKEN, '--page', str(self.page)],
                                     stdout=subprocess.PIPE, text=True)
        self.port = int(self.proc.stdout.readline().split()[1])

    def tearDown(self):
        self.proc.terminate()
        self.proc.wait(5)
        self.proc.stdout.close()
        self.tmp.cleanup()

    def get(self, path, host=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        conn.request('GET', path, headers={'Host': host or f'127.0.0.1:{self.port}'})
        response = conn.getresponse()
        body = response.read()
        conn.close()
        return response.status, response.getheader('Content-Security-Policy'), body

    def test_page_and_state_need_the_token(self):
        status, policy, body = self.get(f'/{TOKEN}/')
        self.assertEqual((status, body), (200, b'<title>Work map</title>'))
        self.assertIn("script-src 'self'", policy)
        self.assertEqual(self.get(f'/{TOKEN}/state')[2], b'{"n": 1}')
        self.assertEqual(self.get(f'/{TOKEN}/app.js')[0], 200)
        for path in ('/', '/state', '/wrong-token-0000000/state', f'/{TOKEN}x/state'):
            self.assertEqual(self.get(path)[0], 404, path)

    def test_another_site_cannot_read_it(self):
        self.assertEqual(self.get(f'/{TOKEN}/state', host='evil.example')[0], 403)
        self.assertEqual(self.get(f'/{TOKEN}/state', host=f'localhost:{self.port}')[0], 200)

    def test_nothing_outside_the_page_folder(self):
        for name in ('../secret.txt', '..%2Fsecret.txt', 'secret.txt', '.hidden.js', 'index.html/../../secret.txt'):
            self.assertEqual(self.get(f'/{TOKEN}/{name}')[0], 404, name)

    def test_changes_are_pushed_as_they_happen(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        conn.request('GET', f'/{TOKEN}/events', headers={'Host': f'127.0.0.1:{self.port}'})
        response = conn.getresponse()
        self.assertEqual(response.getheader('Content-Type'), 'text/event-stream')
        self.assertEqual(response.fp.readline(), b'data: {"n": 1}\n')
        response.fp.readline()
        time.sleep(0.05)
        self.state.write_text(json.dumps({'n': 2}))
        self.assertEqual(response.fp.readline(), b'data: {"n": 2}\n')
        conn.close()

    def test_tidy_deletes_old_states_in_its_own_folder_only(self):
        import os
        root = Path(self.tmp.name) / 'home' / '.claude' / 'work-map'
        root.mkdir(parents=True)
        old, fresh, mine, other = root / 'old.json', root / 'fresh.json', root / 'mine.json', root / 'notes.txt'
        for f in (old, fresh, mine, other):
            f.write_text('{}')
        week = time.time() - 8 * 86400
        for f in (old, mine, other):
            os.utime(f, (week, week))
        (root / 'below').mkdir()
        deep = root / 'below' / 'deep.json'
        deep.write_text('{}')
        os.utime(deep, (week, week))
        proc = subprocess.Popen([sys.executable, '-I', str(SERVE), '--state', str(mine), '--token', TOKEN, '--page', str(self.page), '--tidy-days', '7'],
                                stdout=subprocess.PIPE, text=True)
        proc.stdout.readline()
        proc.terminate(); proc.wait(5); proc.stdout.close()
        self.assertFalse(old.exists(), 'an old state is deleted')
        self.assertTrue(fresh.exists(), 'a recent state stays')
        self.assertTrue(mine.exists(), "the session's own state stays, however old")
        self.assertTrue(other.exists(), 'only .json files')
        self.assertTrue(deep.exists(), 'nothing below the folder')

    def test_tidy_only_runs_in_a_work_map_folder(self):
        import os
        stray = Path(self.tmp.name) / 'old.json'
        stray.write_text('{}')
        week = time.time() - 8 * 86400
        os.utime(stray, (week, week))
        proc = subprocess.Popen([sys.executable, '-I', str(SERVE), '--state', str(self.state), '--token', TOKEN, '--page', str(self.page), '--tidy-days', '7'],
                                stdout=subprocess.PIPE, text=True)
        proc.stdout.readline()
        proc.terminate(); proc.wait(5); proc.stdout.close()
        self.assertTrue(stray.exists())

    def test_a_weak_token_is_refused(self):
        result = subprocess.run([sys.executable, '-I', str(SERVE), '--state', str(self.state), '--token', 'short', '--page', str(self.page)],
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('at least 16', result.stderr)


if __name__ == '__main__':
    unittest.main()
