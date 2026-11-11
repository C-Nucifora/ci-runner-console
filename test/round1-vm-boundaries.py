"""Round 1 bounded VM experiments, using only temporary controller copies and fakes.

Run selected classes serially under the shared heavy.lock, with a 60-second timeout.
RecoveryRegressions reproduces defects on baseline 3f8c4ec. No real sudo,
systemctl, runner configuration, network, or root-owned host paths are used.
"""
import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
fixture = runpy.run_path(str(ROOT / 'test/vm-boundaries.py'))


class IsolatedVm(unittest.TestCase):
    # Reuse fixture plumbing without inheriting or rerunning the baseline tests.
    fake = fixture['Boundaries'].fake
    run_ctl = fixture['Boundaries'].run_ctl
    wrapper = fixture['Boundaries'].wrapper
    instance = fixture['Boundaries'].instance
    unit = fixture['Boundaries'].unit
    execute_configure = fixture['Boundaries'].execute_configure

    def setUp(self):
        fixture['Boundaries'].setUp(self)
        self.env['TMPDIR'] = os.environ.get('TMPDIR', tempfile.gettempdir())
        self.events_path = self.root / 'events'
        self.state_path = self.root / 'systemd-state'
        self.fail_path = self.root / 'fail-once'
        self.env.update(EVENTS=str(self.events_path), STATE=str(self.state_path),
                        FAIL_ONCE=str(self.fail_path))
        self.state_path.write_text(json.dumps({'active': True, 'enabled': True,
                                              'loaded': True}))
        self.fake('systemctl', '''#!/usr/bin/python3
import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ['EVENTS'], 'a') as f:
    f.write(json.dumps(['systemctl', *args]) + '\\n')
failure = pathlib.Path(os.environ['FAIL_ONCE'])
if failure.exists() and failure.read_text() == args[0]:
    failure.unlink()
    sys.exit(1)
path = pathlib.Path(os.environ['STATE'])
state = json.loads(path.read_text())
if args[0] == 'stop': state['active'] = False
elif args[0] == 'disable': state['enabled'] = False
elif args[0] == 'start': state['active'] = True
elif args[0] == 'enable': state['enabled'] = True
elif args[0] == 'daemon-reload':
    state['loaded'] = any((path.parent / 'units').glob('*.service'))
elif args[0] == 'is-active': print('active' if state['active'] else 'inactive')
elif args[0] == 'is-enabled': print('enabled' if state['enabled'] else 'disabled')
elif args[0] == 'show': print('running' if 'SubState' in args else '')
else: sys.exit(90)
path.write_text(json.dumps(state))
''')

    def events(self):
        return [json.loads(line) for line in self.events_path.read_text().splitlines()] \
            if self.events_path.exists() else []

    def configure_fixture(self, directory):
        self.execute_configure()
        (directory / 'config.sh').write_text('''#!/usr/bin/python3
import json, os, pathlib, sys
assert sys.argv[1:] == ['remove']
assert os.environ.get('VSO_AGENT_INPUT_TOKEN') == 'synthetic_token_123'
with open(os.environ['EVENTS'], 'a') as f:
    f.write(json.dumps(['configure', *sys.argv[1:]]) + '\\n')
if os.path.lexists('.service'): sys.exit(9)
failure = pathlib.Path(os.environ['FAIL_ONCE'])
if failure.exists() and failure.read_text() == 'configure':
    failure.unlink()
    sys.exit(1)
''')

    def registered_instance(self, name='r', unit_name=None):
        directory = self.instance(name)
        unit = self.unit(directory, unit_name or f'actions.runner.console.{name}.service')
        (directory / '.service').write_text(unit.name)
        (directory / '.runner').write_text('{}')
        (directory / '.credentials').write_text('synthetic recoverable credentials')
        self.configure_fixture(directory)
        return directory, unit

    def marker(self, path, kind, unit_name=''):
        if os.path.lexists(path):
            if path.is_dir() and not path.is_symlink():
                path.rmdir()
            else:
                path.unlink()
        if kind == 'missing':
            return
        if kind == 'directory':
            path.mkdir()
        elif kind == 'fifo':
            os.mkfifo(path)
        elif kind == 'dangling-symlink':
            path.symlink_to(self.root / 'absent-target')
        elif kind == 'symlink':
            target = self.root / 'outside-marker'
            target.write_text('outside data must survive')
            path.symlink_to(target)
        else:
            path.write_text({'valid': unit_name, 'empty': '', 'corrupt': 'sshd.service',
                             'oversized': 'x' * 256, 'multiline': unit_name + '\nsshd.service'}[kind])


class RecoveryRegressions(IsolatedVm):
    def test_missing_marker_must_not_hide_a_bound_installed_unit(self):
        directory, unit = self.registered_instance(unit_name='actions.runner.org.r.service')
        before = json.loads(self.run_ctl('list').stdout)['instances'][0]
        self.assertEqual(before['unit'], unit.name)
        (directory / '.service').unlink()
        after = json.loads(self.run_ctl('list').stdout)['instances'][0]
        self.assertEqual(after['unit'], unit.name,
                         f'missing runner-owned marker hides verified installed unit: {after}')

    def test_missing_marker_remove_must_not_leave_an_active_bound_unit(self):
        directory, unit = self.registered_instance(unit_name='actions.runner.org.r.service')
        (directory / '.service').unlink()
        result = self.run_ctl('remove', 'r')
        state = json.loads(self.state_path.read_text())
        evidence = dict(reply=result.stdout, instance_exists=directory.exists(),
                        unit_exists=unit.exists(), systemd=state, events=self.events())
        if result.returncode == 0:
            self.assertFalse(unit.exists() or state['active'], evidence)
        else:
            self.assertTrue(directory.exists(), evidence)

    def test_marker_directory_failure_must_leave_a_retryable_instance(self):
        directory, unit = self.registered_instance()
        self.marker(directory / '.service', 'directory')
        first = self.run_ctl('remove', 'r')
        self.assertNotEqual(first.returncode, 0)
        self.assertTrue((directory / '.credentials').exists())
        self.assertNotIn(['configure', 'remove'], self.events())
        second = self.run_ctl('remove', 'r')
        self.assertTrue(unit.exists() or second.returncode == 0,
                        f'cleanup must retain trusted unit evidence or support retry; '
                        f'first={first.stdout}; retry={second.stdout}; '
                        f'unit_exists={unit.exists()}; events={self.events()}')

    def test_failed_reload_retry_must_finish_systemd_cleanup(self):
        directory, unit = self.registered_instance()
        self.fail_path.write_text('daemon-reload')
        first = self.run_ctl('remove', 'r')
        self.assertNotEqual(first.returncode, 0)
        self.assertIn('service reload failed', first.stdout)
        self.assertFalse(unit.exists())
        self.assertTrue((directory / '.credentials').exists())
        self.assertNotIn(['configure', 'remove'], self.events())
        second = self.run_ctl('remove', 'r')
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertFalse(directory.exists())
        self.assertFalse(json.loads(self.state_path.read_text())['loaded'],
                         f'retry reports success without retrying failed reload: {self.events()}')

    def test_missing_marker_discovery_does_not_select_an_unrelated_unit(self):
        directory, unit = self.registered_instance(unit_name='actions.runner.org.r.service')
        other = self.instance('other')
        unrelated = self.unit(other, 'actions.runner.org.other.service')
        (directory / '.service').unlink()
        result = self.run_ctl('remove', 'r')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(unit.exists())
        self.assertTrue(unrelated.exists())
        touched = [event[2] for event in self.events()
                   if event[:2] in (['systemctl', 'stop'], ['systemctl', 'disable'])]
        self.assertEqual(touched, [unit.name, unit.name])

    def test_duplicate_bindings_refuse_even_with_a_canonical_unit(self):
        directory, canonical = self.registered_instance()
        duplicate = self.unit(directory, 'actions.runner.org.r.service')
        for marker in ('valid', 'missing'):
            with self.subTest(marker=marker):
                self.marker(directory / '.service', marker, canonical.name)
                result = self.run_ctl('remove', 'r')
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertTrue(canonical.exists() and duplicate.exists())
                self.assertTrue((directory / '.credentials').exists())
                self.assertEqual(self.events(), [])

    def test_missing_marker_discovery_refuses_unsafe_units(self):
        directory, unit = self.registered_instance(unit_name='actions.runner.org.r.service')
        (directory / '.service').unlink()
        original = unit.read_text()
        for kind in ('symlink', 'writable', 'wrong-user', 'malformed', 'dropin'):
            with self.subTest(kind=kind):
                unit.unlink()
                unit.write_text(original)
                unit.chmod(0o644)
                if kind == 'symlink':
                    target = self.root / 'outside-unit'
                    target.write_text(original)
                    unit.unlink()
                    unit.symlink_to(target)
                elif kind == 'writable':
                    unit.chmod(0o666)
                elif kind == 'wrong-user':
                    unit.write_text(original.replace('User=runner', 'User=root'))
                elif kind == 'malformed':
                    unit.write_text('not a supported unit')
                else:
                    Path(str(unit) + '.d').mkdir()
                result = self.run_ctl('remove', 'r')
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertTrue((directory / '.credentials').exists())
                self.assertEqual(self.events(), [])

    def test_discovery_limit_refuses_without_side_effects(self):
        directory, unit = self.registered_instance(unit_name='actions.runner.org.r.service')
        (directory / '.service').unlink()
        for index in range(128):
            (unit.parent / f'actions.runner.extra{index}.service').touch()
        result = self.run_ctl('remove', 'r')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertTrue(unit.exists())
        self.assertTrue((directory / '.credentials').exists())
        self.assertEqual(self.events(), [])

    def test_directory_marker_refuses_before_stopping_and_recovers_after_repair(self):
        directory, unit = self.registered_instance()
        self.marker(directory / '.service', 'directory')
        for _ in range(2):
            result = self.run_ctl('remove', 'r')
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertTrue(unit.exists())
            self.assertTrue((directory / '.credentials').exists())
            self.assertEqual(self.events(), [])
        self.marker(directory / '.service', 'valid', unit.name)
        result = self.run_ctl('remove', 'r')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(directory.exists() or unit.exists())

    def test_noncanonical_reload_failure_retries_before_deregistration(self):
        directory, unit = self.registered_instance(unit_name='actions.runner.org.r.service')
        self.fail_path.write_text('daemon-reload')
        first = self.run_ctl('remove', 'r')
        self.assertNotEqual(first.returncode, 0, first.stdout)
        self.assertFalse(unit.exists())
        self.assertTrue((directory / '.credentials').exists())
        self.assertNotIn(['configure', 'remove'], self.events())
        second = self.run_ctl('remove', 'r')
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        events = self.events()
        self.assertEqual(events.count(['systemctl', 'daemon-reload']), 2)
        self.assertEqual(events[-2:], [['systemctl', 'daemon-reload'], ['configure', 'remove']])
        self.assertFalse(json.loads(self.state_path.read_text())['loaded'])


class BoundaryExperiments(IsolatedVm):
    def test_canonical_unit_survives_seven_marker_damage_variants(self):
        for index, kind in enumerate(('missing', 'empty', 'corrupt', 'oversized',
                                      'multiline', 'dangling-symlink', 'fifo')):
            with self.subTest(marker=kind):
                name = f'r{index}'
                directory, unit = self.registered_instance(name)
                self.marker(directory / '.service', kind, unit.name)
                listed = json.loads(self.run_ctl('list').stdout)['instances']
                self.assertEqual(next(row for row in listed if row['name'] == name)['unit'], unit.name)
                result = self.run_ctl('remove', name)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertFalse(directory.exists())
                self.assertFalse(unit.exists())

    def test_untrusted_marker_cannot_redirect_canonical_cleanup(self):
        directory, unit = self.registered_instance()
        self.marker(directory / '.service', 'symlink')
        result = self.run_ctl('remove', 'r')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / 'outside-marker').read_text(), 'outside data must survive')
        self.assertFalse(unit.exists())

    def test_corrupt_marker_with_noncanonical_unit_refuses_removal(self):
        directory, unit = self.registered_instance(unit_name='actions.runner.org.r.service')
        self.marker(directory / '.service', 'corrupt')
        result = self.run_ctl('remove', 'r')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(unit.exists())
        self.assertTrue((directory / '.credentials').exists())
        self.assertEqual(self.events(), [])

    def test_stop_disable_and_deregistration_failures_retain_then_recover(self):
        for index, phase in enumerate(('stop', 'disable', 'configure')):
            with self.subTest(phase=phase):
                name = f'r{index}'
                directory, unit = self.registered_instance(name)
                self.fail_path.write_text(phase)
                before = len(self.events())
                first = self.run_ctl('remove', name)
                self.assertNotEqual(first.returncode, 0, first.stdout)
                self.assertEqual((directory / '.credentials').read_text(), 'synthetic recoverable credentials')
                if phase != 'configure':
                    self.assertTrue(unit.exists())
                    self.assertNotIn(['configure', 'remove'], self.events()[before:])
                second = self.run_ctl('remove', name)
                self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
                self.assertFalse(directory.exists())
                self.assertFalse(unit.exists())

    def test_uncertain_registration_types_require_successful_deregistration(self):
        for name in ('.runner', '.credentials'):
            for kind in ('directory', 'fifo', 'dangling-symlink', 'empty'):
                with self.subTest(marker=name, kind=kind):
                    directory = self.instance()
                    self.configure_fixture(directory)
                    self.marker(directory / name, kind)
                    self.fail_path.write_text('configure')
                    first = self.run_ctl('remove', 'r')
                    self.assertNotEqual(first.returncode, 0)
                    self.assertTrue(os.path.lexists(directory / name))
                    second = self.run_ctl('remove', 'r')
                    self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
                    self.assertFalse(directory.exists())

    def test_unsafe_root_and_ancestor_symlink_fail_closed(self):
        outside = self.root / 'outside'
        outside.mkdir()
        self.runners.rmdir()
        self.runners.symlink_to(outside)
        self.assertIn('unsafe runners directory', self.run_ctl('list').stdout)
        self.runners.unlink()
        self.runners.mkdir(mode=0o777)
        self.runners.chmod(0o777)
        self.assertIn('unsafe runners directory', self.run_ctl('list').stdout)
        self.runners.chmod(0o755)
        parent_link = self.root / 'parent-link'
        parent_link.symlink_to(self.root, target_is_directory=True)
        self.ctl.write_text(self.ctl.read_text().replace(str(self.runners), str(parent_link / 'runners')))
        self.assertIn('unsafe runners directory', self.run_ctl('list').stdout)
        self.assertEqual(self.events(), [])

    def test_legacy_metadata_types_and_json_shapes_are_bounded(self):
        legacy = self.root / 'legacy'
        legacy.mkdir()
        config = legacy / 'config.sh'
        config.write_text('#!/bin/sh\nexit 0\n')
        config.chmod(0o755)
        for value in ([], None, 7, {'agentName': ['r']}, {'agentName': 'r\nother'},
                      {'agentName': '../escape'}, {'agentName': 'valid-name'}):
            with self.subTest(value=value):
                (legacy / '.runner').write_text(json.dumps(value))
                rows = json.loads(self.run_ctl('list').stdout)['instances']
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]['name'], 'valid-name' if value == {'agentName': 'valid-name'} else 'legacy')
        for kind in ('directory', 'fifo', 'dangling-symlink'):
            with self.subTest(kind=kind):
                self.marker(legacy / '.runner', kind)
                self.assertEqual(json.loads(self.run_ctl('list').stdout)['instances'][0]['name'], 'legacy')

    def test_wrapper_direct_validation_and_exact_argv(self):
        cases = [
            (['create', 'r', ','.join(['x' * 39] * 20), 'https://github.com/org/repo', 'a group'], True),
            (['create', 'r', '', 'https://github.com/o'], True),
            (['create', 'r', '', 'https://github.com/o', 'x' * 64], True),
            (['create', 'r', 'x' * 40, 'https://github.com/o'], False),
            (['create', 'r', ','.join(['x'] * 21), 'https://github.com/o'], False),
            (['create', 'r', '', 'https://github.com/o', 'x' * 65], False),
            (['create', 'r', '', 'https://github.com/o', 'a\tb'], False),
            (['create', 'r', '', 'https://github.com/o\n'], False),
            (['create', 'r', '', 'https://github.com/o/r/x'], False),
        ]
        for name, valid in [('r', True), ('a' * 63, True), ('a' * 64, False),
                            ('r..x', False), ('-r', False), ('r\nx', False),
                            ('r/other', False), ('r;id', False), ('r$(id)', False),
                            ('r\u00e9', False), ('r.', True)]:
            cases.append((['create', name, '', 'https://github.com/o'], valid))
        for argv, valid in cases:
            with self.subTest(argv=argv):
                wrapped = self.wrapper(argv)
                direct = self.run_ctl(*argv)
                self.assertEqual(wrapped.returncode, 0 if valid else 42, wrapped.stderr)
                if valid:
                    last = json.loads((self.root / 'calls').read_text().splitlines()[-1])
                    self.assertEqual(last[3:], argv)
                    self.assertIn('no trusted runner distribution', direct.stdout)
                else:
                    self.assertIn('invalid ', direct.stdout)
        self.assertEqual(self.events(), [])


if __name__ == '__main__':
    unittest.main()
