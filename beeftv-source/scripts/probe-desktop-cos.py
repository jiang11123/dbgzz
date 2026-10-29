#!/usr/bin/env python3
"""Opt-in COS publication probe. Writes only unique probe objects and their locks."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import threading
import uuid

from desktop_cos_store import COSStore, PublishError, fingerprint


def probe(bucket, region):
    first, second = COSStore(bucket, region), COSStore(bucket, region)
    target = first.probe_prefix + uuid.uuid4().hex + "/feed.json"
    result = {"bucket": bucket, "target": target, "lock": first.lock_key(target)}
    claims = {first.claim_key(target, None)}
    first.check_conditions()
    try:
        with tempfile.TemporaryDirectory(prefix="beeftv-two-publisher-probe-") as directory:
            initial, a, b, current = (Path(directory) / name for name in ("initial", "a", "b", "current"))
            initial.write_bytes(b"BeefTV probe initial feed")
            a.write_bytes(b"BeefTV probe feed A")
            b.write_bytes(b"BeefTV probe feed B")
            if not first.conditional_put(target, initial, "no-store", None):
                raise PublishError("Initial conditional probe creation failed")
            etag = first.get(target, current)
            claims.add(first.claim_key(target, etag))

            held = first.acquire(target)
            try:
                try:
                    second.conditional_put(target, a, "no-store", etag)
                except PublishError as error:
                    if "already held" not in str(error):
                        raise
                else:
                    raise PublishError("A second publisher was admitted while a lock was held")
            finally:
                first.release(held)
            result["held_lock_blocks_second_client"] = True

            start = threading.Barrier(2)

            def writer(store, source):
                start.wait(timeout=10)
                try:
                    return store.conditional_put(target, source, "no-store", etag)
                except PublishError as error:
                    if "already held" in str(error):
                        return False
                    raise

            with ThreadPoolExecutor(max_workers=2) as workers:
                left = workers.submit(writer, first, a)
                right = workers.submit(writer, second, b)
                outcomes = [left.result(), right.result()]
            if sum(outcomes) != 1:
                raise PublishError("Competing publishers did not produce exactly one winner")
            if first.get(target, current) is None or fingerprint(current) not in (fingerprint(a), fingerprint(b)):
                raise PublishError("Competing publisher readback failed")
            result["competing_clients_exactly_one_winner"] = True
            if second.conditional_put(target, initial, "no-store", etag):
                raise PublishError("Stale ETag replaced a newer feed")
            result["stale_etag_rejected"] = True

            class LostCreateReceipt:
                dropped = 0

                def request(self, method, key, *args, **kwargs):
                    response = first.http.request(method, key, *args, **kwargs)
                    if method == "PUT" and key.startswith(first.lock_prefix) and response.status == 200:
                        self.dropped += 1
                        raise PublishError("COS PUT outcome is unknown")
                    return response

            transport = LostCreateReceipt()
            third = COSStore(bucket, region, transport)
            reconciled = third.acquire(target)
            third.release(reconciled)
            if transport.dropped != 1:
                raise PublishError("Lost lock-create receipt was not reconciled from one request")
            result["lost_create_receipt_reconciled_without_retry"] = True
    finally:
        # An unconfirmed mutation deliberately retains its lock. Never clear an
        # abandoned lock here, even though this target is only a test object.
        if first._lock_content(first.lock_key(target)) is not None:
            raise PublishError(f"Probe lock retained for operator inspection: {first.lock_key(target)}")
        first.delete_probe(target)
        for key in claims:
            first.delete_probe(key)
    result["cleanup"] = "verified release and one-attempt probe deletion"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Explicitly permit unique probe objects in the configured public bucket")
    parser.add_argument("--bucket", default="beeftv-components-1481187348")
    parser.add_argument("--region", default="ap-guangzhou")
    args = parser.parse_args()
    if not args.run:
        parser.error("No cloud requests without --run")
    try:
        print(json.dumps(probe(args.bucket, args.region), indent=2))
        return 0
    except PublishError as error:
        print(json.dumps({"status": "blocked", "reason": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
