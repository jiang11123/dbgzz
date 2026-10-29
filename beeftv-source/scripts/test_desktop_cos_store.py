"""Exercise COS publication ownership and ambiguous network outcomes without cloud writes."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.parse

from desktop_cos_store import COSHTTP, COSResponse, COSStore, PublishError, fingerprint


class MemoryCOS:
    def __init__(self):
        self.objects = {}
        self.calls = []
        self.mutex = threading.Lock()
        self.before_put = self.after_put = self.after_delete = None
        self.ignore_forbid = False

    def request(self, method, key, source=None, headers=None, destination=None, max_bytes=None):
        headers = headers or {}
        data = Path(source).read_bytes() if isinstance(source, (Path, str)) else source
        with self.mutex:
            self.calls.append((method, key, headers.get("x-cos-forbid-overwrite")))
        if method == "PUT" and self.before_put:
            self.before_put(key, data)
        with self.mutex:
            previous = self.objects.get(key)
            if method == "PUT":
                if not self.ignore_forbid and headers.get("x-cos-forbid-overwrite") == "true" and previous is not None:
                    return COSResponse(409, code="FileAlreadyExists")
                self.objects[key] = data
            elif method == "DELETE":
                self.objects.pop(key, None)
        if method == "PUT":
            if self.after_put:
                self.after_put(key, data)
            return COSResponse(200, '"' + hashlib.md5(data).hexdigest() + '"')
        if method == "DELETE":
            if self.after_delete:
                self.after_delete(key)
            return COSResponse(204)
        if previous is None:
            return COSResponse(404)
        if max_bytes is not None and len(previous) > max_bytes:
            raise PublishError("COS object exceeds its read limit")
        Path(destination).write_bytes(previous)
        return COSResponse(200, '"' + hashlib.md5(previous).hexdigest() + '"')


class COSPublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.wire = MemoryCOS()
        self.first, self.second = self.client(), self.client()
        self.a, self.b = self.root / "a", self.root / "b"
        self.a.write_bytes(b"signed envelope A")
        self.b.write_bytes(b"signed envelope B")
        self.target = "beeftv/desktop-update.json"

    def client(self):
        return COSStore("beeftv-components-1481187348", "ap-guangzhou", self.wire)

    def etag(self):
        return self.first.get(self.target, self.root / "read")

    def test_native_forbid_create_keeps_immutable_bytes_and_capability_probe_cleans_up(self):
        key = "beeftv/v1.0.0/asset.zip"
        self.assertTrue(self.first.put(key, self.a, "immutable"))
        self.assertFalse(self.second.put(key, self.b, "immutable"))
        self.assertEqual(self.wire.objects[key], self.a.read_bytes())
        self.first.check_conditions()
        self.assertEqual(set(self.wire.objects), {key})

    def test_ignored_forbid_header_blocks_before_publication(self):
        self.wire.ignore_forbid = True
        with self.assertRaisesRegex(PublishError, "forbid-overwrite"):
            self.first.check_conditions()
        self.assertEqual(self.wire.objects, {})

    def test_only_one_competing_writer_can_hold_target_and_stale_etag_loses_after_release(self):
        self.assertTrue(self.first.put(self.target, self.a, "no-store"))
        original = self.etag()
        entered, finish = threading.Event(), threading.Event()

        def block(key, data):
            if key == self.target:
                entered.set()
                if not finish.wait(10):
                    raise PublishError("test writer did not finish")

        self.wire.before_put = block
        with ThreadPoolExecutor(max_workers=1) as pool:
            writer = pool.submit(self.first.put, self.target, self.b, "no-store", original)
            self.assertTrue(entered.wait(10))
            try:
                with self.assertRaisesRegex(PublishError, "already held"):
                    self.second.put(self.target, self.a, "no-store", original)
            finally:
                finish.set()
            self.assertTrue(writer.result(timeout=10))
        self.wire.before_put = None
        self.assertFalse(self.second.put(self.target, self.a, "no-store", original))
        self.assertEqual(self.wire.objects[self.target], self.b.read_bytes())
        self.assertNotIn(self.first.lock_key(self.target), self.wire.objects)

    def test_if_none_match_initial_feed_creation_also_uses_lock(self):
        self.assertTrue(self.first.put(self.target, self.a, "no-store"))
        self.assertFalse(self.second.put(self.target, self.b, "no-store"))
        self.assertEqual(self.wire.objects[self.target], self.a.read_bytes())

    def test_lost_create_receipt_reconciles_same_nonce_without_reissuing_put(self):
        seen = []

        def lost(key, data):
            if key.startswith(self.first.lock_prefix):
                seen.append(data)
                raise PublishError("COS PUT outcome is unknown")

        self.wire.after_put = lost
        self.assertTrue(self.first.put(self.target, self.a, "no-store"))
        self.assertEqual(len(seen), 1)
        self.assertEqual(self.wire.objects[self.target], self.a.read_bytes())
        self.assertNotIn(self.first.lock_key(self.target), self.wire.objects)
        self.assertIn(self.first.claim_key(self.target, None), self.wire.objects)

    def test_stale_origin_read_cannot_consume_an_expected_etag_twice(self):
        self.first.put(self.target, self.a, "no-store")
        old_etag = self.etag()
        self.first.put(self.target, self.b, "no-store", old_etag)
        request = self.wire.request
        stale = [True]

        def stale_get(method, key, *args, **kwargs):
            if method == "GET" and key == self.target and stale[0]:
                stale[0] = False
                Path(kwargs["destination"]).write_bytes(self.a.read_bytes())
                return COSResponse(200, old_etag)
            return request(method, key, *args, **kwargs)

        self.wire.request = stale_get
        self.assertFalse(self.second.put(self.target, self.a, "no-store", old_etag))
        self.assertEqual(self.wire.objects[self.target], self.b.read_bytes())
        self.assertNotIn(self.first.lock_key(self.target), self.wire.objects)

    def test_absent_feed_claim_identity_is_stable_and_separate_from_etag_strings(self):
        self.assertEqual(self.first.claim_key(self.target, None), self.second.claim_key(self.target, None))
        self.assertNotEqual(self.first.claim_key(self.target, None), self.first.claim_key(self.target, "null"))
        other = "beeftv/another-feed.json"
        self.assertNotEqual(self.first.claim_key(self.target, None), self.first.claim_key(other, None))
        self.first.put(self.target, self.a, "no-store")
        # Simulate a stale 404 after a successfully created first feed.
        request = self.wire.request
        stale = [True]

        def stale_absent(method, key, *args, **kwargs):
            if method == "GET" and key == self.target and stale[0]:
                stale[0] = False
                return COSResponse(404)
            return request(method, key, *args, **kwargs)

        self.wire.request = stale_absent
        self.assertFalse(self.second.put(self.target, self.b, "no-store"))
        self.assertEqual(self.wire.objects[self.target], self.a.read_bytes())

    def test_first_stale_404_cannot_overwrite_an_existing_feed_without_a_null_claim(self):
        self.wire.objects[self.target] = self.b.read_bytes()
        request = self.wire.request
        stale = [True]

        def stale_absent(method, key, *args, **kwargs):
            if method == "GET" and key == self.target and stale[0]:
                stale[0] = False
                return COSResponse(404)
            return request(method, key, *args, **kwargs)

        self.wire.request = stale_absent
        self.assertFalse(self.first.put(self.target, self.a, "no-store"))
        self.assertEqual(self.wire.objects[self.target], self.b.read_bytes())
        self.assertIn(self.first.claim_key(self.target, None), self.wire.objects)
        self.assertNotIn(self.first.lock_key(self.target), self.wire.objects)
        self.assertEqual([forbid for method, key, forbid in self.wire.calls if method == "PUT" and key == self.target], ["true"])

    def test_lost_claim_create_receipt_reconciles_exact_content(self):
        claims = []

        def lost(key, data):
            if key.startswith(self.first.claim_prefix):
                claims.append(key)
                raise PublishError("COS PUT outcome is unknown")

        self.wire.after_put = lost
        self.assertTrue(self.first.put(self.target, self.a, "no-store"))
        self.assertEqual(len(claims), 1)
        self.assertEqual(self.wire.objects[self.target], self.a.read_bytes())
        self.assertIn(claims[0], self.wire.objects)

    def test_unknown_uncommitted_claim_retains_lock_and_does_not_write_target(self):
        def unknown(key, data):
            if key.startswith(self.first.claim_prefix):
                raise PublishError("COS PUT outcome is unknown")

        self.wire.before_put = unknown
        with self.assertRaisesRegex(PublishError, "claim is unconfirmed"):
            self.first.put(self.target, self.a, "no-store")
        self.assertIn(self.first.lock_key(self.target), self.wire.objects)
        self.assertNotIn(self.target, self.wire.objects)
        self.assertEqual(sum(method == "PUT" and key.startswith(self.first.claim_prefix) for method, key, _ in self.wire.calls), 1)

    def test_unknown_uncommitted_lock_create_does_not_retry_or_write_target(self):
        def unknown(key, data):
            raise PublishError("COS PUT outcome is unknown")

        self.wire.before_put = unknown
        with self.assertRaisesRegex(PublishError, "acquisition is unconfirmed"):
            self.first.put(self.target, self.a, "no-store")
        self.assertEqual(self.wire.objects, {})
        self.assertEqual(sum(method == "PUT" for method, _, _ in self.wire.calls), 1)

    def test_abandoned_lock_never_expires_and_another_writer_never_deletes_it(self):
        lock = self.first.acquire(self.target)
        document = json.loads(lock[1])
        document["createdAt"] = "1900-01-01T00:00:00+00:00"
        abandoned = json.dumps(document).encode()
        self.wire.objects[lock[0]] = abandoned
        for _ in range(2):
            with self.assertRaisesRegex(PublishError, "already held"):
                self.second.put(self.target, self.b, "no-store")
        self.assertEqual(self.wire.objects, {lock[0]: abandoned})
        self.assertFalse(any(method == "DELETE" for method, _, _ in self.wire.calls))

    def test_unknown_target_put_keeps_owned_lock_even_if_new_bytes_are_visible(self):
        def lost(key, data):
            if key == self.target:
                raise PublishError("COS PUT outcome is unknown")

        self.wire.after_put = lost
        with self.assertRaisesRegex(PublishError, "outcome is unknown"):
            self.first.put(self.target, self.a, "no-store")
        lock_key = self.first.lock_key(self.target)
        self.assertIn(lock_key, self.wire.objects)
        with self.assertRaisesRegex(PublishError, "already held"):
            self.second.put(self.target, self.b, "no-store")
        self.assertEqual(self.wire.objects[self.target], self.a.read_bytes())

    def test_lost_delete_receipt_never_deletes_successor_lock(self):
        successor = b'{"nonce":"another-writer"}'

        def lost(key):
            self.wire.objects[key] = successor
            raise PublishError("COS DELETE outcome is unknown")

        self.wire.after_delete = lost
        with self.assertRaisesRegex(PublishError, "release is unconfirmed"):
            self.first.put(self.target, self.a, "no-store")
        self.assertEqual(self.wire.objects[self.first.lock_key(self.target)], successor)
        self.assertEqual(sum(method == "DELETE" for method, _, _ in self.wire.calls), 1)

    def test_lost_delete_receipt_is_unconfirmed_even_when_lock_is_now_absent(self):
        def lost(key):
            raise PublishError("COS DELETE outcome is unknown")

        self.wire.after_delete = lost
        with self.assertRaisesRegex(PublishError, "release is unconfirmed"):
            self.first.put(self.target, self.a, "no-store")
        self.assertNotIn(self.first.lock_key(self.target), self.wire.objects)
        self.assertEqual(self.wire.calls[-1][0], "DELETE")
        self.assertEqual(sum(method == "DELETE" for method, _, _ in self.wire.calls), 1)

    def test_unknown_delete_without_commit_retains_lock_and_never_retries(self):
        lock = self.first.acquire(self.target)
        request = self.wire.request

        def unknown(method, key, *args, **kwargs):
            if method == "DELETE":
                self.wire.calls.append((method, key, None))
                raise PublishError("COS DELETE outcome is unknown")
            return request(method, key, *args, **kwargs)

        self.wire.request = unknown
        with self.assertRaisesRegex(PublishError, "release is unconfirmed"):
            self.first.release(lock)
        self.assertEqual(self.wire.objects[lock[0]], lock[1])
        self.assertEqual(sum(method == "DELETE" for method, _, _ in self.wire.calls), 1)

    def test_unexpected_delete_status_is_not_confirmed_by_later_absence(self):
        lock = self.first.acquire(self.target)
        request = self.wire.request

        def unconfirmed(method, key, *args, **kwargs):
            result = request(method, key, *args, **kwargs)
            return COSResponse(202) if method == "DELETE" else result

        self.wire.request = unconfirmed
        with self.assertRaisesRegex(PublishError, "release is unconfirmed"):
            self.first.release(lock)
        self.assertNotIn(lock[0], self.wire.objects)
        self.assertEqual(self.wire.calls[-1][0], "DELETE")
        self.assertEqual(sum(method == "DELETE" for method, _, _ in self.wire.calls), 1)

    def test_releasing_foreign_lock_is_refused_without_delete(self):
        lock = self.first.acquire(self.target)
        self.wire.objects[lock[0]] = b"other owner"
        with self.assertRaisesRegex(PublishError, "ownership changed"):
            self.first.release(lock)
        self.assertFalse(any(method == "DELETE" for method, _, _ in self.wire.calls))

    def pending_claim(self, etag=None):
        lock = self.first.acquire(self.target)
        self.assertTrue(self.first.consume_etag(self.target, etag, fingerprint(self.a), lock))
        return lock[1], self.wire.objects[self.first.claim_key(self.target, etag)]

    def test_explicit_resume_completes_original_bytes_without_new_nonce_or_claim(self):
        lock, claim = self.pending_claim()
        start = len(self.wire.calls)
        self.assertTrue(self.second.resume(self.target, self.a, lock, claim))
        self.assertEqual(self.wire.objects[self.target], self.a.read_bytes())
        self.assertEqual(self.wire.objects[self.first.claim_key(self.target, None)], claim)
        self.assertNotIn(self.first.lock_key(self.target), self.wire.objects)
        self.assertEqual([(key, forbid) for method, key, forbid in self.wire.calls[start:] if method == "PUT"], [(self.target, "true")])

    def test_explicit_resume_of_already_committed_bytes_only_releases_original_lock(self):
        lock, claim = self.pending_claim()
        self.wire.objects[self.target] = self.a.read_bytes()
        start = len(self.wire.calls)
        self.assertTrue(self.second.resume(self.target, self.a, lock, claim))
        self.assertFalse(any(method == "PUT" for method, _, _ in self.wire.calls[start:]))
        self.assertEqual(self.wire.objects[self.first.claim_key(self.target, None)], claim)

    def test_explicit_resume_replaces_only_original_nonnull_etag_state(self):
        self.wire.objects[self.target] = self.b.read_bytes()
        original = self.etag()
        lock, claim = self.pending_claim(original)
        self.assertTrue(self.second.resume(self.target, self.a, lock, claim))
        self.assertEqual(self.wire.objects[self.target], self.a.read_bytes())
        self.assertEqual(self.wire.objects[self.first.claim_key(self.target, original)], claim)
        self.assertNotIn(self.first.lock_key(self.target), self.wire.objects)

    def test_resume_matching_body_with_original_etag_requires_same_claim_put_before_unlock(self):
        for outcome in ("verified", "unknown"):
            with self.subTest(outcome=outcome):
                self.wire = MemoryCOS()
                self.first, self.second = self.client(), self.client()
                self.wire.objects[self.target] = self.b.read_bytes()
                original = self.etag()
                lock, claim = self.pending_claim(original)
                request = self.wire.request
                stale = [True]

                def inconsistent_get(method, key, *args, **kwargs):
                    if method == "GET" and key == self.target and stale[0]:
                        stale[0] = False
                        Path(kwargs["destination"]).write_bytes(self.a.read_bytes())
                        return COSResponse(200, original)
                    return request(method, key, *args, **kwargs)

                self.wire.request = inconsistent_get
                if outcome == "unknown":
                    def lost(key, data):
                        if key == self.target:
                            raise PublishError("COS PUT outcome is unknown")
                    self.wire.after_put = lost
                start = len(self.wire.calls)
                if outcome == "verified":
                    self.assertTrue(self.second.resume(self.target, self.a, lock, claim))
                else:
                    with self.assertRaisesRegex(PublishError, "Recovery PUT outcome is unknown"):
                        self.second.resume(self.target, self.a, lock, claim)
                mutations = [(method, key) for method, key, _ in self.wire.calls[start:] if method in ("PUT", "DELETE")]
                expected = [("PUT", self.target)]
                if outcome == "verified":
                    expected.append(("DELETE", self.first.lock_key(self.target)))
                    self.assertNotIn(self.first.lock_key(self.target), self.wire.objects)
                else:
                    self.assertEqual(self.wire.objects[self.first.lock_key(self.target)], lock)
                self.assertEqual(mutations, expected)
                self.assertEqual(self.wire.objects[self.first.claim_key(self.target, original)], claim)

    def test_resume_refuses_wrong_bytes_nonce_target_live_lock_or_claim(self):
        for scenario in ("bytes", "nonce", "target", "live-lock", "live-claim", "missing-lock", "missing-claim", "changed-target"):
            with self.subTest(scenario=scenario):
                self.wire.objects.clear()
                lock, claim = self.pending_claim()
                source, target = self.a, self.target
                if scenario == "bytes":
                    source = self.b
                if scenario == "nonce":
                    document = json.loads(lock)
                    document["nonce"] = "f" * 32
                    lock = json.dumps(document).encode()
                if scenario == "target":
                    target = "beeftv/other-feed.json"
                if scenario == "live-lock":
                    self.wire.objects[self.first.lock_key(self.target)] = b"different owner"
                if scenario == "live-claim":
                    self.wire.objects[self.first.claim_key(self.target, None)] = b"different claim"
                if scenario == "missing-lock":
                    del self.wire.objects[self.first.lock_key(self.target)]
                if scenario == "missing-claim":
                    del self.wire.objects[self.first.claim_key(self.target, None)]
                if scenario == "changed-target":
                    self.wire.objects[self.target] = self.b.read_bytes()
                start = len(self.wire.calls)
                with self.assertRaises(PublishError):
                    self.second.resume(target, source, lock, claim)
                self.assertFalse(any(method in ("PUT", "DELETE") for method, _, _ in self.wire.calls[start:]))

    def test_resume_target_unknown_put_retains_original_lock_and_claim(self):
        lock, claim = self.pending_claim()

        def lost(key, data):
            if key == self.target:
                raise PublishError("COS PUT outcome is unknown")

        self.wire.after_put = lost
        with self.assertRaisesRegex(PublishError, "Recovery PUT outcome is unknown"):
            self.second.resume(self.target, self.a, lock, claim)
        self.assertEqual(self.wire.objects[self.first.lock_key(self.target)], lock)
        self.assertEqual(self.wire.objects[self.first.claim_key(self.target, None)], claim)

    def test_resume_first_create_forbid_rejects_a_stale_absence_and_other_existing_bytes(self):
        lock, claim = self.pending_claim()
        self.wire.objects[self.target] = self.b.read_bytes()
        request = self.wire.request
        stale = [True]

        def stale_absent(method, key, *args, **kwargs):
            if method == "GET" and key == self.target and stale[0]:
                stale[0] = False
                return COSResponse(404)
            return request(method, key, *args, **kwargs)

        self.wire.request = stale_absent
        with self.assertRaisesRegex(PublishError, "readback failed"):
            self.second.resume(self.target, self.a, lock, claim)
        self.assertEqual(self.wire.objects[self.target], self.b.read_bytes())
        self.assertEqual(self.wire.objects[self.first.lock_key(self.target)], lock)

    def test_resume_first_create_stale_absence_reconciles_identical_committed_bytes(self):
        lock, claim = self.pending_claim()
        self.wire.objects[self.target] = self.a.read_bytes()
        request = self.wire.request
        stale = [True]

        def stale_absent(method, key, *args, **kwargs):
            if method == "GET" and key == self.target and stale[0]:
                stale[0] = False
                return COSResponse(404)
            return request(method, key, *args, **kwargs)

        self.wire.request = stale_absent
        self.assertTrue(self.second.resume(self.target, self.a, lock, claim))
        self.assertEqual(self.wire.objects[self.target], self.a.read_bytes())
        self.assertNotIn(self.first.lock_key(self.target), self.wire.objects)


class COSHTTPTests(unittest.TestCase):
    def test_native_request_signs_forbid_header_and_streams_file(self):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.status, response.headers = 200, {"ETag": '"etag"'}
        response.read.return_value = b""
        captured = []
        opener = unittest.mock.MagicMock()

        def open_request(request, timeout):
            captured.append((request, request.data.read()))
            return response

        opener.open.side_effect = open_request
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"AWS_ACCESS_KEY_ID": "fixture-access", "AWS_SECRET_ACCESS_KEY": "fixture-secret"}):
            source = Path(directory) / "archive"
            source.write_bytes(b"release bytes")
            result = COSHTTP("beeftv-components-1481187348", "ap-guangzhou", opener).request("PUT", "beeftv/test file.zip", source, {"x-cos-forbid-overwrite": "true"})
        self.assertEqual(result.status, 200)
        request, body = captured[0]
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(request.full_url).query)
        self.assertIn("x-cos-forbid-overwrite", query["X-Amz-SignedHeaders"][0])
        self.assertEqual(request.get_header("X-cos-forbid-overwrite"), "true")
        self.assertEqual(request.get_header("Content-length"), str(len(body)))
        self.assertEqual(body, b"release bytes")
        self.assertIn("test%20file.zip", request.full_url)

    def test_delete_transport_is_single_attempt_and_diagnostics_hide_signed_url(self):
        opener = unittest.mock.MagicMock()
        opener.open.side_effect = OSError("credential-bearing https://example.invalid/?secret=value")
        with patch.dict("os.environ", {"AWS_ACCESS_KEY_ID": "fixture-access", "AWS_SECRET_ACCESS_KEY": "fixture-secret"}):
            with self.assertRaisesRegex(PublishError, "^COS DELETE outcome is unknown$"):
                COSHTTP("beeftv-components-1481187348", "ap-guangzhou", opener).request("DELETE", "beeftv/lock")
        self.assertEqual(opener.open.call_count, 1)


class ExplicitCloudProbeTests(unittest.TestCase):
    def test_two_client_probe_runs_against_native_contract_and_cleans_only_its_objects(self):
        spec = importlib.util.spec_from_file_location("probe_desktop_cos", Path(__file__).with_name("probe-desktop-cos.py"))
        probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(probe)
        wire = MemoryCOS()
        wire.objects["beeftv/v1.0.0/keep.zip"] = b"existing public release"

        def client(bucket, region, transport=None):
            return COSStore(bucket, region, transport or wire)

        with patch.object(probe, "COSStore", side_effect=client):
            result = probe.probe("beeftv-components-1481187348", "ap-guangzhou")
        self.assertTrue(result["competing_clients_exactly_one_winner"])
        self.assertTrue(result["held_lock_blocks_second_client"])
        self.assertTrue(result["stale_etag_rejected"])
        self.assertTrue(result["lost_create_receipt_reconciled_without_retry"])
        self.assertEqual(wire.objects, {"beeftv/v1.0.0/keep.zip": b"existing public release"})


if __name__ == "__main__":
    unittest.main()
