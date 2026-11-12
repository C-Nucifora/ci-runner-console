"""Bounded VM regressions using temporary controller copies and strict fakes."""
import base64
import json
import os
from pathlib import Path
import runpy
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
Fixture = runpy.run_path(str(ROOT / 'test/round1-vm-boundaries.py'))['IsolatedVm']


class RoundFourBoundaries(Fixture):
    def test_raw_wrapper_frames_refuse_without_dispatch_and_clean_private_temps(self):
        staging = self.root / 'wrapper-temporary'
        staging.mkdir()
        self.env['TMPDIR'] = str(staging)
        malformed = [b'null', b'{}', b'false', b'"list"', b'[]', b'["list",{}]',
                     b'["list"]\x00', b'["list"][]', b'["list", "\\ud800"]',
                     b'["list"', b'\xff["list"]', b'["list",null]',
                     b'["start","r\\u0000suffix"]', b'["start","r\\nsuffix"]']
        encoded = [base64.b64encode(raw).decode() for raw in malformed]
        encoded += ['', 'A', '!!!!', 'A' * 4097, base64.b64encode(b'["list"]').decode() + '\n']
        for frame in encoded:
            with self.subTest(frame=repr(frame[:80])):
                result = subprocess.run(['bash', str(ROOT / 'vm/ci-runner-ctl-ssh')],
                    env=dict(self.env, SSH_ORIGINAL_COMMAND=frame), input='synthetic_token_123\n',
                    text=True, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 42, result.stdout + result.stderr)
                self.assertFalse((self.root / 'calls').exists())
                self.assertEqual(list(staging.iterdir()), [])
        result = self.wrapper(['logs', 'r', '0001'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.root / 'calls').read_text().splitlines()[-1])[3:], ['logs', 'r', '0001'])
        self.assertEqual(list(staging.iterdir()), [])

    def test_configuration_permission_damage_refuses_before_sourcing_then_recovers(self):
        config = self.root / 'absent.conf'
        marker = self.root / 'sourced'
        config.write_text(f'printf synthetic > "{marker}"\nMAX_RUNNERS=2\n')
        for mode in (0o620, 0o602, 0o660, 0o646):
            with self.subTest(mode=oct(mode)):
                config.chmod(mode)
                result = self.run_ctl('headroom')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('unsafe controller configuration', result.stdout)
                self.assertFalse(marker.exists())
                self.assertFalse((self.root / 'calls').exists())
        config.chmod(0o600)
        result = self.run_ctl('headroom')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout)['cap'], 2)
        self.assertEqual(marker.read_text(), 'synthetic')

    def test_hardlinked_marker_cleanup_preserves_alias_and_credentials_on_reload_failure(self):
        directory, unit = self.registered_instance()
        alias = self.root / 'unrelated-marker-alias'
        os.link(directory / '.service', alias)
        self.fail_path.write_text('daemon-reload')
        result = self.run_ctl('remove', 'r')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(alias.read_text(), unit.name)
        self.assertEqual((directory / '.credentials').read_text(), 'synthetic recoverable credentials')
        self.assertFalse(unit.exists())
        self.assertFalse((directory / '.service').exists())
        result = self.run_ctl('remove', 'r')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertFalse(directory.exists())
        self.assertEqual(alias.read_text(), unit.name, 'cleanup must unlink the marker, not truncate its inode')

    def test_direct_logs_count_is_literal_at_zero_and_leading_zero_boundaries(self):
        directory, unit = self.registered_instance()
        for count in ('0', '0000', '0001', '9999'):
            with self.subTest(count=count):
                result = self.run_ctl('logs', 'r', count)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                call = json.loads((self.root / 'calls').read_text().splitlines()[-1])
                self.assertEqual(call[1:], ['-u', unit.name, '-n', count, '--no-pager', '-o', 'short-iso'])
        before = (self.root / 'calls').read_bytes()
        for count in ('-1', '+1', '10000', ' 1', '1\n', '1e3', '١'):
            with self.subTest(count=repr(count)):
                self.assertNotEqual(self.run_ctl('logs', 'r', count).returncode, 0)
                self.assertEqual((self.root / 'calls').read_bytes(), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
