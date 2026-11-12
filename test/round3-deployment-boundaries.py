"""Round-three deployment boundary probes. Parent reviewed before execution.

Prerequisites: Python 3, /bin/bash, shared heavy.lock and designated TMPDIR.
Only a temporary deploy.sh copy runs, with PATH containing strict fakes only.
No installer, remote shell, build, credentials, listener or live check runs.
The packaging fakes model sequencing, not archive contents or deployed state.
"""
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
REMOTE_STAGE = '/tmp/crc-stage.ABCDE12345'
PREFLIGHT = 'sudo test -f /etc/ci-runner-console.env'
ALLOCATE = 'mktemp -d /tmp/crc-stage.XXXXXXXXXX'

# No fake forwards a command to a shell or another executable.
FAKE = r'''
import json, os, pathlib, shutil, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ['FIXTURE'])
stage = root / 'stage'
mode = os.environ['MODE']
remote = '/tmp/crc-stage.ABCDE12345'
with (root / 'calls').open('a') as log:
    log.write(json.dumps([name, *args]) + '\n')
def refuse():
    print('UNEXPECTED_BOUNDARY: ' + repr([name, *args]), file=sys.stderr)
    sys.exit(97)
if name == 'dirname' and args == [str(root / 'deploy/deploy.sh')]:
    print(root / 'deploy')
elif name == 'npm' and args == ['run', 'build']:
    sys.exit(71 if mode == 'build-failure' else 0)
elif name == 'mktemp' and args == ['-d']:
    stage.mkdir()
    print(stage)
elif name == 'mkdir' and args == ['-p', str(stage / 'web')]:
    pass
elif name == 'cp' and args in [
    ['-r', 'dist', str(stage / 'dist')],
    ['-r', 'web/dist', str(stage / 'web/dist')],
    ['package.json', 'package-lock.json', 'deploy/ci-runner-console.service', str(stage) + '/'],
]:
    pass
elif name == 'rm' and args == ['-rf', '--', str(stage)]:
    shutil.rmtree(stage)
elif name == 'tar' and args == ['-C', str(stage), '-czf', '-', '.']:
    sys.stdout.buffer.write(b'synthetic archive')
elif name == 'ssh':
    if args[:5] != ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'fixture.invalid'] or len(args) != 6:
        refuse()
    command = args[5]
    if command == 'sudo test -f /etc/ci-runner-console.env':
        sys.exit(70 if mode == 'preflight-failure' else 0)
    elif command == 'mktemp -d /tmp/crc-stage.XXXXXXXXXX':
        print(os.environ.get('STAGE_REPLY', remote))
        sys.exit(72 if mode == 'allocation-failure' else 0)
    elif command == "tar -C '" + remote + "' -xzf -":
        sys.stdin.buffer.read(1024)
        sys.exit(73 if mode == 'upload-failure' else 0)
    elif command == "sudo bash -s -- '" + remote + "'":
        # Discard the heredoc. Never interpret or execute remote installation.
        sys.stdin.buffer.read(16384)
        sys.exit(74 if mode == 'install-failure' else 0)
    elif command == "rm -rf -- '" + remote + "'":
        pass
    else:
        refuse()
else:
    refuse()
'''


class DeploymentBoundaries(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='crc-round3-deploy-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.root / 'deploy').mkdir()
        self.script = self.root / 'deploy/deploy.sh'
        self.script.write_text((ROOT / 'deploy/deploy.sh').read_text())
        for name in ('dirname', 'npm', 'mktemp', 'mkdir', 'cp', 'rm', 'tar', 'ssh'):
            executable = self.bin / name
            executable.write_text(f'#!{sys.executable}\n' + FAKE)
            executable.chmod(0o700)
        self.env = {
            'PATH': str(self.bin),
            'TMPDIR': str(self.root), 'FIXTURE': str(self.root), 'LC_ALL': 'C',
        }

    def deploy(self, mode, *hosts, reply=REMOTE_STAGE):
        (self.root / 'calls').unlink(missing_ok=True)
        result = subprocess.run(
            ['/bin/bash', str(self.script), *hosts], cwd=self.root,
            env=dict(self.env, MODE=mode, STAGE_REPLY=reply),
            input='', text=True, capture_output=True, timeout=5,
        )
        path = self.root / 'calls'
        calls = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return result, calls

    def safe(self, result):
        self.assertNotIn('UNEXPECTED_BOUNDARY', result.stderr, result.stderr)
        self.assertNotIn('command not found', result.stderr, result.stderr)

    def remote_commands(self, calls):
        return [call[-1] for call in calls if call[0] == 'ssh']

    def test_host_rejection_precedes_every_external_command(self):
        for hosts in [(), ('-oProxyCommand=x',), ('fixture.invalid;id',),
                      ('fixture.invalid\nother',), ('fixture.invalid', 'extra')]:
            with self.subTest(hosts=hosts):
                result, calls = self.deploy('normal', *hosts)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])

    def test_preflight_and_build_failures_stop_before_staging(self):
        for mode in ('preflight-failure', 'build-failure'):
            with self.subTest(mode=mode):
                result, calls = self.deploy(mode, 'fixture.invalid')
                self.safe(result)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.remote_commands(calls), [PREFLIGHT])
                self.assertEqual([call[0] for call in calls],
                                 ['dirname', 'ssh'] + (['npm'] if mode == 'build-failure' else []))
                self.assertFalse((self.root / 'stage').exists())

    def test_invalid_successful_stage_reply_is_never_used_for_cleanup(self):
        for reply in ('/tmp/other', REMOTE_STAGE + '\nextra', REMOTE_STAGE + "'; id; #"):
            with self.subTest(reply=reply):
                result, calls = self.deploy('normal', 'fixture.invalid', reply=reply)
                self.safe(result)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.remote_commands(calls), [PREFLIGHT, ALLOCATE])
                self.assertFalse((self.root / 'stage').exists())

    def test_failed_stage_allocation_never_uses_unvalidated_stdout(self):
        # Hypothesis: errexit skips validation, but EXIT still consumes REMOTE_STAGE.
        for reply in ('/tmp/other', REMOTE_STAGE + "'; id; #"):
            with self.subTest(reply=reply):
                result, calls = self.deploy('allocation-failure', 'fixture.invalid', reply=reply)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / 'stage').exists())
                self.assertEqual(self.remote_commands(calls), [PREFLIGHT, ALLOCATE],
                                 'failed allocation must not select a remote cleanup command')
                self.safe(result)

    def test_upload_install_and_success_paths_clean_only_validated_stage(self):
        for mode in ('upload-failure', 'install-failure', 'normal'):
            with self.subTest(mode=mode):
                result, calls = self.deploy(mode, 'fixture.invalid')
                self.safe(result)
                self.assertEqual(result.returncode == 0, mode == 'normal', result.stderr)
                expected = [PREFLIGHT, ALLOCATE, f"tar -C '{REMOTE_STAGE}' -xzf -"]
                if mode != 'upload-failure':
                    expected.append(f"sudo bash -s -- '{REMOTE_STAGE}'")
                expected.append(f"rm -rf -- '{REMOTE_STAGE}'")
                self.assertEqual(self.remote_commands(calls), expected)
                self.assertFalse((self.root / 'stage').exists())


class LiveRefusalBoundaries(unittest.TestCase):
    def test_opt_in_and_reboot_refusals_precede_credentials_or_requests(self):
        requests = types.ModuleType('requests')
        accesses = []

        def refuse(name):
            accesses.append(name)
            raise AssertionError(f'unexpected requests access: {name}')

        requests.__getattr__ = refuse
        cases = [({}, 'set ALLOW_LIVE_CHECKS=1')]
        cases.extend(({'ALLOW_LIVE_CHECKS': value}, 'set ALLOW_LIVE_CHECKS=1')
                     for value in ('0', 'true', '01', '1 ', ' 1'))
        cases.append(({'ALLOW_LIVE_CHECKS': '1', 'REBOOT_TEST': '1'}, 'REBOOT_TEST=1 is unsupported'))
        for env, message in cases:
            with self.subTest(env=env), patch.dict(os.environ, env, clear=True), \
                    patch.dict(sys.modules, {'requests': requests}):
                # Empty credential environment also prevents reaching the live body
                # if either refusal unexpectedly falls through.
                with self.assertRaisesRegex(SystemExit, message):
                    runpy.run_path(str(ROOT / 'deploy/e2e-check.py'), run_name='__main__')
                self.assertEqual(accesses, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
