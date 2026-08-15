#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sqlite3
import subprocess
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ECDICT_COMMIT = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b"
ECDICT_SHA256 = "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf"
ECDICT_URL = f"https://raw.githubusercontent.com/skywind3000/ECDICT/{ECDICT_COMMIT}/ecdict.csv"


def clean(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def normalize(value: str) -> str:
    return clean(value).lower()


def unique(values):
    result = []
    for value in values or []:
        if value and value not in result:
            result.append(value)
    return result


def infer_pos(translation: str, fallback: str) -> str:
    aliases = {"vt": "verb", "vi": "verb", "v": "verb", "n": "noun", "adj": "adjective", "adv": "adverb", "prep": "preposition", "conj": "conjunction", "pron": "pronoun", "num": "number", "interj": "exclamation"}
    prefixes = re.findall(r"(?:^|\n)\s*([a-z]+)\.", translation.lower())
    mapped = unique(aliases.get(prefix) for prefix in prefixes if aliases.get(prefix))
    if mapped:
        return " / ".join(mapped)
    return clean(fallback).split("/")[0] if fallback else "word"


def compact_translation(value: str) -> str:
    lines = unique(clean(line) for line in value.splitlines())
    return "；".join(lines[:3])


def band_number(value: str) -> float:
    try:
        return float(re.search(r"\d+(?:\.\d+)?", value or "").group())
    except (AttributeError, ValueError):
        return 0.0


def download_ecdict() -> Path:
    target = Path(tempfile.mkdtemp(prefix="ielts-ecdict-")) / "ecdict.csv"
    with urllib.request.urlopen(ECDICT_URL, timeout=180) as response, target.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    return target


def verify(path: Path) -> None:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != ECDICT_SHA256:
        raise SystemExit(f"ECDICT checksum mismatch: {digest}")


def export_ielts(target: Path) -> list[dict]:
    subprocess.run(["node", str(ROOT / "scripts" / "export_ielts.js"), str(ROOT / "dict.js"), str(target)], check=True)
    return json.loads(target.read_text(encoding="utf-8"))


def merge_entry(base: dict | None, incoming: dict) -> dict:
    if not base:
        return incoming
    merged = dict(base)
    merged["is_ielts"] = int(bool(base["is_ielts"] or incoming["is_ielts"]))
    merged["is_cet4"] = int(bool(base["is_cet4"] or incoming["is_cet4"]))
    merged["is_cet6"] = int(bool(base["is_cet6"] or incoming["is_cet6"]))
    merged["catalogs"] = unique(base["catalogs"] + incoming["catalogs"])
    merged["source_tags"] = unique(base["source_tags"] + incoming["source_tags"])
    if incoming["is_ielts"]:
        for key, value in incoming.items():
            if key not in {"catalogs", "source_tags", "is_ielts", "is_cet4", "is_cet6", "bnc", "frq"} and value not in (None, "", [], {}):
                merged[key] = value
    merged["bnc"] = min(value for value in [base.get("bnc", 0), incoming.get("bnc", 0)] if value > 0) if any(value > 0 for value in [base.get("bnc", 0), incoming.get("bnc", 0)]) else 0
    merged["frq"] = min(value for value in [base.get("frq", 0), incoming.get("frq", 0)] if value > 0) if any(value > 0 for value in [base.get("frq", 0), incoming.get("frq", 0)]) else 0
    return merged


def build(ecdict_path: Path, output: Path) -> dict:
    verify(ecdict_path)
    with tempfile.TemporaryDirectory() as directory:
        ielts = export_ielts(Path(directory) / "ielts.json")
    frontend_catalog = output.parent / "ielts-catalog.js"
    frontend_catalog.parent.mkdir(parents=True, exist_ok=True)
    frontend_catalog.write_text(
        "window.ieltsCatalog = " + json.dumps(ielts, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    entries: dict[str, dict] = {}
    for item in ielts:
        key = normalize(item["word"])
        entry = {
            "normalized": key, "word": item["word"], "phonetic": item.get("phonetic", ""), "pos": item.get("pos", ""),
            "definition": item.get("definition", ""), "band": item.get("band", "6.5"), "module": item.get("module", "IELTS"),
            "topic": item.get("topic", "General Vocabulary"), "related_topics": item.get("related_topics", []),
            "synonyms": item.get("synonyms", []), "antonyms": item.get("antonyms", []), "collocations": item.get("collocations", []),
            "examples": item.get("examples", []), "note": item.get("paraphraseExamContext", ""), "catalogs": ["ielts"],
            "source_tags": ["ielts"], "is_ielts": 1, "is_cet4": 0, "is_cet6": 0, "bnc": 0, "frq": 0,
            "learning_mode": item.get("learning_mode", "recognition"), "classification_source": "curated"
        }
        entries[key] = merge_entry(entries.get(key), entry)

    with ecdict_path.open(encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            word, translation = clean(row.get("word")), row.get("translation", "").strip()
            if not word or not translation:
                continue
            tags = set((row.get("tag") or "").split())
            is_cet4, is_cet6 = "cet4" in tags, "cet6" in tags
            # Keep gk-only rows as lookup material, but never promote them to
            # CET-4 membership or expose them through study catalog filters.
            if not is_cet4 and not is_cet6 and "gk" not in tags:
                continue
            key = normalize(word)
            catalogs = (["cet4"] if is_cet4 else []) + (["cet6"] if is_cet6 else [])
            module = " / ".join(label for enabled, label in [(is_cet4, "CET-4"), (is_cet6, "CET-6")] if enabled) or "Local Dictionary"
            entry = {
                "normalized": key, "word": word, "phonetic": clean(row.get("phonetic")), "pos": infer_pos(translation, row.get("pos", "")),
                "definition": compact_translation(translation), "band": "6.5" if is_cet6 else "6.0", "module": module,
                "topic": "General Vocabulary", "related_topics": [], "synonyms": [], "antonyms": [], "collocations": [], "examples": [],
                "note": "ECDICT 离线词条", "catalogs": catalogs, "source_tags": sorted(tags & {"gk", "cet4", "cet6"}),
                "is_ielts": 0, "is_cet4": int(is_cet4), "is_cet6": int(is_cet6),
                "bnc": int(row.get("bnc") or 0), "frq": int(row.get("frq") or 0), "learning_mode": "recognition", "classification_source": "curated"
            }
            entries[key] = merge_entry(entries.get(key), entry)

    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()
    conn = sqlite3.connect(output)
    conn.executescript("""
      PRAGMA journal_mode=DELETE;
      CREATE TABLE catalog_entries (
        normalized TEXT PRIMARY KEY, word TEXT NOT NULL, phonetic TEXT NOT NULL, pos TEXT NOT NULL,
        definition TEXT NOT NULL, band TEXT NOT NULL, module TEXT NOT NULL, topic TEXT NOT NULL,
        related_topics_json TEXT NOT NULL, synonyms_json TEXT NOT NULL, antonyms_json TEXT NOT NULL,
        collocations_json TEXT NOT NULL, examples_json TEXT NOT NULL, note TEXT NOT NULL,
        catalogs_json TEXT NOT NULL, source_tags_json TEXT NOT NULL,
        is_ielts INTEGER NOT NULL, is_cet4 INTEGER NOT NULL, is_cet6 INTEGER NOT NULL,
        bnc INTEGER NOT NULL, frq INTEGER NOT NULL, learning_mode TEXT NOT NULL, classification_source TEXT NOT NULL
      );
      CREATE INDEX idx_catalog_flags ON catalog_entries(is_ielts, is_cet4, is_cet6);
      CREATE INDEX idx_catalog_rank ON catalog_entries(bnc, frq, normalized);
      CREATE INDEX idx_catalog_topic ON catalog_entries(topic, normalized);
    """)
    json_fields = {"related_topics", "synonyms", "antonyms", "collocations", "examples", "catalogs", "source_tags"}
    columns = [row[1] for row in conn.execute("PRAGMA table_info(catalog_entries)")]
    for entry in entries.values():
        values = []
        for column in columns:
            source_key = column[:-5] if column.endswith("_json") else column
            value = entry.get(source_key, [] if source_key in json_fields else "")
            values.append(json.dumps(value, ensure_ascii=False, separators=(",", ":")) if source_key in json_fields else value)
        conn.execute(f"INSERT INTO catalog_entries VALUES ({','.join('?' for _ in columns)})", values)
    conn.commit()
    counts = {
        "total": conn.execute("SELECT COUNT(*) FROM catalog_entries").fetchone()[0],
        "ielts": conn.execute("SELECT COUNT(*) FROM catalog_entries WHERE is_ielts=1").fetchone()[0],
        "cet4": conn.execute("SELECT COUNT(*) FROM catalog_entries WHERE is_cet4=1").fetchone()[0],
        "cet6": conn.execute("SELECT COUNT(*) FROM catalog_entries WHERE is_cet6=1").fetchone()[0],
    }
    conn.close()
    if counts["ielts"] != 185 or not counts["cet4"] or not counts["cet6"]:
        raise SystemExit(f"catalog count validation failed: {counts}")
    return counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ecdict", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "catalog.db")
    args = parser.parse_args()
    source = args.ecdict or download_ecdict()
    counts = build(source, args.output)
    manifest = {
        "schema_version": 1, "ecdict_commit": ECDICT_COMMIT, "ecdict_sha256": ECDICT_SHA256,
        "ecdict_url": ECDICT_URL,
        "cet4_definition": "source tag cet4 only; gk-only rows remain lookup-only and are not promoted into CET-4",
        "counts": counts
    }
    target = args.output.parent / "catalog-manifest.json"
    target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
