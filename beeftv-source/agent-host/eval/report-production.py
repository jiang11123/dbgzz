"""Read-only production timing from the real Go and official Durable databases.

No model calls. Run with --profile <isolated desktop data> --run <evidence dir>.
The run must contain full-lifecycle.json or receipt.json with canvas/session/start.
Money comes from the reconciled receipt, never the SDK's provider cost defaults.
"""
import argparse
from contextlib import contextmanager
import datetime
import json
import pathlib
import sqlite3


def millis(value):
    if not value:
        return None
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000


def wall(intervals):
    """Union overlapping intervals; parallel jobs must not inflate wall time."""
    total, previous = 0, None
    for start, end in sorted((a, b) for a, b in intervals if a is not None and b is not None):
        if end < start:
            raise ValueError("negative timing interval")
        if previous is None or start > previous[1]:
            total += end - start
            previous = [start, end]
        elif end > previous[1]:
            total += end - previous[1]
            previous[1] = end
    return round(total / 1000, 3)


@contextmanager
def read_db(path):
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
    finally:
        connection.close()


def report(profile, run, existing=False):
    receipt_path = run / "full-lifecycle.json"
    if not receipt_path.exists():
        receipt_path = run / "receipt.json"
    receipt = json.loads(receipt_path.read_text())
    start = millis(receipt["startedAt"])
    # The same Durable session can later receive edits or a read-only review.
    # Re-reading its database must not change an already completed run's score.
    finish = millis(receipt["finishedAt"]) if receipt.get("finishedAt") else None
    elapsed = receipt.get("seconds", receipt.get("elapsedSeconds"))
    if finish is None and isinstance(elapsed, (int, float)):
        finish = start + elapsed * 1000
    in_run = lambda timestamp: timestamp is not None and timestamp >= start and (finish is None or timestamp <= finish)
    session = receipt["sessionId"].removeprefix("durable:")
    databases = list((profile / "sessions").rglob(session + ".sqlite"))
    if len(databases) != 1:
        raise ValueError("expected exactly one official session database")
    with read_db(databases[0]) as db:
        entries = [json.loads(row["record"]) for row in db.execute("SELECT record FROM entries")]
    root = next(entry["conversationId"] for entry in entries if entry["kind"] == "pi.user")
    messages = [message for entry in entries if entry.get("conversationId") == root and entry["kind"] == "pi.assistant"
                for message in entry.get("model", []) if message.get("role") == "assistant" and in_run(message["timestamp"])]
    auxiliary = [message for entry in entries if entry.get("conversationId") != root
                 for message in entry.get("model", []) if message.get("role") == "assistant" and in_run(message["timestamp"])]
    if not messages:
        raise ValueError("no main model responses for this run")
    with read_db(profile / "open_ai_canvas.db") as db:
        tasks = [dict(row) for row in db.execute("SELECT id,type,status,created_at,started_at,completed_at FROM tasks WHERE project_id=?", (receipt["canvasId"],))]
        tasks = [task for task in tasks if in_run(millis(task["created_at"]))]
        turn_ids = {row[0] for row in db.execute("SELECT turn_id FROM assistant_turns WHERE canvas_id=? AND durable_session_id=?", (receipt["canvasId"], receipt["sessionId"]))}
        operations = [dict(row) for row in db.execute("SELECT op,turn_id,result_json,updated_at FROM agent_op_records WHERE status='succeeded'")]
        operations = [row for row in operations if row["turn_id"] in turn_ids and in_run(millis(row["updated_at"]))]
        logs = [dict(row) for row in db.execute("SELECT task_id,payload,created_at FROM task_logs WHERE payload LIKE ?", ('{"phase":"result_transfer_%"}',))]
    generations = [task for task in tasks if task["type"] in ("canvas_image", "canvas_video", "canvas_audio")]
    render_ids = {json.loads(row["result_json"]).get("taskId") for row in operations if row["op"] == "canvas.timeline.render"}
    renders = [task for task in tasks if task["type"] == "timeline_render" and task["id"] in render_ids]
    ready = start if existing else None
    limitations = []
    if not existing and generations and all(task["status"] == "succeeded" and task["completed_at"] for task in generations):
        ready = max(millis(task["completed_at"]) for task in generations)
        generated_ids = {task["id"] for task in generations}
        for row in operations:
            value = json.loads(row["result_json"])
            if row["op"] == "canvas.task.bind" and value.get("taskId") in generated_ids and value.get("bindingStatus") == "bound":
                ready = max(ready, millis(row["updated_at"]))
    exports = [millis(row["updated_at"]) for row in operations if row["op"] == "canvas.project.export"]
    rendered = [millis(task["completed_at"]) for task in renders if task["status"] == "succeeded"]
    outputs_ready = max(max(exports), max(rendered)) if exports and rendered else None
    final = messages[-1]
    final_text = final.get("stopReason") == "stop" and not any(item.get("type") == "toolCall" for item in final.get("content", []))
    nonfinal = messages[:-1] if final_text else messages
    after = [message for message in nonfinal if ready is not None and message["timestamp"] >= ready]
    end = final["timestamp"] + final.get("durationMs", 0)
    transfer, supplier, saving = [], [], []
    for task in generations:
        boundaries = [(json.loads(row["payload"]).get("phase"), millis(row["created_at"])) for row in logs if row["task_id"] == task["id"]]
        begins = [time for phase, time in boundaries if phase == "result_transfer_start"]
        ends = [time for phase, time in boundaries if phase == "result_transfer_end"]
        if begins and ends:
            supplier.append((millis(task["started_at"]), min(begins)))
            transfer.append((min(begins), max(ends)))
            saving.append((max(ends), millis(task["completed_at"])))
    if len(transfer) != len(generations):
        limitations.append("Some channels return inline media or lack transfer boundaries; their generation and transfer cannot be separated. Unknown is not zero.")
    seconds = lambda value: round((value - ready) / 1000, 3) if ready is not None and value is not None else None
    result = {
        "source": "actual Go SQLite + official Durable SQLite; no simulator", "canvasId": receipt["canvasId"],
        "totalSeconds": round((end - start) / 1000, 3), "materialsReadyAtMs": ready,
        "outputsReadySecondsAfterMaterials": seconds(outputs_ready), "completedSecondsAfterMaterials": seconds(end),
        "nonFinalResponsesAfterMaterials": len(after) if ready is not None else None,
        "modelResponsesUntilOutputsReady": sum(message["timestamp"] < outputs_ready for message in after) if outputs_ready is not None else None,
        "finalExplanationSeconds": round(final.get("durationMs", 0) / 1000, 3) if final_text else None,
        "mainModelResponses": len(messages), "modelErrors": sum(message.get("stopReason") == "error" for message in messages),
        "nativeAuxiliaryAssistantEntries": len(auxiliary),
        "committedCompactions": sum(entry["kind"] == "pi.compaction" for entry in entries),
        "observedModelWallSeconds": wall((message["timestamp"], message["timestamp"] + message.get("durationMs", 0)) for message in messages + auxiliary),
        "modelWallSeconds": wall((message["timestamp"], message["timestamp"] + message.get("durationMs", 0)) for message in messages),
        "generationAndPersistenceWallSeconds": wall((millis(task["started_at"]), millis(task["completed_at"])) for task in generations),
        "renderWallSeconds": wall((millis(task["started_at"]), millis(task["completed_at"])) for task in renders),
        "observedSupplierWaitWallSeconds": wall(supplier) if supplier else None,
        "observedTransferWallSeconds": wall(transfer) if transfer else None,
        "observedSaveWallSeconds": wall(saving) if saving else None,
        "tasksWithTransferBoundaries": len(transfer), "actualCostCNY": receipt.get("actualCNY"),
        "limitations": limitations, "tasks": tasks,
        "modelCalls": [{"startedAtMs": message["timestamp"], "durationMs": message.get("durationMs"), "stopReason": message.get("stopReason"),
                        "tools": [item["name"] for item in message.get("content", []) if item.get("type") == "toolCall"]} for message in messages],
    }
    (run / "performance.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=pathlib.Path, required=True)
    parser.add_argument("--run", type=pathlib.Path, required=True)
    parser.add_argument("--existing-media", action="store_true")
    args = parser.parse_args()
    measured = report(args.profile, args.run, args.existing_media)
    print(json.dumps({key: value for key, value in measured.items() if key not in ("tasks", "modelCalls")}, ensure_ascii=False))
