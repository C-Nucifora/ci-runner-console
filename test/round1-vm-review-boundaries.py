"""Independent round-one review. Temporary controller copies and fakes only."""
import json
import os
from pathlib import Path
import runpy
import unittest

ROOT = Path(__file__).resolve().parents[1]
Fixture = runpy.run_path(str(ROOT / 'test/round1-vm-boundaries.py'))['IsolatedVm']


class ReviewBoundaries(Fixture):
    def retained(self, directory, unit):
        self.assertTrue(unit.exists())
        self.assertEqual((directory / '.credentials').read_text(),
                         'synthetic recoverable credentials')

    def test_two_noncanonical_bindings_refuse_then_recover_without_marker(self):
        directory, unit = self.registered_instance(unit_name='actions.runner.first.service')
        (directory / '.service').unlink()
        duplicate = self.unit(directory, 'actions.runner.second.service')
        result = self.run_ctl('remove', 'r')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.retained(directory, unit)
        self.assertEqual(self.events(), [])
        duplicate.unlink()
        result = self.run_ctl('remove', 'r')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertFalse(directory.exists() or unit.exists())

    def test_verified_unrelated_unit_with_different_user_is_not_touched(self):
        directory, unit = self.registered_instance(unit_name='actions.runner.first.service')
        (directory / '.service').unlink()
        other = self.unit(self.root / 'other', 'actions.runner.unrelated.service')
        other.write_text(other.read_text().replace('User=runner', 'User=another'))
        Path(str(other) + '.d').mkdir()
        result = self.run_ctl('remove', 'r')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(other.exists())
        self.assertFalse(any(other.name in event for event in self.events()))

    def test_unreadable_candidate_types_refuse_then_recover(self):
        for kind in ('fifo', 'dangling-link', 'bad-utf8', 'oversized'):
            with self.subTest(kind=kind):
                directory, unit = self.registered_instance(unit_name='actions.runner.first.service')
                (directory / '.service').unlink()
                other = unit.parent / 'actions.runner.uncertain.service'
                if kind == 'fifo':
                    os.mkfifo(other)
                elif kind == 'dangling-link':
                    other.symlink_to(self.root / 'absent')
                else:
                    other.write_bytes(b'\xff' if kind == 'bad-utf8' else b'x' * 65537)
                before = self.events()
                result = self.run_ctl('remove', 'r')
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.retained(directory, unit)
                self.assertEqual(self.events(), before)
                other.unlink()
                result = self.run_ctl('remove', 'r')
                self.assertEqual(result.returncode, 0, result.stdout)

    def test_exact_candidate_limit_preserves_directory_and_recovers(self):
        directory, unit = self.registered_instance(unit_name='actions.runner.first.service')
        (directory / '.service').unlink()
        for index in range(127):
            self.unit(self.root / 'other', f'actions.runner.other{index}.service')
        listed = json.loads(self.run_ctl('list').stdout)['instances']
        self.assertEqual(listed[0]['unit'], unit.name)
        extra = self.unit(self.root / 'other', 'actions.runner.overflow.service')
        before = self.events()
        result = self.run_ctl('remove', 'r')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.retained(directory, unit)
        self.assertEqual(self.events(), before)
        self.assertNotEqual(self.run_ctl('list').returncode, 0)
        self.assertEqual(json.loads(self.run_ctl('headroom').stdout)['instances'], 1)
        extra.unlink()
        result = self.run_ctl('remove', 'r')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(len(list(unit.parent.glob('*.service'))), 127)

    def test_marker_and_unit_unlink_failures_keep_retry_evidence(self):
        for phase in ('marker', 'unit'):
            with self.subTest(phase=phase):
                directory, unit = self.registered_instance(unit_name='actions.runner.first.service')
                marker = directory / '.service'
                self.env['UNLINK_TARGET'] = str(marker if phase == 'marker' else unit)
                self.fail_path.write_text('unlink')
                self.fake('rm', '''#!/usr/bin/python3
import os, pathlib, sys
failure = pathlib.Path(os.environ['FAIL_ONCE'])
if sys.argv[-1] == os.environ['UNLINK_TARGET'] and failure.exists():
    failure.unlink()
    sys.exit(1)
os.execv('/bin/rm', ['rm', *sys.argv[1:]])
''')
                before = len(self.events())
                result = self.run_ctl('remove', 'r')
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.retained(directory, unit)
                self.assertEqual(marker.exists(), phase == 'marker')
                self.assertEqual(self.events()[before:], [
                    ['systemctl', 'stop', unit.name], ['systemctl', 'disable', unit.name]])
                result = self.run_ctl('remove', 'r')
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertFalse(directory.exists() or unit.exists())

    def test_repeated_reload_then_configure_failure_recovers(self):
        directory, unit = self.registered_instance(unit_name='actions.runner.first.service')
        (directory / '.service').unlink()
        for phase in ('daemon-reload', 'daemon-reload', 'configure'):
            self.fail_path.write_text(phase)
            result = self.run_ctl('remove', 'r')
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertFalse(unit.exists())
            self.assertTrue((directory / '.credentials').exists())
            self.assertEqual(len(json.loads(self.run_ctl('list').stdout)['instances']), 1)
        result = self.run_ctl('remove', 'r')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.events().count(['systemctl', 'daemon-reload']), 4)
        self.assertEqual(self.events().count(['configure', 'remove']), 2)
        self.assertFalse(directory.exists())

    def test_noncanonical_marker_directory_preflight_preserves_active_service(self):
        directory, unit = self.registered_instance(unit_name='actions.runner.first.service')
        self.marker(directory / '.service', 'directory')
        result = self.run_ctl('remove', 'r')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.retained(directory, unit)
        self.assertEqual(self.events(), [])
        self.assertTrue(json.loads(self.state_path.read_text())['active'])
        self.marker(directory / '.service', 'missing')
        result = self.run_ctl('remove', 'r')
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_bad_token_preflight_does_not_stop_service(self):
        directory, unit = self.registered_instance(unit_name='actions.runner.first.service')
        (directory / '.service').unlink()
        result = self.run_ctl('remove', 'r', token='bad')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.retained(directory, unit)
        self.assertEqual(self.events(), [])

    def test_ambiguity_must_not_be_reported_as_confirmed_absence(self):
        directory, unit = self.registered_instance()
        self.unit(directory, 'actions.runner.second.service')
        result = self.run_ctl('list')
        if result.returncode != 0:
            return  # Failing inventory closed is also safe.
        row = json.loads(result.stdout)['instances'][0]
        self.assertFalse(row['unit'] is None and row['serviceInstalled'] is False,
                         f'two installed units become authoritative no-service state: {row}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
