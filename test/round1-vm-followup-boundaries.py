"""Fresh follow-up review. Only temporary controller copies and fake commands run."""
import json
import runpy
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
Fixture = runpy.run_path(str(ROOT / 'test/round1-vm-boundaries.py'))['IsolatedVm']


class FollowupBoundaries(Fixture):
    def retained(self, directory):
        self.assertEqual((directory / '.credentials').read_text(),
                         'synthetic recoverable credentials')

    def test_late_ambiguous_instance_does_not_publish_an_earlier_valid_row(self):
        first, first_unit = self.registered_instance('a')
        second, second_unit = self.registered_instance('z')
        duplicate = self.unit(second, 'actions.runner.duplicate.service')
        result = self.run_ctl('list')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout), {
            'ok': False,
            'error': 'service discovery uncertain; inspect runner units before retrying',
        })
        self.assertEqual(self.events(), [])
        self.assertEqual(json.loads(self.run_ctl('headroom').stdout)['instances'], 2)
        self.retained(first)
        self.retained(second)
        duplicate.unlink()
        recovered = self.run_ctl('list')
        self.assertEqual(recovered.returncode, 0, recovered.stdout)
        self.assertEqual([row['unit'] for row in json.loads(recovered.stdout)['instances']],
                         [first_unit.name, second_unit.name])

    def test_query_failure_keeps_the_installed_unit_and_recovers_on_refresh(self):
        directory, unit = self.registered_instance()
        self.fail_path.write_text('is-active')
        result = self.run_ctl('list')
        self.assertEqual(result.returncode, 0, result.stdout)
        row = json.loads(result.stdout)['instances'][0]
        self.assertEqual(row['unit'], unit.name)
        self.assertTrue(row['serviceInstalled'])
        self.assertIsNone(row['active'])
        self.assertTrue(row['registered'])
        self.retained(directory)
        self.assertEqual(json.loads(self.run_ctl('list').stdout)['instances'][0]['active'], 'active')
        self.assertTrue(all(event[1] in ('is-active', 'is-enabled', 'show') for event in self.events()))

    def test_stale_marker_is_uncertainty_until_repaired_then_configure_can_retry(self):
        directory, unit = self.registered_instance()
        unit.unlink()
        for operation in [('list',), ('remove', 'r')]:
            result = self.run_ctl(*operation)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.retained(directory)
        self.assertEqual(self.events(), [])
        self.assertEqual(json.loads(self.run_ctl('headroom').stdout)['instances'], 1)
        (directory / '.service').unlink()
        row = json.loads(self.run_ctl('list').stdout)['instances'][0]
        self.assertIsNone(row['unit'])
        self.assertFalse(row['serviceInstalled'])
        self.assertTrue(row['registered'])
        self.fail_path.write_text('configure')
        result = self.run_ctl('remove', 'r')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.retained(directory)
        self.assertEqual(json.loads(self.run_ctl('headroom').stdout)['instances'], 1)
        result = self.run_ctl('remove', 'r')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertFalse(directory.exists())
        self.assertEqual(self.events(), [
            ['systemctl', 'daemon-reload'], ['configure', 'remove'],
            ['systemctl', 'daemon-reload'], ['configure', 'remove'],
        ])

    def test_reload_retry_waits_for_new_discovery_error_to_be_repaired(self):
        directory, unit = self.registered_instance()
        self.fail_path.write_text('daemon-reload')
        self.assertNotEqual(self.run_ctl('remove', 'r').returncode, 0)
        self.assertFalse(unit.exists())
        uncertain = unit.parent / 'actions.runner.new.service'
        uncertain.write_text('synthetic unsupported unit')
        before = self.events()
        for operation in [('list',), ('remove', 'r')]:
            result = self.run_ctl(*operation)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.retained(directory)
        self.assertEqual(self.events(), before)
        self.assertEqual(json.loads(self.run_ctl('headroom').stdout)['instances'], 1)
        uncertain.unlink()
        result = self.run_ctl('remove', 'r')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.events()[-2:], [['systemctl', 'daemon-reload'], ['configure', 'remove']])
        self.assertEqual(self.events().count(['systemctl', 'daemon-reload']), 2)
        self.assertFalse(directory.exists())

    def test_missing_unit_directory_and_unreadable_unit_directory_are_distinct(self):
        directory = self.instance()
        row = json.loads(self.run_ctl('list').stdout)['instances'][0]
        self.assertIsNone(row['unit'])
        units = self.root / 'units'
        units.write_text('synthetic non-directory at discovery path')
        result = self.run_ctl('list')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout)['ok'], False)
        result = self.run_ctl('remove', 'r')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertTrue(directory.exists())
        self.assertEqual(json.loads(self.run_ctl('headroom').stdout)['instances'], 1)
        self.assertEqual(self.events(), [])
        units.unlink()
        self.assertEqual(self.run_ctl('remove', 'r').returncode, 0)
        self.assertFalse(directory.exists())

    def test_status_does_not_turn_ambiguous_discovery_into_confirmed_absence(self):
        directory, unit = self.registered_instance()
        self.unit(directory, 'actions.runner.duplicate.service')
        result = self.run_ctl('status', 'r')
        self.retained(directory)
        self.assertTrue(unit.exists())
        self.assertEqual(self.events(), [])
        self.assertNotEqual(result.returncode, 0,
                            f'ambiguous bindings reported as successful status: {result.stdout}')

    def test_directory_resolution_error_cannot_publish_partial_inventory_or_free_capacity(self):
        first, _ = self.registered_instance('a')
        second, _ = self.registered_instance('z')
        self.env['UNRESOLVED_DIRECTORY'] = str(second)
        self.fake('realpath', '''#!/usr/bin/python3
import os, sys
if sys.argv[-1] == os.environ['UNRESOLVED_DIRECTORY']:
    print('synthetic path resolution I/O failure', file=sys.stderr)
    sys.exit(1)
os.execv('/usr/bin/realpath', ['realpath', *sys.argv[1:]])
''')
        result = self.run_ctl('list')
        capacity = json.loads(self.run_ctl('headroom').stdout)
        self.retained(first)
        self.retained(second)
        with self.subTest(contract='inventory'):
            self.assertNotEqual(result.returncode, 0,
                                f'resolution failure publishes partial inventory: {result.stdout}')
        with self.subTest(contract='capacity'):
            self.assertEqual(capacity['instances'], 2,
                             f'existing unresolved directory frees capacity: {capacity}')
        result = self.run_ctl('create', 'third', '', 'https://github.com/synthetic')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('instance discovery uncertain', result.stdout)
        self.assertFalse((self.runners / 'third').exists())
        self.ctl.write_text(self.ctl.read_text().replace('MAX_RUNNERS=3', 'MAX_RUNNERS=2'))
        result = self.run_ctl('create', 'third', '', 'https://github.com/synthetic')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('runner cap reached (2/2)', result.stdout)
        self.assertEqual(self.events(), [])
        self.retained(first)
        self.retained(second)



if __name__ == '__main__':
    unittest.main(verbosity=2)
