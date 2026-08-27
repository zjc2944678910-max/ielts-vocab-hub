"""Offline catalog, FSRS study sessions, settings, and data portability.

This module deliberately contains no HTTP or AI code.  It is safe to use when
the configured model or the network is unavailable.
"""

from __future__ import annotations

import json
import os
import random
import re
import shutil
import sqlite3
import sys
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
BUNDLED_CATALOG_PATH = ROOT / "data" / "catalog.db"
CATALOG_PATH = (
    BUNDLED_CATALOG_PATH
    if os.environ.get("IELTS_VOCAB_PUBLIC_MODE", "0") == "1"
    else Path(os.environ.get("IELTS_VOCAB_CATALOG_PATH", BUNDLED_CATALOG_PATH)).expanduser()
)
sys.path.insert(0, str(ROOT / "vendor"))
from fsrs import Card, Rating, ReviewLog, Scheduler  # noqa: E402


SCHEMA_VERSION = 8
GROUP_SIZE = 10
LEARN_STREAK_NEEDED = 3
REVIEW_STREAK_NEEDED = 2
DEFAULT_SETTINGS: dict[str, Any] = {
    "profile_name": "学习者",
    "avatar_version": 0,
    "background_version": 0,
    "background_enabled": False,
    "background_overlay": 0.72,
    "button_color": "#9fe7c5",
    "enabled_catalogs": ["ielts"],
    "paused_catalogs": [],
    "daily_new_limit": 20,
    "target_topics": [],
    "target_band": "6.5",
    "filter_basic_words": True,
    "desired_retention": 0.90,
    "dictation_count": 10,
    "dictation_scope": ["due", "mistakes"],
    "voice_provider": "google",
    "voice_name": "",
    "voice_lang": "en-GB",
    "speech_rate": 0.82,
    "autoplay": True,
}
SETTING_KEYS = set(DEFAULT_SETTINGS)
JSON_PERSONAL_FIELDS = {
    "related_topics": "related_topics_json",
    "synonyms": "synonyms_json",
    "antonyms": "antonyms_json",
    "collocations": "collocations_json",
    "examples": "examples_json",
    "senses": "senses_json",
    "tags": "tags_json",
    "manual_fields": "manual_fields_json",
}
EDITABLE_OVERRIDE_FIELDS = {
    "definition", "band", "pos", "module", "topic", "related_topics",
    "tags", "note", "learning_mode",
}
_schema_lock = threading.Lock()
_schema_ready: set[str] = set()

FOUNDATION_POS_PREFIXES = (
    "article", "auxiliary", "conjunction", "determiner", "interjection",
    "modal", "number", "preposition", "pronoun",
)
ACADEMIC_SUFFIXES = (
    "able", "ance", "ence", "graphy", "hood", "ical", "ible", "ify",
    "ism", "ist", "ity", "ive", "ize", "ise", "ment", "ology", "ous",
    "phobia", "ship", "sion", "tion",
)

CATALOG_DEFINITIONS: dict[str, tuple[str, str]] = {
    "ielts": ("IELTS 精选", "185 个高频雅思学术词"),
    "cet4": ("CET-4 核心", "仅采用 ECDICT cet4 标签，基础词默认不进入训练"),
    "cet6": ("CET-6 核心", "ECDICT 考试词，基础词默认不进入训练"),
    "oxford_ielts": ("Oxford IELTS", "本机 Oxford IELTS 词表，默认关闭"),
    "oxford_toefl": ("Oxford TOEFL", "本机 Oxford TOEFL 词表，默认关闭"),
    "oxford_gre": ("Oxford GRE", "本机 Oxford GRE 词表，默认关闭"),
    "oxford_cet4": ("Oxford CET-4", "本机 Oxford CET-4 词表，默认关闭"),
    "oxford_cet6": ("Oxford CET-6", "本机 Oxford CET-6 词表，默认关闭"),
    "oxford_kaoyan": ("Oxford 考研", "本机 Oxford 考研词表，默认关闭"),
    "oxford_tem8": ("Oxford 专八", "本机 Oxford TEM-8 词表，默认关闭"),
    "oxford_sat": ("Oxford SAT", "本机 Oxford SAT 词表，默认关闭"),
}
CATALOG_IDS = frozenset(CATALOG_DEFINITIONS)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return utc_now().isoformat(timespec="seconds")


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def json_load(value: Any, fallback: Any) -> Any:
    try:
        return json.loads(value or "")
    except (TypeError, json.JSONDecodeError):
        return fallback


def cancel_active_sessions(conn: sqlite3.Connection) -> None:
    """Cancel generated queues and remove only their never-reviewed cards."""
    sessions = conn.execute("SELECT id,queue_json FROM study_sessions WHERE status='active'").fetchall()
    queued_card_ids: set[str] = set()
    for session in sessions:
        queue = json_load(session["queue_json"], [])
        if isinstance(queue, dict):
            for item in queue.get("words") or []:
                if item.get("card_id"):
                    queued_card_ids.add(item["card_id"])
        elif isinstance(queue, list):
            for task in queue:
                if task.get("card_id"):
                    queued_card_ids.add(task["card_id"])
    stamp = now_iso()
    conn.execute(
        "UPDATE study_sessions SET status='cancelled',completed_at=?,updated_at=? WHERE status='active'",
        (stamp, stamp),
    )
    for card_id in queued_card_ids:
        conn.execute(
            "DELETE FROM study_cards WHERE id=? AND NOT EXISTS (SELECT 1 FROM review_logs WHERE card_id=?)",
            (card_id, card_id),
        )


def ensure_schema(conn: sqlite3.Connection, db_path: Path) -> None:
    """Idempotently add study tables and make one pre-migration backup."""
    key = str(db_path)
    if key in _schema_ready:
        return
    with _schema_lock:
        if key in _schema_ready:
            return
        conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        version_row = conn.execute("SELECT value FROM meta WHERE key='study_schema_version'").fetchone()
        old_version = int(version_row[0]) if version_row and str(version_row[0]).isdigit() else 0
        if old_version < SCHEMA_VERSION and db_path.exists() and db_path.stat().st_size:
            backup_dir = db_path.parent / "backups"
            backup_dir.mkdir(parents=True, exist_ok=True)
            backup_marker = f"study_schema_backup_v{SCHEMA_VERSION}"
            marker = conn.execute("SELECT value FROM meta WHERE key=?", (backup_marker,)).fetchone()
            if not marker:
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                backup_path = backup_dir / f"data-before-study-v{SCHEMA_VERSION}-{stamp}.db"
                backup = sqlite3.connect(backup_path)
                conn.backup(backup)
                backup.close()
                backup_path.chmod(0o600)
                conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", (backup_marker, str(backup_path)))

        word_columns = {row[1] for row in conn.execute("PRAGMA table_info(words)")}
        additions = {
            "related_topics_json": "TEXT NOT NULL DEFAULT '[]'",
            "classification_source": "TEXT NOT NULL DEFAULT 'local'",
            "manual_fields_json": "TEXT NOT NULL DEFAULT '[]'",
            "learning_mode": "TEXT NOT NULL DEFAULT 'auto'",
            "catalogs_json": "TEXT NOT NULL DEFAULT '[]'",
            "senses_json": "TEXT NOT NULL DEFAULT '[]'",
        }
        for name, definition in additions.items():
            if name not in word_columns:
                conn.execute(f"ALTER TABLE words ADD COLUMN {name} {definition}")

        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS study_cards (
              id TEXT PRIMARY KEY,
              normalized TEXT NOT NULL,
              card_type TEXT NOT NULL CHECK(card_type IN ('meaning','spelling')),
              fsrs_json TEXT NOT NULL,
              suspended INTEGER NOT NULL DEFAULT 0,
              source_catalogs_json TEXT NOT NULL DEFAULT '[]',
              calibration INTEGER NOT NULL DEFAULT 0,
              retrievability REAL,
              last_rating INTEGER,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(normalized, card_type)
            );
            CREATE INDEX IF NOT EXISTS idx_study_cards_due ON study_cards(suspended, card_type);
            CREATE TABLE IF NOT EXISTS review_logs (
              id TEXT PRIMARY KEY,
              card_id TEXT,
              normalized TEXT NOT NULL,
              card_type TEXT NOT NULL,
              rating INTEGER NOT NULL,
              correct INTEGER NOT NULL,
              answer TEXT NOT NULL DEFAULT '',
              used_options INTEGER NOT NULL DEFAULT 0,
              hints_json TEXT NOT NULL DEFAULT '[]',
              replays INTEGER NOT NULL DEFAULT 0,
              duration_ms INTEGER NOT NULL DEFAULT 0,
              review_kind TEXT NOT NULL DEFAULT 'review',
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_review_logs_created ON review_logs(created_at);
            CREATE INDEX IF NOT EXISTS idx_review_logs_word ON review_logs(normalized, card_type, created_at);
            CREATE TABLE IF NOT EXISTS study_sessions (
              id TEXT PRIMARY KEY,
              mode TEXT NOT NULL,
              scope_json TEXT NOT NULL DEFAULT '{}',
              queue_json TEXT NOT NULL DEFAULT '[]',
              current_index INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'active',
              new_word_count INTEGER NOT NULL DEFAULT 0,
              started_at TEXT NOT NULL,
              completed_at TEXT,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS study_attempts (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
              task_index INTEGER NOT NULL,
              normalized TEXT NOT NULL,
              card_type TEXT NOT NULL,
              answer TEXT NOT NULL DEFAULT '',
              correct INTEGER NOT NULL,
              rating INTEGER NOT NULL,
              duration_ms INTEGER NOT NULL DEFAULT 0,
              hints_json TEXT NOT NULL DEFAULT '[]',
              replays INTEGER NOT NULL DEFAULT 0,
              corrected INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              UNIQUE(session_id, task_index)
            );
            """
        )
        if old_version < 6:
            # Generated queues embed full word payloads.  Rebuild old active
            # queues once so the new difficulty policy takes effect without
            # deleting any cards, attempts, or review history.
            cancel_active_sessions(conn)
        if old_version < 8:
            cancel_active_sessions(conn)
        card_columns = {row[1] for row in conn.execute("PRAGMA table_info(study_cards)")}
        if "retrievability" not in card_columns:
            conn.execute("ALTER TABLE study_cards ADD COLUMN retrievability REAL")
        if "last_rating" not in card_columns:
            conn.execute("ALTER TABLE study_cards ADD COLUMN last_rating INTEGER")
        attempt_columns = {row[1] for row in conn.execute("PRAGMA table_info(study_attempts)")}
        if "corrected" not in attempt_columns:
            conn.execute("ALTER TABLE study_attempts ADD COLUMN corrected INTEGER NOT NULL DEFAULT 0")
        for key_name, value in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key,value_json,updated_at) VALUES(?,?,?)",
                (key_name, json.dumps(value, ensure_ascii=False), now_iso()),
            )
        conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('study_schema_version',?)", (str(SCHEMA_VERSION),))
        conn.commit()
        _schema_ready.add(key)


def get_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    result = dict(DEFAULT_SETTINGS)
    for row in conn.execute("SELECT key,value_json FROM settings"):
        if row["key"] in SETTING_KEYS:
            result[row["key"]] = json_load(row["value_json"], result[row["key"]])
    return result


def update_settings(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    previous = get_settings(conn)
    clean: dict[str, Any] = {}
    if "profile_name" in payload:
        clean["profile_name"] = re.sub(r"\s+", " ", str(payload["profile_name"]).strip())[:40] or "学习者"
    if "avatar_version" in payload:
        clean["avatar_version"] = max(0, int(payload["avatar_version"]))
    if "background_version" in payload:
        clean["background_version"] = max(0, int(payload["background_version"]))
    if "background_enabled" in payload:
        clean["background_enabled"] = bool(payload["background_enabled"])
    if "background_overlay" in payload:
        clean["background_overlay"] = max(0.45, min(0.92, float(payload["background_overlay"])))
    if "button_color" in payload:
        color = str(payload["button_color"]).strip().lower()
        clean["button_color"] = color if re.fullmatch(r"#[0-9a-f]{6}", color) else previous["button_color"]
    if "enabled_catalogs" in payload:
        clean["enabled_catalogs"] = [x for x in payload["enabled_catalogs"] if x in CATALOG_IDS]
    if "paused_catalogs" in payload:
        clean["paused_catalogs"] = [x for x in payload["paused_catalogs"] if x in CATALOG_IDS]
    if "daily_new_limit" in payload:
        clean["daily_new_limit"] = max(0, min(100, int(payload["daily_new_limit"])))
    if "dictation_count" in payload:
        clean["dictation_count"] = max(5, min(100, int(payload["dictation_count"])))
    if "desired_retention" in payload:
        value = float(payload["desired_retention"])
        clean["desired_retention"] = value if value in {0.85, 0.9, 0.95} else 0.9
    if "target_band" in payload:
        clean["target_band"] = str(payload["target_band"])
    if "filter_basic_words" in payload:
        clean["filter_basic_words"] = bool(payload["filter_basic_words"])
    if "target_topics" in payload:
        clean["target_topics"] = [str(x) for x in payload["target_topics"]][:20]
    if "dictation_scope" in payload:
        clean["dictation_scope"] = [str(x) for x in payload["dictation_scope"]][:10]
    if "voice_provider" in payload:
        clean["voice_provider"] = "system" if payload["voice_provider"] == "system" else "google"
    if "voice_lang" in payload:
        clean["voice_lang"] = "en-US" if payload["voice_lang"] == "en-US" else "en-GB"
    if "voice_name" in payload:
        clean["voice_name"] = str(payload["voice_name"])[:160]
    if "speech_rate" in payload:
        clean["speech_rate"] = max(0.5, min(1.2, float(payload["speech_rate"])))
    if "autoplay" in payload:
        clean["autoplay"] = bool(payload["autoplay"])
    stamp = now_iso()
    for key, value in clean.items():
        conn.execute(
            "INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES(?,?,?)",
            (key, json.dumps(value, ensure_ascii=False), stamp),
        )
    conn.commit()
    updated = get_settings(conn)
    if updated["filter_basic_words"] != previous["filter_basic_words"]:
        cancel_active_sessions(conn)
        conn.commit()
    if updated["desired_retention"] != previous["desired_retention"]:
        scheduler = scheduler_for(updated)
        for row in conn.execute("SELECT * FROM study_cards"):
            card = Card.from_json(row["fsrs_json"])
            logs = []
            for log in conn.execute("SELECT * FROM review_logs WHERE card_id=? AND review_kind IN ('due','new','dictation_due') ORDER BY created_at", (row["id"],)):
                logs.append(ReviewLog(card.card_id, Rating(log["rating"]), datetime.fromisoformat(log["created_at"]), log["duration_ms"]))
            if logs:
                card = scheduler.reschedule_card(card, logs)
                conn.execute("UPDATE study_cards SET fsrs_json=?,updated_at=? WHERE id=?", (card.to_json(), now_iso(), row["id"]))
        conn.commit()
    return updated


@contextmanager
def catalog_connection():
    if not CATALOG_PATH.exists():
        raise RuntimeError("内置词库尚未构建")
    conn = sqlite3.connect(f"file:{CATALOG_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.create_function("study_tier", 5, catalog_study_tier, deterministic=True)
    try:
        yield conn
    finally:
        conn.close()


def catalog_study_tier(normalized: str, pos: str, bnc: int, source_tags_json: str, is_ielts: int) -> int:
    """Return 0/1/2 for curated/core/supplemental words and 9 for foundations.

    ECDICT's ``gk`` tag was intentionally used to lift CET-4 above 4,000
    entries.  It also contains elementary grammar and everyday vocabulary, so
    the study pool must not treat the raw catalog membership as difficulty.
    """
    if is_ielts:
        return 0
    tags = set(json_load(source_tags_json, []))
    word = normalize(normalized)
    letters = sum(char.isalpha() for char in word)
    part = (pos or "").strip().lower()
    rank = int(bnc or 0)
    if letters <= 3 or any(part.startswith(prefix) for prefix in FOUNDATION_POS_PREFIXES):
        return 9
    has_exam_tag = bool(tags & {"cet4", "cet6", "exam"})
    if has_exam_tag:
        if 0 < rank <= 600 and letters <= 6 and not word.endswith(ACADEMIC_SUFFIXES):
            return 9
        return 1
    return 9


def catalog_entry_is_study_ready(item: dict[str, Any]) -> bool:
    return catalog_study_tier(
        item.get("normalized") or item.get("word", ""), item.get("pos", ""),
        item.get("bnc", 0), json.dumps(item.get("source_tags", []), ensure_ascii=False),
        item.get("is_ielts", 0),
    ) < 9


def word_is_study_ready(word: dict[str, Any]) -> bool:
    """Allow explicit personal choices while filtering automatic basics."""
    if word.get("saved") or word.get("manual_fields"):
        return True
    return word.get("study_eligible") is not False


def catalog_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    item = dict(row)
    for key in ("related_topics", "synonyms", "antonyms", "collocations", "examples", "catalogs", "source_tags"):
        item[key] = json_load(item.pop(f"{key}_json"), [])
    item["source"] = "catalog"
    item["saved"] = False
    item["status"] = "new"
    item["manual_fields"] = []
    item["study_tier"] = catalog_study_tier(
        item["normalized"], item["pos"], item["bnc"],
        json.dumps(item["source_tags"], ensure_ascii=False), item["is_ielts"],
    )
    item["study_eligible"] = item["study_tier"] < 9
    return item


def personal_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    item = dict(row)
    item["normalized"] = item.get("normalized") or normalize(item.get("word", ""))
    for key, db_key in JSON_PERSONAL_FIELDS.items():
        item[key] = json_load(item.get(db_key), [])
    item["saved"] = bool(item.get("saved"))
    item["auto_classified"] = bool(item.get("auto_classified"))
    return item


def merge_word(base: dict[str, Any] | None, personal: dict[str, Any] | None) -> dict[str, Any] | None:
    if not base:
        return personal
    result = dict(base)
    if not personal:
        return result
    manual = set(personal.get("manual_fields", []))
    for field in EDITABLE_OVERRIDE_FIELDS:
        if field in manual:
            result[field] = personal.get(field)
    for field in ("id", "saved", "status", "note", "created_at", "updated_at", "ai_enrichment", "senses"):
        if field in personal:
            result[field] = personal[field]
    if personal.get("tags"):
        result["tags"] = list(dict.fromkeys([*result.get("tags", []), *personal["tags"]]))
    result["manual_fields"] = list(manual)
    result["classification_source"] = personal.get("classification_source") or result.get("classification_source")
    result["learning_mode"] = personal.get("learning_mode") if "learning_mode" in manual else result.get("learning_mode", "auto")
    return result


def get_word(conn: sqlite3.Connection, normalized: str) -> dict[str, Any] | None:
    key = normalize(normalized)
    with catalog_connection() as catalog:
        base = catalog_row(catalog.execute("SELECT * FROM catalog_entries WHERE normalized=?", (key,)).fetchone())
    personal = personal_row(conn.execute("SELECT * FROM words WHERE normalized=?", (key,)).fetchone())
    return merge_word(base, personal)


def _catalog_membership_clause(catalogs: list[str]) -> tuple[str, list[Any]]:
    selected = list(dict.fromkeys(item for item in catalogs if item in CATALOG_IDS))
    if not selected:
        return "0=1", []
    placeholders = ",".join("?" for _ in selected)
    return (
        f"EXISTS (SELECT 1 FROM json_each(catalog_entries.catalogs_json) membership WHERE membership.value IN ({placeholders}))",
        selected,
    )


def catalog_counts(filter_basic_words: bool = True) -> list[dict[str, Any]]:
    with catalog_connection() as conn:
        rows = {
            row["catalog_id"]: row
            for row in conn.execute(
                """SELECT membership.value catalog_id, COUNT(*) total,
                          SUM(study_tier(normalized,pos,bnc,source_tags_json,is_ielts)<9) ready
                   FROM catalog_entries, json_each(catalog_entries.catalogs_json) membership
                   GROUP BY membership.value"""
            )
            if row["catalog_id"] in CATALOG_IDS
        }
    def item(key: str) -> dict[str, Any]:
        row = rows[key]
        total = int(row["total"] or 0)
        ready = int(row["ready"] or 0)
        name, description = CATALOG_DEFINITIONS[key]
        return {
            "id": key, "name": name, "count": ready if filter_basic_words else total,
            "total_count": total, "hidden_count": total - ready if filter_basic_words else 0,
            "description": description,
        }
    return [item(key) for key in CATALOG_DEFINITIONS if key in rows]


def library_page(conn: sqlite3.Connection, query: dict[str, list[str]]) -> dict[str, Any]:
    catalogs = [x for x in (query.get("catalog") or query.get("catalogs") or []) if x in CATALOG_IDS]
    if len(catalogs) == 1 and "," in catalogs[0]:
        catalogs = [x for x in catalogs[0].split(",") if x in CATALOG_IDS]
    search = (query.get("search") or [""])[0].strip().lower()
    topic = (query.get("topic") or [""])[0]
    band = (query.get("band") or [""])[0]
    status = (query.get("status") or [""])[0]
    cursor = max(0, int((query.get("cursor") or ["0"])[0] or 0))
    limit = max(1, min(250, int((query.get("limit") or ["80"])[0] or 80)))
    where, params = [], []
    settings = get_settings(conn)
    if settings.get("filter_basic_words", True):
        where.append("study_tier(normalized,pos,bnc,source_tags_json,is_ielts)<9")
    if catalogs:
        catalog_clause, catalog_params = _catalog_membership_clause(catalogs)
        where.append(catalog_clause)
        params.extend(catalog_params)
    if search:
        where.append("(normalized LIKE ? OR definition LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%"])
    if topic:
        where.append("(topic=? OR related_topics_json LIKE ?)")
        params.extend([topic, f'%"{topic}"%'])
    if band:
        match = re.search(r"\d+(?:\.\d+)?", band)
        if match:
            where.append("CAST(substr(band,1,3) AS REAL)>=?")
            params.append(float(match.group()))
    sql_where = " WHERE " + " AND ".join(where) if where else ""
    with catalog_connection() as catalog:
        rows = catalog.execute(
            "SELECT * FROM catalog_entries" + sql_where + " ORDER BY is_ielts DESC, study_tier(normalized,pos,bnc,source_tags_json,is_ielts), CASE WHEN bnc>0 THEN bnc ELSE 999999 END, CASE WHEN frq>0 THEN frq ELSE 999999 END, normalized LIMIT ? OFFSET ?",
            (*params, limit + 1, cursor),
        ).fetchall()
    result = []
    for raw in rows[:limit]:
        base = catalog_row(raw)
        personal = personal_row(conn.execute("SELECT * FROM words WHERE normalized=?", (base["normalized"],)).fetchone())
        merged = merge_word(base, personal)
        if status and merged.get("status") != status:
            continue
        result.append(merged)
    return {"words": result, "next_cursor": cursor + limit if len(rows) > limit else None}


def scheduler_for(settings: dict[str, Any]) -> Scheduler:
    return Scheduler(
        desired_retention=float(settings.get("desired_retention", 0.9)),
        learning_steps=(timedelta(minutes=1), timedelta(minutes=10)),
        relearning_steps=(timedelta(minutes=10),),
        maximum_interval=3650,
        enable_fuzzing=True,
    )


def card_record(row: sqlite3.Row) -> tuple[Card, dict[str, Any]]:
    return Card.from_json(row["fsrs_json"]), dict(row)


def card_retrievability(card: Card, scheduler: Scheduler) -> float | None:
    try:
        return scheduler.get_card_retrievability(card)
    except (ValueError, TypeError):
        return None


def desired_card_types(word: dict[str, Any]) -> list[str]:
    mode = word.get("learning_mode", "auto")
    if mode == "recognition":
        return ["meaning"]
    if mode == "production":
        return ["meaning", "spelling"]
    if word.get("saved"):
        return ["meaning", "spelling"]
    module = str(word.get("module", "")).lower()
    if "writing" in module or "speaking" in module:
        return ["meaning", "spelling"]
    return ["meaning"]


def ensure_card(conn: sqlite3.Connection, word: dict[str, Any], card_type: str, *, calibration: int = 0) -> sqlite3.Row:
    key = normalize(word["word"])
    existing = conn.execute("SELECT * FROM study_cards WHERE normalized=? AND card_type=?", (key, card_type)).fetchone()
    if existing:
        return existing
    card_id = str(uuid.uuid4())
    card = Card(card_id=abs(hash(card_id)) % 2_000_000_000)
    stamp = now_iso()
    conn.execute(
        """INSERT INTO study_cards (
          id,normalized,card_type,fsrs_json,suspended,source_catalogs_json,
          calibration,retrievability,last_rating,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (card_id, key, card_type, card.to_json(), 0, json.dumps(word.get("catalogs", [])), calibration, None, None, stamp, stamp),
    )
    return conn.execute("SELECT * FROM study_cards WHERE id=?", (card_id,)).fetchone()


def option_definitions(word: dict[str, Any], catalogs: list[str], filter_basic_words: bool = True) -> list[str]:
    target = word.get("definition", "")
    where, catalog_params = _catalog_membership_clause(catalogs)
    if where == "0=1":
        where, catalog_params = "1=1", []
    if filter_basic_words:
        where += " AND study_tier(normalized,pos,bnc,source_tags_json,is_ielts)<9"
    pos = (word.get("pos") or "").split(".")[0]
    with catalog_connection() as catalog:
        target_band = float(re.search(r"\d+(?:\.\d+)?", str(word.get("band", "6.5"))).group()) if re.search(r"\d+(?:\.\d+)?", str(word.get("band", "6.5"))) else 6.5
        candidates = catalog.execute(
            f"SELECT definition FROM catalog_entries WHERE {where} AND normalized!=? AND definition!='' AND pos LIKE ? AND ABS(CAST(substr(band,1,3) AS REAL)-?)<=1 ORDER BY RANDOM() LIMIT 18",
            (*catalog_params, normalize(word["word"]), f"{pos}%" if pos else "%", target_band),
        ).fetchall()
    values = [target]
    for row in candidates:
        value = row["definition"]
        if value and value not in values:
            values.append(value)
        if len(values) == 4:
            break
    random.shuffle(values)
    return values


def task_payload(conn: sqlite3.Connection, card_row: sqlite3.Row, *, is_new: bool, review_kind: str, settings: dict[str, Any]) -> dict[str, Any]:
    word = get_word(conn, card_row["normalized"])
    card = Card.from_json(card_row["fsrs_json"])
    item = {
        "card_id": card_row["id"], "card_type": card_row["card_type"], "is_new": is_new,
        "review_kind": review_kind, "word": word, "due": card.due.isoformat(),
    }
    item["memory"] = {"difficulty": card.difficulty, "stability": card.stability, "state": card.state.name, "retrievability": card_row["retrievability"]}
    if card_row["card_type"] == "meaning":
        item["options"] = option_definitions(
            word, settings.get("enabled_catalogs", ["ielts"]),
            settings.get("filter_basic_words", True),
        )
    return item


def _active_catalog_clause(catalogs: list[str]) -> tuple[str, list[Any]]:
    return _catalog_membership_clause(catalogs)


def _group_size(payload: dict[str, Any]) -> int:
    if payload.get("limit") is not None:
        return max(1, min(GROUP_SIZE, int(payload["limit"])))
    return GROUP_SIZE


def _abandon_other_group_session(conn: sqlite3.Connection, keep_mode: str) -> None:
    other = "review" if keep_mode == "learn" else "learn"
    stamp = now_iso()
    conn.execute(
        "UPDATE study_sessions SET status='abandoned',completed_at=?,updated_at=? WHERE mode=? AND status='active'",
        (stamp, stamp, other),
    )


def _group_item(conn: sqlite3.Connection, word: dict[str, Any], *, is_new: bool, mode: str, settings: dict[str, Any], card_row: sqlite3.Row | None) -> dict[str, Any]:
    needed = LEARN_STREAK_NEEDED if mode == "learn" else REVIEW_STREAK_NEEDED
    return {
        "normalized": word["normalized"],
        "card_id": card_row["id"] if card_row else None,
        "is_new": is_new,
        "review_kind": "new" if is_new else "due",
        "word": word,
        "options": option_definitions(word, settings.get("enabled_catalogs", ["ielts"]), settings.get("filter_basic_words", True)),
        "streak": 0,
        "needed": needed,
        "unfamiliar": False,
        "meaning_done": False,
        "seen_count": 0,
        "review_self_done": False,
        "instant_know": False,
        "spell_done": False,
        "spell_correct": None,
        "spell_needs_retry": False,
    }


def _collect_due_meaning_items(conn: sqlite3.Connection, settings: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    paused = set(settings.get("paused_catalogs", []))
    now = utc_now()
    scored: list[tuple[datetime, sqlite3.Row]] = []
    for row in conn.execute("SELECT * FROM study_cards WHERE suspended=0 AND card_type='meaning'"):
        catalogs = set(json_load(row["source_catalogs_json"], []))
        if catalogs and catalogs.issubset(paused):
            continue
        card = Card.from_json(row["fsrs_json"])
        if card.due <= now:
            scored.append((card.due, row))
    scored.sort(key=lambda item: item[0])
    items = []
    for _, row in scored[:limit]:
        word = get_word(conn, row["normalized"])
        if not word:
            continue
        items.append(_group_item(conn, word, is_new=False, mode="review", settings=settings, card_row=row))
    return items


def _iter_new_word_candidates(conn: sqlite3.Connection, settings: dict[str, Any], catalogs: list[str], topic: str):
    paused = set(settings.get("paused_catalogs", []))
    seen_cards = {row["normalized"] for row in conn.execute("SELECT normalized FROM study_cards")}
    personal_rows = conn.execute("SELECT * FROM words ORDER BY saved DESC, created_at").fetchall()
    for raw in personal_rows:
        personal = personal_row(raw)
        key = personal["normalized"]
        if key in seen_cards:
            continue
        word = get_word(conn, key) or personal
        if settings.get("filter_basic_words", True) and not word_is_study_ready(word):
            continue
        if topic and word.get("topic") != topic and topic not in word.get("related_topics", []):
            continue
        catalogs_for_word = set(word.get("catalogs") or [])
        if catalogs_for_word and catalogs_for_word.issubset(paused):
            continue
        yield word
        seen_cards.add(key)
    clause, params = _active_catalog_clause(catalogs)
    if settings.get("filter_basic_words", True):
        clause += " AND study_tier(normalized,pos,bnc,source_tags_json,is_ielts)<9"
    topics = settings.get("target_topics", [])
    order = (
        f"SELECT * FROM catalog_entries WHERE {clause} ORDER BY is_ielts DESC, CASE WHEN topic IN ({','.join('?' for _ in topics)}) THEN 0 ELSE 1 END, study_tier(normalized,pos,bnc,source_tags_json,is_ielts), CASE WHEN bnc>0 THEN bnc ELSE 999999 END, CASE WHEN frq>0 THEN frq ELSE 999999 END, normalized LIMIT 1200"
        if topics else
        f"SELECT * FROM catalog_entries WHERE {clause} ORDER BY is_ielts DESC, study_tier(normalized,pos,bnc,source_tags_json,is_ielts), CASE WHEN bnc>0 THEN bnc ELSE 999999 END, CASE WHEN frq>0 THEN frq ELSE 999999 END, normalized LIMIT 1200"
    )
    query_params = (*params, *topics) if topics else params
    with catalog_connection() as catalog:
        rows = catalog.execute(order, query_params).fetchall()
    for raw in rows:
        base = catalog_row(raw)
        key = base["normalized"]
        if key in seen_cards:
            continue
        word = merge_word(base, personal_row(conn.execute("SELECT * FROM words WHERE normalized=?", (key,)).fetchone()))
        if topic and word.get("topic") != topic and topic not in word.get("related_topics", []):
            continue
        yield word
        seen_cards.add(key)


def _collect_new_learn_items(conn: sqlite3.Connection, settings: dict[str, Any], catalogs: list[str], topic: str, limit: int) -> list[dict[str, Any]]:
    local_start = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc).isoformat()
    completed_today = conn.execute(
        "SELECT COUNT(DISTINCT normalized) FROM review_logs WHERE review_kind='new' AND created_at>=?",
        (local_start,),
    ).fetchone()[0]
    remaining = max(0, int(settings["daily_new_limit"]) - completed_today)
    take = min(limit, remaining)
    items = []
    if take <= 0:
        return items
    for word in _iter_new_word_candidates(conn, settings, catalogs, topic):
        items.append(_group_item(conn, word, is_new=True, mode="learn", settings=settings, card_row=None))
        if len(items) >= take:
            break
    return items


def _prompt_kind_for(item: dict[str, Any], mode: str, phase: str) -> str:
    if phase == "spelling":
        return "spelling"
    if mode == "review" and not item.get("review_self_done"):
        return "review_self"
    if mode == "learn" and item.get("seen_count", 0) == 0:
        return "meaning_mcq"
    if mode == "learn":
        return "know_check"
    return "meaning_mcq"


def _pick_group_item(queue: dict[str, Any], last: str | None) -> dict[str, Any] | None:
    phase = queue.get("phase") or "meaning"
    if phase == "spelling":
        for item in queue["words"]:
            if not item.get("spell_done"):
                return item
        return None
    pending = [item for item in queue["words"] if not item.get("meaning_done")]
    if not pending:
        return None
    if len(pending) == 1:
        return pending[0]
    others = [item for item in pending if item["normalized"] != last] or pending
    others.sort(key=lambda item: (item.get("streak", 0), item.get("seen_count", 0) == 0, -item.get("seen_count", 0)))
    lowest = others[0].get("streak", 0)
    pool = [item for item in others if item.get("streak", 0) == lowest]
    return random.choice(pool)


def _set_current_prompt(queue: dict[str, Any], mode: str, last: str | None = None) -> dict[str, Any] | None:
    item = _pick_group_item(queue, last if last is not None else queue.get("last_normalized"))
    if not item:
        if queue.get("phase") != "spelling" and all(word.get("meaning_done") for word in queue["words"]):
            queue["phase"] = "spelling"
            item = _pick_group_item(queue, None)
        if not item:
            queue["current"] = None
            queue["phase"] = "done"
            return None
    kind = _prompt_kind_for(item, mode, queue.get("phase") or "meaning")
    queue["current"] = {"normalized": item["normalized"], "kind": kind}
    return queue["current"]


def _group_progress(queue: dict[str, Any]) -> dict[str, Any]:
    words = queue.get("words") or []
    return {
        "remembered": sum(1 for item in words if item.get("meaning_done")),
        "total": len(words),
        "phase": queue.get("phase") or "meaning",
        "spelling_done": sum(1 for item in words if item.get("spell_done")),
        "spelling_total": len(words),
        "unfamiliar": sum(1 for item in words if item.get("unfamiliar")),
    }


def _public_current(queue: dict[str, Any]) -> dict[str, Any] | None:
    current = queue.get("current")
    if not current:
        return None
    item = next((word for word in queue.get("words") or [] if word["normalized"] == current["normalized"]), None)
    if not item:
        return None
    return {
        "kind": current["kind"],
        "normalized": item["normalized"],
        "word": item["word"],
        "options": item.get("options") or [],
        "streak": item.get("streak", 0),
        "needed": item.get("needed", LEARN_STREAK_NEEDED),
        "unfamiliar": bool(item.get("unfamiliar")),
        "seen_count": item.get("seen_count", 0),
        "spell_needs_retry": bool(item.get("spell_needs_retry")),
        "card_type": "spelling" if current["kind"] == "spelling" else "meaning",
        "is_new": bool(item.get("is_new")),
        "review_kind": item.get("review_kind"),
    }


def _create_group_session(conn: sqlite3.Connection, payload: dict[str, Any], mode: str) -> dict[str, Any]:
    settings = get_settings(conn)
    catalogs = [x for x in payload.get("catalogs", settings["enabled_catalogs"]) if x in CATALOG_IDS]
    topic = str(payload.get("topic") or "")
    limit = _group_size(payload)
    _abandon_other_group_session(conn, mode)
    words = _collect_due_meaning_items(conn, settings, limit) if mode == "review" else _collect_new_learn_items(conn, settings, catalogs, topic, limit)
    queue = {
        "engine": "group",
        "phase": "meaning",
        "streak_needed": LEARN_STREAK_NEEDED if mode == "learn" else REVIEW_STREAK_NEEDED,
        "last_normalized": None,
        "settled": False,
        "settle_summary": None,
        "words": words,
        "current": None,
    }
    if words:
        _set_current_prompt(queue, mode, last="")
    session_id = str(uuid.uuid4())
    stamp = now_iso()
    conn.execute(
        "INSERT INTO study_sessions VALUES(?,?,?,?,?,?,?,?,?,?)",
        (session_id, mode, json.dumps(payload, ensure_ascii=False), json.dumps(queue, ensure_ascii=False), 0, "active", len(words), stamp, None, stamp),
    )
    conn.commit()
    return get_session(conn, session_id)


def create_session(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    mode = payload.get("mode", "review")
    if mode not in {"learn", "review", "dictation"}:
        raise ValueError("训练类型无效")
    active = conn.execute("SELECT * FROM study_sessions WHERE mode=? AND status='active' ORDER BY updated_at DESC LIMIT 1", (mode,)).fetchone()
    if active:
        return get_session(conn, active["id"])
    if mode in {"learn", "review"}:
        return _create_group_session(conn, payload, mode)
    settings = get_settings(conn)
    requested_catalogs = [x for x in payload.get("catalogs", settings["enabled_catalogs"]) if x in CATALOG_IDS]
    requested_topic = str(payload.get("topic") or "")
    default_scopes = ["due", "mistakes", "catalogs"] if mode == "dictation" else ["due", "catalogs"]
    raw_scopes = payload.get("scopes")
    scopes = set(raw_scopes if isinstance(raw_scopes, list) else default_scopes)
    paused = set(settings.get("paused_catalogs", []))
    now = utc_now()
    queue: list[dict[str, Any]] = []
    due_rows = conn.execute("SELECT * FROM study_cards WHERE suspended=0 ORDER BY updated_at").fetchall()
    for row in due_rows:
        if mode == "dictation" and ("due" not in scopes or row["card_type"] != "spelling"):
            continue
        catalogs = set(json_load(row["source_catalogs_json"], []))
        if catalogs and catalogs.issubset(paused):
            continue
        card = Card.from_json(row["fsrs_json"])
        if card.due <= now:
            queue.append(task_payload(conn, row, is_new=False, review_kind="due", settings=settings))

    if mode == "review":
        completed_today = conn.execute(
            "SELECT COUNT(DISTINCT normalized) FROM review_logs WHERE review_kind='new' AND created_at>=?",
            (datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc).isoformat(),),
        ).fetchone()[0]
        unique_limit = max(0, int(settings["daily_new_limit"]) - completed_today)
    else:
        unique_limit = max(0, min(100, int(payload.get("limit", settings["dictation_count"]))))
    seen = {task["word"]["normalized"] for task in queue}
    new_word_keys = {task["word"]["normalized"] for task in queue if task.get("is_new")}
    if mode == "dictation" and "mistakes" in scopes:
        mistakes = conn.execute(
            "SELECT normalized FROM review_logs WHERE card_type='spelling' AND correct=0 GROUP BY normalized ORDER BY MAX(created_at) DESC"
        ).fetchall()
        for row in mistakes:
            if len(queue) >= unique_limit or row["normalized"] in seen:
                continue
            word = get_word(conn, row["normalized"])
            if not word:
                continue
            card = conn.execute("SELECT * FROM study_cards WHERE normalized=? AND card_type='spelling'", (row["normalized"],)).fetchone()
            task = task_payload(conn, card, is_new=False, review_kind="free", settings=settings) if card else {"card_id": None, "card_type": "spelling", "is_new": False, "review_kind": "free", "word": word, "due": None}
            queue.append(task); seen.add(row["normalized"])
    personal_where = []
    if mode == "review":
        personal_where.append("1=1")
    else:
        if "saved" in scopes: personal_where.append("saved=1")
        if "personal" in scopes: personal_where.append("1=1")
    if personal_where and unique_limit:
        rows = conn.execute(f"SELECT * FROM words WHERE {' OR '.join(personal_where)} ORDER BY saved DESC,created_at").fetchall()
        for raw in rows:
            if len({t['word']['normalized'] for t in queue if t.get('is_new')}) >= unique_limit:
                break
            personal = personal_row(raw); key = personal["normalized"]
            has_any_card = conn.execute("SELECT 1 FROM study_cards WHERE normalized=?", (key,)).fetchone()
            if key in seen or (mode == "review" and has_any_card):
                continue
            word = get_word(conn, key) or personal
            if settings.get("filter_basic_words", True) and not word_is_study_ready(word):
                continue
            if requested_topic and word.get("topic") != requested_topic and requested_topic not in word.get("related_topics", []):
                continue
            types = desired_card_types(word) if mode == "review" else ["spelling"]
            for card_type in types:
                if mode == "review":
                    card = ensure_card(conn, word, card_type)
                    queue.append(task_payload(conn, card, is_new=True, review_kind="new", settings=settings))
                else:
                    spelling = conn.execute("SELECT * FROM study_cards WHERE normalized=? AND card_type='spelling'", (key,)).fetchone()
                    queue.append(task_payload(conn, spelling, is_new=False, review_kind="free", settings=settings) if spelling else {"card_id": None, "card_type": "spelling", "is_new": True, "review_kind": "free", "word": word, "due": None})
            seen.add(key)
            new_word_keys.add(key)
    requested_words = [normalize(x) for x in payload.get("words", []) if normalize(x)]
    if mode == "dictation" and requested_words:
        for key in requested_words:
            if len(queue) >= unique_limit or key in seen:
                continue
            word = get_word(conn, key)
            if word:
                queue.append({"card_id": None, "card_type": "spelling", "is_new": False, "review_kind": "free", "word": word, "due": None}); seen.add(key)
    if unique_limit:
        should_add_catalogs = mode == "review" or "catalogs" in scopes
        clause, params = _active_catalog_clause(requested_catalogs if should_add_catalogs else [])
        if settings.get("filter_basic_words", True):
            clause += " AND study_tier(normalized,pos,bnc,source_tags_json,is_ielts)<9"
        with catalog_connection() as catalog:
            rows = catalog.execute(
                f"SELECT * FROM catalog_entries WHERE {clause} ORDER BY is_ielts DESC, CASE WHEN topic IN ({','.join('?' for _ in settings.get('target_topics', []))}) THEN 0 ELSE 1 END, study_tier(normalized,pos,bnc,source_tags_json,is_ielts), CASE WHEN bnc>0 THEN bnc ELSE 999999 END, CASE WHEN frq>0 THEN frq ELSE 999999 END, normalized LIMIT 1200" if settings.get("target_topics") else f"SELECT * FROM catalog_entries WHERE {clause} ORDER BY is_ielts DESC, study_tier(normalized,pos,bnc,source_tags_json,is_ielts), CASE WHEN bnc>0 THEN bnc ELSE 999999 END, CASE WHEN frq>0 THEN frq ELSE 999999 END, normalized LIMIT 1200",
                (*params, *settings.get("target_topics", [])) if settings.get("target_topics") else params,
            ).fetchall()
        added_words = 0
        for raw in rows:
            if mode == "review" and len(new_word_keys) >= unique_limit:
                break
            base = catalog_row(raw)
            key = base["normalized"]
            has_any_card = conn.execute("SELECT 1 FROM study_cards WHERE normalized=?", (key,)).fetchone()
            if key in seen or (mode == "review" and has_any_card):
                continue
            word = merge_word(base, personal_row(conn.execute("SELECT * FROM words WHERE normalized=?", (key,)).fetchone()))
            if requested_topic and word.get("topic") != requested_topic and requested_topic not in word.get("related_topics", []):
                continue
            if mode == "review":
                types = desired_card_types(word)
            else:
                if word.get("learning_mode") == "recognition" and "learning_mode" in word.get("manual_fields", []):
                    continue
                types = ["spelling"]
            for card_type in types:
                if mode == "review":
                    row = ensure_card(conn, word, card_type)
                    queue.append(task_payload(conn, row, is_new=True, review_kind="new", settings=settings))
                else:
                    spelling = conn.execute("SELECT * FROM study_cards WHERE normalized=? AND card_type='spelling'", (key,)).fetchone()
                    queue.append(task_payload(conn, spelling, is_new=False, review_kind="free", settings=settings) if spelling else {"card_id": None, "card_type": "spelling", "is_new": True, "review_kind": "free", "word": word, "due": None})
            seen.add(key)
            if mode == "review":
                new_word_keys.add(key)
            added_words += 1
            if added_words >= unique_limit:
                break
    if mode == "dictation":
        queue = queue[:max(1, int(payload.get("limit", settings["dictation_count"])))]
    session_id = str(uuid.uuid4())
    stamp = now_iso()
    conn.execute(
        "INSERT INTO study_sessions VALUES(?,?,?,?,?,?,?,?,?,?)",
        (session_id, mode, json.dumps(payload, ensure_ascii=False), json.dumps(queue, ensure_ascii=False), 0, "active", len({t['word']['normalized'] for t in queue if t['is_new']}), stamp, None, stamp),
    )
    conn.commit()
    return get_session(conn, session_id)


def session_from_row(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["scope"] = json_load(item.pop("scope_json"), {})
    queue = json_load(item.pop("queue_json"), [])
    if isinstance(queue, dict) and queue.get("engine") == "group":
        item["engine"] = "group"
        item["phase"] = queue.get("phase") or "meaning"
        item["words"] = queue.get("words") or []
        item["progress"] = _group_progress(queue)
        item["current"] = _public_current(queue)
        item["settled"] = bool(queue.get("settled"))
        item["settle_summary"] = queue.get("settle_summary")
        item["streak_needed"] = queue.get("streak_needed", LEARN_STREAK_NEEDED)
        item["queue"] = []
        item["total"] = len(item["words"])
    else:
        item["engine"] = "linear"
        item["queue"] = queue if isinstance(queue, list) else []
        item["total"] = len(item["queue"])
        item["words"] = []
        item["phase"] = "linear"
        index = int(item.get("current_index") or 0)
        item["current"] = item["queue"][index] if 0 <= index < len(item["queue"]) else None
    return item


def get_session(conn: sqlite3.Connection, session_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM study_sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        return None
    item = session_from_row(row)
    rating_names = {1: "Again", 2: "Hard", 3: "Good", 4: "Easy"}
    words_by_key = {word["normalized"]: word for word in item.get("words") or []}
    item["attempts"] = []
    for attempt in conn.execute("SELECT * FROM study_attempts WHERE session_id=? ORDER BY task_index", (session_id,)):
        data = dict(attempt)
        data["correct"] = bool(data["correct"])
        data["corrected"] = bool(data.get("corrected"))
        data["rating_name"] = rating_names.get(data["rating"], "Again")
        if item.get("engine") == "group":
            word_item = words_by_key.get(data["normalized"])
            if word_item:
                data["task"] = {"word": word_item["word"], "card_type": data["card_type"]}
        elif 0 <= data["task_index"] < len(item["queue"]):
            data["task"] = item["queue"][data["task_index"]]
        item["attempts"].append(data)
    return item


def spelling_normalize(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def levenshtein(left: str, right: str) -> int:
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def _settle_rating(item: dict[str, Any], mode: str) -> Rating:
    if item.get("spell_correct") is False:
        return Rating.Again
    if not item.get("unfamiliar"):
        if mode == "review" and item.get("instant_know"):
            return Rating.Easy
        return Rating.Good
    return Rating.Hard


def _settle_group(conn: sqlite3.Connection, mode: str, queue: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings(conn)
    scheduler = scheduler_for(settings)
    dues = []
    stamp = now_iso()
    for item in queue["words"]:
        word = item["word"]
        rating = _settle_rating(item, mode)
        card_row = ensure_card(conn, word, "meaning")
        card = Card.from_json(card_row["fsrs_json"])
        card, _ = scheduler.review_card(card, rating, review_datetime=utc_now())
        retrievability = card_retrievability(card, scheduler)
        conn.execute(
            "UPDATE study_cards SET fsrs_json=?,calibration=0,retrievability=?,last_rating=?,updated_at=? WHERE id=?",
            (card.to_json(), retrievability, rating.value, stamp, card_row["id"]),
        )
        review_kind = "new" if item.get("is_new") else "due"
        conn.execute(
            "INSERT INTO review_logs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                str(uuid.uuid4()), card_row["id"], word["normalized"], "meaning", rating.value,
                int(not item.get("unfamiliar")), "", 0, "[]", 0, 0, review_kind, stamp,
            ),
        )
        item["card_id"] = card_row["id"]
        item["due"] = card.due.isoformat()
        dues.append({
            "word": word["word"],
            "due": item["due"],
            "rating": rating.name,
            "unfamiliar": bool(item.get("unfamiliar")),
        })
    queue["settled"] = True
    queue["settle_summary"] = {
        "remembered": sum(1 for item in queue["words"] if not item.get("unfamiliar")),
        "unfamiliar": sum(1 for item in queue["words"] if item.get("unfamiliar")),
        "dues": dues,
    }
    return queue


def _mark_meaning_result(item: dict[str, Any], correct: bool) -> None:
    item["seen_count"] = int(item.get("seen_count") or 0) + 1
    if correct:
        item["streak"] = int(item.get("streak") or 0) + 1
        if item["streak"] >= int(item.get("needed") or LEARN_STREAK_NEEDED):
            item["meaning_done"] = True
    else:
        item["streak"] = 0
        item["unfamiliar"] = True


def _record_group_attempt(conn: sqlite3.Connection, row: sqlite3.Row, queue: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    if row["status"] != "active":
        raise ValueError("训练会话已结束")
    current = queue.get("current")
    if not current:
        raise ValueError("训练题目不存在")
    item = next((word for word in queue["words"] if word["normalized"] == current["normalized"]), None)
    if not item:
        raise ValueError("训练题目不存在")
    word = item["word"]
    kind = current["kind"]
    answer = str(payload.get("answer", "")).strip()
    timeout = bool(payload.get("timeout"))
    hints = [str(x) for x in payload.get("hints", [])]
    duration = max(0, min(3_600_000, int(payload.get("duration_ms", 0))))
    replays = max(0, min(100, int(payload.get("replays", 0))))
    close = False
    show_detail = False
    expected = word.get("definition")
    card_type = "meaning"

    if kind == "review_self":
        item["review_self_done"] = True
        if answer == "know" and not timeout:
            item["streak"] = int(item.get("needed") or REVIEW_STREAK_NEEDED)
            item["meaning_done"] = True
            item["instant_know"] = True
            item["seen_count"] = int(item.get("seen_count") or 0) + 1
            correct = True
            show_detail = False
        elif answer == "fuzzy" and not timeout:
            item["unfamiliar"] = True
            item["seen_count"] = int(item.get("seen_count") or 0) + 1
            correct = False
            show_detail = True
        else:
            item["unfamiliar"] = True
            item["streak"] = 0
            item["seen_count"] = int(item.get("seen_count") or 0) + 1
            correct = False
            show_detail = True
    elif kind == "know_check":
        correct = answer == "know" and not timeout
        _mark_meaning_result(item, correct)
        show_detail = not correct
    elif kind == "meaning_mcq":
        correct = answer == str(word.get("definition", "")).strip()
        _mark_meaning_result(item, correct)
        show_detail = True
    elif kind == "spelling":
        card_type = "spelling"
        expected = word["word"]
        actual = spelling_normalize(answer)
        target = spelling_normalize(word["word"])
        correct = actual == target
        close_limit = 1 if len(target) <= 7 else 2
        close = not correct and levenshtein(actual, target) <= close_limit
        if correct:
            item["spell_done"] = True
            item["spell_correct"] = True
            item["spell_needs_retry"] = False
        else:
            item["unfamiliar"] = True
            item["spell_correct"] = False
            item["spell_needs_retry"] = True
        show_detail = not correct
    else:
        raise ValueError("训练题目不存在")

    verdict = "remembered" if item.get("meaning_done") and not item.get("unfamiliar") else ("unfamiliar" if not correct or item.get("unfamiliar") else "progress")
    rating = Rating.Good if correct else Rating.Again
    stamp = now_iso()
    attempt_index = int(row["current_index"] or 0)
    conn.execute(
        """INSERT INTO study_attempts (
          id,session_id,task_index,normalized,card_type,answer,correct,rating,
          duration_ms,hints_json,replays,corrected,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (str(uuid.uuid4()), row["id"], attempt_index, word["normalized"], card_type, answer, int(correct), rating.value, duration, json.dumps(hints), replays, int(correct), stamp),
    )
    last = item["normalized"]
    if kind == "spelling" and not correct:
        queue["current"] = {"normalized": item["normalized"], "kind": "spelling"}
        queue["last_normalized"] = last
    else:
        queue["last_normalized"] = last
        _set_current_prompt(queue, row["mode"], last=last)
    status = "active"
    if queue.get("phase") == "done" and not queue.get("settled"):
        _settle_group(conn, row["mode"], queue)
        status = "complete"
        queue["phase"] = "done"
        queue["current"] = None
    conn.execute(
        "UPDATE study_sessions SET queue_json=?,current_index=?,status=?,completed_at=CASE WHEN ?='complete' THEN ? ELSE completed_at END,updated_at=? WHERE id=?",
        (json.dumps(queue, ensure_ascii=False), attempt_index + 1, status, status, stamp, stamp, row["id"]),
    )
    conn.commit()
    public = get_session(conn, row["id"])
    due = None
    if queue.get("settled") and item.get("due"):
        due = item["due"]
    return {
        "correct": correct,
        "close": close,
        "rating": verdict,
        "expected": expected,
        "show_detail": show_detail,
        "timeout": timeout,
        "scheduled": bool(queue.get("settled")),
        "due": due,
        "duration_ms": duration,
        "replays": replays,
        "current_index": attempt_index + 1,
        "status": status,
        "streak": item.get("streak", 0),
        "needed": item.get("needed"),
        "meaning_done": bool(item.get("meaning_done")),
        "unfamiliar": bool(item.get("unfamiliar")),
        "word": word,
        "current": public.get("current") if public else None,
        "progress": public.get("progress") if public else _group_progress(queue),
        "settle_summary": queue.get("settle_summary"),
        "phase": queue.get("phase"),
    }


def record_attempt(conn: sqlite3.Connection, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM study_sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        raise KeyError("训练会话不存在")
    queue = json_load(row["queue_json"], [])
    if isinstance(queue, dict) and queue.get("engine") == "group":
        return _record_group_attempt(conn, row, queue, payload)
    session = get_session(conn, session_id)
    if not session:
        raise KeyError("训练会话不存在")
    index = int(payload.get("task_index", session["current_index"]))
    if index < 0 or index >= len(session["queue"]):
        raise ValueError("训练题目不存在")
    existing = conn.execute("SELECT * FROM study_attempts WHERE session_id=? AND task_index=?", (session_id, index)).fetchone()
    if existing:
        if payload.get("correction"):
            task = session["queue"][index]
            corrected = spelling_normalize(str(payload.get("answer", ""))) == spelling_normalize(task["word"]["word"])
            if corrected:
                conn.execute("UPDATE study_attempts SET corrected=1 WHERE id=?", (existing["id"],))
                conn.commit()
            return {"duplicate": True, "corrected": corrected, "current_index": session["current_index"]}
        return {"duplicate": True, "current_index": session["current_index"]}
    task = session["queue"][index]
    word = task["word"]
    answer = str(payload.get("answer", ""))
    hints = [str(x) for x in payload.get("hints", [])]
    recall_mode = payload.get("recall_mode", "options")
    if task["card_type"] == "spelling":
        actual, expected = spelling_normalize(answer), spelling_normalize(word["word"])
        correct = actual == expected
        close_limit = 1 if len(expected) <= 7 else 2
        close = not correct and levenshtein(actual, expected) <= close_limit
    else:
        correct = answer.strip() == str(word.get("definition", "")).strip()
        close = False
    if not correct or recall_mode == "skip":
        rating = Rating.Again
    elif payload.get("easy"):
        rating = Rating.Easy
    elif hints or recall_mode == "options":
        rating = Rating.Hard
    else:
        rating = Rating.Good
    card_row = conn.execute("SELECT * FROM study_cards WHERE id=?", (task["card_id"],)).fetchone()
    scheduled = task["review_kind"] in {"due", "new"}
    if card_row and scheduled:
        card = Card.from_json(card_row["fsrs_json"])
        card, _ = scheduler_for(get_settings(conn)).review_card(card, rating, review_datetime=utc_now())
        scheduler = scheduler_for(get_settings(conn))
        retrievability = card_retrievability(card, scheduler)
        conn.execute(
            "UPDATE study_cards SET fsrs_json=?,calibration=0,retrievability=?,last_rating=?,updated_at=? WHERE id=?",
            (card.to_json(), retrievability, rating.value, now_iso(), card_row["id"]),
        )
    elif task["review_kind"] == "free" and not correct and not (word.get("learning_mode") == "recognition" and "learning_mode" in word.get("manual_fields", [])):
        card_row = ensure_card(conn, word, "spelling")
        activated = Card.from_json(card_row["fsrs_json"])
        activated.due = utc_now()
        conn.execute("UPDATE study_cards SET fsrs_json=?,suspended=0,updated_at=? WHERE id=?", (activated.to_json(), now_iso(), card_row["id"]))
        scheduled = False
    stamp = now_iso()
    duration = max(0, min(3_600_000, int(payload.get("duration_ms", 0))))
    replays = max(0, min(100, int(payload.get("replays", 0))))
    log_card_id = card_row["id"] if card_row else task.get("card_id")
    log_kind = task["review_kind"] if session["mode"] == "review" else ("dictation_due" if task["review_kind"] == "due" else "dictation_free")
    conn.execute(
        "INSERT INTO review_logs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (str(uuid.uuid4()), log_card_id, word["normalized"], task["card_type"], rating.value, int(correct), answer, int(recall_mode == "options"), json.dumps(hints), replays, duration, log_kind, stamp),
    )
    conn.execute(
        """INSERT INTO study_attempts (
          id,session_id,task_index,normalized,card_type,answer,correct,rating,
          duration_ms,hints_json,replays,corrected,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (str(uuid.uuid4()), session_id, index, word["normalized"], task["card_type"], answer, int(correct), rating.value, duration, json.dumps(hints), replays, int(correct), stamp),
    )
    next_index = max(session["current_index"], index + 1)
    status = "complete" if next_index >= len(session["queue"]) else "active"
    conn.execute(
        "UPDATE study_sessions SET current_index=?,status=?,completed_at=CASE WHEN ?='complete' THEN ? ELSE completed_at END,updated_at=? WHERE id=?",
        (next_index, status, status, stamp, stamp, session_id),
    )
    conn.commit()
    due = None
    if card_row:
        refreshed = conn.execute("SELECT fsrs_json FROM study_cards WHERE id=?", (card_row["id"],)).fetchone()
        if refreshed:
            due = Card.from_json(refreshed["fsrs_json"]).due.isoformat()
    return {"correct": correct, "close": close, "rating": rating.name, "expected": word["word"] if task["card_type"] == "spelling" else word.get("definition"), "scheduled": scheduled, "due": due, "duration_ms": duration, "replays": replays, "current_index": next_index, "status": status}


def update_session(conn: sqlite3.Connection, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    status = payload.get("status")
    if status not in {"active", "complete", "abandoned"}:
        raise ValueError("训练状态无效")
    stamp = now_iso()
    conn.execute(
        "UPDATE study_sessions SET status=?,completed_at=CASE WHEN ?='active' THEN NULL ELSE ? END,updated_at=? WHERE id=?",
        (status, status, stamp, stamp, session_id),
    )
    conn.commit()
    result = get_session(conn, session_id)
    if not result:
        raise KeyError("训练会话不存在")
    return result


def dashboard(conn: sqlite3.Connection) -> dict[str, Any]:
    settings = get_settings(conn)
    now = utc_now()
    due = {"meaning": 0, "spelling": 0}
    for row in conn.execute("SELECT * FROM study_cards WHERE suspended=0"):
        catalogs = set(json_load(row["source_catalogs_json"], []))
        if catalogs and catalogs.issubset(set(settings["paused_catalogs"])):
            continue
        if Card.from_json(row["fsrs_json"]).due <= now:
            due[row["card_type"]] += 1
    local_start = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc).isoformat()
    reviewed = conn.execute("SELECT COUNT(*) FROM review_logs WHERE review_kind IN ('due','dictation_due') AND created_at>=?", (local_start,)).fetchone()[0]
    new_words = conn.execute("SELECT COUNT(DISTINCT normalized) FROM review_logs WHERE review_kind='new' AND created_at>=?", (local_start,)).fetchone()[0]
    day_rows = conn.execute("SELECT created_at FROM review_logs").fetchall()
    active_days = {datetime.fromisoformat(row["created_at"]).astimezone().date().isoformat() for row in day_rows}
    streak = 0
    day = datetime.now().astimezone().date()
    while day.isoformat() in active_days:
        streak += 1
        day -= timedelta(days=1)
    active_sessions = {row["mode"]: row["id"] for row in conn.execute("SELECT id,mode FROM study_sessions WHERE status='active' ORDER BY updated_at")}
    return {"due": due, "due_total": sum(due.values()), "reviewed_today": reviewed, "new_words_today": new_words, "new_limit": settings["daily_new_limit"], "streak": streak, "active_sessions": active_sessions, "active_session_id": next(iter(active_sessions.values()), None)}


def export_data(conn: sqlite3.Connection) -> dict[str, Any]:
    tables = ["words", "settings", "study_cards", "review_logs", "study_sessions", "study_attempts", "chats", "messages", "notebooks", "notes", "note_revisions", "chat_note_links"]
    result = {"format": "ielts-vocab-hub", "version": SCHEMA_VERSION, "exported_at": now_iso(), "data": {}}
    for table in tables:
        result["data"][table] = [dict(row) for row in conn.execute(f"SELECT * FROM {table}")]
    return result


def import_preview(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("format") != "ielts-vocab-hub" or not isinstance(payload.get("data"), dict):
        raise ValueError("不是有效的 Vocab Atelier 导出文件")
    version = int(payload.get("version", 0))
    if version > SCHEMA_VERSION or version < 1:
        raise ValueError("导出文件版本不受支持")
    allowed = {"words", "settings", "study_cards", "review_logs", "study_sessions", "study_attempts", "chats", "messages", "notebooks", "notes", "note_revisions", "chat_note_links"}
    counts = {table: len(rows) for table, rows in payload["data"].items() if table in allowed and isinstance(rows, list)}
    return {"valid": True, "version": version, "counts": counts}


def import_data(conn: sqlite3.Connection, payload: dict[str, Any], mode: str = "merge") -> dict[str, Any]:
    preview = import_preview(payload)
    if mode not in {"merge", "replace"}:
        raise ValueError("导入方式无效")
    tables = ["words", "settings", "study_cards", "review_logs", "study_sessions", "study_attempts", "chats", "messages", "notebooks", "notes", "note_revisions", "chat_note_links"]
    if mode == "replace":
        for table in reversed(tables):
            conn.execute(f"DELETE FROM {table}")
    imported = {}
    for table in tables:
        rows = payload["data"].get(table, [])
        count = 0
        columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        for row in rows:
            if not isinstance(row, dict):
                continue
            keys = [key for key in row if key in columns]
            if not keys:
                continue
            conn.execute(
                f"INSERT OR REPLACE INTO {table} ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})",
                [row[key] for key in keys],
            )
            count += 1
        imported[table] = count
    conn.commit()
    try:
        import notes as note_store
        for row in conn.execute("SELECT id FROM notes"):
            note_store.rebuild_index(conn, row["id"])
        conn.commit()
    except (ImportError, sqlite3.OperationalError):
        pass
    return {"ok": True, "mode": mode, "imported": imported, "preview": preview}


def delete_scope(conn: sqlite3.Connection, scope: str) -> dict[str, Any]:
    if scope == "dictation":
        session_ids = [row[0] for row in conn.execute("SELECT id FROM study_sessions WHERE mode='dictation'")]
        for session_id in session_ids:
            conn.execute("DELETE FROM study_sessions WHERE id=?", (session_id,))
        conn.execute("DELETE FROM review_logs WHERE review_kind IN ('dictation_due','dictation_free','dictation')")
    elif scope == "chats":
        conn.execute("DELETE FROM chats")
    elif scope == "learning":
        conn.execute("DELETE FROM review_logs")
        conn.execute("DELETE FROM study_sessions")
        conn.execute("DELETE FROM study_cards")
    elif scope == "all":
        for table in ("review_logs", "study_sessions", "study_cards", "chats", "note_revisions", "notes", "notebooks", "words"):
            conn.execute(f"DELETE FROM {table}")
        stamp = now_iso()
        conn.execute("INSERT INTO notebooks(id,name,sort_order,created_at,updated_at) VALUES(?,?,?,?,?)", ("default-notebook", "我的笔记", 0, stamp, stamp))
        conn.execute("DELETE FROM settings")
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute("INSERT INTO settings VALUES(?,?,?)", (key, json.dumps(value), now_iso()))
    else:
        raise ValueError("清除范围无效")
    conn.commit()
    return {"ok": True, "scope": scope}
