import random
import unittest
from unittest.mock import patch

import proxy
import speaking


class SpeakingBankTests(unittest.TestCase):
    def test_part_aliases_and_set_shape(self):
        sample = speaking.build_set("Part 1", rng=random.Random(0))
        self.assertEqual(sample["part"], "part1")
        self.assertEqual(len(sample["items"]), 3)
        self.assertEqual(sample["prep_seconds"], 0)
        self.assertEqual(sample["answer_seconds"], 45)
        self.assertTrue(sample["items"][0]["prompt"])

        cue = speaking.build_set("2", rng=random.Random(1))
        self.assertEqual(cue["part"], "part2")
        self.assertEqual(len(cue["items"]), 1)
        self.assertGreaterEqual(len(cue["items"][0]["bullets"]), 3)
        self.assertEqual(cue["prep_seconds"], 60)

        discussion = speaking.build_set("part3", rng=random.Random(2))
        self.assertEqual(discussion["part"], "part3")
        self.assertEqual(len(discussion["items"]), 3)
        self.assertTrue(discussion["context"])

    def test_unknown_part_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Part"):
            speaking.build_set("writing")

    def test_heuristic_stays_conservative_and_offers_upgrades(self):
        empty = speaking.heuristic_feedback(speaking.normalize_attempt({
            "part": "part1",
            "prompt": "Where is your hometown, and what is it known for?",
            "answer": "",
        }))
        self.assertLessEqual(empty["band_overall"], 4.5)
        self.assertGreaterEqual(len(empty["upgrades"]), 4)

        fuller = speaking.heuristic_feedback(speaking.normalize_attempt({
            "part": "part2",
            "topic": "Learning",
            "prompt": "Describe a skill you would like to learn",
            "bullets": ["what the skill is", "how you would learn it", "why this skill would be useful"],
            "answer": (
                "I think I would like to learn public speaking because it is very good for work. "
                "A lot of people need this skill nowadays. I would take a course and practise every week. "
                "It would help me explain ideas more clearly."
            ),
        }))
        self.assertLessEqual(fuller["band_overall"], 6.0)
        sources = {item["from"] for item in fuller["upgrades"]}
        self.assertTrue({"I think", "a lot of"} & sources)
        valid, reason = proxy._schema_valid(
            {key: fuller[key] for key in speaking.FEEDBACK_SCHEMA["required"]},
            speaking.FEEDBACK_SCHEMA,
        )
        self.assertTrue(valid, reason)

    def test_normalize_feedback_fills_short_model_output(self):
        attempt = speaking.normalize_attempt({
            "part": "part1",
            "prompt": "What kinds of food do you usually eat at home?",
            "answer": "I usually cook rice and vegetables because it is cheap and healthy.",
        })
        cleaned = speaking.normalize_feedback({
            "band_overall": 8.2,
            "fluency": {"band": 8, "comment": "还算连贯。"},
            "vocabulary": {"band": 7, "comment": "用词普通。"},
            "grammar": {"band": 7, "comment": "句子简单。"},
            "task": {"band": 7, "comment": "基本切题。"},
            "upgrades": [{"from": "cheap", "to": "affordable", "why": "更中性。"}],
            "model_answer": "",
        }, attempt=attempt)
        self.assertEqual(cleaned["band_overall"], 8.0)
        self.assertGreaterEqual(len(cleaned["upgrades"]), 4)
        self.assertTrue(cleaned["model_answer"])


class SpeakingApiTests(unittest.TestCase):
    def test_unconfigured_feedback_uses_local_heuristic(self):
        payload = {
            "part": "part1",
            "prompt": "Do you prefer cooking or eating out?",
            "answer": "I prefer cooking because I can control the oil and it costs less.",
        }
        with patch("proxy.public_config", return_value={"configured": False}), \
             patch("proxy.call_ai_json") as mocked:
            result = proxy.speaking_feedback(payload)
        mocked.assert_not_called()
        self.assertEqual(result["source"], "local")
        self.assertFalse(result["ai_available"])
        self.assertIn("band_overall", result["feedback"])

    def test_configured_feedback_uses_model_json(self):
        payload = {
            "part": "part3",
            "topic": "Learning",
            "prompt": "Should schools spend more time teaching practical skills?",
            "answer": "I would argue that schools should keep a balance because students still need academic training.",
        }
        model = {
            "band_overall": 6.5,
            "fluency": {"band": 6.5, "comment": "能展开，但例子偏少。"},
            "vocabulary": {"band": 6.5, "comment": "有立场词，细节不够准。"},
            "grammar": {"band": 6.0, "comment": "复合句还不多。"},
            "task": {"band": 6.5, "comment": "回答了问题，缺反方。"},
            "upgrades": [
                {"from": "keep a balance", "to": "strike a better balance", "why": "搭配更自然。"},
                {"from": "because", "to": "mainly because", "why": "因果更有层次。"},
                {"from": "students", "to": "school-leavers", "why": "按语境收窄。"},
                {"from": "academic training", "to": "a solid academic foundation", "why": "更具体。"},
            ],
            "model_answer": "I would argue that schools should strike a better balance. Practical skills help teenagers find work, but a solid academic foundation still matters. For example, coding is useful, yet students also need to evaluate information critically. If schools ignore either side, graduates leave unprepared.",
        }
        with patch("proxy.public_config", return_value={"configured": True}), \
             patch("proxy.call_ai_json", return_value=model) as mocked, \
             patch("proxy.current_ai_route", return_value={"task_profile": "ielts_writing"}):
            result = proxy.speaking_feedback(payload)
        mocked.assert_called_once()
        self.assertEqual(mocked.call_args.kwargs["task"], "ielts_writing")
        self.assertEqual(result["source"], "ai")
        self.assertEqual(result["feedback"]["band_overall"], 6.5)
        self.assertEqual(len(result["feedback"]["upgrades"]), 4)

    def test_model_failure_falls_back_locally(self):
        payload = {
            "part": "part1",
            "prompt": "What kind of weather do you enjoy most?",
            "answer": "I enjoy cool autumn weather because I can walk outside without feeling tired.",
        }
        with patch("proxy.public_config", return_value={"configured": True}), \
             patch("proxy.call_ai_json", side_effect=proxy.ApiFailure("upstream_error", "busy", 502)), \
             patch("proxy.current_ai_route", return_value={}):
            result = proxy.speaking_feedback(payload)
        self.assertEqual(result["source"], "local_fallback")
        self.assertTrue(result["feedback"]["notice"])
