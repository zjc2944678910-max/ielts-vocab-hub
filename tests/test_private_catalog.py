import unittest
from pathlib import Path

from scripts.build_private_catalog import (
    OXFORD_SOURCE_MARKER,
    default_oxford_source_root,
    parse_exchange,
    parse_oxford_chinese,
    parse_oxford_noad,
)


class PrivateCatalogBuilderTests(unittest.TestCase):
    def test_oxford_chinese_parser_keeps_senses_and_bilingual_examples(self):
        xml = """<d:entry xmlns:d="http://www.apple.com/DTDs/DictionaryService-1.0.rng" d:title="comparison">
          <span class="gramb"><span class="ps">noun</span>
            <span class="semb"><span class="trg"><span class="ind">comparing</span><span class="trans">比较</span><span class="trans ty_pinyin">bǐjiào</span></span>
              <span class="exg"><span class="ex">for comparison</span><span class="trg"><span class="trans">以供比较</span></span></span>
            </span>
            <span class="semb"><span class="trg"><span class="trans">对比</span></span></span>
          </span>
        </d:entry>"""
        parsed = parse_oxford_chinese(xml, "", "")
        self.assertEqual([sense["definition"] for sense in parsed["senses"]], ["比较", "对比"])
        self.assertEqual(parsed["senses"][0]["examples"], [{"en": "for comparison", "cn": "以供比较"}])
        self.assertNotIn("bǐjiào", str(parsed))

    def test_noad_parser_is_explicitly_english_only(self):
        xml = """<d:entry xmlns:d="http://www.apple.com/DTDs/DictionaryService-1.0.rng" d:title="session">
          <span class="se1"><span class="pos">noun</span><span class="msDict"><span class="df">a meeting of a deliberative body</span><span class="eg"><span class="ex">a closed session</span></span></span></span>
        </d:entry>"""
        parsed = parse_oxford_noad(xml, "", "")
        self.assertEqual(parsed["senses"][0]["definition"], "a meeting of a deliberative body")
        self.assertEqual(parsed["senses"][0]["source"], "noad")

    def test_default_oxford_source_survives_products_bucket_move(self):
        root = default_oxford_source_root()
        expected = Path("/Users/zhangjincheng/Documents/GitHub/antigravity-workspace/output")
        if (expected / OXFORD_SOURCE_MARKER).is_file():
            self.assertEqual(root, expected)
            self.assertTrue((root / OXFORD_SOURCE_MARKER).is_file())

    def test_ecdict_exchange_produces_only_safe_morphology_aliases(self):
        aliases = list(parse_exchange("s:comparisons/p:compared/i:comparing/0:comparison", "comparison"))
        self.assertEqual(aliases, [
            ("comparisons", "comparison", "复数"),
            ("compared", "comparison", "过去式"),
            ("comparing", "comparison", "现在分词"),
        ])


if __name__ == "__main__":
    unittest.main()
