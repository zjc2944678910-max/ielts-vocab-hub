#!/usr/bin/env python3
"""Build the private Oxford + ECDICT catalog used by the local app.

The output contains normalized, structured fields only.  Raw Oxford XML and
the source export databases are deliberately never copied into the catalog.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_OUTPUT = ROOT.parents[1] / "output"
DEFAULT_OUTPUT = Path.home() / ".local" / "share" / "ielts-vocab-hub" / "catalog-private.db"
ECDICT_COMMIT = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b"
ECDICT_SHA256 = "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf"
ECDICT_URL = f"https://raw.githubusercontent.com/skywind3000/ECDICT/{ECDICT_COMMIT}/ecdict.csv"
DICTIONARY_NS = "{http://www.apple.com/DTDs/DictionaryService-1.0.rng}"

CATEGORY_SOURCES = {
    "oxford_ielts": "oxford_dictionary",
    "oxford_toefl": "oxford_toefl",
    "oxford_gre": "oxford_gre",
    "oxford_cet4": "oxford_cet4",
    "oxford_cet6": "oxford_cet6",
    "oxford_kaoyan": "oxford_kaoyan",
    "oxford_tem8": "oxford_tem8",
    "oxford_sat": "oxford_sat",
}

EXCHANGE_LABELS = {
    "p": "过去式",
    "d": "过去分词",
    "i": "现在分词",
    "3": "第三人称单数",
    "r": "比较级",
    "t": "最高级",
    "s": "复数",
}


def clean(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def normalize(value: str | None) -> str:
    return clean(value).lower()


def unique(values: Iterable[Any], limit: int | None = None) -> list[Any]:
    result: list[Any] = []
    seen: set[str] = set()
    for value in values:
        if isinstance(value, dict):
            marker = json.dumps(value, ensure_ascii=False, sort_keys=True)
        else:
            marker = str(value)
        if not value or marker in seen:
            continue
        seen.add(marker)
        result.append(value)
        if limit and len(result) >= limit:
            break
    return result


def class_names(element: ET.Element) -> set[str]:
    return set((element.attrib.get("class") or "").split())


def text(element: ET.Element | None) -> str:
    return clean("".join(element.itertext())) if element is not None else ""


def descendants_with_class(element: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in element.iter() if name in class_names(child)]


def parse_xml(raw_xml: str) -> ET.Element | None:
    try:
        return ET.fromstring(raw_xml)
    except ET.ParseError:
        return None


def parent_map(element: ET.Element) -> dict[ET.Element, ET.Element]:
    return {child: parent for parent in element.iter() for child in parent}


def has_ancestor_class(
    element: ET.Element,
    parents: dict[ET.Element, ET.Element],
    class_name: str,
    stop: ET.Element,
) -> bool:
    current = parents.get(element)
    while current is not None and current is not stop:
        if class_name in class_names(current):
            return True
        current = parents.get(current)
    return False


def parse_oxford_chinese(raw_xml: str, summary: str, fallback_pos: str) -> dict[str, Any] | None:
    root = parse_xml(raw_xml)
    if root is None:
        return None
    parents = parent_map(root)
    senses: list[dict[str, Any]] = []
    grammar_blocks = descendants_with_class(root, "gramb")
    blocks = grammar_blocks or [root]
    for block in blocks:
        pos = text(next(iter(descendants_with_class(block, "ps")), None)) or clean(fallback_pos)
        sense_blocks = descendants_with_class(block, "semb")
        for sense_block in sense_blocks:
            translations = []
            for candidate in descendants_with_class(sense_block, "trans"):
                if "ty_pinyin" in class_names(candidate):
                    continue
                if has_ancestor_class(candidate, parents, "exg", sense_block):
                    continue
                value = text(candidate)
                if re.search(r"[\u3400-\u9fff]", value):
                    translations.append(value)
            definition = "；".join(unique(translations, 12))
            if not definition:
                continue
            gloss = text(next(iter(descendants_with_class(sense_block, "ind")), None))
            examples = []
            for example_group in descendants_with_class(sense_block, "exg"):
                english = text(next(iter(descendants_with_class(example_group, "ex")), None))
                english = english or text(next(iter(descendants_with_class(example_group, "con")), None))
                chinese = next((
                    text(candidate)
                    for candidate in descendants_with_class(example_group, "trans")
                    if "ty_pinyin" not in class_names(candidate) and re.search(r"[\u3400-\u9fff]", text(candidate))
                ), "")
                if english:
                    examples.append({"en": english, "cn": chinese})
            senses.append({
                "pos": pos,
                "definition": definition,
                "definition_en": gloss,
                "examples": unique(examples, 6),
                "source": "oxford",
            })
    if not senses:
        fallback = clean(summary)
        if re.search(r"[\u3400-\u9fff]", fallback):
            senses = [{
                "pos": clean(fallback_pos), "definition": fallback, "definition_en": "",
                "examples": [], "source": "oxford",
            }]
    if not senses:
        return None
    return {"senses": unique(senses, 40)}


def parse_oxford_noad(raw_xml: str, summary: str, fallback_pos: str) -> dict[str, Any] | None:
    root = parse_xml(raw_xml)
    if root is None:
        return None
    parents = parent_map(root)
    senses: list[dict[str, Any]] = []
    for definition_element in descendants_with_class(root, "df"):
        definition = text(definition_element)
        if not definition:
            continue
        container = parents.get(definition_element)
        while container is not None and not ({"msDict", "se2", "subEntry"} & class_names(container)):
            container = parents.get(container)
        scope = container if container is not None else root
        pos = ""
        current = definition_element
        while current is not None and current is not root:
            candidate = next(iter(descendants_with_class(current, "pos")), None)
            if candidate is not None:
                pos = text(candidate)
                break
            current = parents.get(current)
        if not pos:
            preceding = descendants_with_class(root, "pos")
            pos = text(preceding[0]) if preceding else clean(fallback_pos)
        examples = [{"en": text(example), "cn": ""} for example in descendants_with_class(scope, "ex") if text(example)]
        senses.append({
            "pos": pos,
            "definition": definition,
            "definition_en": definition,
            "examples": unique(examples, 4),
            "source": "noad",
        })
    if not senses and clean(summary):
        senses = [{
            "pos": clean(fallback_pos), "definition": clean(summary), "definition_en": clean(summary),
            "examples": [], "source": "noad",
        }]
    return {"senses": unique(senses, 40)} if senses else None


def merge_parsed_rows(rows: list[sqlite3.Row], source: str) -> dict[str, Any] | None:
    senses: list[dict[str, Any]] = []
    words: list[str] = []
    phonetic_uk = phonetic_us = ""
    parser = parse_oxford_chinese if source == "oxford" else parse_oxford_noad
    for row in rows:
        parsed = parser(row["raw_xml"], row["definition_summary"], row["pos"])
        if not parsed:
            continue
        words.append(clean(row["word"]))
        phonetic_uk = phonetic_uk or clean(row["phonetic_uk"])
        phonetic_us = phonetic_us or clean(row["phonetic_us"])
        senses.extend(parsed["senses"])
    senses = unique(senses, 80)
    if not senses:
        return None
    examples = unique((example for sense in senses for example in sense.get("examples", [])), 16)
    return {
        "word": words[0],
        "phonetic_uk": phonetic_uk,
        "phonetic_us": phonetic_us,
        "pos": " / ".join(unique((sense.get("pos", "") for sense in senses), 4)),
        "definition": "；".join(unique((sense.get("definition", "") for sense in senses), 4)),
        "senses": senses,
        "examples": examples,
    }


def source_checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def download_ecdict() -> Path:
    target = Path(tempfile.mkdtemp(prefix="ielts-private-ecdict-")) / "ecdict.csv"
    with urllib.request.urlopen(ECDICT_URL, timeout=180) as response, target.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    return target


def verify_ecdict(path: Path) -> None:
    digest = source_checksum(path)
    if digest != ECDICT_SHA256:
        raise SystemExit(f"ECDICT checksum mismatch: {digest}")


def create_private_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE dictionary_entries (
          normalized TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('oxford','ecdict','noad')),
          word TEXT NOT NULL,
          phonetic_uk TEXT NOT NULL DEFAULT '',
          phonetic_us TEXT NOT NULL DEFAULT '',
          pos TEXT NOT NULL DEFAULT '',
          definition TEXT NOT NULL DEFAULT '',
          senses_json TEXT NOT NULL DEFAULT '[]',
          examples_json TEXT NOT NULL DEFAULT '[]',
          PRIMARY KEY(normalized, source)
        );
        CREATE INDEX idx_dictionary_source_word ON dictionary_entries(source, normalized);
        CREATE TABLE dictionary_alias_candidates (
          alias TEXT NOT NULL, normalized TEXT NOT NULL, label TEXT NOT NULL,
          PRIMARY KEY(alias, normalized, label)
        );
        CREATE TABLE dictionary_aliases (
          alias TEXT NOT NULL, normalized TEXT NOT NULL, label TEXT NOT NULL,
          PRIMARY KEY(alias, normalized, label)
        );
        CREATE INDEX idx_dictionary_alias ON dictionary_aliases(alias);
        CREATE TABLE private_catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """
    )


def insert_dictionary_entry(conn: sqlite3.Connection, normalized: str, source: str, item: dict[str, Any]) -> None:
    conn.execute(
        """INSERT OR REPLACE INTO dictionary_entries
           (normalized,source,word,phonetic_uk,phonetic_us,pos,definition,senses_json,examples_json)
           VALUES(?,?,?,?,?,?,?,?,?)""",
        (
            normalized, source, item["word"], item.get("phonetic_uk", ""), item.get("phonetic_us", ""),
            item.get("pos", ""), item.get("definition", ""),
            json.dumps(item.get("senses", []), ensure_ascii=False, separators=(",", ":")),
            json.dumps(item.get("examples", []), ensure_ascii=False, separators=(",", ":")),
        ),
    )


def import_oxford(conn: sqlite3.Connection, path: Path, source: str, direction: str) -> dict[str, int]:
    source_conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    source_conn.row_factory = sqlite3.Row
    accepted = rejected = 0
    current_key = ""
    group: list[sqlite3.Row] = []

    def flush() -> None:
        nonlocal accepted, rejected, group, current_key
        if not group:
            return
        item = merge_parsed_rows(group, source)
        if item:
            insert_dictionary_entry(conn, current_key, source, item)
            accepted += 1
        else:
            rejected += len(group)
        group = []

    rows = source_conn.execute(
        """SELECT word,phonetic_uk,phonetic_us,pos,definition_summary,raw_xml
           FROM entries WHERE direction=? ORDER BY lower(trim(word)), id""",
        (direction,),
    )
    for row in rows:
        key = normalize(row["word"])
        if not re.fullmatch(r"[a-z][a-z0-9 .,'’&+/@_-]*", key, re.IGNORECASE):
            rejected += 1
            continue
        if current_key and key != current_key:
            flush()
        current_key = key
        group.append(row)
    flush()
    source_conn.close()
    conn.commit()
    return {"accepted_headwords": accepted, "rejected_rows": rejected}


def ecdict_senses(translation: str, pos: str) -> list[dict[str, Any]]:
    senses = []
    for part in unique(clean(line) for line in (translation or "").splitlines()):
        marker = re.match(r"^([a-z]+)\.\s*(.*)$", part, re.IGNORECASE)
        definition = marker.group(2) if marker else part
        if not definition or not re.search(r"[\u3400-\u9fff]", definition):
            continue
        senses.append({
            "pos": marker.group(1) if marker else clean(pos).split("/")[0],
            "definition": definition,
            "definition_en": "",
            "examples": [],
            "source": "ecdict",
        })
    return unique(senses, 24)


def parse_exchange(exchange: str, lemma: str) -> Iterable[tuple[str, str, str]]:
    for part in (exchange or "").split("/"):
        code, separator, values = part.partition(":")
        label = EXCHANGE_LABELS.get(code)
        if not separator or not label:
            continue
        for form in values.split(","):
            alias = normalize(form)
            if alias and alias != lemma and re.fullmatch(r"[a-z][a-z'-]*", alias):
                yield alias, lemma, label


def import_ecdict(conn: sqlite3.Connection, path: Path) -> dict[str, int]:
    verify_ecdict(path)
    accepted = rejected = alias_candidates = 0
    with path.open(encoding="utf-8-sig", newline="") as source_file:
        for row in csv.DictReader(source_file):
            word = clean(row.get("word"))
            key = normalize(word)
            translation = row.get("translation") or ""
            senses = ecdict_senses(translation, row.get("pos") or "")
            if not key or not re.fullmatch(r"[a-z][a-z0-9 .,'’&+/@_-]*", key, re.IGNORECASE) or not senses:
                rejected += 1
                continue
            item = {
                "word": word,
                "phonetic_uk": clean(row.get("phonetic")),
                "phonetic_us": clean(row.get("phonetic")),
                "pos": " / ".join(unique((sense["pos"] for sense in senses), 4)),
                "definition": "；".join(unique((sense["definition"] for sense in senses), 4)),
                "senses": senses,
                "examples": [],
            }
            insert_dictionary_entry(conn, key, "ecdict", item)
            accepted += 1
            for alias in parse_exchange(row.get("exchange") or "", key):
                conn.execute("INSERT OR IGNORE INTO dictionary_alias_candidates VALUES(?,?,?)", alias)
                alias_candidates += 1
            if accepted % 20_000 == 0:
                conn.commit()
    conn.execute(
        """INSERT INTO dictionary_aliases(alias,normalized,label)
           SELECT alias,MIN(normalized),MIN(label)
           FROM dictionary_alias_candidates
           GROUP BY alias
           HAVING COUNT(DISTINCT normalized)=1"""
    )
    conn.execute("DROP TABLE dictionary_alias_candidates")
    conn.commit()
    return {
        "accepted_headwords": accepted,
        "rejected_rows": rejected,
        "alias_candidates": alias_candidates,
        "safe_aliases": conn.execute("SELECT COUNT(*) FROM dictionary_aliases").fetchone()[0],
    }


def category_words(path: Path) -> set[str]:
    source = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    words = {
        normalize(row[0])
        for row in source.execute("SELECT word FROM oxford_entries")
        if re.fullmatch(r"[a-z][a-z0-9 .,'’&+/@_-]*", normalize(row[0]), re.IGNORECASE)
    }
    source.close()
    return words


def ensure_catalog_entry(conn: sqlite3.Connection, key: str, catalogs: list[str]) -> bool:
    existing = conn.execute("SELECT catalogs_json,source_tags_json FROM catalog_entries WHERE normalized=?", (key,)).fetchone()
    if existing:
        memberships = unique([*json.loads(existing[0] or "[]"), *catalogs])
        tags = unique([*json.loads(existing[1] or "[]"), "exam"])
        conn.execute(
            "UPDATE catalog_entries SET catalogs_json=?,source_tags_json=? WHERE normalized=?",
            (json.dumps(memberships, ensure_ascii=False, separators=(",", ":")), json.dumps(tags, ensure_ascii=False, separators=(",", ":")), key),
        )
        return True
    source = conn.execute(
        """SELECT * FROM dictionary_entries
           WHERE normalized=? AND source IN ('oxford','ecdict')
           ORDER BY CASE source WHEN 'oxford' THEN 0 ELSE 1 END LIMIT 1""",
        (key,),
    ).fetchone()
    if not source:
        return False
    source = dict(source)
    values = {
        "normalized": key,
        "word": source["word"],
        "phonetic": source["phonetic_uk"] or source["phonetic_us"],
        "pos": source["pos"],
        "definition": source["definition"],
        "band": "6.5",
        "module": "Oxford Exam Vocabulary",
        "topic": "General Vocabulary",
        "related_topics_json": "[]",
        "synonyms_json": "[]",
        "antonyms_json": "[]",
        "collocations_json": "[]",
        "examples_json": source["examples_json"],
        "note": "Oxford 本机私有词条",
        "catalogs_json": json.dumps(catalogs, ensure_ascii=False, separators=(",", ":")),
        "source_tags_json": '["exam"]',
        "is_ielts": 0,
        "is_cet4": 0,
        "is_cet6": 0,
        "bnc": 0,
        "frq": 0,
        "learning_mode": "recognition",
        "classification_source": "curated",
    }
    columns = [row[1] for row in conn.execute("PRAGMA table_info(catalog_entries)")]
    conn.execute(
        f"INSERT INTO catalog_entries({','.join(columns)}) VALUES({','.join('?' for _ in columns)})",
        [values[column] for column in columns],
    )
    return True


def import_categories(conn: sqlite3.Connection, source_root: Path) -> dict[str, dict[str, int]]:
    memberships: dict[str, list[str]] = {}
    raw_counts: dict[str, int] = {}
    for category_id, directory in CATEGORY_SOURCES.items():
        path = source_root / directory / "oxford_dictionary.db"
        if not path.exists():
            raise SystemExit(f"Missing category export: {path}")
        words = category_words(path)
        raw_counts[category_id] = len(words)
        for word in words:
            memberships.setdefault(word, []).append(category_id)
    accepted = {category_id: 0 for category_id in CATEGORY_SOURCES}
    rejected = {category_id: 0 for category_id in CATEGORY_SOURCES}
    for key, catalogs in memberships.items():
        if ensure_catalog_entry(conn, key, catalogs):
            for category_id in catalogs:
                accepted[category_id] += 1
        else:
            for category_id in catalogs:
                rejected[category_id] += 1
    conn.commit()
    return {
        category_id: {"input": raw_counts[category_id], "accepted": accepted[category_id], "rejected": rejected[category_id]}
        for category_id in CATEGORY_SOURCES
    }


def build(
    *,
    bilingual: Path,
    noad: Path,
    ecdict: Path,
    source_root: Path,
    base_catalog: Path,
    output: Path,
) -> dict[str, Any]:
    for path in (bilingual, noad, ecdict, base_catalog):
        if not path.exists():
            raise SystemExit(f"Missing source file: {path}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    if temporary.exists():
        temporary.unlink()
    source = sqlite3.connect(f"file:{base_catalog}?mode=ro", uri=True)
    target = sqlite3.connect(temporary)
    source.backup(target)
    source.close()
    target.row_factory = sqlite3.Row
    target.execute("PRAGMA journal_mode=DELETE")
    target.execute("PRAGMA synchronous=NORMAL")
    create_private_tables(target)

    oxford_stats = import_oxford(target, bilingual, "oxford", "en_zh")
    noad_stats = import_oxford(target, noad, "noad", "en_en")
    ecdict_stats = import_ecdict(target, ecdict)
    category_stats = import_categories(target, source_root)
    target.execute("INSERT OR REPLACE INTO private_catalog_meta VALUES('schema_version','1')")
    target.execute("INSERT OR REPLACE INTO private_catalog_meta VALUES('oxford_license_scope','local-private-only')")
    quick_check = target.execute("PRAGMA quick_check").fetchone()[0]
    target.execute("ANALYZE")
    target.commit()
    counts = {
        row["source"]: row["count"]
        for row in target.execute("SELECT source,COUNT(*) count FROM dictionary_entries GROUP BY source")
    }
    catalog_total = target.execute("SELECT COUNT(*) FROM catalog_entries").fetchone()[0]
    target.close()
    os.chmod(temporary, 0o600)
    temporary.replace(output)

    manifest = {
        "schema_version": 1,
        "scope": "local-private-only",
        "output": str(output),
        "sources": {
            "oxford_chinese": {"path": str(bilingual), "sha256": source_checksum(bilingual), **oxford_stats},
            "oxford_noad": {"path": str(noad), "sha256": source_checksum(noad), **noad_stats},
            "ecdict": {"commit": ECDICT_COMMIT, "sha256": ECDICT_SHA256, **ecdict_stats},
        },
        "dictionary_counts": counts,
        "catalog_entries": catalog_total,
        "categories": category_stats,
        "sqlite_quick_check": quick_check,
        "raw_oxford_xml_copied": False,
    }
    manifest_path = output.with_name(f"{output.stem}-manifest.json")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(manifest_path, 0o600)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=WORKSPACE_OUTPUT)
    parser.add_argument("--bilingual", type=Path)
    parser.add_argument("--noad", type=Path)
    parser.add_argument("--ecdict", type=Path)
    parser.add_argument("--base-catalog", type=Path, default=ROOT / "data" / "catalog.db")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    bilingual = args.bilingual or args.source_root / "oxford_full" / "oxford_chinese_unabridged_136k.db"
    noad = args.noad or args.source_root / "oxford_full" / "oxford_noad_unabridged_111k.db"
    ecdict = args.ecdict or download_ecdict()
    manifest = build(
        bilingual=bilingual, noad=noad, ecdict=ecdict, source_root=args.source_root,
        base_catalog=args.base_catalog, output=args.output.expanduser(),
    )
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
