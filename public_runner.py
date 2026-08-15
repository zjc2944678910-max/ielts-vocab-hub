#!/usr/bin/env python3
"""Run the isolated public backend and same-origin gateway as one service."""

from __future__ import annotations

import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CONFIG_DIR = Path.home() / ".config" / "ielts-vocab-hub-public"
DATA_DIR = Path.home() / ".local" / "share" / "ielts-vocab-hub-public"
SECRET_PATH = CONFIG_DIR / "gateway.json"
BACKEND_PORT = 8091
PUBLIC_PORT = 8090


def load_or_create_secret() -> str:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(CONFIG_DIR, 0o700)
    try:
        value = json.loads(SECRET_PATH.read_text(encoding="utf-8"))["secret"]
        if isinstance(value, str) and len(value) >= 32:
            return value
    except (FileNotFoundError, OSError, KeyError, TypeError, json.JSONDecodeError):
        pass
    value = secrets.token_urlsafe(48)
    temporary = SECRET_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps({"secret": value}), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(SECRET_PATH)
    os.chmod(SECRET_PATH, 0o600)
    return value


def main() -> None:
    secret = load_or_create_secret()
    DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(DATA_DIR, 0o700)
    env = os.environ.copy()
    env.update({
        "PYTHONUNBUFFERED": "1",
        "IELTS_VOCAB_PUBLIC_MODE": "1",
        "IELTS_VOCAB_GATEWAY_SECRET": secret,
        "IELTS_VOCAB_PORT": str(BACKEND_PORT),
        "IELTS_VOCAB_PUBLIC_BACKEND_PORT": str(BACKEND_PORT),
        "IELTS_VOCAB_PUBLIC_PORT": str(PUBLIC_PORT),
        "IELTS_VOCAB_REQUIRE_ACCESS": os.environ.get("IELTS_VOCAB_REQUIRE_ACCESS", "0"),
        "IELTS_VOCAB_ALLOWED_EMAILS": os.environ.get("IELTS_VOCAB_ALLOWED_EMAILS", ""),
        "IELTS_VOCAB_ALLOWED_AUTHENTIK_USERS": os.environ.get("IELTS_VOCAB_ALLOWED_AUTHENTIK_USERS", ""),
        "IELTS_VOCAB_CONFIG_DIR": str(CONFIG_DIR),
        "IELTS_VOCAB_DATA_DIR": str(DATA_DIR),
        # Never allow a private Oxford catalog to cross into the public runner,
        # even when the parent shell has a local override configured.
        "IELTS_VOCAB_CATALOG_PATH": str(ROOT / "data" / "catalog.db"),
    })
    logs = Path("/tmp")
    backend_log = (logs / "ielts-vocab-public-backend.log").open("ab", buffering=0)
    gateway_log = (logs / "ielts-vocab-public-gateway.log").open("ab", buffering=0)
    backend = subprocess.Popen([sys.executable, str(ROOT / "proxy.py")], cwd=ROOT, env=env, stdout=backend_log, stderr=subprocess.STDOUT)
    gateway = subprocess.Popen([sys.executable, str(ROOT / "public_server.py")], cwd=ROOT, env=env, stdout=gateway_log, stderr=subprocess.STDOUT)
    children = [backend, gateway]

    def stop(*_: object) -> None:
        for child in children:
            if child.poll() is None:
                child.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        for _ in range(300):
            if any(child.poll() is not None for child in children):
                raise RuntimeError("public service failed during startup")
            try:
                with socket.create_connection(("127.0.0.1", PUBLIC_PORT), timeout=.3):
                    print(f"Vocab Atelier public service ready at http://127.0.0.1:{PUBLIC_PORT}", flush=True)
                    break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError("public service did not become ready")
        while all(child.poll() is None for child in children):
            time.sleep(.5)
    finally:
        stop()
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
        backend_log.close()
        gateway_log.close()


if __name__ == "__main__":
    main()
