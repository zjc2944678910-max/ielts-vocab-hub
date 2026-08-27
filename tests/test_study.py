import json
import base64
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import proxy
import study


class StudySystemTests(unittest.TestCase):
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

    def test_catalog_counts_and_curated_uniqueness(self):
        catalog_rows = {row["id"]: row for row in study.catalog_counts()}
        counts = {key: row["count"] for key, row in catalog_rows.items()}
        self.assertEqual(counts["ielts"], 185)
        self.assertGreater(counts["cet4"], 3000)
        self.assertGreater(counts["cet6"], 4000)
        self.assertGreater(catalog_rows["cet4"]["hidden_count"], 100)
        with study.catalog_connection() as catalog:
            self.assertEqual(
                catalog.execute("SELECT COUNT(*) FROM catalog_entries WHERE is_ielts=1").fetchone()[0],
                catalog.execute("SELECT COUNT(DISTINCT normalized) FROM catalog_entries WHERE is_ielts=1").fetchone()[0],
            )

    def test_foundation_filter_separates_lookup_from_study_pool(self):
        lookup_only = study.get_word(self.conn, "the")
        self.assertIsNotNone(lookup_only)
        self.assertFalse(lookup_only["is_cet4"])
        self.assertFalse(lookup_only["study_eligible"])
        word = study.get_word(self.conn, "system")
        self.assertEqual(word["study_tier"], 9)
        self.assertFalse(word["study_eligible"])
        self.assertIsNotNone(word)  # Still available to exact local lookup.
        filtered = study.library_page(self.conn, {"catalogs": ["cet4"], "search": ["system"], "limit": ["250"]})
        self.assertNotIn("system", [item["normalized"] for item in filtered["words"]])
        study.update_settings(self.conn, {"filter_basic_words": False})
        complete = study.library_page(self.conn, {"catalogs": ["cet4"], "search": ["system"], "limit": ["250"]})
        self.assertIn("system", [item["normalized"] for item in complete["words"]])

    def test_new_catalog_queue_filters_basics_but_existing_due_card_remains(self):
        study.update_settings(self.conn, {"enabled_catalogs": ["cet4"], "filter_basic_words": True, "daily_new_limit": 20})
        basic = study.get_word(self.conn, "system")
        card = study.ensure_card(self.conn, basic, "meaning")
        self.conn.commit()
        review = study.create_session(self.conn, {"mode": "review", "catalogs": ["cet4"]})
        self.assertEqual(review["engine"], "group")
        self.assertIn(card["id"], [item["card_id"] for item in review["words"]])
        learn = study.create_session(self.conn, {"mode": "learn", "catalogs": ["cet4"]})
        self.assertNotIn("system", [item["word"]["normalized"] for item in learn["words"]])
        self.assertTrue(all(item["word"].get("study_eligible", True) for item in learn["words"]))

    def test_related_topic_filter_returns_word_once(self):
        with study.catalog_connection() as catalog:
            row = catalog.execute("SELECT topic,related_topics_json FROM catalog_entries WHERE is_ielts=1 AND related_topics_json!='[]' LIMIT 1").fetchone()
        topic = json.loads(row["related_topics_json"])[0]
        page = study.library_page(self.conn, {"catalogs": ["ielts"], "topic": [topic], "limit": ["250"]})
        keys = [word["normalized"] for word in page["words"]]
        self.assertEqual(len(keys), len(set(keys)))

    def _due(self, card_id):
        return study.Card.from_json(self.conn.execute("SELECT fsrs_json FROM study_cards WHERE id=?", (card_id,)).fetchone()[0]).due

    def test_group_attempts_do_not_schedule_until_settle(self):
        word = study.get_word(self.conn, "objective")
        meaning = study.ensure_card(self.conn, word, "meaning")
        spelling = study.ensure_card(self.conn, word, "spelling")
        self.conn.commit()
        before_meaning = self._due(meaning["id"])
        before_spelling = self._due(spelling["id"])
        session = study.create_session(self.conn, {"mode": "review", "catalogs": ["ielts"], "limit": 1})
        self.assertEqual(session["current"]["kind"], "review_self")
        study.record_attempt(self.conn, session["id"], {"answer": "know"})
        self.assertEqual(self._due(meaning["id"]), before_meaning)
        self.assertEqual(self._due(spelling["id"]), before_spelling)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM review_logs").fetchone()[0], 0)
        settled = study.record_attempt(self.conn, session["id"], {"answer": "objective"})
        self.assertEqual(settled["status"], "complete")
        self.assertGreater(self._due(meaning["id"]), before_meaning)
        self.assertEqual(self._due(spelling["id"]), before_spelling)

    def test_learn_wrong_resets_streak_and_returns_word(self):
        session = study.create_session(self.conn, {"mode": "learn", "catalogs": ["ielts"], "limit": 1})
        word = session["words"][0]["word"]
        self.assertEqual(session["current"]["kind"], "meaning_mcq")
        study.record_attempt(self.conn, session["id"], {"answer": "definitely wrong"})
        mid = study.get_session(self.conn, session["id"])
        item = mid["words"][0]
        self.assertEqual(item["streak"], 0)
        self.assertTrue(item["unfamiliar"])
        self.assertEqual(mid["current"]["normalized"], word["normalized"])
        self.assertEqual(mid["current"]["kind"], "know_check")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM review_logs").fetchone()[0], 0)
        for _ in range(3):
            current = study.get_session(self.conn, session["id"])["current"]
            answer = "know" if current["kind"] == "know_check" else word["definition"]
            study.record_attempt(self.conn, session["id"], {"answer": answer})
        done = study.get_session(self.conn, session["id"])
        self.assertTrue(done["words"][0]["meaning_done"])
        self.assertEqual(done["phase"], "spelling")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM review_logs").fetchone()[0], 0)

    def test_learn_group_excludes_due_words_and_caps_size(self):
        word = study.get_word(self.conn, "objective")
        study.ensure_card(self.conn, word, "meaning")
        self.conn.commit()
        study.update_settings(self.conn, {"enabled_catalogs": ["ielts"], "daily_new_limit": 20})
        session = study.create_session(self.conn, {"mode": "learn", "catalogs": ["ielts"]})
        keys = [item["word"]["normalized"] for item in session["words"]]
        self.assertNotIn("objective", keys)
        self.assertLessEqual(len(session["words"]), 10)
        self.assertTrue(all(item["is_new"] for item in session["words"]))
        self.assertEqual(session["current"]["kind"], "meaning_mcq")

    def test_learn_three_consecutive_correct_marks_remembered(self):
        session = study.create_session(self.conn, {"mode": "learn", "catalogs": ["ielts"], "limit": 1})
        word = session["words"][0]["word"]
        study.record_attempt(self.conn, session["id"], {"answer": word["definition"]})
        study.record_attempt(self.conn, session["id"], {"answer": "know"})
        study.record_attempt(self.conn, session["id"], {"answer": "know"})
        done = study.get_session(self.conn, session["id"])
        self.assertTrue(done["words"][0]["meaning_done"])
        self.assertFalse(done["words"][0]["unfamiliar"])
        self.assertEqual(done["phase"], "spelling")
        self.assertEqual(done["current"]["kind"], "spelling")

    def test_free_dictation_does_not_create_card_until_wrong(self):
        session = study.create_session(self.conn, {"mode": "dictation", "catalogs": ["cet4"], "limit": 1})
        task = session["queue"][0]
        self.assertIsNone(task["card_id"])
        self.assertFalse(self.conn.execute("SELECT 1 FROM study_cards WHERE normalized=?", (task["word"]["normalized"],)).fetchone())
        study.record_attempt(self.conn, session["id"], {"task_index": 0, "answer": "definitely wrong"})
        row = self.conn.execute("SELECT * FROM study_cards WHERE normalized=? AND card_type='spelling'", (task["word"]["normalized"],)).fetchone()
        self.assertIsNotNone(row)
        self.assertLessEqual(study.Card.from_json(row["fsrs_json"]).due, datetime.now(timezone.utc) + timedelta(seconds=2))

    def test_empty_scope_retry_uses_only_requested_wrong_words(self):
        session = study.create_session(self.conn, {"mode": "dictation", "scopes": [], "catalogs": [], "words": ["objective"], "limit": 10})
        self.assertEqual([task["word"]["word"] for task in session["queue"]], ["objective"])

    def test_active_session_restores_attempt_history(self):
        session = study.create_session(self.conn, {"mode": "dictation", "catalogs": ["ielts"], "limit": 1})
        task = session["queue"][0]
        study.record_attempt(self.conn, session["id"], {"task_index": 0, "answer": task["word"]["word"], "duration_ms": 812, "replays": 2})
        restored = study.get_session(self.conn, session["id"])
        self.assertEqual(restored["attempts"][0]["duration_ms"], 812)
        self.assertEqual(restored["attempts"][0]["replays"], 2)

    def test_personal_manual_fields_override_curated_only_when_explicit(self):
        base = study.get_word(self.conn, "objective")
        stored = proxy.upsert_word({**base, "definition": "不应覆盖", "topic": "General Vocabulary", "manual_fields": [], "source": "legacy"}, preserve_existing=False)
        merged = study.get_word(self.conn, "objective")
        self.assertNotEqual(merged["definition"], "不应覆盖")
        self.conn.execute("UPDATE words SET definition=?,manual_fields_json=?,classification_source='manual' WHERE id=?", ("用户释义", '["definition"]', stored["id"]))
        self.conn.commit()
        self.assertEqual(study.get_word(self.conn, "objective")["definition"], "用户释义")

    def test_export_never_contains_api_key(self):
        payload = study.export_data(self.conn)
        encoded = json.dumps(payload)
        self.assertNotIn("api_key", encoded)
        self.assertNotIn("Authorization", encoded)

    def test_profile_and_theme_settings_are_validated(self):
        settings = study.update_settings(self.conn, {
            "profile_name": "  Jin   Cheng  ",
            "background_enabled": True,
            "background_overlay": 2,
            "button_color": "#234abc",
        })
        self.assertEqual(settings["profile_name"], "Jin Cheng")
        self.assertTrue(settings["background_enabled"])
        self.assertEqual(settings["background_overlay"], 0.92)
        self.assertEqual(settings["button_color"], "#234abc")
        settings = study.update_settings(self.conn, {"button_color": "javascript:bad"})
        self.assertEqual(settings["button_color"], "#234abc")

    def test_pronunciation_provider_is_validated(self):
        self.assertEqual(study.update_settings(self.conn, {"voice_provider": "google"})["voice_provider"], "google")
        self.assertEqual(study.update_settings(self.conn, {"voice_provider": "unknown"})["voice_provider"], "google")
        self.assertEqual(study.update_settings(self.conn, {"voice_provider": "system"})["voice_provider"], "system")

    def test_profile_images_use_fixed_private_paths(self):
        jpeg = b"\xff\xd8\xff" + (b"x" * 200) + b"\xff\xd9"
        encoded = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
        target = proxy.save_profile_image("avatar", encoded)
        self.assertEqual(target, proxy.DATA_DIR / "profile-avatar.jpg")
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(proxy.ApiFailure):
            proxy.save_profile_image("../outside", encoded)

    def test_recognition_pauses_and_production_resumes_spelling_history(self):
        word = study.get_word(self.conn, "objective")
        card = study.ensure_card(self.conn, word, "spelling")
        self.conn.commit()
        recognition = {**word, "learning_mode": "recognition", "manual_fields": ["learning_mode"]}
        proxy.sync_learning_cards(self.conn, recognition)
        paused = self.conn.execute("SELECT * FROM study_cards WHERE id=?", (card["id"],)).fetchone()
        self.assertEqual(paused["suspended"], 1)
        production = {**recognition, "learning_mode": "production"}
        proxy.sync_learning_cards(self.conn, production)
        resumed = self.conn.execute("SELECT * FROM study_cards WHERE id=?", (card["id"],)).fetchone()
        self.assertEqual(resumed["suspended"], 0)
        self.assertEqual(resumed["id"], card["id"])


if __name__ == "__main__":
    unittest.main()
