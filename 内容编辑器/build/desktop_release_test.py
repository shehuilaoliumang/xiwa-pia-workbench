"""EXE release-cache upgrade logic only; does not build or launch an EXE."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

FAN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(FAN))
import fan_entry


class ReleaseCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='fan-release-check-')
        self.root = Path(self.temporary.name).resolve()
        self.bundle = self.root / 'bundle'
        self.target = self.root / 'installed'
        self.bundle.mkdir()
        self.target.mkdir()
        (self.bundle / 'main.cjs').write_text('new shell', encoding='utf-8')
        (self.bundle / 'package.json').write_text('{"version":"0.2.1"}', encoding='utf-8')
        self.runtime(self.bundle / 'runtime', b'new-runtime', '41')
        workspace = self.target / 'fan-data' / 'workspaces' / 'kept'
        workspace.mkdir(parents=True)
        (workspace / 'script.json').write_text('keep this', encoding='utf-8')

    def tearDown(self):
        assert self.root.parent == Path(tempfile.gettempdir()).resolve()
        assert self.root.name.startswith('fan-release-check-')
        self.temporary.cleanup()

    def runtime(self, directory, content, version):
        for name in fan_entry.DESKTOP_REQUIRED:
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(version.encode() if name == 'version' else content)

    def release(self):
        with patch.object(fan_entry, 'FROZEN', True), patch.object(fan_entry, 'bundled_desktop_dir', return_value=self.bundle):
            result = fan_entry.ensure_desktop(self.target)
        self.assertEqual((self.target / 'fan-data/workspaces/kept/script.json').read_text(), 'keep this')
        self.assertEqual((result / 'main.cjs').read_text(), 'new shell')
        return result

    def test_old_shell_updates_without_recopying_same_runtime(self):
        self.runtime(self.target / 'desktop/runtime', b'already-released', '41')
        (self.target / 'desktop/main.cjs').write_text('old shell', encoding='utf-8')
        result = self.release()
        self.assertEqual((result / 'runtime/electron.exe').read_bytes(), b'already-released')
        self.assertEqual((result / 'package.json').read_text(), '{"version":"0.2.1"}')

    def test_partial_or_new_version_runtime_is_repaired_without_deleting_workspaces(self):
        self.runtime(self.target / 'desktop/runtime', b'old runtime', '40')
        (self.target / 'desktop/runtime/v8_context_snapshot.bin').unlink()
        result = self.release()
        self.assertEqual((result / 'runtime/electron.exe').read_bytes(), b'new-runtime')
        self.assertTrue(fan_entry._runtime_complete(result / 'runtime'))

    def test_incomplete_frozen_bundle_is_rejected_before_copy(self):
        (self.bundle / 'runtime/snapshot_blob.bin').unlink()
        with patch.object(fan_entry, 'FROZEN', True), patch.object(fan_entry, 'bundled_desktop_dir', return_value=self.bundle):
            with self.assertRaisesRegex(SystemExit, '不完整'):
                fan_entry.ensure_desktop(self.target)
        self.assertFalse((self.target / 'desktop').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
