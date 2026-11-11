"""Isolated script regressions. Never invoke real sudo, systemctl, or network tools."""
import base64
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.env = dict(os.environ, PATH=str(self.bin) + ':' + os.environ['PATH'],
                        CALLS=str(self.root / 'calls'), TMPDIR=str(self.root))
        for name in ('sudo', 'systemctl', 'journalctl', 'curl'):
            self.fake(name, '#!/usr/bin/python3\nimport os,sys,json\nwith open(os.environ["CALLS"],"a") as f: f.write(json.dumps(sys.argv)+"\\n")\nsys.exit(int(os.environ.get("FAKE_EXIT","0")))\n')
        self.fake('id', '#!/bin/sh\nprintf "1001\\n"\n')
        self.runners = self.root / 'runners'
        self.runners.mkdir(mode=0o755)
        self.dist = self.root / 'dist'
        self.dist.mkdir(mode=0o755)
        source = (ROOT / 'vm/ci-runner-ctl').read_text()
        source = source.replace('/etc/ci-runner-ctl.conf', str(self.root / 'absent.conf'))
        source = source.replace('/opt/runners', str(self.runners))
        source = source.replace('/opt/actions-runner', str(self.root / 'legacy'))
        source = source.replace('/opt/runner-dist', str(self.dist))
        source = source.replace('/run/ci-runner-ctl.lock', str(self.root / 'lock'))
        source = source.replace('/etc/systemd/system/', str(self.root / 'units') + '/')
        source = source.replace('[[ $EUID -eq 0 ]]', '[[ 0 -eq 0 ]]')
        # Model root ownership with this test process, without sudo or chown.
        source = source.replace('st.st_uid == 0', 'st.st_uid == os.geteuid()')
        self.ctl = self.root / 'ctl'
        self.ctl.write_text(source)

    def fake(self, name, source):
        path = self.bin / name
        path.write_text(source)
        path.chmod(0o755)

    def run_ctl(self, *args, token='synthetic_token_123'):
        return subprocess.run(['bash', str(self.ctl), *args], env=self.env,
                              input=token + '\n', text=True, capture_output=True, timeout=10)

    def wrapper(self, argv):
        env = dict(self.env, SSH_ORIGINAL_COMMAND=base64.b64encode(json.dumps(argv).encode()).decode())
        return subprocess.run(['bash', str(ROOT / 'vm/ci-runner-ctl-ssh')], env=env,
                              input='synthetic_token_123\n', text=True, capture_output=True, timeout=5)

    def test_wrapper_exact_argv(self):
        for argv in (['list'], ['logs', 'runner-1', '20'], ['create', 'r1', '', 'https://github.com/org', 'a group']):
            self.assertEqual(self.wrapper(argv).returncode, 0)
            last = json.loads((self.root / 'calls').read_text().splitlines()[-1])
            self.assertEqual(last[3:], argv)

    def test_wrapper_rejects_before_sudo(self):
        for argv in (['list', 'extra'], ['remove'], ['start', '../x'], ['start', '-x'],
                     ['create', 'r', '', 'https://github.com/../x'], ['logs', 'r', '1;id'],
                     ['create', 'r', 'bad label', 'https://github.com/org'], ['list', None], ['list\0']):
            self.assertEqual(self.wrapper(argv).returncode, 42, argv)
        self.assertFalse((self.root / 'calls').exists())

    def test_label_limits_match_api(self):
        labels = ','.join(f'{i:02d}' + 'a' * 37 for i in range(20))
        self.assertEqual(len(labels), 799)
        self.assertEqual(self.wrapper(['create', 'r', labels, 'https://github.com/org']).returncode, 0)
        (self.root / 'calls').unlink()
        for invalid in (labels + ',extra', 'a' * 40, 'a,,b', 'a,'):
            self.assertEqual(self.wrapper(['create', 'r', invalid, 'https://github.com/org']).returncode, 42)
            result = self.run_ctl('create', 'r', invalid, 'https://github.com/org')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('invalid labels', result.stdout)
        self.assertFalse((self.root / 'calls').exists())

    def test_direct_dispatch_rejects_extra_args(self):
        self.assertNotEqual(self.run_ctl('start', 'r', 'extra').returncode, 0)
        self.assertFalse((self.root / 'calls').exists())

    def test_symlink_instance_is_not_discovered(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'config.sh').write_text('#!/bin/sh\n')
        (outside / 'config.sh').chmod(0o755)
        (self.runners / 'r').symlink_to(outside)
        self.assertEqual(json.loads(self.run_ctl('list').stdout)['instances'], [])
        self.assertNotEqual(self.run_ctl('remove', 'r').returncode, 0)
        self.assertTrue(outside.exists())

    def test_untrusted_unit_cannot_select_service(self):
        d = self.runners / 'r'
        d.mkdir()
        (d / 'config.sh').write_text('#!/bin/sh\n')
        (d / 'config.sh').chmod(0o755)
        for unit in ('sshd.service', 'actions.runner.other.service', '--all'):
            (d / '.service').write_text(unit)
            self.assertNotEqual(self.run_ctl('stop', 'r').returncode, 0)
        self.assertFalse((self.root / 'calls').exists())

    def test_trusted_unit_must_bind_exact_directory_and_user(self):
        d = self.instance()
        unit = self.unit(d)
        content = unit.read_text()
        for unsafe in (content.replace(str(d), str(self.root)),
                       content.replace('User=runner', 'User=root'),
                       content.replace('User=runner', 'user=runner'),
                       content.replace('User=runner', 'User:runner'),
                       '[DEFAULT]\nUser=runner\n' + content.replace('User=runner\n', ''),
                       content.replace('/runsvc.sh', '/other.sh')):
            unit.write_text(unsafe)
            self.assertNotEqual(self.run_ctl('start', 'r').returncode, 0, unsafe)
        unit.write_text(content)
        unit.chmod(0o666)
        self.assertNotEqual(self.run_ctl('start', 'r').returncode, 0)
        unit.chmod(0o644)
        dropin = Path(str(unit) + '.d')
        dropin.symlink_to(self.root / 'missing')
        self.assertNotEqual(self.run_ctl('start', 'r').returncode, 0)
        dropin.unlink()
        self.assertFalse((self.root / 'calls').exists())
        self.assertEqual(self.run_ctl('start', 'r').returncode, 0)
        calls = [json.loads(line)[1:] for line in (self.root / 'calls').read_text().splitlines()]
        self.assertIn(['start', unit.name], calls)
        self.assertIn(['enable', unit.name], calls)

    def test_metadata_cannot_select_another_instances_trusted_unit(self):
        d = self.instance()
        other = self.instance('other')
        unit = self.unit(other, 'actions.runner.other.service')
        (d / '.service').write_text(unit.name)
        self.assertNotEqual(self.run_ctl('stop', 'r').returncode, 0)
        self.assertFalse((self.root / 'calls').exists())

    def test_service_metadata_symlinks_and_fifos_fail_closed(self):
        d = self.instance()
        metadata = d / '.service'
        metadata.symlink_to(self.root / 'absent')
        self.assertNotEqual(self.run_ctl('remove', 'r').returncode, 0)
        metadata.unlink()
        os.mkfifo(metadata)
        self.assertNotEqual(self.run_ctl('remove', 'r').returncode, 0)
        self.assertFalse((self.root / 'calls').exists())

    def test_runner_cannot_hide_directory_from_cap_or_rename_it(self):
        d = self.instance()
        (d / 'config.sh').unlink()
        (d / '.runner').write_text('{"agentName":"other"}')
        self.ctl.write_text(self.ctl.read_text().replace('MAX_RUNNERS=3', 'MAX_RUNNERS=1'))
        result = self.run_ctl('list')
        self.assertEqual([i['name'] for i in json.loads(result.stdout)['instances']], ['r'])
        self.assertIn('runner cap reached', self.run_ctl('create', 'new', '', 'https://github.com/org').stdout)

    def test_configuration_symlink_and_writable_file_are_not_sourced(self):
        config = self.root / 'absent.conf'
        victim = self.root / 'victim'
        victim.write_text(f'touch {self.root}/executed\n')
        config.symlink_to(victim)
        self.assertIn('unsafe controller configuration', self.run_ctl('list').stdout)
        config.unlink()
        config.write_text(victim.read_text())
        config.chmod(0o666)
        self.assertIn('unsafe controller configuration', self.run_ctl('list').stdout)
        self.assertFalse((self.root / 'executed').exists())

    def test_root_runner_account_is_rejected(self):
        self.fake('id', '#!/bin/sh\nprintf "0\\n"\n')
        self.assertIn('runner user must be unprivileged', self.run_ctl('list').stdout)
        self.assertFalse((self.root / 'calls').exists())

    def test_distribution_must_match_pin(self):
        archive = self.dist / 'actions-runner-linux-x64-2.336.0.tar.gz'
        archive.write_bytes(b'fake archive')
        archive.chmod(0o644)
        result = self.run_ctl('create', 'r', '', 'https://github.com/org')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checksum mismatch', result.stdout)
        self.assertFalse((self.runners / 'r').exists())

    def test_configure_keeps_token_off_argv_and_output(self):
        # Source only definitions, then invoke configure with a synthetic token.
        definitions = self.ctl.read_text().split('# ---------------------------------------------------------------- dispatch')[0]
        self.ctl.write_text(definitions + '\nexec 9>"$1/lock"\ntoken=$(read_token)\nconfigure "$1" "$token" --unattended\n')
        self.execute_configure()
        config = self.runners / 'config.sh'
        config.write_text('''#!/usr/bin/python3
import os, sys, json
try:
    os.fstat(9)
    lock_closed = False
except OSError:
    lock_closed = True
with open("configured", "w") as f:
    json.dump({"argv": sys.argv[1:], "token": os.environ.get("VSO_AGENT_INPUT_TOKEN"),
               "cwd": os.getcwd(), "lock_closed": lock_closed}, f)
print(os.environ.get("VSO_AGENT_INPUT_TOKEN"))
print(os.environ.get("VSO_AGENT_INPUT_TOKEN"), file=sys.stderr)
''')
        config.chmod(0o755)
        result = self.run_ctl(str(self.runners))
        self.assertEqual(result.returncode, 0)
        self.assertNotIn('synthetic_token_123', (self.root / 'calls').read_text())
        self.assertEqual(result.stdout + result.stderr, '')
        self.assertEqual(json.loads((self.runners / 'configured').read_text()), {
            'argv': ['--unattended'], 'token': 'synthetic_token_123',
            'cwd': str(self.runners), 'lock_closed': True})

    def execute_configure(self):
        # Execute only the controller's bash as our current user, never real sudo.
        self.fake('sudo', '''#!/usr/bin/python3
import os, sys, json
assert sys.argv[1:5] == ["-u", "runner", "-H", "bash"]
with open(os.environ["CALLS"], "a") as f:
    f.write(json.dumps(sys.argv) + "\\n")
os.execvp("bash", sys.argv[4:])
''')

    def instance(self, name='r'):
        directory = self.runners / name
        directory.mkdir(mode=0o755)
        config = directory / 'config.sh'
        config.write_text('#!/bin/sh\nexit 0\n')
        config.chmod(0o755)
        return directory

    def unit(self, directory, name='actions.runner.console.r.service', content=None):
        folder = self.root / 'units'
        folder.mkdir(exist_ok=True, mode=0o755)
        path = folder / name
        path.write_text(content or f'[Service]\nUser=runner\nWorkingDirectory={directory}\nExecStart={directory}/runsvc.sh\n')
        path.chmod(0o644)
        return path

    def stage_fake_distribution(self):
        archive = self.dist / 'actions-runner-linux-x64-2.336.0.tar.gz'
        archive.write_bytes(b'fake archive')
        archive.chmod(0o644)
        self.fake('sha256sum', '#!/bin/sh\nexit 0\n')
        self.fake('chown', '#!/bin/sh\nexit 0\n')
        self.fake('tar', '#!/usr/bin/python3\nimport pathlib,sys\np=pathlib.Path(sys.argv[-1])/"config.sh"\np.write_text("#!/bin/sh\\nexit 1\\n")\np.chmod(0o755)\n')

    def test_partial_registration_is_retained(self):
        self.stage_fake_distribution()
        self.execute_configure()
        tar = self.bin / 'tar'
        tar.write_text(tar.read_text() + '\np.write_text("#!/bin/sh\\nprintf registered > .credentials\\nexit 1\\n")\n')
        result = self.run_ctl('create', 'r', '', 'https://github.com/org')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('instance retained', result.stdout)
        self.assertTrue((self.runners / 'r/config.sh').exists())
        self.assertEqual((self.runners / 'r/.credentials').read_text(), 'registered')

    def test_failed_unpack_removes_only_new_directory(self):
        self.stage_fake_distribution()
        self.fake('tar', '#!/bin/sh\nexit 1\n')
        existing = self.instance('existing')
        self.assertIn('runner extraction failed', self.run_ctl('create', 'r', '', 'https://github.com/org').stdout)
        self.assertFalse((self.runners / 'r').exists())
        self.assertTrue(existing.exists())

    def test_service_failure_retains_registration_and_unit(self):
        self.stage_fake_distribution()
        (self.root / 'units').mkdir()
        self.fake('systemctl', '#!/bin/sh\nexit 1\n')
        result = self.run_ctl('create', 'r', '', 'https://github.com/org')
        self.assertIn('service install/start failed; instance retained', result.stdout)
        self.assertTrue((self.runners / 'r').exists())
        self.assertTrue((self.root / 'units/actions.runner.console.r.service').exists())

    def test_service_symlink_is_not_written(self):
        self.stage_fake_distribution()
        (self.root / 'units').mkdir()
        victim = self.root / 'victim'
        victim.write_text('untouched')
        tar = self.bin / 'tar'
        tar.write_text(tar.read_text() + f'\n(p.parent / ".service").symlink_to({str(victim)!r})\n')
        result = self.run_ctl('create', 'r', '', 'https://github.com/org')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(victim.read_text(), 'untouched')
        self.assertTrue((self.root / 'units/actions.runner.console.r.service').exists())

    def test_deregistration_failure_retains_directory(self):
        d = self.runners / 'r'
        d.mkdir()
        (d / 'config.sh').write_text('#!/bin/sh\n')
        (d / 'config.sh').chmod(0o755)
        (d / '.runner').write_text('{}')
        self.env['FAKE_EXIT'] = '1'
        result = self.run_ctl('remove', 'r')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('deregistration failed', result.stdout)
        self.assertTrue(d.exists())

    def test_existing_service_marker_is_uninstalled_before_deregistration(self):
        self.execute_configure()
        d = self.instance()
        unit = self.unit(d)
        (d / '.service').write_text(unit.name)
        (d / '.runner').write_text('{}')
        (d / '.credentials').write_text('recoverable')
        (d / 'config.sh').write_text('#!/bin/sh\n[ ! -e .service ] || exit 9\nexit 1\n')
        result = self.run_ctl('remove', 'r')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(unit.exists())
        self.assertFalse((d / '.service').exists())
        self.assertEqual((d / '.credentials').read_text(), 'recoverable')
        (d / 'config.sh').write_text('#!/bin/sh\n[ ! -e .service ] || exit 9\nexit 0\n')
        self.assertEqual(self.run_ctl('remove', 'r').returncode, 0)
        self.assertFalse(d.exists())

    def test_empty_interrupted_creation_can_be_removed(self):
        d = self.runners / 'empty'
        d.mkdir()
        self.assertEqual(self.run_ctl('remove', 'empty').returncode, 0)
        self.assertFalse(d.exists())
        self.assertFalse((self.root / 'calls').exists())

    def test_missing_config_with_registration_is_retained(self):
        self.execute_configure()
        d = self.runners / 'partial'
        d.mkdir()
        (d / '.runner').write_text('{}')
        self.assertNotEqual(self.run_ctl('remove', 'partial').returncode, 0)
        self.assertTrue((d / '.runner').exists())

    def test_failed_stop_does_not_deregister_or_delete(self):
        d = self.instance()
        unit = self.unit(d)
        self.env['FAKE_EXIT'] = '1'
        self.assertIn('service stop failed; instance retained', self.run_ctl('remove', 'r').stdout)
        self.assertTrue(d.exists())
        self.assertTrue(unit.exists())
        calls = [json.loads(line) for line in (self.root / 'calls').read_text().splitlines()]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1:], ['stop', unit.name])

    def test_remove_does_not_follow_runner_owned_symlink(self):
        d = self.instance()
        self.unit(d)
        outside = self.root / 'outside'
        outside.mkdir()
        victim = outside / 'victim'
        victim.write_text('untouched')
        (d / 'linked').symlink_to(outside)
        self.execute_configure()
        self.assertEqual(self.run_ctl('remove', 'r').returncode, 0)
        self.assertFalse(d.exists())
        self.assertEqual(victim.read_text(), 'untouched')

    def test_lock_timeout_performs_no_action(self):
        self.ctl.write_text(self.ctl.read_text().replace('flock -w 10 9', 'flock -w 0.1 9'))
        with (self.root / 'lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = self.run_ctl('list')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('another runner operation is in progress', result.stdout)
        self.assertFalse((self.root / 'calls').exists())

    def test_configure_timeout_kills_its_child(self):
        definitions = self.ctl.read_text().split('# ---------------------------------------------------------------- dispatch')[0]
        self.ctl.write_text(definitions.replace('timeout -k 5 120', 'timeout -k 0.1 0.2') +
                            '\ntoken=$(read_token)\nconfigure "$1" "$token" --unattended\n')
        self.execute_configure()
        d = self.instance()
        (d / 'config.sh').write_text('#!/bin/sh\nsleep 30 &\nchild=$!\necho "$child" > child.pid\ntrap \'wait "$child"; exit 143\' TERM\nwait "$child"\n')
        result = self.run_ctl(str(d))
        self.assertEqual(result.returncode, 124)
        child = int((d / 'child.pid').read_text())
        self.assertFalse(Path(f'/proc/{child}').exists())

    def test_concurrent_creates_cannot_exceed_cap(self):
        self.stage_fake_distribution()
        self.ctl.write_text(self.ctl.read_text().replace('MAX_RUNNERS=3', 'MAX_RUNNERS=1'))
        self.fake('sudo', '#!/bin/sh\nsleep 0.2\nexit 1\n')
        first = subprocess.Popen(['bash', str(self.ctl), 'create', 'one', '', 'https://github.com/org'],
                                 env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        second = subprocess.Popen(['bash', str(self.ctl), 'create', 'two', '', 'https://github.com/org'],
                                  env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        first.stdin.write('synthetic_token_123\n')
        first.stdin.flush()
        second_out, _ = second.communicate('synthetic_token_123\n', timeout=10)
        first_out, _ = first.communicate(timeout=10)
        self.assertIn('runner cap reached', first_out + second_out)
        self.assertEqual(len(list(self.runners.iterdir())), 1)

    def test_installer_rejects_injected_settings_before_sudo(self):
        for key, value in [('MAX_RUNNERS', '3;id'), ('RUNNER_VERSION', '../bad'),
                           ('RUNNER_USER', 'runner\nroot'), ('RUNNER_SHA256', 'bad')]:
            result = subprocess.run(['bash', str(ROOT / 'vm/install-vm.sh')],
                                    env=dict(self.env, **{key: value}), input='',
                                    text=True, capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'calls').exists())


if __name__ == '__main__':
    unittest.main()
