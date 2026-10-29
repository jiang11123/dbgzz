import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare_depth", Path(__file__).with_name("prepare-depth-manifest.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ManifestTests(unittest.TestCase):
    def fixture(self, root):
        for variant in ("cpu", "cuda"):
            name = f"beeftv-depth-runtime-v1-windows-amd64-{variant}.zip"
            content = b"runtime"
            meta = dict(name=name, size=len(content), sha256=hashlib.sha256(content).hexdigest(), files=1, expandedSize=100)
            if variant == "cuda":
                parts = []
                for index, data in enumerate((content[:3], content[3:]), 1):
                    part_name = f"{name}.part-{index:03d}"
                    (root / part_name).write_bytes(data)
                    parts.append(dict(name=part_name, size=len(data), sha256=hashlib.sha256(data).hexdigest()))
                meta["parts"] = parts
            else:
                (root / name).write_bytes(content)
            (root / (name + ".json")).write_text(json.dumps(meta), encoding="utf-8-sig")

    def test_complete_packages_and_parts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            payload = module.prepare(root)
            self.assertEqual(len(payload["runtimes"]), 2)
            self.assertEqual(len(payload["runtimes"]["windows-amd64/cuda"]["parts"]), 2)
            part = root / "beeftv-depth-runtime-v1-windows-amd64-cuda.zip.part-002"
            part.write_bytes(b"xxxx")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                module.prepare(root)

    def test_rejects_wrong_assembled_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            path = root / "beeftv-depth-runtime-v1-windows-amd64-cuda.zip.json"
            meta = json.loads(path.read_text(encoding="utf-8-sig"))
            meta["sha256"] = "0" * 64
            path.write_text(json.dumps(meta))
            with self.assertRaisesRegex(ValueError, "assembled runtime mismatch"):
                module.prepare(root)


if __name__ == "__main__":
    unittest.main()
