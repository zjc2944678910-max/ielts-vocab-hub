import unittest
import json
from email.message import Message
import tempfile
import time
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import MagicMock, patch

import proxy
import notes
from proxy import ApiFailure, ai_translate_lookup, classify_for_storage, classify_heuristic, classify_with_ai, cleanup_stale_empty_chats, dictionary_lookup, fetch_google_pronunciation, get_or_classify_word, parse_cambridge, parse_cambridge_chinese


class CambridgeParserTests(unittest.TestCase):
    def make_chat_handler(self, events):
        handler = object.__new__(proxy.VocabApiHandler)
        handler.allowed_origin = lambda: "http://127.0.0.1:8080"
        handler.send_response = lambda _status: None
        handler.end_cors_headers = lambda _content_type: None
        handler.send_header = lambda _name, _value: None
        handler.end_headers = lambda: None
        handler.sse_event = lambda event, data: events.append((event, data))
        return handler

    def test_chat_stream_is_immediate_and_disables_deepseek_thinking(self):
        response = [
            b'data: {"choices":[{"delta":{"content":"A short answer."},"finish_reason":null}]}\n',
            b'data: {"choices":[{"delta":{"content":"<actions>[{\\"type\\":\\"save_word\\",\\"word\\":\\"answer\\"}]</actions>"},"finish_reason":"stop"}]}\n',
            b'data: [DONE]\n',
        ]
        config = {"base_url": "https://api.deepseek.com/v1/chat/completions", "model": "deepseek-v4-flash", "api_key": "test"}
        events = []
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with patch.multiple(proxy, CONFIG_DIR=base / "config", DATA_DIR=base / "data", DB_PATH=base / "data" / "data.db"), \
                 patch("proxy.read_config", return_value=config), \
                 patch("proxy.ai_request", return_value=response) as request:
                with proxy.db_connect() as conn:
                    now = proxy.now_iso()
                    conn.execute("INSERT INTO chats VALUES(?,?,?,?,?)", ("chat", "新对话", None, now, now))
                self.make_chat_handler(events).stream_chat("chat", {"content": "help"})
                request.assert_called_once()
                self.assertEqual(request.call_args.kwargs["thinking"], "disabled")
                with proxy.db_connect() as conn:
                    stored = conn.execute("SELECT content,status,actions_json FROM messages WHERE chat_id='chat' AND role='assistant'").fetchone()
        deltas = [data["text"] for event, data in events if event == "delta"]
        self.assertTrue(deltas)
        self.assertLess(len(deltas[0]), 256)
        self.assertNotIn("<actions>", "".join(deltas))
        self.assertEqual((stored["content"], stored["status"]), ("A short answer.", "complete"))
        self.assertIn("save_word", stored["actions_json"])

    def test_chat_stream_persists_retryable_error_instead_of_empty_success(self):
        response = [
            b'data: {"choices":[{"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\n',
            b'data: {"choices":[{"delta":{"content":""},"finish_reason":"length"}]}\n',
            b'data: [DONE]\n',
        ]
        config = {"base_url": "https://api.deepseek.com/v1/chat/completions", "model": "deepseek-v4-flash", "api_key": "test"}
        events = []
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with patch.multiple(proxy, CONFIG_DIR=base / "config", DATA_DIR=base / "data", DB_PATH=base / "data" / "data.db"), \
                 patch("proxy.read_config", return_value=config), \
                 patch("proxy.ai_request", return_value=response):
                with proxy.db_connect() as conn:
                    now = proxy.now_iso()
                    conn.execute("INSERT INTO chats VALUES(?,?,?,?,?)", ("chat", "新对话", None, now, now))
                self.make_chat_handler(events).stream_chat("chat", {"content": "help"})
                with proxy.db_connect() as conn:
                    stored = conn.execute("SELECT content,status FROM messages WHERE chat_id='chat' AND role='assistant'").fetchone()
        self.assertEqual(stored["status"], "error")
        self.assertTrue(stored["content"])
        self.assertIn("输出额度", stored["content"])
        self.assertEqual([event for event, _data in events][-1], "error")

    def test_note_draft_budget_scales_for_deepseek_v4_only(self):
        deepseek = {
            "base_url": "https://api.deepseek.com/v1/chat/completions",
            "model": "deepseek-v4-flash",
        }
        generic = {"base_url": "https://example.test/v1/chat/completions", "model": "generic"}
        self.assertGreater(proxy.note_draft_token_budget("中" * 6183, deepseek), 2600)
        self.assertLessEqual(proxy.note_draft_token_budget("中" * 100_000, deepseek), 32_768)
        self.assertEqual(proxy.note_draft_token_budget("中" * 6183, generic), 2600)

    def test_ai_stream_reports_length_and_merges_repeated_boundary(self):
        response = [
            b'data: {"choices":[{"delta":{"content":"## Title\\npart one"},"finish_reason":null}]}\n',
            b'data: {"choices":[{"delta":{"content":""},"finish_reason":"length"}]}\n',
            b'data: [DONE]\n',
        ]
        content, reason = proxy.read_ai_stream(response)
        self.assertEqual((content, reason), ("## Title\npart one", "length"))
        merged, addition = proxy.merge_ai_continuation(content, "part one and two")
        self.assertEqual(merged, "## Title\npart one and two")
        self.assertEqual(addition, " and two")
        merged, addition = proxy.merge_ai_continuation("word", "different")
        self.assertEqual((merged, addition), ("worddifferent", "different"))

    def test_ai_request_can_disable_deepseek_thinking(self):
        response = MagicMock()
        config = {
            "base_url": "https://api.deepseek.com/v1/chat/completions",
            "model": "deepseek-v4-flash",
            "api_key": "test-key",
        }
        with patch("proxy.urllib.request.urlopen", return_value=response) as request:
            result = proxy.ai_request(
                [{"role": "user", "content": "organize"}],
                config=config,
                stream=True,
                thinking="disabled",
            )
        self.assertIs(result, response)
        body = json.loads(request.call_args.args[0].data)
        self.assertEqual(body["thinking"], {"type": "disabled"})

    def test_access_user_can_claim_legacy_notes_once_with_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            legacy_id = "1" * 64
            access_id = "2" * 64
            with patch.multiple(proxy, PUBLIC_MODE=True, DATA_DIR=base / "data"):
                proxy.set_public_visitor(legacy_id)
                with proxy.db_connect() as conn:
                    notes.create_note(conn, {"title": "旧笔记", "content_md": "# Legacy\n\nKeep me."})

                proxy.set_public_visitor(access_id)
                proxy.REQUEST_CONTEXT.identity_mode = "access"
                proxy.REQUEST_CONTEXT.legacy_visitor = legacy_id
                result = proxy.claim_legacy_data()
                self.assertTrue(result["ok"])
                with proxy.db_connect() as conn:
                    migrated = notes.list_notes(conn, {})["notes"]
                self.assertEqual([item["title"] for item in migrated], ["旧笔记"])
                self.assertTrue((proxy.request_data_dir() / "backups" / result["backup"] / "data.db").exists())
                self.assertTrue((base / "data" / "visitors" / legacy_id / ".claimed.json").exists())
                with self.assertRaisesRegex(ApiFailure, "没有可迁移"):
                    proxy.claim_legacy_data()

    def test_public_api_configs_are_isolated_per_visitor(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with patch.multiple(proxy, PUBLIC_MODE=True, DATA_DIR=base / "data"):
                proxy.set_public_visitor("a" * 64)
                proxy.write_config({
                    "base_url": "https://alpha.example/v1/chat/completions",
                    "model": "alpha-model",
                    "api_key": "alpha-secret",
                })
                alpha_path = proxy.request_config_path()
                self.assertEqual(proxy.read_config()["model"], "alpha-model")
                self.assertEqual(alpha_path.stat().st_mode & 0o777, 0o600)

                proxy.set_public_visitor("b" * 64)
                self.assertIsNone(proxy.read_config())
                proxy.write_config({
                    "base_url": "https://beta.example/v1/chat/completions",
                    "model": "beta-model",
                    "api_key": "beta-secret",
                })
                beta_path = proxy.request_config_path()
                self.assertNotEqual(alpha_path, beta_path)
                self.assertEqual(proxy.read_config()["api_key"], "beta-secret")

                proxy.set_public_visitor("a" * 64)
                self.assertEqual(proxy.read_config()["api_key"], "alpha-secret")
                self.assertNotIn("api_key", proxy.public_config(proxy.read_config()))

    def test_google_pronunciation_validates_and_returns_audio(self):
        class Response:
            def __init__(self):
                self.headers = Message(); self.headers["Content-Type"] = "audio/mpeg"
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, _limit): return b"ID3" + b"audio" * 20
        proxy.PRONUNCIATION_CACHE.clear()
        with patch("proxy.urllib.request.urlopen", return_value=Response()) as request:
            self.assertTrue(fetch_google_pronunciation("vocabulary", "en-GB").startswith(b"ID3"))
            self.assertIn("translate.google.com/translate_tts", request.call_args.args[0].full_url)
        with self.assertRaises(ApiFailure):
            fetch_google_pronunciation("x" * 241)

    def test_stale_empty_chats_are_removed_without_touching_recent_or_used_chats(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with patch.multiple(proxy, CONFIG_DIR=base / "config", DATA_DIR=base / "data", DB_PATH=base / "data" / "data.db"):
                with proxy.db_connect() as conn:
                    recent = datetime.now(timezone.utc).isoformat(timespec="seconds")
                    old = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(timespec="seconds")
                    conn.executemany("INSERT INTO chats VALUES(?,?,?,?,?)", [
                        ("old-empty", "新对话", None, old, old),
                        ("recent-empty", "新对话", None, recent, recent),
                        ("old-used", "已使用", None, old, old),
                    ])
                    conn.execute("INSERT INTO messages(id,chat_id,role,content,status,actions_json,created_at,citations_json) VALUES(?,?,?,?,?,?,?,?)", ("m1", "old-used", "user", "hello", "complete", "[]", old, "[]"))
                    self.assertEqual(cleanup_stale_empty_chats(conn), 1)
                    remaining = {row[0] for row in conn.execute("SELECT id FROM chats")}
        self.assertEqual(remaining, {"recent-empty", "old-used"})

    def test_chinese_english_parser_returns_multiple_expressions(self):
        page = """
        <h2 class="tw-bw dhw dpos-h_hw di-title" lang="zh-Hans">简化</h2>
        <span class="trans dtranszh lmr-10 hdib" lang="en"><a><span class="dtrans">simplification</span></a></span>
        <span class="pos dpos-zh lmr-10 hdib">noun</span><br><div class="def">the act of making something simpler</div>
        <span class="dtrans-egzh lmr-10 hdb" lang="en">This is a simplification.</span>
        <span class="dtrans-eg-transzh lmr-10 hdb" lang="zh-Hans">这是一种简化。</span>
        <span class="trans dtranszh lmr-10 hdib" lang="en"><a><span class="dtrans">streamline</span></a></span>
        <span class="pos dpos-zh lmr-10 hdib">verb</span><br><div class="def">to make a process more effective</div>
        <h2 class="tw-bw dhw dpos-h_hw di-title" lang="zh-Hans">简化地</h2>
        <span class="trans dtranszh lmr-10 hdib" lang="en"><span class="dtrans">simplistically</span></span>
        """
        item = parse_cambridge_chinese(page, "简化", "https://example.test/简化")
        self.assertEqual(item["direction"], "zh-en")
        self.assertEqual(item["heading_match"], "exact")
        self.assertEqual([entry["expression"] for entry in item["expressions"]], ["simplification", "streamline"])
        self.assertEqual(item["expressions"][0]["examples"][0]["cn"], "这是一种简化。")

    def test_chinese_phrase_falls_back_to_core_heading(self):
        page = """
        <h2 class="tw-bw dhw dpos-h_hw di-title" lang="zh-Hans">缓解</h2>
        <span class="trans dtranszh lmr-10 hdib" lang="en"><a><span class="dtrans">alleviate</span></a></span>
        <span class="pos dpos-zh lmr-10 hdib">verb</span><div class="def">to make a problem less severe</div>
        <span class="trans dtranszh lmr-10 hdib" lang="en"><span class="dtrans">ease</span></span>
        <span class="pos dpos-zh lmr-10 hdib">verb</span><div class="def">to make less unpleasant</div>
        <h2 class="tw-bw dhw dpos-h_hw di-title" lang="zh-Hans">缓解剂</h2>
        <span class="trans dtranszh lmr-10 hdib" lang="en"><span class="dtrans">mitigant</span></span>
        """
        item = parse_cambridge_chinese(page, "缓解压力", "https://example.test/缓解?q=缓解压力")
        self.assertEqual(item["heading_match"], "related")
        self.assertEqual(item["matched_heading"], "缓解")
        self.assertEqual([entry["expression"] for entry in item["expressions"]], ["alleviate", "ease"])

    def test_phrasal_verb_title_counts_as_exact_match(self):
        page = """
        <div class="pv-block"><div class="di-title"><h2 class="headword tw-bw dhw dpos-h_hw "><b>look <span class="obj dobj">something</span> up</b></h2></div>
        <span class="pos dpos">phrasal verb</span> with <span class="hw dhw">look</span>
        <span class="pos dpos">verb</span>
        <div class="def ddef_d db">to try to find information</div>
        <div class="def-body ddef_b"><span class="trans dtrans dtrans-se break-cj" lang="zh-Hans">查阅</span></div>
        </div>
        """
        item = parse_cambridge(page, "look up")
        self.assertTrue(item["exact"])
        self.assertEqual(item["match_kind"], "phrase")
        self.assertEqual(item["word"], "look up")
        self.assertEqual(item["definition"], "查阅")

    def test_leading_article_is_stripped_from_idiom_lookup(self):
        self.assertEqual(proxy.strip_english_article("a double-edged sword"), "double-edged sword")
        self.assertEqual(proxy.english_lookup_forms("a double-edged sword")[0], "double-edged sword")
        self.assertIn("double-edged-sword", proxy.cambridge_slugs("a double-edged sword"))
        self.assertTrue(proxy.lookup_equivalent("a double-edged sword", "double-edged sword"))
        page = """
        <span class="hw dhw">double-edged sword</span><span class="pos dpos">noun</span>
        <div class="def ddef_d db">something that has advantages and disadvantages</div>
        <div class="def-body ddef_b"><span class="trans dtrans dtrans-se break-cj" lang="zh-Hans">双刃剑</span></div>
        """
        item = parse_cambridge(page, "a double-edged sword")
        self.assertTrue(item["exact"])
        self.assertEqual(item["definition"], "双刃剑")
        self.assertEqual(item["match_kind"], "phrase")

    @patch("proxy.read_config", return_value={"configured": "yes"})
    @patch("proxy.google_translate_lookup", side_effect=proxy.ApiFailure("translate_unavailable", "down", 502))
    @patch("proxy.fetch_local_dictionary", side_effect=proxy.ApiFailure("word_not_found", "none", 404))
    @patch("proxy.fetch_oxford_dictionary", side_effect=proxy.ApiFailure("word_not_found", "none", 404))
    @patch("proxy.ai_translate_lookup", return_value={"query": "a double-edged sword", "direction": "en-zh", "source": "ai", "expressions": [{"expression": "a double-edged sword", "translation_cn": "双刃剑"}]})
    def test_smart_phrase_falls_back_to_ai_when_dictionaries_miss(self, ai_lookup, _oxford, _local, _google, _config):
        result = dictionary_lookup("a double-edged sword", "smart")
        self.assertEqual(result["mode"], "ai")
        self.assertEqual(result["fallback_from"], "google")
        ai_lookup.assert_called_once_with("a double-edged sword")

    def test_chinese_phrase_suggestions_prefer_matching_ielts_words(self):
        self.assertEqual(proxy.chinese_query_tokens("缓解压力"), ["缓解压力", "缓解", "压力"])
        suggestions = proxy.dictionary_suggestions("缓解压力", 8)
        words = [item["word"] for item in suggestions]
        self.assertIn("alleviate", words)
        self.assertLess(words.index("alleviate"), 3)

    @patch("proxy.call_ai_json", return_value={"expressions": [{
        "expression": "alleviate pressure", "translation_cn": "缓解压力",
        "pos_or_register": "IELTS writing", "explanation_cn": "正式表达",
        "examples": [{"en": "The policy may alleviate pressure.", "cn": "该政策可能缓解压力。"}],
    }]})
    def test_ai_translation_returns_safe_structured_candidates(self, _call):
        item = ai_translate_lookup("缓解压力")
        self.assertEqual(item["direction"], "zh-en")
        self.assertEqual(item["expressions"][0]["expression"], "alleviate pressure")
        self.assertEqual(item["expressions"][0]["examples"][0]["cn"], "该政策可能缓解压力。")

    @patch("proxy.call_ai_json", return_value={"key_expressions": [{
        "expression": "bear the brunt of", "translation_cn": "承受主要冲击",
        "pos_or_register": "phrase", "explanation_cn": "常见固定搭配", "examples": [],
    }]})
    def test_ai_translation_accepts_compatible_key_name(self, _call):
        item = ai_translate_lookup("bear the brunt of")
        self.assertEqual(item["direction"], "en-zh")
        self.assertEqual(item["expressions"][0]["translation_cn"], "承受主要冲击")

    @patch("proxy.call_ai_json", return_value={"expression": "a double-edged sword", "translation_cn": "一把双刃剑"})
    def test_ai_translation_heals_flat_object(self, _call):
        item = ai_translate_lookup("a double-edged sword")
        self.assertEqual(item["expressions"][0]["translation_cn"], "一把双刃剑")
        self.assertEqual(item["expressions"][0]["expression"], "a double-edged sword")

    @patch("proxy.read_config", return_value={"configured": "yes"})
    @patch("proxy.google_translate_lookup", side_effect=ApiFailure("translate_unavailable", "down", 502))
    @patch("proxy.ai_translate_lookup", return_value={"query": "缓解压力", "direction": "zh-en", "source": "ai", "expressions": [{"expression": "alleviate pressure"}]})
    def test_smart_chinese_falls_back_to_ai(self, ai_lookup, _google, _config):
        result = dictionary_lookup("缓解压力", "smart")
        self.assertEqual(result["mode"], "ai")
        self.assertEqual(result["fallback_from"], "google")
        ai_lookup.assert_called_once_with("缓解压力")

    @patch("proxy.ai_translate_lookup")
    @patch("proxy.google_translate_lookup", return_value={"query": "这是一个完整句子。", "direction": "zh-en", "source": "google", "expressions": [{"expression": "This is a complete sentence."}]})
    def test_smart_chinese_sentence_uses_google_before_ai(self, google_lookup, ai_lookup):
        result = dictionary_lookup("这是一个完整句子。", "smart")
        self.assertEqual(result["mode"], "google")
        google_lookup.assert_called_once()
        ai_lookup.assert_not_called()

    def test_google_translate_parser_reads_sentence_and_alternatives(self):
        payload = [
            [["双刃剑", "a double-edged sword", None, None, 3]],
            [["noun", [["双面刃", "double-edged sword", 0], ["双刃剑", "a double-edged sword", 0]]]],
            "en",
        ]
        self.assertEqual(proxy._google_translated_text(payload), "双刃剑")
        self.assertEqual(proxy._google_alternatives(payload, "双刃剑"), ["双面刃"])
        self.assertEqual(proxy._google_translated_text(["一把双刃剑"]), "一把双刃剑")

    @patch("proxy.urllib.request.urlopen")
    def test_google_translate_uses_chrome_endpoint(self, urlopen):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self): return b'["\xe4\xb8\x80\xe6\x8a\x8a\xe5\x8f\x8c\xe5\x88\x83\xe5\x89\x91"]'
        urlopen.return_value = Response()
        item = proxy.google_translate_lookup("a double-edged sword")
        self.assertEqual(item["source"], "google")
        self.assertEqual(item["definition"], "一把双刃剑")
        self.assertIn("clients5.google.com/translate_a/t", urlopen.call_args.args[0].full_url)
        self.assertIn("dict-chrome-ex", urlopen.call_args.args[0].full_url)

    def test_nested_markup_keeps_complete_translation_and_examples(self):
        page = """
        <span class="hw dhw">experience</span>
        <span class="pos dpos">noun</span>
        <span class="region dreg">uk</span><span class="ipa dipa">ɪkˈspɪə.ri.əns</span>
        <div class="ddef_h"><span class="epp-xref dxref B1">B1</span>
          <div class="def ddef_d db">knowledge from <a>doing</a> things</div>
        </div><div class="def-body ddef_b">
          <span class="trans dtrans dtrans-se  break-cj" lang="zh-Hans"><a><span>经验</span></a>;<a><span>经历</span></a></span>
          <div class="examp dexamp"><span class="eg deg">The best way to <a>learn</a> is <span>by</span> experience.</span>
          <span class="trans dtrans dtrans-se hdb break-cj" lang="zh-Hans">最好的学习方式是在实践中学习。</span></div>
          <div class="examp dexamp"><span class="eg deg">I <a>know</a> from experience.</span>
          <span class="trans dtrans dtrans-se hdb break-cj" lang="zh-Hans">这是经验之谈。</span></div>
        </div><div class="ddef_h"></div>
        """
        item = parse_cambridge(page, "experience")
        self.assertEqual(item["pos"], "noun")
        self.assertEqual(item["definition"], "经验；经历")
        self.assertEqual(item["examples"][0]["en"], "The best way to learn is by experience.")
        self.assertEqual(item["examples"][1]["en"], "I know from experience.")

    def test_definition_without_examples_still_uses_chinese(self):
        page = """
        <span class="hw dhw">fissure</span><span class="pos dpos">noun</span>
        <div class="def ddef_d db">a deep, narrow crack</div></div><div class="def-body ddef_b">
          <span class="trans dtrans dtrans-se  break-cj" lang="zh-Hans">（岩石或土地的）<a><span>裂缝</span></a>，裂隙</span>
        </div><div class="ddef_h"></div>
        """
        item = parse_cambridge(page, "fissure")
        self.assertEqual(item["definition"], "（岩石或土地的）裂缝，裂隙")
        self.assertEqual(item["examples"], [])

    def test_multiple_parts_of_speech_and_senses_are_preserved(self):
        page = """
        <span class="hw dhw">pan</span><span class="pos dpos">noun</span>
        <div class="def ddef_d db">a cooking container</div><div class="def-body ddef_b"><span class="trans dtrans dtrans-se  break-cj" lang="zh-Hans">平底锅</span></div>
        <div class="def ddef_d db">a toilet bowl</div><div class="def-body ddef_b"><span class="trans dtrans dtrans-se  break-cj" lang="zh-Hans">马桶</span></div>
        <span class="hw dhw">pan</span><span class="pos dpos">verb</span>
        <div class="def ddef_d db">to move a camera</div><div class="def-body ddef_b"><span class="trans dtrans dtrans-se  break-cj" lang="zh-Hans">摇摄</span></div>
        <span class="hw dhw">pan-</span><span class="pos dpos">prefix</span>
        <div class="def ddef_d db">all</div><div class="def-body ddef_b"><span class="trans dtrans dtrans-se  break-cj" lang="zh-Hans">全</span></div>
        """
        item = parse_cambridge(page, "pan")
        self.assertTrue(item["exact"])
        self.assertEqual([(sense["pos"], sense["definition"]) for sense in item["senses"]], [
            ("noun", "平底锅"), ("noun", "马桶"), ("verb", "摇摄"),
        ])

    def test_redirected_headword_is_not_treated_as_exact(self):
        page = """
        <span class="hw dhw">pot plant</span><span class="pos dpos">noun</span>
        <div class="def ddef_d db">a houseplant</div><div class="def-body ddef_b"><span class="trans dtrans dtrans-se  break-cj" lang="zh-Hans">室内盆栽植物</span></div>
        """
        item = parse_cambridge(page, "plant pot", "https://example.test/pot-plant?q=plant-pot")
        self.assertEqual(item["query"], "plant pot")
        self.assertEqual(item["headword"], "pot plant")
        self.assertFalse(item["exact"])
        self.assertEqual(item["match_kind"], "redirect")

    def test_regular_inflections_are_classified_conservatively(self):
        cases = [
            ("comparisons", "comparison", "noun", "复数"),
            ("compares", "compare", "verb", "第三人称单数"),
            ("compared", "compare", "verb", "过去式/过去分词"),
            ("comparing", "compare", "verb", "现在分词"),
            ("bigger", "big", "adjective", "比较级"),
            ("biggest", "big", "adjective", "最高级"),
        ]
        for query, headword, pos, label in cases:
            with self.subTest(query=query):
                self.assertEqual(proxy.inflection_label_for(query, headword, pos), label)
        self.assertEqual(proxy.inflection_label_for("plant pot", "pot plant", "noun"), "")
        self.assertEqual(proxy.inflection_label_for("better", "good", "adjective"), "")

    def test_cambridge_inflection_uses_the_lemma_chinese_meaning(self):
        page = """
        <span class="hw dhw">comparison</span><span class="pos dpos">noun</span>
        <div class="def ddef_d db">the act of comparing</div><div class="def-body ddef_b"><span class="trans dtrans dtrans-se break-cj" lang="zh-Hans">比较，对照，对比</span></div>
        """
        item = parse_cambridge(page, "comparisons")
        self.assertFalse(item["exact"])
        self.assertEqual(item["match_kind"], "inflection")
        self.assertEqual(item["word"], "comparison")
        self.assertEqual(item["definition"], "比较，对照，对比")
        self.assertEqual(item["inflection"], {"form": "comparisons", "headword": "comparison", "label": "复数"})

    @patch("proxy.call_ai_json", return_value={"word": "pot plant", "definition": "错误替换", "topic": "General Vocabulary"})
    def test_ai_classification_cannot_replace_headword_or_senses(self, _call):
        senses = [{"pos": "noun", "definition": "花盆", "source": "cambridge"}]
        item = classify_with_ai({"word": "plant pot", "definition": "花盆", "senses": senses, "source": "cambridge"})
        self.assertEqual(item["word"], "plant pot")
        self.assertEqual(item["senses"], senses)

    @patch("proxy.fetch_local_dictionary", side_effect=ApiFailure("word_not_found", "none", 404))
    @patch("proxy.fetch_oxford_dictionary", side_effect=ApiFailure("word_not_found", "none", 404))
    @patch("proxy.google_translate_lookup")
    def test_smart_lookup_uses_google_when_local_misses(self, google, _oxford, _local):
        google.return_value = {
            "query": "plant pot", "word": "plant pot", "headword": "plant pot", "exact": True,
            "definition": "花盆", "senses": [{"definition": "花盆", "source": "google"}], "source": "google",
        }
        result = dictionary_lookup("plant pot", "smart")
        self.assertEqual(result["mode"], "google")
        self.assertEqual(result["result"]["definition"], "花盆")
        google.assert_called_once()

    @patch("proxy.google_translate_lookup")
    @patch("proxy.fetch_local_dictionary")
    @patch("proxy.fetch_oxford_dictionary")
    def test_smart_lookup_stops_before_google_when_oxford_has_chinese(self, oxford, ecdict, google):
        oxford.return_value = {
            "word": "comparison", "headword": "comparison", "query": "comparisons",
            "exact": False, "match_kind": "inflection",
            "inflection": {"form": "comparisons", "headword": "comparison", "label": "复数"},
            "definition": "比较；对照；对比",
            "senses": [{"pos": "noun", "definition": "比较", "source": "oxford"}],
        }
        ecdict.side_effect = ApiFailure("word_not_found", "none", 404)
        result = dictionary_lookup("comparisons", "smart")
        self.assertEqual(result["result"]["word"], "comparison")
        self.assertEqual(result["result"]["match_kind"], "inflection")
        self.assertEqual(result["sources"][0]["id"], "oxford")
        google.assert_not_called()

    def test_dictionary_suggestions_use_local_prefix_index(self):
        suggestions = proxy.dictionary_suggestions("al", 8)
        self.assertTrue(suggestions)
        self.assertEqual(suggestions[0]["word"], "alleviate")
        self.assertTrue(all(item["word"].lower().startswith("al") for item in suggestions))

    @patch("proxy.fetch_free_dictionary", return_value={"word": "example", "definition": "a sample", "senses": [{"definition": "a sample"}]})
    def test_free_dictionary_can_be_requested_without_smart_fanout(self, free_lookup):
        result = dictionary_lookup("example", "free")
        self.assertEqual(result["sources"][0]["id"], "free")
        free_lookup.assert_called_once_with("example")

    def test_local_classifier_keeps_dictionary_result_available(self):
        item = classify_heuristic({
            "word": "equanimity",
            "pos": "noun",
            "definition": "镇静；沉着",
            "source": "cambridge",
        })
        self.assertEqual(item["definition"], "镇静；沉着")
        self.assertEqual(item["topic"], "General Vocabulary")
        self.assertTrue(item["auto_classified"])

    @patch("proxy.read_config", return_value={"configured": "yes"})
    @patch("proxy.classify_with_ai", side_effect=ApiFailure("upstream_error", "temporary failure", 502))
    def test_ai_failure_falls_back_to_local_classification(self, _classify, _config):
        item, mode = classify_for_storage({
            "word": "equanimity",
            "pos": "noun",
            "definition": "镇静；沉着",
            "source": "cambridge",
        })
        self.assertEqual(mode, "local")
        self.assertEqual(item["definition"], "镇静；沉着")
        self.assertTrue(item["auto_classified"])

    def test_concurrent_classification_calls_ai_once(self):
        entry = {"word": "equanimity", "pos": "noun", "definition": "镇静；沉着", "source": "cambridge"}
        calls = []

        def slow_classifier(item, _use_ai):
            calls.append(item["word"])
            time.sleep(0.04)
            return classify_heuristic(item), "ai"

        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with patch.multiple(proxy, CONFIG_DIR=base / "config", DATA_DIR=base / "data", DB_PATH=base / "data" / "data.db"), \
                 patch("proxy.classify_for_storage", side_effect=slow_classifier):
                with ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(pool.map(lambda _: get_or_classify_word(entry, True), range(2)))

        self.assertEqual(calls, ["equanimity"])
        self.assertEqual(sorted(result[1] for result in results), [False, True])
        self.assertEqual({result[0]["word"] for result in results}, {"equanimity"})


if __name__ == "__main__":
    unittest.main()
