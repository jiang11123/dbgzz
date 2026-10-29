import hashlib
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("macos_source", Path(__file__).with_name("package-macos-media-source.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SourcePacketTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.source = self.root / "original.tar.gz"
        self.source.write_bytes(b"original source fixture")
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        for name, content in {"ffprobe": b"binary fixture", "LICENSE": b"license fixture", "README.txt": b"configure flags fixture"}.items():
            (self.runtime / name).write_bytes(content)
        self.facts = {"sourceSHA256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
                      "probeSHA256": hashlib.sha256((self.runtime / "ffprobe").read_bytes()).hexdigest(),
                      "target": "darwin/arm64", "sourceCommit": "fixture"}
        (self.runtime / "manifest.json").write_text(json.dumps(self.facts))
        self.output = self.root / "sources.tar.gz"

    def test_packet_contains_original_inputs_and_can_be_regenerated(self):
        module.package(self.source, self.runtime, "darwin/arm64", self.output)
        original = self.output.read_bytes()
        with tarfile.open(self.output) as archive:
            entries = {item.name: archive.extractfile(item).read() for item in archive.getmembers()}
        self.assertEqual(entries["ffmpeg-source.tar.gz"], self.source.read_bytes())
        manifest = json.loads(entries["manifest.json"])
        self.assertEqual(manifest["binaryHashes"]["ffprobe"], self.facts["probeSHA256"])
        for entry in manifest["sources"]:
            self.assertEqual(hashlib.sha256(entries[entry["path"]]).hexdigest(), entry["sha256"])
        self.assertIn(b"./ffmpeg-source.tar.gz", entries[manifest["buildInstructions"]])
        module.package(self.source, self.runtime, "darwin/arm64", self.output)
        self.assertEqual(original, self.output.read_bytes())

    def test_mismatches_do_not_replace_an_existing_packet(self):
        self.output.write_bytes(b"keep existing packet")
        with self.assertRaises(ValueError):
            module.package(self.source, self.runtime, "darwin/amd64", self.output)
        original = self.source.read_bytes()
        self.source.write_bytes(b"wrong source")
        with self.assertRaises(ValueError):
            module.package(self.source, self.runtime, "darwin/arm64", self.output)
        self.source.write_bytes(original)
        (self.runtime / "ffprobe").write_bytes(b"wrong binary")
        with self.assertRaises(ValueError):
            module.package(self.source, self.runtime, "darwin/arm64", self.output)
        self.assertEqual(self.output.read_bytes(), b"keep existing packet")


if __name__ == "__main__":
    unittest.main()
