import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import notes
import proxy
import study


class NotesSystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.patches = patch.multiple(
            proxy,
            CONFIG_DIR=base / "config",
            DATA_DIR=base / "data",
            DB_PATH=base / "data" / "data.db",
        )
        self.patches.start()
        study._schema_ready.clear()
        self.conn = proxy.db_connect()

    def tearDown(self):
        self.conn.close()
        self.patches.stop()
        self.temp.cleanup()

    def test_note_crud_search_and_version_conflict(self):
        created = notes.create_note(self.conn, {
            "title": "FSRS 复习",
            "tags": ["记忆", "IELTS"],
            "content_md": "# Forgetting curve\n\nActive recall improves long-term memory.\n\n## 中文\n遗忘曲线需要间隔复习。",
        })
        english = notes.list_notes(self.conn, {"q": ["active recall"]})["notes"]
        chinese = notes.list_notes(self.conn, {"q": ["遗忘曲线"]})["notes"]
        self.assertEqual([item["id"] for item in english], [created["id"]])
        self.assertEqual([item["id"] for item in chinese], [created["id"]])

        updated = notes.update_note(self.conn, created["id"], {"version": 1, "content_md": created["content_md"] + "\nGood.", "title": created["title"], "tags": created["tags"]})
        self.assertEqual(updated["version"], 2)
        self.assertEqual(notes.list_revisions(self.conn, created["id"]), [])
        with self.assertRaisesRegex(RuntimeError, "version_conflict"):
            notes.update_note(self.conn, created["id"], {"version": 1, "title": "stale"})

    def test_ai_draft_is_confirmed_and_preserves_revision(self):
        created = notes.create_note(self.conn, {"title": "Essay", "content_md": "Original", "tags": ["writing"]})
        draft, _ = notes.create_ai_draft(self.conn, created["id"], "polish", "clearer")
        notes.finish_ai_draft(self.conn, draft["id"], "Improved", "ready")
        updated = notes.apply_ai_draft(self.conn, draft["id"], {"version": created["version"], "mode": "replace"})
        self.assertEqual(updated["content_md"], "Improved")
        revisions = notes.list_revisions(self.conn, created["id"])
        self.assertEqual(revisions[0]["content_md"], "Original")
        self.assertEqual(revisions[0]["reason"], "ai")

    def test_empty_ai_draft_is_rejected(self):
        created = notes.create_note(self.conn, {"title": "Essay", "content_md": "Original"})
        draft, _ = notes.create_ai_draft(self.conn, created["id"], "organize", "")
        with self.assertRaisesRegex(ValueError, "不能为空"):
            notes.finish_ai_draft(self.conn, draft["id"], "  \n", "ready")
        stored = self.conn.execute("SELECT status,content_md FROM note_ai_drafts WHERE id=?", (draft["id"],)).fetchone()
        self.assertEqual((stored["status"], stored["content_md"]), ("generating", ""))

    def test_repeated_blank_note_creation_reuses_one_draft(self):
        first, reused = notes.create_or_reuse_blank_note(self.conn, {"title": "无标题笔记", "content_md": "", "tags": []})
        self.assertFalse(reused)
        second, reused = notes.create_or_reuse_blank_note(self.conn, {"title": "无标题笔记", "content_md": "", "tags": []})
        self.assertTrue(reused)
        self.assertEqual(first["id"], second["id"])
        renamed = notes.update_note(self.conn, first["id"], {"version": first["version"], "title": "开始记录", "content_md": "内容", "tags": []})
        third, reused = notes.create_or_reuse_blank_note(self.conn, {"title": "无标题笔记", "content_md": "", "tags": []})
        self.assertFalse(reused)
        self.assertNotEqual(renamed["id"], third["id"])

    def test_discard_ai_draft_removes_hidden_storage(self):
        created = notes.create_note(self.conn, {"title": "Draft source", "content_md": "Original"})
        draft, _ = notes.create_ai_draft(self.conn, created["id"], "organize", "")
        notes.finish_ai_draft(self.conn, draft["id"], "Temporary organized content", "ready")
        before = notes.storage_usage(self.conn)["bytes"]
        self.assertTrue(notes.discard_ai_draft(self.conn, draft["id"]))
        self.assertLess(notes.storage_usage(self.conn)["bytes"], before)
        self.assertFalse(notes.discard_ai_draft(self.conn, draft["id"]))

    def test_selected_notes_and_one_shot_full_search_are_scoped(self):
        first = notes.create_note(self.conn, {"title": "Cities", "content_md": "# Pollution\nUrban air pollution harms health."})
        second = notes.create_note(self.conn, {"title": "Education", "content_md": "# Learning\nActive recall helps students."})
        context, sources = notes.search_context(self.conn, "active recall", [first["id"]], False)
        self.assertTrue(sources)
        self.assertTrue(all(source["note_id"] == first["id"] for source in sources))
        all_context, all_sources = notes.search_context(self.conn, "active recall", [first["id"]], True)
        self.assertIn(second["id"], {source["note_id"] for source in all_sources})
        self.assertIn("[N1]", all_context)

    def test_ai_citations_only_accept_retrieved_sources(self):
        sources = [{"ref": "N1", "note_id": "one"}, {"ref": "N3", "note_id": "three"}]
        answer = "真实来源 [N1]，伪造来源 [N2]，另一个真实来源 [N3]。"
        cleaned = proxy.sanitize_note_citations(answer, sources)
        self.assertIn("[N1]", cleaned)
        self.assertIn("[N3]", cleaned)
        self.assertNotIn("[N2]", cleaned)

    def test_markdown_import_preview_update_and_zip_export(self):
        source = "---\nid: note-fixed\ntitle: Revision notes\nnotebook: Course\ntags: [exam, writing]\n---\n# Revision notes\n\nFirst version."
        preview = notes.import_preview(self.conn, [{"name": "revision.md", "content": source}])
        self.assertEqual(preview["files"][0]["status"], "create")
        result = notes.import_files(self.conn, [{"name": "revision.md", "content": source}])
        self.assertEqual(result["created"], 1)
        changed = source.replace("First version.", "Second version.")
        preview = notes.import_preview(self.conn, [{"name": "revision.md", "content": changed}])
        self.assertEqual(preview["files"][0]["status"], "update")
        result = notes.import_files(self.conn, [{"name": "revision.md", "content": changed}], confirm_updates=True)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(notes.get_note(self.conn, "note-fixed")["content_md"].strip(), "# Revision notes\n\nSecond version.")
        archive = zipfile.ZipFile(io.BytesIO(notes.export_notes_zip(self.conn)))
        names = archive.namelist()
        self.assertEqual(len(names), 1)
        self.assertTrue(names[0].startswith("Course/"))
        self.assertIn("id: \"note-fixed\"", archive.read(names[0]).decode())

    def test_quota_rejects_atomically_and_export_excludes_pending_drafts(self):
        created = notes.create_note(self.conn, {"title": "Small", "content_md": "1234"})
        draft, _ = notes.create_ai_draft(self.conn, created["id"], "summary", "")
        notes.finish_ai_draft(self.conn, draft["id"], "pending-secret-draft", "ready")
        exported = study.export_data(self.conn)
        encoded = str(exported)
        self.assertIn("Small", encoded)
        self.assertNotIn("pending-secret-draft", encoded)
        with patch.object(notes, "MAX_TOTAL_BYTES", notes.storage_usage(self.conn)["bytes"] + 2):
            with self.assertRaises(ValueError):
                notes.create_note(self.conn, {"title": "Too large", "content_md": "more"})
        self.assertIsNone(self.conn.execute("SELECT 1 FROM notes WHERE title='Too large'").fetchone())

    def test_batch_import_rolls_back_every_file_on_failure(self):
        files = [
            {"name": "one.md", "content": "---\nnotebook: Batch\n---\n# One\n\nFirst"},
            {"name": "two.md", "content": "---\nnotebook: Batch\n---\n# Two\n\nSecond"},
        ]
        original = notes.create_note
        calls = 0

        def fail_second(conn, payload, *, commit=True):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("simulated_import_failure")
            return original(conn, payload, commit=commit)

        with patch.object(notes, "create_note", side_effect=fail_second):
            with self.assertRaisesRegex(RuntimeError, "simulated_import_failure"):
                notes.import_files(self.conn, files)
        self.assertEqual(notes.list_notes(self.conn, {})["notes"], [])
        self.assertIsNone(self.conn.execute("SELECT 1 FROM notebooks WHERE name='Batch'").fetchone())


if __name__ == "__main__":
    unittest.main()
