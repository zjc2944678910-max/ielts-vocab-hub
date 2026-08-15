"""Personal Markdown notes, search, versioning and import/export support."""

from __future__ import annotations

import base64
import io
import json
import re
import sqlite3
import threading
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_NOTEBOOK_ID = "default-notebook"
MAX_NOTES = 2_000
MAX_NOTE_BYTES = 2_000_000
MAX_TOTAL_BYTES = 100_000_000
MAX_IMPORT_FILES = 100
NOTE_CONTEXT_BUDGET = 6_000
BLANK_NOTE_LOCK = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json(value: str | None, default: Any) -> Any:
    try:
        return json.loads(value or "")
    except (TypeError, json.JSONDecodeError):
        return default


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS notebooks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          notebook_id TEXT NOT NULL REFERENCES notebooks(id),
          title TEXT NOT NULL,
          content_md TEXT NOT NULL DEFAULT '',
          tags_json TEXT NOT NULL DEFAULT '[]',
          source_filename TEXT NOT NULL DEFAULT '',
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notes_notebook_updated ON notes(notebook_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS note_revisions (
          id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          content_md TEXT NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]',
          reason TEXT NOT NULL DEFAULT 'manual',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_note_revisions_note_created ON note_revisions(note_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS note_chunks (
          id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL,
          heading TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          UNIQUE(note_id, chunk_index)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS note_search USING fts5(
          chunk_id UNINDEXED, note_id UNINDEXED, title, heading, content,
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TABLE IF NOT EXISTS chat_note_links (
          chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY(chat_id, note_id)
        );
        CREATE TABLE IF NOT EXISTS note_ai_drafts (
          id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          operation TEXT NOT NULL,
          instruction TEXT NOT NULL DEFAULT '',
          source_version INTEGER NOT NULL,
          content_md TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'generating',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        """
    )
    stamp = now_iso()
    conn.execute(
        "INSERT OR IGNORE INTO notebooks(id,name,sort_order,created_at,updated_at) VALUES(?,?,?,?,?)",
        (DEFAULT_NOTEBOOK_ID, "我的笔记", 0, stamp, stamp),
    )
    conn.commit()


def notebook_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row)


def note_from_row(row: sqlite3.Row, *, include_content: bool = True) -> dict[str, Any]:
    result = dict(row)
    result["tags"] = _json(result.pop("tags_json", "[]"), [])
    if not include_content:
        content = result.pop("content_md", "")
        result["excerpt"] = re.sub(r"\s+", " ", re.sub(r"[#>*_`~-]", "", content)).strip()[:180]
    return result


def revision_from_row(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    result["tags"] = _json(result.pop("tags_json", "[]"), [])
    return result


def clean_title(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())[:160] or "无标题笔记"


def clean_tags(value: Any) -> list[str]:
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        tag = re.sub(r"\s+", " ", str(item).strip())[:40]
        if tag and tag.casefold() not in {x.casefold() for x in result}:
            result.append(tag)
    return result[:30]


def validate_content(value: Any) -> str:
    content = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    if len(content.encode("utf-8")) > MAX_NOTE_BYTES:
        raise ValueError("单篇笔记不能超过 2 MB")
    return content


def storage_usage(conn: sqlite3.Connection) -> dict[str, int]:
    count = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
    active = conn.execute("SELECT COALESCE(SUM(length(CAST(content_md AS BLOB))),0) FROM notes").fetchone()[0]
    revisions = conn.execute("SELECT COALESCE(SUM(length(CAST(content_md AS BLOB))),0) FROM note_revisions").fetchone()[0]
    drafts = conn.execute("SELECT COALESCE(SUM(length(CAST(content_md AS BLOB))),0) FROM note_ai_drafts").fetchone()[0]
    return {"notes": int(count), "bytes": int(active + revisions + drafts), "limit_notes": MAX_NOTES, "limit_bytes": MAX_TOTAL_BYTES}


def enforce_quota(conn: sqlite3.Connection, delta_bytes: int, *, creating: bool = False) -> None:
    usage = storage_usage(conn)
    if creating and usage["notes"] >= MAX_NOTES:
        raise ValueError("笔记数量已达到 2,000 篇上限")
    if usage["bytes"] + max(0, delta_bytes) > MAX_TOTAL_BYTES:
        raise ValueError("笔记空间已达到 100 MB 上限，请导出并清理旧版本")


def split_markdown(content: str) -> list[tuple[str, str]]:
    chunks: list[tuple[str, str]] = []
    heading = "正文"
    buffer: list[str] = []

    def flush() -> None:
        nonlocal buffer
        text = "\n".join(buffer).strip()
        while text:
            part = text[:1200]
            if len(text) > 1200:
                split_at = max(part.rfind("\n\n"), part.rfind("。"), part.rfind(". "))
                if split_at > 500:
                    part = text[: split_at + 1]
            chunks.append((heading, part.strip()))
            text = text[len(part):].strip()
        buffer = []

    for line in content.splitlines():
        match = re.match(r"^\s{0,3}#{1,4}\s+(.+?)\s*$", line)
        if match:
            flush()
            heading = re.sub(r"[*_`]+", "", match.group(1)).strip()[:160] or "正文"
        else:
            buffer.append(line)
    flush()
    return chunks or [("正文", content[:1200])]


def rebuild_index(conn: sqlite3.Connection, note_id: str) -> None:
    row = conn.execute("SELECT title,content_md FROM notes WHERE id=?", (note_id,)).fetchone()
    conn.execute("DELETE FROM note_search WHERE note_id=?", (note_id,))
    conn.execute("DELETE FROM note_chunks WHERE note_id=?", (note_id,))
    if not row:
        return
    for index, (heading, content) in enumerate(split_markdown(row["content_md"])):
        chunk_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO note_chunks(id,note_id,chunk_index,heading,content) VALUES(?,?,?,?,?)",
            (chunk_id, note_id, index, heading, content),
        )
        conn.execute(
            "INSERT INTO note_search(chunk_id,note_id,title,heading,content) VALUES(?,?,?,?,?)",
            (chunk_id, note_id, row["title"], heading, content),
        )


def list_notebooks(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT b.*,COUNT(n.id) AS note_count FROM notebooks b LEFT JOIN notes n ON n.notebook_id=b.id GROUP BY b.id ORDER BY b.sort_order,b.created_at"
    ).fetchall()
    return [notebook_from_row(row) for row in rows]


def create_notebook(conn: sqlite3.Connection, name: Any, *, commit: bool = True) -> dict[str, Any]:
    clean = clean_title(name)
    stamp = now_iso()
    notebook_id = str(uuid.uuid4())
    order = conn.execute("SELECT COALESCE(MAX(sort_order),0)+1 FROM notebooks").fetchone()[0]
    conn.execute("INSERT INTO notebooks VALUES(?,?,?,?,?)", (notebook_id, clean, order, stamp, stamp))
    if commit:
        conn.commit()
    return notebook_from_row(conn.execute("SELECT * FROM notebooks WHERE id=?", (notebook_id,)).fetchone())


def update_notebook(conn: sqlite3.Connection, notebook_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM notebooks WHERE id=?", (notebook_id,)).fetchone()
    if not row:
        raise KeyError("笔记本不存在")
    name = clean_title(payload.get("name", row["name"]))
    order = int(payload.get("sort_order", row["sort_order"]))
    conn.execute("UPDATE notebooks SET name=?,sort_order=?,updated_at=? WHERE id=?", (name, order, now_iso(), notebook_id))
    conn.commit()
    return notebook_from_row(conn.execute("SELECT * FROM notebooks WHERE id=?", (notebook_id,)).fetchone())


def delete_notebook(conn: sqlite3.Connection, notebook_id: str) -> None:
    if notebook_id == DEFAULT_NOTEBOOK_ID:
        raise ValueError("默认笔记本不能删除")
    if not conn.execute("SELECT 1 FROM notebooks WHERE id=?", (notebook_id,)).fetchone():
        raise KeyError("笔记本不存在")
    conn.execute("UPDATE notes SET notebook_id=?,updated_at=? WHERE notebook_id=?", (DEFAULT_NOTEBOOK_ID, now_iso(), notebook_id))
    conn.execute("DELETE FROM notebooks WHERE id=?", (notebook_id,))
    conn.commit()


def _cursor(value: str | None) -> int:
    if not value:
        return 0
    try:
        return max(0, int(base64.urlsafe_b64decode(value + "==").decode()))
    except (ValueError, UnicodeDecodeError):
        return 0


def _next_cursor(value: int) -> str:
    return base64.urlsafe_b64encode(str(value).encode()).decode().rstrip("=")


def list_notes(conn: sqlite3.Connection, query: dict[str, list[str]]) -> dict[str, Any]:
    notebook_id = (query.get("notebook_id") or [""])[0]
    tag = (query.get("tag") or [""])[0].strip()
    search = (query.get("q") or [""])[0].strip()
    offset = _cursor((query.get("cursor") or [""])[0])
    clauses, values = [], []
    fts_ids: list[str] | None = None
    if notebook_id:
        clauses.append("n.notebook_id=?"); values.append(notebook_id)
    if tag:
        clauses.append("EXISTS (SELECT 1 FROM json_each(n.tags_json) WHERE value=?)"); values.append(tag)
    if search and re.fullmatch(r"[\w\s\-']+", search, re.ASCII):
        tokens = [token for token in re.findall(r"[A-Za-z0-9]+", search.casefold()) if token][:10]
        if tokens:
            match_query = " AND ".join(f'"{token}"*' for token in tokens)
            fts_ids = list(dict.fromkeys(
                row["note_id"]
                for row in conn.execute(
                    "SELECT note_id FROM note_search WHERE note_search MATCH ? ORDER BY bm25(note_search) LIMIT 300",
                    (match_query,),
                )
            ))
            if not fts_ids:
                return {"notes": [], "next_cursor": None, "usage": storage_usage(conn)}
            clauses.append(f"n.id IN ({','.join('?' for _ in fts_ids)})")
            values.extend(fts_ids)
    elif search:
        like = f"%{search}%"
        clauses.append("(n.title LIKE ? OR n.content_md LIKE ? OR n.tags_json LIKE ?)")
        values.extend([like, like, like])
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    rows = conn.execute(
        f"SELECT n.*,b.name AS notebook_name FROM notes n JOIN notebooks b ON b.id=n.notebook_id{where} ORDER BY n.updated_at DESC LIMIT 51 OFFSET ?",
        [*values, offset],
    ).fetchall()
    more = len(rows) > 50
    rows = rows[:50]
    return {"notes": [note_from_row(row, include_content=False) for row in rows], "next_cursor": _next_cursor(offset + 50) if more else None, "usage": storage_usage(conn)}


def get_note(conn: sqlite3.Connection, note_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT n.*,b.name AS notebook_name FROM notes n JOIN notebooks b ON b.id=n.notebook_id WHERE n.id=?",
        (note_id,),
    ).fetchone()
    return note_from_row(row) if row else None


def create_note(conn: sqlite3.Connection, payload: dict[str, Any], *, commit: bool = True) -> dict[str, Any]:
    notebook_id = str(payload.get("notebook_id") or DEFAULT_NOTEBOOK_ID)
    if not conn.execute("SELECT 1 FROM notebooks WHERE id=?", (notebook_id,)).fetchone():
        notebook_id = DEFAULT_NOTEBOOK_ID
    content = validate_content(payload.get("content_md", ""))
    enforce_quota(conn, len(content.encode("utf-8")), creating=True)
    stamp = now_iso()
    note_id = str(payload.get("id") or uuid.uuid4())
    if conn.execute("SELECT 1 FROM notes WHERE id=?", (note_id,)).fetchone():
        note_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?)",
        (note_id, notebook_id, clean_title(payload.get("title")), content, json.dumps(clean_tags(payload.get("tags")), ensure_ascii=False), str(payload.get("source_filename") or "")[:255], 1, stamp, stamp),
    )
    rebuild_index(conn, note_id)
    if commit:
        conn.commit()
    return get_note(conn, note_id)  # type: ignore[return-value]


def create_or_reuse_blank_note(conn: sqlite3.Connection, payload: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Keep repeated UI clicks from creating multiple untouched blank notes."""
    notebook_id = str(payload.get("notebook_id") or DEFAULT_NOTEBOOK_ID)
    title = clean_title(payload.get("title"))
    content = validate_content(payload.get("content_md", ""))
    tags = clean_tags(payload.get("tags"))
    is_ui_blank = (
        title == "无标题笔记"
        and not content.strip()
        and not tags
        and not payload.get("id")
        and not payload.get("source_filename")
    )
    if not is_ui_blank:
        return create_note(conn, payload), False
    if not conn.execute("SELECT 1 FROM notebooks WHERE id=?", (notebook_id,)).fetchone():
        notebook_id = DEFAULT_NOTEBOOK_ID
    with BLANK_NOTE_LOCK:
        row = conn.execute(
            """
            SELECT id FROM notes
            WHERE notebook_id=? AND title='无标题笔记' AND trim(content_md)=''
              AND tags_json='[]' AND source_filename=''
            ORDER BY updated_at DESC LIMIT 1
            """,
            (notebook_id,),
        ).fetchone()
        if row:
            return get_note(conn, row["id"]), True  # type: ignore[return-value]
        return create_note(conn, {**payload, "notebook_id": notebook_id}), False


def save_revision(conn: sqlite3.Connection, row: sqlite3.Row, reason: str) -> None:
    conn.execute(
        "INSERT INTO note_revisions VALUES(?,?,?,?,?,?,?)",
        (str(uuid.uuid4()), row["id"], row["title"], row["content_md"], row["tags_json"], reason[:40], now_iso()),
    )


def update_note(conn: sqlite3.Connection, note_id: str, payload: dict[str, Any], *, reason: str = "manual", commit: bool = True) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    if not row:
        raise KeyError("笔记不存在")
    try:
        expected = int(payload["version"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("保存笔记必须携带当前版本号") from exc
    if expected != row["version"]:
        raise RuntimeError("version_conflict")
    title = clean_title(payload.get("title", row["title"]))
    content = validate_content(payload.get("content_md", row["content_md"]))
    tags = clean_tags(payload.get("tags", _json(row["tags_json"], [])))
    notebook_id = str(payload.get("notebook_id", row["notebook_id"]))
    if not conn.execute("SELECT 1 FROM notebooks WHERE id=?", (notebook_id,)).fetchone():
        raise ValueError("目标笔记本不存在")
    old_bytes = len(row["content_md"].encode("utf-8"))
    new_bytes = len(content.encode("utf-8"))
    changed = (title, content, tags, notebook_id) != (row["title"], row["content_md"], _json(row["tags_json"], []), row["notebook_id"])
    should_snapshot = changed and (reason != "manual" or payload.get("create_revision") is True)
    revision_bytes = old_bytes if should_snapshot else 0
    enforce_quota(conn, max(0, new_bytes - old_bytes) + revision_bytes)
    if should_snapshot:
        save_revision(conn, row, reason)
    conn.execute(
        "UPDATE notes SET notebook_id=?,title=?,content_md=?,tags_json=?,version=version+1,updated_at=? WHERE id=?",
        (notebook_id, title, content, json.dumps(tags, ensure_ascii=False), now_iso(), note_id),
    )
    rebuild_index(conn, note_id)
    if commit:
        conn.commit()
    return get_note(conn, note_id)  # type: ignore[return-value]


def delete_note(conn: sqlite3.Connection, note_id: str) -> None:
    conn.execute("DELETE FROM note_search WHERE note_id=?", (note_id,))
    if not conn.execute("DELETE FROM notes WHERE id=?", (note_id,)).rowcount:
        raise KeyError("笔记不存在")
    conn.commit()


def list_revisions(conn: sqlite3.Connection, note_id: str) -> list[dict[str, Any]]:
    return [revision_from_row(row) for row in conn.execute("SELECT * FROM note_revisions WHERE note_id=? ORDER BY created_at DESC LIMIT 100", (note_id,))]


def restore_revision(conn: sqlite3.Connection, note_id: str, revision_id: str, version: int) -> dict[str, Any]:
    revision = conn.execute("SELECT * FROM note_revisions WHERE id=? AND note_id=?", (revision_id, note_id)).fetchone()
    if not revision:
        raise KeyError("历史版本不存在")
    current = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    if not current:
        raise KeyError("笔记不存在")
    return update_note(conn, note_id, {"version": version, "title": revision["title"], "content_md": revision["content_md"], "tags": _json(revision["tags_json"], [])}, reason="restore")


def parse_front_matter(text: str, filename: str) -> dict[str, Any]:
    content = text.replace("\r\n", "\n").replace("\r", "\n")
    metadata: dict[str, Any] = {}
    match = re.match(r"^---\n([\s\S]*?)\n---\n?", content)
    if match:
        for line in match.group(1).splitlines():
            key, sep, value = line.partition(":")
            if not sep:
                continue
            value = value.strip().strip("'\"")
            if key.strip() == "tags":
                metadata["tags"] = [x.strip().strip("'\"") for x in value.strip("[]").split(",") if x.strip()]
            elif key.strip() in {"id", "title", "notebook", "updated_at"}:
                metadata[key.strip()] = value
        content = content[match.end():]
    heading = re.search(r"^#\s+(.+?)\s*$", content, re.MULTILINE)
    metadata["title"] = clean_title(metadata.get("title") or (heading.group(1) if heading else Path(filename).stem))
    metadata["content_md"] = validate_content(content)
    metadata["tags"] = clean_tags(metadata.get("tags", []))
    metadata["source_filename"] = Path(filename).name[:255]
    return metadata


def import_preview(conn: sqlite3.Connection, files: Any) -> dict[str, Any]:
    if not isinstance(files, list) or not files or len(files) > MAX_IMPORT_FILES:
        raise ValueError("每批请选择 1–100 个 Markdown 文件")
    result = []
    projected = 0
    for item in files:
        if not isinstance(item, dict) or not str(item.get("name", "")).lower().endswith(".md"):
            raise ValueError("只支持 UTF-8 Markdown 文件")
        parsed = parse_front_matter(str(item.get("content", "")), str(item.get("name")))
        exported_id = str(parsed.get("id") or "")
        existing = conn.execute("SELECT id,title,content_md,version FROM notes WHERE id=?", (exported_id,)).fetchone() if exported_id else None
        duplicate = conn.execute("SELECT id FROM notes WHERE title=? AND content_md=?", (parsed["title"], parsed["content_md"])).fetchone()
        status = "identical" if duplicate else "update" if existing else "create"
        content_bytes = len(parsed["content_md"].encode("utf-8"))
        if status == "create":
            projected += content_bytes
        elif status == "update" and existing and parsed["content_md"] != existing["content_md"]:
            old_bytes = len(existing["content_md"].encode("utf-8"))
            projected += old_bytes + max(0, content_bytes - old_bytes)
        result.append({"name": item["name"], "title": parsed["title"], "status": status, "existing_id": existing["id"] if existing else None})
    usage = storage_usage(conn)
    if usage["notes"] + sum(x["status"] == "create" for x in result) > MAX_NOTES:
        raise ValueError("导入后将超过 2,000 篇笔记上限")
    enforce_quota(conn, projected)
    return {"valid": True, "files": result, "projected_bytes": projected, "usage": storage_usage(conn)}


def _notebook_by_name(conn: sqlite3.Connection, name: str, *, commit: bool = True) -> str:
    if not name:
        return DEFAULT_NOTEBOOK_ID
    row = conn.execute("SELECT id FROM notebooks WHERE lower(name)=lower(?)", (name,)).fetchone()
    return row["id"] if row else create_notebook(conn, name, commit=commit)["id"]


def import_files(conn: sqlite3.Connection, files: Any, *, confirm_updates: bool = False) -> dict[str, int]:
    preview = import_preview(conn, files)
    counts = {"created": 0, "updated": 0, "skipped": 0}
    try:
        for item, state in zip(files, preview["files"]):
            parsed = parse_front_matter(str(item.get("content", "")), str(item.get("name")))
            if state["status"] == "identical":
                counts["skipped"] += 1; continue
            if state["status"] == "update" and not confirm_updates:
                counts["skipped"] += 1; continue
            parsed["notebook_id"] = _notebook_by_name(conn, str(parsed.pop("notebook", "")), commit=False)
            if state["status"] == "update":
                current = get_note(conn, state["existing_id"])
                update_note(conn, state["existing_id"], {**parsed, "version": current["version"]}, reason="import", commit=False)  # type: ignore[index]
                counts["updated"] += 1
            else:
                create_note(conn, parsed, commit=False); counts["created"] += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return counts


def yaml_quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def export_markdown(note: dict[str, Any]) -> str:
    tags = ", ".join(yaml_quote(tag) for tag in note.get("tags", []))
    front = ["---", f"id: {yaml_quote(note['id'])}", f"title: {yaml_quote(note['title'])}", f"notebook: {yaml_quote(note.get('notebook_name','我的笔记'))}", f"tags: [{tags}]", f"updated_at: {yaml_quote(note['updated_at'])}", "---", ""]
    return "\n".join(front) + note.get("content_md", "")


def safe_filename(value: str, suffix: str = ".md") -> str:
    clean = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", value).strip(" .")[:100] or "note"
    return clean + suffix


def export_notes_zip(conn: sqlite3.Connection, note_ids: list[str] | None = None, notebook_id: str | None = None) -> bytes:
    clauses, values = [], []
    if note_ids:
        clauses.append(f"n.id IN ({','.join('?' for _ in note_ids[:2000])})"); values.extend(note_ids[:2000])
    if notebook_id:
        clauses.append("n.notebook_id=?"); values.append(notebook_id)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    rows = conn.execute(f"SELECT n.*,b.name AS notebook_name FROM notes n JOIN notebooks b ON b.id=n.notebook_id{where} ORDER BY b.sort_order,n.updated_at", values).fetchall()
    output = io.BytesIO()
    used: set[str] = set()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for row in rows:
            note = note_from_row(row)
            base = f"{safe_filename(note['notebook_name'], '')}/{safe_filename(note['title'])}"
            name, index = base, 2
            while name.casefold() in used:
                name = base[:-3] + f"-{index}.md"; index += 1
            used.add(name.casefold())
            archive.writestr(name, export_markdown(note).encode("utf-8"))
    raw = output.getvalue()
    if len(raw) > MAX_TOTAL_BYTES:
        raise ValueError("导出文件超过 100 MB，请缩小范围后重试")
    return raw


def set_chat_notes(conn: sqlite3.Connection, chat_id: str, note_ids: Any) -> list[dict[str, Any]]:
    if not conn.execute("SELECT 1 FROM chats WHERE id=?", (chat_id,)).fetchone():
        raise KeyError("会话不存在")
    ids = [str(x) for x in note_ids] if isinstance(note_ids, list) else []
    ids = list(dict.fromkeys(ids))[:20]
    valid = conn.execute(f"SELECT id,title FROM notes WHERE id IN ({','.join('?' for _ in ids)})", ids).fetchall() if ids else []
    conn.execute("DELETE FROM chat_note_links WHERE chat_id=?", (chat_id,))
    for row in valid:
        conn.execute("INSERT INTO chat_note_links VALUES(?,?,?)", (chat_id, row["id"], now_iso()))
    conn.commit()
    return [dict(row) for row in valid]


def get_chat_notes(conn: sqlite3.Connection, chat_id: str) -> list[dict[str, Any]]:
    return [dict(row) for row in conn.execute("SELECT n.id,n.title FROM notes n JOIN chat_note_links l ON l.note_id=n.id WHERE l.chat_id=? ORDER BY l.created_at", (chat_id,))]


def search_context(conn: sqlite3.Connection, question: str, note_ids: list[str], search_all: bool) -> tuple[str, list[dict[str, str]]]:
    ids = list(dict.fromkeys(str(x) for x in note_ids))[:20]
    if not search_all and not ids:
        return "", []
    clauses, values = [], []
    if ids and not search_all:
        clauses.append(f"c.note_id IN ({','.join('?' for _ in ids)})"); values.extend(ids)
    query_words = [x for x in re.findall(r"[\w\u4e00-\u9fff]+", question.casefold()) if len(x) > 1][:12]
    score = " + ".join(["CASE WHEN lower(c.content) LIKE ? THEN 1 ELSE 0 END" for _ in query_words]) or "0"
    score_values = [f"%{word}%" for word in query_words]
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    rows = conn.execute(
        f"SELECT c.note_id,n.title,c.heading,c.content,({score}) AS relevance FROM note_chunks c JOIN notes n ON n.id=c.note_id{where} ORDER BY relevance DESC,n.updated_at DESC,c.chunk_index LIMIT 24",
        [*score_values, *values],
    ).fetchall()
    used = 0
    sources: list[dict[str, str]] = []
    blocks: list[str] = []
    for row in rows:
        size = len(row["content"])
        if blocks and used + size > NOTE_CONTEXT_BUDGET:
            continue
        ref = f"N{len(sources)+1}"
        sources.append({"ref": ref, "note_id": row["note_id"], "title": row["title"], "heading": row["heading"]})
        blocks.append(f"[{ref}] {row['title']} › {row['heading']}\n{row['content']}")
        used += size
        if used >= NOTE_CONTEXT_BUDGET:
            break
    return "\n\n".join(blocks), sources


def create_ai_draft(conn: sqlite3.Connection, note_id: str, operation: str, instruction: str) -> tuple[dict[str, Any], dict[str, Any]]:
    note = get_note(conn, note_id)
    if not note:
        raise KeyError("笔记不存在")
    draft_id, stamp = str(uuid.uuid4()), now_iso()
    conn.execute("INSERT INTO note_ai_drafts VALUES(?,?,?,?,?,?,?,?,?)", (draft_id, note_id, operation[:40], instruction[:2000], note["version"], "", "generating", stamp, stamp))
    conn.commit()
    return dict(conn.execute("SELECT * FROM note_ai_drafts WHERE id=?", (draft_id,)).fetchone()), note


def finish_ai_draft(conn: sqlite3.Connection, draft_id: str, content: str, status: str) -> dict[str, Any]:
    validate_content(content)
    if not content.strip():
        raise ValueError("AI 草稿正文不能为空")
    enforce_quota(conn, len(content.encode("utf-8")))
    conn.execute("UPDATE note_ai_drafts SET content_md=?,status=?,updated_at=? WHERE id=?", (content, status, now_iso(), draft_id))
    conn.commit()
    return dict(conn.execute("SELECT * FROM note_ai_drafts WHERE id=?", (draft_id,)).fetchone())


def discard_ai_draft(conn: sqlite3.Connection, draft_id: str) -> bool:
    deleted = conn.execute("DELETE FROM note_ai_drafts WHERE id=?", (draft_id,)).rowcount
    conn.commit()
    return bool(deleted)


def apply_ai_draft(conn: sqlite3.Connection, draft_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    draft = conn.execute("SELECT * FROM note_ai_drafts WHERE id=?", (draft_id,)).fetchone()
    if not draft:
        raise KeyError("AI 草稿不存在")
    note = get_note(conn, draft["note_id"])
    if not note:
        raise KeyError("原笔记不存在")
    if note["version"] != draft["source_version"] or int(payload.get("version", -1)) != note["version"]:
        raise RuntimeError("version_conflict")
    mode = str(payload.get("mode", "replace"))
    if mode == "new":
        created = create_note(conn, {"notebook_id": note["notebook_id"], "title": f"{note['title']} · AI 整理", "content_md": draft["content_md"], "tags": note["tags"]})
        conn.execute("DELETE FROM note_ai_drafts WHERE id=?", (draft_id,)); conn.commit()
        return created
    content = draft["content_md"] if mode == "replace" else note["content_md"].rstrip() + "\n\n" + draft["content_md"].lstrip()
    updated = update_note(conn, note["id"], {"version": note["version"], "content_md": content, "title": note["title"], "tags": note["tags"], "notebook_id": note["notebook_id"]}, reason="ai")
    conn.execute("DELETE FROM note_ai_drafts WHERE id=?", (draft_id,)); conn.commit()
    return updated
