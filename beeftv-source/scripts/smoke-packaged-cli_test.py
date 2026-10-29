import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("smoke", Path(__file__).with_name("smoke-packaged-cli.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PackagedCLITest(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "fixture uses a POSIX executable")
    def test_startup_failure_reports_stderr_without_client_token(self):
        name = "BeefTV.app/Contents/MacOS/cli/beeftv"
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "package.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                entry = zipfile.ZipInfo(name)
                entry.external_attr = 0o100755 << 16
                bundle.writestr(entry, b'#!/bin/sh\necho "fixture startup failure $BEEFTV_CLIENT_TOKEN" >&2\nexit 1\n')
            with self.assertRaisesRegex(RuntimeError, r"fixture startup failure \[redacted\]"):
                module.smoke(archive, "darwin-arm64")

    def test_rejects_unusable_cli_before_execution(self):
        name = "BeefTV.app/Contents/MacOS/cli/beeftv"
        for defect in ("missing", "empty", "symlink", "not-executable"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as root:
                archive = Path(root) / "package.zip"
                with zipfile.ZipFile(archive, "w") as bundle:
                    if defect != "missing":
                        entry = zipfile.ZipInfo(name)
                        entry.external_attr = (0o120755 if defect == "symlink" else
                                               0o100644 if defect == "not-executable" else
                                               0o100755) << 16
                        bundle.writestr(entry, b"" if defect == "empty" else b"invalid")
                with self.assertRaises(RuntimeError):
                    module.smoke(archive, "darwin-arm64")


if __name__ == "__main__":
    unittest.main()
