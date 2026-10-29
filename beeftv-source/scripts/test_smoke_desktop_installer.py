import errno
import importlib.util
from pathlib import Path
import sys
import urllib.error
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('installer_smoke', Path(__file__).with_name('smoke-desktop-installer.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class WebViewCloseTests(unittest.TestCase):
    def test_timeout_keeps_waiting_until_connection_is_refused(self):
        process = MagicMock(spec=['webview_port', 'pid', 'poll', 'terminate', 'kill', 'wait'])
        process.webview_port = 12345
        opener = MagicMock()
        opener.open.side_effect = [urllib.error.URLError(TimeoutError('slow endpoint')),
                                   urllib.error.URLError(ConnectionRefusedError(errno.ECONNREFUSED, 'closed'))]
        with patch.object(smoke.urllib.request, 'build_opener', return_value=opener), patch.object(smoke.time, 'sleep'):
            smoke.stop(process)
        self.assertEqual(opener.open.call_count, 2)

    def test_only_timeouts_fail_instead_of_crediting_an_old_webview(self):
        process = MagicMock(spec=['webview_port', 'pid', 'poll', 'terminate', 'kill', 'wait'])
        process.webview_port = 12345
        opener = MagicMock()
        opener.open.side_effect = urllib.error.URLError(TimeoutError('still listening'))
        with patch.object(smoke.urllib.request, 'build_opener', return_value=opener), patch.object(smoke.time, 'sleep'), patch.object(smoke.time, 'monotonic', side_effect=[0, 1, 31]):
            with self.assertRaisesRegex(RuntimeError, 'Old WebView remained running'):
                smoke.stop(process)


class WindowsInstallerContractTests(unittest.TestCase):
    def test_windows_nsi_uses_utf8_bom_and_streamlined_direct_install(self):
        nsi_path = Path(__file__).resolve().parent / 'installers/windows.nsi'
        raw = nsi_path.read_bytes()
        self.assertTrue(raw.startswith(b'\xef\xbb\xbf'), 'windows.nsi must start with a UTF-8 BOM')
        text = raw.decode('utf-8-sig')
        self.assertNotIn('MUI_PAGE_WELCOME', text)
        self.assertNotIn('MUI_PAGE_COMPONENTS', text)
        self.assertNotIn('StageDir', text)
        self.assertIn('!define MUI_FINISHPAGE_RUN "$INSTDIR\\BeefTV.exe"', text)
        self.assertIn('CreateShortcut "$DESKTOP\\BeefTV.lnk" "$INSTDIR\\BeefTV.exe"', text)
        self.assertIn('taskkill.exe', text)
        self.assertIn('Windows 无法移动以下程序文件夹', text)

    def test_packager_compiles_windows_installer_as_utf8_without_warnings(self):
        import os
        import shutil
        import subprocess
        import tempfile
        packager_path = Path(__file__).with_name('package-desktop-installer.py')
        packager_text = packager_path.read_text(encoding='utf-8')
        self.assertIn("'-INPUTCHARSET', 'UTF8'", packager_text)
        if not shutil.which('makensis'):
            return
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = root / 'payload'
            payload.mkdir()
            (payload / 'BeefTV.exe').write_bytes(b'fixture')
            out_dir = root / 'dist'
            result = subprocess.run(
                ['python3', str(packager_path), '--platform', 'windows-amd64',
                 '--input', str(payload), '--output-dir', str(out_dir)],
                capture_output=True, text=True, check=True,
            )
            self.assertIn('(UTF8)', result.stdout)
            self.assertNotIn('warning', result.stdout.lower())
            self.assertEqual(len(list(out_dir.glob('BeefTV-*-windows-amd64-setup.exe'))), 1)


@unittest.skipUnless(sys.platform == 'darwin', 'native macOS disk image verification')
class MacDiskImageTests(unittest.TestCase):
    def test_real_packager_creates_verified_hfs_image(self):
        import plistlib
        import shutil
        import subprocess
        import tempfile
        packager_spec = importlib.util.spec_from_file_location(
            'installer_packager', Path(__file__).with_name('package-desktop-installer.py'))
        packager = importlib.util.module_from_spec(packager_spec)
        packager_spec.loader.exec_module(packager)
        with tempfile.TemporaryDirectory(prefix='beeftv-native-dmg-') as directory:
            root = Path(directory)
            payload = root / 'fixture with spaces' / 'BeefTV.app'
            binary = payload / 'Contents/MacOS/BeefTV'
            binary.parent.mkdir(parents=True)
            shutil.copyfile('/usr/bin/true', binary)
            binary.chmod(0o755)
            with (payload / 'Contents/Info.plist').open('wb') as info:
                plistlib.dump({'CFBundleExecutable': 'BeefTV', 'CFBundleIdentifier': 'test.beeftv.dmg',
                               'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1'}, info)
            subprocess.run(['codesign', '--force', '--sign', '-', str(payload)], check=True,
                           capture_output=True, text=True)
            output = root / 'fixture.dmg'
            packager.package('v1.0.0', 'darwin-amd64', payload, output)
            image_info = subprocess.run(['hdiutil', 'imageinfo', str(output)], check=True,
                                        capture_output=True, text=True).stdout
            self.assertIn('Apple_HFS', image_info)
            self.assertNotIn('Apple_APFS', image_info)
            subprocess.run(['hdiutil', 'verify', str(output)], check=True,
                           capture_output=True, text=True)


if __name__ == '__main__':
    unittest.main()
