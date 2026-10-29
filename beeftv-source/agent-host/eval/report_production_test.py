"""A prior render must never make a failed new run look delivered."""
import importlib.util
from contextlib import closing
import json
import pathlib
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("production", pathlib.Path(__file__).with_name("report-production.py"))
production = importlib.util.module_from_spec(spec)
spec.loader.exec_module(production)


class ProductionReportTest(unittest.TestCase):
    def test_reuses_canvas_but_not_old_render_or_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            profile, run = root / "profile", root / "run"
            (profile / "sessions").mkdir(parents=True)
            run.mkdir()
            (run / "receipt.json").write_text(json.dumps({"canvasId": "canvas", "sessionId": "durable:test", "startedAt": "2026-10-19T10:00:00Z", "seconds": 20}))
            with closing(sqlite3.connect(profile / "sessions/test.sqlite")) as db:
                db.execute("CREATE TABLE entries(record TEXT)")
                records = [{"kind": "pi.user", "conversationId": 1, "model": []}, {"kind": "pi.assistant", "conversationId": 1,
                            "model": [{"role": "assistant", "timestamp": 1792404000000, "durationMs": 1000, "stopReason": "stop", "content": []},
                                      {"role": "assistant", "timestamp": 1792404060000, "durationMs": 1000, "stopReason": "stop", "content": []}]}]
                db.executemany("INSERT INTO entries VALUES(?)", [(json.dumps(row),) for row in records])
                db.commit()
            with closing(sqlite3.connect(profile / "open_ai_canvas.db")) as db:
                db.executescript("""
                    CREATE TABLE tasks(id,type,status,created_at,started_at,completed_at,project_id);
                    CREATE TABLE assistant_turns(turn_id,canvas_id,durable_session_id);
                    CREATE TABLE agent_op_records(op,turn_id,result_json,updated_at,status);
                    CREATE TABLE task_logs(task_id,payload,created_at);
                """)
                old = "2026-10-19T09:00:00Z"
                new = "2026-10-19T10:00:00Z"
                db.executemany("INSERT INTO tasks VALUES(?,?,?,?,?,?,?)", [
                    ("old-render", "timeline_render", "succeeded", old, old, old, "canvas"),
                    ("old-image", "canvas_image", "succeeded", old, old, old, "canvas"),
                    ("new-render", "timeline_render", "failed", new, new, "2026-10-19T10:00:10Z", "canvas"),
                    ("later-render", "timeline_render", "succeeded", "2026-10-19T10:01:00Z", "2026-10-19T10:01:00Z", "2026-10-19T10:01:01Z", "canvas"),
                ])
                db.execute("INSERT INTO assistant_turns VALUES('turn','canvas','durable:test')")
                db.executemany("INSERT INTO agent_op_records VALUES(?,?,?,?,?)", [
                    ("canvas.timeline.render", "turn", '{"taskId":"new-render"}', new, "succeeded"),
                    ("canvas.project.export", "turn", '{"resourceId":"zip"}', "2026-10-19T10:00:05Z", "succeeded"),
                    ("canvas.timeline.render", "turn", '{"taskId":"later-render"}', "2026-10-19T10:01:00Z", "succeeded"),
                    ("canvas.project.export", "turn", '{"resourceId":"later-zip"}', "2026-10-19T10:01:02Z", "succeeded"),
                ])
                db.commit()
            result = production.report(profile, run, existing=True)
            self.assertIsNone(result["outputsReadySecondsAfterMaterials"])
            self.assertEqual(result["generationAndPersistenceWallSeconds"], 0)
            self.assertEqual(result["mainModelResponses"], 1)
            self.assertEqual(result["totalSeconds"], 1)
            self.assertEqual([task["id"] for task in result["tasks"]], ["new-render"])
            with closing(sqlite3.connect(profile / "open_ai_canvas.db")) as db:
                db.execute("UPDATE tasks SET status='succeeded' WHERE id='new-render'")
                db.commit()
            self.assertEqual(production.report(profile, run, existing=True)["outputsReadySecondsAfterMaterials"], 10)


if __name__ == "__main__":
    unittest.main()
