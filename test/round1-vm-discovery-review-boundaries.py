"""Independent R1-V05/V06 review using temporary controllers and bounded fakes."""
import json
from pathlib import Path
import runpy
import unittest

ROOT = Path(__file__).resolve().parents[1]
Fixture = runpy.run_path(str(ROOT / 'test/round1-vm-boundaries.py'))['IsolatedVm']


class DiscoveryReviewBoundaries(Fixture):
    def resolution_failure(self, directory, redirected=None):
        self.env['FAILED_PATH'] = str(directory)
        self.env['REDIRECTED_PATH'] = str(redirected) if redirected else ''
        self.fake('realpath', '''#!/usr/bin/python3
import os, sys
if sys.argv[-1] == os.environ['FAILED_PATH']:
    if os.environ['REDIRECTED_PATH']:
        print(os.environ['REDIRECTED_PATH'])
        sys.exit(0)
    print('synthetic path inspection failure', file=sys.stderr)
    sys.exit(1)
os.execv('/usr/bin/realpath', ['realpath', *sys.argv[1:]])
''')

    def refused(self, *args):
        result = self.run_ctl(*args)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        reply = json.loads(result.stdout)
        self.assertFalse(reply['ok'], reply)
        self.assertNotIn('instances', reply)
        return reply

    def retained(self, *instances):
        for directory, unit in instances:
            self.assertTrue(unit.exists())
            self.assertEqual((directory / '.credentials').read_text(),
                             'synthetic recoverable credentials')

    def test_early_and_late_path_failures_block_every_lookup_caller(self):
        first = self.registered_instance('a')
        last = self.registered_instance('z')
        for failed in (first[0], last[0]):
            with self.subTest(failed=failed.name):
                self.resolution_failure(failed)
                for args in [('list',), ('status', 'a'), ('status', 'z'),
                             ('status', 'missing'), ('logs', 'a'), ('start', 'a'),
                             ('stop', 'a'), ('restart', 'a'), ('remove', 'a')]:
                    with self.subTest(operation=args):
                        self.refused(*args)
                self.assertIn('instance discovery uncertain', self.refused(
                    'create', 'third', '', 'https://github.com/synthetic')['error'])
                self.assertFalse((self.runners / 'third').exists())
                self.assertEqual(json.loads(self.run_ctl('headroom').stdout)['instances'], 2)
                self.retained(first, last)
                self.assertEqual(self.events(), [])
                self.assertFalse((self.root / 'calls').exists())
        (self.bin / 'realpath').unlink()
        result = self.run_ctl('list')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual([row['name'] for row in json.loads(result.stdout)['instances']], ['a', 'z'])
        self.assertIn('already exists', self.refused(
            'create', 'a', '', 'https://github.com/synthetic')['error'])
        self.assertIn('no trusted runner distribution', self.refused(
            'create', 'third', '', 'https://github.com/synthetic')['error'])

    def test_resolved_path_outside_instance_is_counted_but_never_used(self):
        instance = self.registered_instance()
        outside = self.root / 'outside'
        outside.mkdir()
        sentinel = outside / 'keep'
        sentinel.write_text('outside data')
        self.resolution_failure(instance[0], redirected=outside)
        for args in [('list',), ('status', 'r'), ('remove', 'r'), ('start', 'r')]:
            self.refused(*args)
        capacity = json.loads(self.run_ctl('headroom').stdout)
        self.assertEqual((capacity['instances'], capacity['remaining']), (1, 2))
        self.assertEqual(sentinel.read_text(), 'outside data')
        self.retained(instance)
        self.assertEqual(self.events(), [])

    def test_count_includes_invalid_named_directories_and_excludes_symlinks(self):
        self.instance('a')
        (self.runners / 'bad name').mkdir()
        (self.runners / 'bad..name').mkdir()
        outside = self.root / 'outside'
        outside.mkdir()
        (self.runners / 'linked').symlink_to(outside, target_is_directory=True)
        (self.runners / 'dangling').symlink_to(self.root / 'absent')
        (self.runners / 'file').write_text('not a directory')
        # Record discovery calls even if a shell caller suppresses their failure.
        self.env['UNEXPECTED_DISCOVERY'] = str(self.root / 'unexpected-discovery')
        self.fake('python3', '''#!/usr/bin/python3
import os, pathlib, sys
if len(sys.argv) == 5 and sys.argv[1] == '-' and sys.argv[-1] == 'runner':
    pathlib.Path(os.environ['UNEXPECTED_DISCOVERY']).touch()
    sys.exit(97)
os.execv('/usr/bin/python3', ['python3', *sys.argv[1:]])
''')
        self.resolution_failure(self.runners / 'a')
        capacity = self.run_ctl('headroom')
        self.assertEqual(capacity.returncode, 0, capacity.stdout)
        reply = json.loads(capacity.stdout)
        self.assertEqual((reply['instances'], reply['remaining']), (3, 0))
        self.assertIn('runner cap reached (3/3)', self.refused(
            'create', 'third', '', 'https://github.com/synthetic')['error'])
        self.ctl.write_text(self.ctl.read_text().replace('MAX_RUNNERS=3', 'MAX_RUNNERS=2'))
        reply = json.loads(self.run_ctl('headroom').stdout)
        self.assertEqual((reply['instances'], reply['remaining']), (3, 0))
        self.assertIn('runner cap reached (3/2)', self.refused(
            'create', 'third', '', 'https://github.com/synthetic')['error'])
        self.assertFalse((self.root / 'unexpected-discovery').exists())
        self.assertEqual(self.events(), [])
        self.assertEqual(list(outside.iterdir()), [])

    def test_legacy_path_failure_keeps_capacity_and_blocks_partial_inventory(self):
        legacy = self.root / 'legacy'
        legacy.mkdir()
        config = legacy / 'config.sh'
        config.write_text('#!/bin/sh\nexit 0\n')
        config.chmod(0o755)
        (legacy / '.runner').write_text('{"agentName":"old"}')
        instance = self.registered_instance()
        self.resolution_failure(legacy)
        self.refused('list')
        self.refused('status', 'r')
        self.assertEqual(json.loads(self.run_ctl('headroom').stdout)['instances'], 2)
        self.assertIn('instance discovery uncertain', self.refused(
            'create', 'third', '', 'https://github.com/synthetic')['error'])
        self.retained(instance)
        self.assertEqual(self.events(), [])

    def test_status_distinguishes_absence_stale_hint_and_inactive_unit(self):
        directory = self.instance()
        result = self.run_ctl('status', 'r')
        self.assertEqual(result.returncode, 0, result.stdout)
        reply = json.loads(result.stdout)
        self.assertIsNone(reply['unit'])
        self.assertIsNone(reply['active'])
        self.assertIsNone(reply['enabled'])
        self.assertEqual(self.events(), [])
        (directory / '.service').write_text('actions.runner.missing.service')
        (self.root / 'units').mkdir()
        self.assertIn('service discovery uncertain', self.refused('status', 'r')['error'])
        self.assertEqual(self.events(), [])
        (directory / '.service').unlink()
        unit = self.unit(directory)
        self.state_path.write_text(json.dumps({'active': False, 'enabled': False, 'loaded': True}))
        result = self.run_ctl('status', 'r')
        self.assertEqual(result.returncode, 0, result.stdout)
        reply = json.loads(result.stdout)
        self.assertEqual((reply['unit'], reply['active'], reply['enabled']),
                         (unit.name, 'inactive', 'disabled'))

    def test_status_propagates_failure_on_second_unit_inspection(self):
        instance = self.registered_instance()
        self.fake('python3', '''#!/usr/bin/python3
import os, pathlib, sys
if len(sys.argv) == 5 and sys.argv[1] == '-' and sys.argv[-1] == 'runner':
    counter = pathlib.Path(os.environ['DISCOVERY_COUNTER'])
    count = int(counter.read_text()) + 1 if counter.exists() else 1
    counter.write_text(str(count))
    if count == 2:
        sys.exit(int(os.environ['DISCOVERY_EXIT']))
os.execv('/usr/bin/python3', ['python3', *sys.argv[1:]])
''')
        counter = self.root / 'discovery-count'
        self.env['DISCOVERY_COUNTER'] = str(counter)
        for code in (2, 7, 124):
            with self.subTest(exit_code=code):
                counter.unlink(missing_ok=True)
                self.env['DISCOVERY_EXIT'] = str(code)
                self.assertIn('service discovery uncertain', self.refused('status', 'r')['error'])
                self.assertEqual(counter.read_text(), '2')
                self.assertEqual(self.events(), [])
                self.retained(instance)

    def test_unrelated_service_ambiguity_does_not_block_verified_target(self):
        target = self.registered_instance('a')
        other = self.registered_instance('z')
        duplicate = self.unit(other[0], 'actions.runner.duplicate.service')
        self.refused('list')
        self.refused('status', 'z')
        self.assertEqual(self.events(), [])
        result = self.run_ctl('start', 'a')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.events(), [
            ['systemctl', 'start', target[1].name],
            ['systemctl', 'enable', target[1].name],
            ['systemctl', 'is-active', target[1].name],
        ])
        self.retained(target, other)
        self.assertTrue(duplicate.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
