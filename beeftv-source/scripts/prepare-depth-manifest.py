"""Verify built packages and prepare the unsigned payload for the signing job."""
import hashlib
import json
from pathlib import Path
import sys

BASE = "https://github.com/glanderness/BeefTV/releases/download/depth-runtime-v2/"


def verify_file(root, entry):
    name = entry["name"]
    if Path(name).name != name or "/" in name or "\\" in name:
        raise ValueError("unsafe artifact name")
    path = root / name
    if path.stat().st_size != entry["size"] or entry["size"] <= 0:
        raise ValueError("artifact size mismatch")
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != entry["sha256"]:
        raise ValueError("artifact hash mismatch")
    return {"urls": [BASE + name], "size": entry["size"], "sha256": digest}


def prepare(root):
    runtimes = {}
    for variant in ("cpu", "cuda"):
        name = f"beeftv-depth-runtime-v1-windows-amd64-{variant}.zip"
        meta = json.loads((root / (name + ".json")).read_text(encoding="utf-8-sig"))
        if meta["name"] != name or not 0 < meta["files"] <= 50000 or not 0 < meta["expandedSize"] <= 12 << 30:
            raise ValueError("invalid runtime metadata")
        if meta.get("parts"):
            parts = []
            whole = hashlib.sha256()
            for index, part in enumerate(meta["parts"], 1):
                if part["name"] != f"{name}.part-{index:03d}" or part["size"] >= 2 << 30:
                    raise ValueError("invalid release part")
                parts.append(verify_file(root, part))
                with (root / part["name"]).open("rb") as source:
                    while chunk := source.read(1024 * 1024):
                        whole.update(chunk)
            if sum(p["size"] for p in parts) != meta["size"] or whole.hexdigest() != meta["sha256"]:
                raise ValueError("assembled runtime mismatch")
            artifact = {"urls": [], "size": meta["size"], "sha256": meta["sha256"], "parts": parts}
        else:
            artifact = verify_file(root, meta)
        artifact.update(files=meta["files"], expandedSize=meta["expandedSize"])
        runtimes[f"windows-amd64/{variant}"] = artifact
    return {"version": 2, "runtimes": runtimes, "model": {
        "urls": ["https://github.com/glanderness/BeefTV/releases/download/v1.5.5/video_depth_anything_vits.pth"],
        "size": 116440756,
        "sha256": "13379300b739e659f076a59d52e9801bd8d38c541a7e71f73bbca4dcfb013609",
    }}


if __name__ == "__main__":
    Path(sys.argv[2]).write_text(json.dumps(prepare(Path(sys.argv[1])), separators=(",", ":")), encoding="utf-8")
