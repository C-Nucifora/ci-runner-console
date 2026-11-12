"""Independent deployment review; strict PATH fakes, no remote execution.

Run serially under heavy.lock with the designated TMPDIR. Reuse only the
existing deployment fixture, never its live-check test class.
"""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'deployment_fixture', Path(__file__).with_name('round3-deployment-boundaries.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
REMOTE = fixture.REMOTE_STAGE


class DeploymentReview(unittest.TestCase):
    deploy = fixture.DeploymentBoundaries.deploy
    safe = fixture.DeploymentBoundaries.safe
    remote_commands = fixture.DeploymentBoundaries.remote_commands

    def setUp(self):
        fixture.DeploymentBoundaries.setUp(self)
        fake = fixture.FAKE.replace(
            "mode = os.environ['MODE']",
            "mode, _, cleanup = os.environ['MODE'].partition('+')")
        fake = fake.replace(
            "    sys.stdout.buffer.write(b'synthetic archive')",
            "    sys.stdout.buffer.write(b'synthetic archive')\n    sys.exit(76 if mode == 'tar-failure' else 0)")
        fake = fake.replace(
            '    elif command == "rm -rf -- \'" + remote + "\'":\n        pass',
            '    elif command == "rm -rf -- \'" + remote + "\'":\n        sys.exit(75 if cleanup == "cleanup-failure" else 0)')
        self.assertIn('sys.exit(75', fake)
        self.assertIn('sys.exit(76', fake)
        for executable in self.bin.iterdir():
            executable.write_text(f'#!{fixture.sys.executable}\n' + fake)

    def test_cleanup_allowlist_rejects_near_matches_even_on_allocation_failure(self):
        replies = ['', '/tmp/crc-stage.ABCDE1234', '/tmp/crc-stage.ABCDE123456',
                   REMOTE + '/', REMOTE + '\r', ' ' + REMOTE, REMOTE + '\nextra',
                   '/tmp/crc-stage.ABCDE1234_', REMOTE + "'; echo synthetic; #",
                   '/tmp/crc-stage.ABCDE1234é', REMOTE + '$(echo synthetic)']
        for mode in ('normal', 'allocation-failure'):
            for reply in replies:
                with self.subTest(mode=mode, reply=repr(reply)):
                    result, calls = self.deploy(mode, 'fixture.invalid', reply=reply)
                    self.safe(result)
                    self.assertEqual(result.returncode, 72 if mode == 'allocation-failure' else 1)
                    self.assertEqual(self.remote_commands(calls), [fixture.PREFLIGHT, fixture.ALLOCATE])
                    self.assertFalse((self.root / 'stage').exists())

    def test_failed_allocation_with_valid_stdout_cleans_stage_without_upload(self):
        for mode in ('allocation-failure', 'allocation-failure+cleanup-failure'):
            with self.subTest(mode=mode):
                result, calls = self.deploy(mode, 'fixture.invalid')
                self.safe(result)
                self.assertEqual(result.returncode, 72)
                self.assertEqual(self.remote_commands(calls), [fixture.PREFLIGHT, fixture.ALLOCATE,
                                                              f"rm -rf -- '{REMOTE}'"])
                self.assertFalse((self.root / 'stage').exists())

    def test_pipeline_failure_stops_installation_and_preserves_exit_status(self):
        for mode, status in [('tar-failure', 76), ('upload-failure', 73)]:
            for suffix in ('', '+cleanup-failure'):
                with self.subTest(mode=mode + suffix):
                    result, calls = self.deploy(mode + suffix, 'fixture.invalid')
                    self.safe(result)
                    self.assertEqual(result.returncode, status)
                    self.assertEqual(self.remote_commands(calls), [fixture.PREFLIGHT, fixture.ALLOCATE,
                        f"tar -C '{REMOTE}' -xzf -", f"rm -rf -- '{REMOTE}'"])
                    self.assertFalse((self.root / 'stage').exists())

    def test_cleanup_failure_does_not_replace_install_result(self):
        for mode, status in [('normal', 0), ('install-failure', 74)]:
            with self.subTest(mode=mode):
                result, calls = self.deploy(mode + '+cleanup-failure', 'fixture.invalid')
                self.safe(result)
                self.assertEqual(result.returncode, status)
                self.assertEqual(self.remote_commands(calls), [fixture.PREFLIGHT, fixture.ALLOCATE,
                    f"tar -C '{REMOTE}' -xzf -", f"sudo bash -s -- '{REMOTE}'", f"rm -rf -- '{REMOTE}'"])
                self.assertFalse((self.root / 'stage').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
