#!/usr/bin/env python3
"""Offline adversarial checks for source-delivery integrity."""

import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("wasm_sources", Path(__file__).with_name("package-wasm-sources.py"))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


def tar_bytes(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for path, data in files.items():
            member = tarfile.TarInfo(path)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


class SourceBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / "cache"
        self.cache.mkdir()
        revision = "a" * 40
        filename = f"fixture-{revision}.tar.gz"
        data = tar_bytes({f"fixture-{revision}/COPYING": b"Fixture license\n", f"fixture-{revision}/codec.c": b"int codec(void) { return 0; }\n"})
        (self.cache / filename).write_bytes(data)
        self.lock = {
            "id": "ffmpeg-wasm", "version": "0.12.10", "license": "GPL-2.0-or-later",
            "binaryHashes": {"wasm": "b" * 64, "javascript": "c" * 64},
            "provenance": {"status": "unresolved", "unresolved": ["Historical build not attested"]},
            "sources": [{"id": "fixture", "repository": "test/fixture", "revision": revision,
                         "filename": filename, "url": f"https://codeload.github.com/test/fixture/tar.gz/{revision}",
                         "sha256": packager.digest(data), "licensePaths": ["COPYING"]}],
        }

    def collect(self, name="output"):
        return packager.collect(self.lock, "1.2.3", self.root / name, self.cache, offline=True)

    def rewrite(self, bundle, transform):
        with tarfile.open(bundle, "r:gz") as archive:
            files = {member.name: archive.extractfile(member).read() for member in archive}
        transform(files)
        damaged = self.root / "damaged.tar.gz"
        damaged.write_bytes(tar_bytes(files))
        return damaged

    def test_offline_bundle_complete_and_repeatable(self):
        first, second = self.collect("first"), self.collect("second")
        self.assertEqual(first.name, "BeefTV-v1.2.3-ffmpeg-wasm-sources.tar.gz")
        self.assertEqual(first.read_bytes(), second.read_bytes())
        result = packager.verify_archive(first, self.lock)
        self.assertEqual(result["provenance"]["status"], "unresolved")
        self.assertEqual(len(result["sources"]), 1)
        self.assertEqual(result["licenses"], ["licenses/fixture/COPYING"])

    def test_tampered_cached_archive_is_rejected_without_redownload(self):
        source = self.lock["sources"][0]
        (self.cache / source["filename"]).write_bytes(b"tampered source")
        with self.assertRaisesRegex(ValueError, "Source checksum mismatch"):
            self.collect()
        self.assertFalse(list((self.root / "output").glob("*.tar.gz")))

    def test_missing_offline_source_is_rejected(self):
        (self.cache / self.lock["sources"][0]["filename"]).unlink()
        with self.assertRaisesRegex(ValueError, "Missing offline source"):
            self.collect()

    def test_tampered_packaged_source_is_rejected(self):
        path = "sources/" + self.lock["sources"][0]["filename"]
        damaged = self.rewrite(self.collect(), lambda files: files.update({path: b"tampered source"}))
        with self.assertRaisesRegex(ValueError, "Bundle checksum mismatch"):
            packager.verify_archive(damaged, self.lock)

    def test_missing_packaged_source_is_rejected(self):
        path = "sources/" + self.lock["sources"][0]["filename"]
        damaged = self.rewrite(self.collect(), lambda files: files.pop(path))
        with self.assertRaises(KeyError):
            packager.verify_archive(damaged, self.lock)

    def test_deleting_manifest_entry_does_not_bypass_required_sources(self):
        def remove_source(files):
            manifest = json.loads(files["manifest.json"])
            manifest["sources"] = []
            files["manifest.json"] = packager.json_bytes(manifest)
        damaged = self.rewrite(self.collect(), remove_source)
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            packager.verify_archive(damaged, self.lock)

    def test_tampered_rebuild_recipe_is_rejected(self):
        damaged = self.rewrite(self.collect(), lambda files: files.update({"rebuild.py": b"unverified recipe"}))
        with self.assertRaisesRegex(ValueError, "Bundle checksum mismatch"):
            packager.verify_archive(damaged, self.lock)

    def test_different_runtime_cannot_use_the_locked_source_materials(self):
        binary = self.root / "runtime"
        binary.mkdir()
        for kind, filename in (("wasm", "ffmpeg-core.wasm"), ("javascript", "ffmpeg-core.js")):
            (binary / filename).write_bytes(kind.encode())
            self.lock["binaryHashes"][kind] = packager.digest(kind.encode())
        packager.verify_binary(binary, self.lock)
        (binary / "ffmpeg-core.wasm").write_bytes(b"another core")
        with self.assertRaisesRegex(ValueError, "core checksum mismatch"):
            packager.verify_binary(binary, self.lock)

    def test_unsafe_archive_member_is_rejected(self):
        damaged = self.rewrite(self.collect(), lambda files: files.update({"../escape": b"outside"}))
        with self.assertRaisesRegex(ValueError, "Unsafe bundle path"):
            packager.verify_archive(damaged, self.lock)

    def test_mutable_revision_cannot_enter_source_lock(self):
        lock = copy.deepcopy(self.lock)
        lock["sources"][0]["revision"] = "master"
        path = self.root / "source-lock.json"
        path.write_bytes(packager.json_bytes(lock))
        with self.assertRaisesRegex(ValueError, "immutable Git commit"):
            packager.load_lock(path)


if __name__ == "__main__":
    unittest.main()
