"""Synthetic acceptance-helper cleanup checks. No imports of live helper setup or network clients."""
import ast
import contextlib
import io
from pathlib import Path
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
NAME = 'e2e-owned-fixture'
APP = 'https://fixture.invalid'


class Reply:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self.body = body if body is not None else {}
        self.headers = {}

    def json(self):
        if isinstance(self.body, Exception):
            raise self.body
        return self.body


class Session:
    def __init__(self, create=None, cleanup=200, interrupt=False):
        self.create = create or Reply(200, {'ok': True, 'confirmedInGitHub': True})
        self.cleanup = cleanup
        self.interrupt = interrupt
        self.cookies = {'crc_session': 'synthetic'}
        self.deleted = []
        self.created = False
        self.removed = False
        self.stopped = False
        self.posts = []

    def get(self, url, **kwargs):
        if url.endswith('/api/me'):
            return Reply(body={'user': {'username': 'fixture', 'groups': ['fixture']}})
        if '/api/audit?' in url:
            return Reply(body={'entries': [
                {'actor': {'username': 'fixture'}, 'action': 'runner.' + action}
                for action in ('create', 'stop', 'start', 'restart', 'delete')]})
        if self.created and self.interrupt:
            raise RuntimeError('synthetic inventory failure')
        runners = [{'name': 'actions-runner', 'state': 'unregistered',
                    'protectedRunner': True, 'actions': {'delete': False}}]
        if self.created and not self.removed:
            runners.append({'name': NAME, 'state': 'stopped' if self.stopped else 'online',
                            'github': {'labels': ['e2e']}})
        return Reply(body={'runners': runners, 'headroom': {'cpus': 1, 'memory': {'totalBytes': 1}},
                           'cap': {'limit': 3, 'used': 1}, 'target': 'reconcile-app'})

    def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        if url.endswith('/api/runners'):
            if self.created:
                name = kwargs['json']['name']
                return Reply(409 if name == NAME else 400 if name == 'bad name!' else 403)
            self.created = True
            if isinstance(self.create, Exception):
                raise self.create
            return self.create
        self.stopped = url.endswith('/stop')
        return Reply(body={'active': 'inactive' if self.stopped else 'active'})

    def delete(self, url, **kwargs):
        self.deleted.append(url)
        if self.cleanup == 200:
            self.removed = True
        return Reply(self.cleanup, {'ok': self.cleanup == 200})


class CleanupBoundaries(unittest.TestCase):
    def exercise(self, session):
        # Compile only run(), so opt-in, credentials, main() and real requests cannot execute.
        tree = ast.parse((ROOT / 'deploy/e2e-check.py').read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run')
        checks = {}
        anon = types.SimpleNamespace(verify=True, get=lambda url, **kw: Reply(401) if '/api/' in url
                                     else types.SimpleNamespace(status_code=302, headers={'location': '/auth/login'}))
        env = dict(APP=APP, TEST_USER='fixture', GROUP_NAME='fixture', TLS_VERIFY=True,
                   GITHUB_TOKEN='synthetic', GITHUB_RUNNERS_URL='https://github.invalid/runners',
                   requests=types.SimpleNamespace(Session=lambda: anon, get=lambda *a, **k: Reply(body={'runners': []})),
                   secrets=types.SimpleNamespace(token_hex=lambda n: 'owned-fixture'),
                   time=types.SimpleNamespace(time=lambda: 0, sleep=lambda n: None),
                   sign_in=lambda: (session, APP),
                   check=lambda name, ok, detail='': checks.setdefault(name, bool(ok)))
        import json
        env['json'] = json
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'e2e-run', 'exec'), env)
        error = None
        with contextlib.redirect_stdout(io.StringIO()):
            try:
                env['run']({})
            except (Exception, SystemExit) as exc:
                error = exc
        return checks, error

    def test_success_deletes_once_and_keeps_acceptance_assertions(self):
        session = Session()
        checks, error = self.exercise(session)
        self.assertIsNone(error)
        self.assertTrue(all(checks.values()), checks)
        self.assertEqual(session.deleted, [APP + '/api/runners/' + NAME])

    def test_completed_error_cleans_owned_runner_but_still_fails_acceptance(self):
        for status in (502, 503):
            with self.subTest(status=status):
                session = Session(Reply(status, {'operationState': 'completed'}))
                checks, error = self.exercise(session)
                self.assertIsInstance(error, SystemExit)
                self.assertFalse(checks['create returns success'])
                self.assertFalse(checks['GitHub confirms the runner online'])
                self.assertEqual(session.deleted, [APP + '/api/runners/' + NAME])
                self.assertEqual(len(session.posts), 1)

    def test_uncertain_or_rejected_create_never_deletes_or_retries(self):
        cases = [Reply(502), Reply(502, {'operationState': 'failed'}),
                 Reply(503, {'operationState': 'not-started'}), Reply(409),
                 Reply(400, {'operationState': 'completed'}), Reply(200, {'ok': False}),
                 Reply(502, ValueError('malformed JSON')), TimeoutError('lost response'),
                 *[Reply(200, {'ok': value}) for value in (1, 'true', {'truthy': True})]]
        for create in cases:
            with self.subTest(create=create):
                session = Session(create)
                _, error = self.exercise(session)
                self.assertIsNotNone(error)
                self.assertEqual(session.deleted, [])
                self.assertEqual(len(session.posts), 1)

    def test_later_exception_cleans_only_owned_name(self):
        session = Session(interrupt=True)
        _, error = self.exercise(session)
        self.assertRegex(str(error), 'synthetic inventory failure')
        self.assertEqual(session.deleted, [APP + '/api/runners/' + NAME])

    def test_cleanup_absence_is_idempotent_and_other_errors_are_reported(self):
        for status in (200, 404, 409, 502, 503):
            with self.subTest(status=status):
                session = Session(Reply(502, {'operationState': 'completed'}), cleanup=status)
                _, error = self.exercise(session)
                if status in (200, 404):
                    self.assertIsInstance(error, SystemExit)
                else:
                    self.assertIsInstance(error, RuntimeError)
                    self.assertIn('manual reconciliation required', str(error))
                    self.assertIn(NAME, str(error))
                self.assertEqual(session.deleted, [APP + '/api/runners/' + NAME])


if __name__ == '__main__':
    unittest.main(verbosity=2)
