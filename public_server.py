#!/usr/bin/env python3
"""Same-origin public gateway with per-visitor identity isolation."""

from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import mimetypes
import os
import re
import secrets
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("IELTS_VOCAB_PUBLIC_PORT", "8090"))
BACKEND_PORT = int(os.environ.get("IELTS_VOCAB_PUBLIC_BACKEND_PORT", "8091"))
GATEWAY_SECRET = os.environ.get("IELTS_VOCAB_GATEWAY_SECRET", "")
REQUIRE_ACCESS = os.environ.get("IELTS_VOCAB_REQUIRE_ACCESS", "0") == "1"
ALLOWED_EMAILS = {
    email.strip().lower()
    for email in os.environ.get("IELTS_VOCAB_ALLOWED_EMAILS", "").split(",")
    if email.strip()
}
ALLOWED_AUTHENTIK_USERS = {
    username.strip().lower()
    for username in os.environ.get("IELTS_VOCAB_ALLOWED_AUTHENTIK_USERS", "").split(",")
    if username.strip()
}
COOKIE_NAME = "va_public_visitor"
MAX_BODY = 4_500_000
MAX_DOWNLOAD = 105_000_000
STATIC_FILES = {
    "/index.html", "/styles.css", "/dict.js", "/speech.js", "/app.js",
    "/markdown.js", "/ai-app.js", "/notes-app.js", "/study-app.js", "/speaking-app.js", "/runtime-config.js",
    "/startup-redirect.js", "/data/ielts-catalog.js",
    "/assets/graphic-eq-round.svg",
}


def signed_cookie(visitor: str) -> str:
    signature = hmac.new(GATEWAY_SECRET.encode(), visitor.encode(), hashlib.sha256).hexdigest()
    return f"{visitor}.{signature}"


def valid_cookie(value: str) -> str | None:
    visitor, separator, signature = value.partition(".")
    if not separator or not re.fullmatch(r"[a-f0-9]{64}", visitor):
        return None
    expected = signed_cookie(visitor).rsplit(".", 1)[1]
    return visitor if hmac.compare_digest(signature, expected) else None


class PublicGateway(BaseHTTPRequestHandler):
    server_version = "VocabAtelierPublic/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        status = args[1] if len(args) > 1 else ""
        print(f"[Public Gateway] {self.command} {self.path.split('?')[0]} - {status}")

    def visitor_identity(self) -> tuple[str | None, bool, str, str]:
        access_email = self.headers.get("Cf-Access-Authenticated-User-Email", "").strip().lower()
        access_assertion = self.headers.get("Cf-Access-Jwt-Assertion", "").strip()
        authentik_username = self.headers.get("X-Authentik-Username", "").strip().lower()
        authentik_uid = self.headers.get("X-Authentik-Uid", "").strip()
        cookies = {}
        for item in self.headers.get("Cookie", "").split(";"):
            key, separator, value = item.strip().partition("=")
            if separator:
                cookies[key] = value
        visitor = valid_cookie(cookies.get(COOKIE_NAME, ""))
        email_allowed = not ALLOWED_EMAILS or access_email in ALLOWED_EMAILS
        authentik_user_allowed = (
            not authentik_username
            or (
                bool(ALLOWED_AUTHENTIK_USERS)
                and authentik_username in ALLOWED_AUTHENTIK_USERS
            )
        )
        if access_assertion and authentik_uid and authentik_user_allowed:
            return hashlib.sha256(f"authentik:{authentik_uid}".encode()).hexdigest(), False, "access", visitor or ""
        if access_email and len(access_email) <= 320 and "@" in access_email and email_allowed and (not REQUIRE_ACCESS or access_assertion):
            return hashlib.sha256(f"access:{access_email}".encode()).hexdigest(), False, "access", visitor or ""
        if REQUIRE_ACCESS:
            return None, False, "anonymous", visitor or ""
        if visitor:
            return visitor, False, "anonymous", ""
        return hashlib.sha256(secrets.token_bytes(32)).hexdigest(), True, "anonymous", ""

    def cookie_header(self, visitor: str) -> str:
        secure = self.headers.get("X-Forwarded-Proto", "") == "https"
        try:
            secure = secure or json.loads(self.headers.get("Cf-Visitor", "{}"))["scheme"] == "https"
        except (KeyError, TypeError, json.JSONDecodeError):
            pass
        flags = "; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000"
        return f"{COOKIE_NAME}={signed_cookie(visitor)}{flags}{'; Secure' if secure else ''}"

    def security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(self), geolocation=()")

    def send_simple(self, status: int, message: str) -> None:
        raw = message.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.security_headers()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def serve_static(self) -> None:
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if path == "/":
            path = "/index.html"
        if path not in STATIC_FILES:
            self.send_simple(404, "Not found")
            return
        target = (ROOT / path.lstrip("/")).resolve()
        if ROOT not in target.parents or not target.is_file():
            self.send_simple(404, "Not found")
            return
        raw = target.read_bytes()
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        visitor, set_cookie, _, _ = self.visitor_identity()
        if not visitor:
            self.send_simple(401, "Email sign-in required")
            return
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith(("text/", "application/javascript")) else content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-cache" if path.endswith((".html", ".css", ".js")) else "public, max-age=3600")
        if set_cookie:
            self.send_header("Set-Cookie", self.cookie_header(visitor))
        self.security_headers()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def proxy_request(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_simple(400, "Invalid body length")
            return
        if length < 0 or length > MAX_BODY:
            self.send_simple(413, "Request body too large")
            return
        body = self.rfile.read(length) if length else None
        visitor, set_cookie, identity_mode, legacy_visitor = self.visitor_identity()
        if not visitor:
            self.send_simple(401, "Email sign-in required")
            return
        headers = {
            "Host": f"127.0.0.1:{BACKEND_PORT}",
            "X-Vocab-Gateway": GATEWAY_SECRET,
            "X-Vocab-Visitor": visitor,
            "X-Vocab-Identity-Mode": identity_mode,
        }
        if legacy_visitor and legacy_visitor != visitor:
            headers["X-Vocab-Legacy-Visitor"] = legacy_visitor
        if self.headers.get("Content-Type"):
            headers["Content-Type"] = self.headers["Content-Type"]
        connection = http.client.HTTPConnection("127.0.0.1", BACKEND_PORT, timeout=45)
        try:
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            streaming = response.getheader("Content-Type", "").startswith("text/event-stream")
            self.send_response(response.status)
            for header in ("Content-Type", "Cache-Control", "Content-Disposition"):
                value = response.getheader(header)
                if value:
                    self.send_header(header, value)
            if set_cookie:
                self.send_header("Set-Cookie", self.cookie_header(visitor))
            self.security_headers()
            downloading = response.getheader("Content-Type", "").startswith("application/zip")
            if streaming or downloading:
                self.send_header("Connection", "close")
                self.end_headers()
                total = 0
                while chunk := response.read(65536):
                    total += len(chunk)
                    if downloading and total > MAX_DOWNLOAD:
                        raise RuntimeError("backend download too large")
                    self.wfile.write(chunk)
                    self.wfile.flush()
            else:
                raw = response.read(MAX_BODY + 1)
                if len(raw) > MAX_BODY:
                    raise RuntimeError("backend response too large")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(raw)
        except (ConnectionError, TimeoutError, OSError, http.client.HTTPException):
            if not self.wfile.closed:
                self.send_simple(502, "Public service is temporarily unavailable")
        finally:
            connection.close()

    def route(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if path == "/health" or path.startswith("/api/") or path.startswith("/lookup/"):
            self.proxy_request()
        else:
            self.serve_static()

    do_GET = route
    do_HEAD = route
    do_POST = route
    do_PUT = route
    do_PATCH = route
    do_DELETE = route
    do_OPTIONS = route


def main() -> None:
    if len(GATEWAY_SECRET) < 32:
        raise RuntimeError("IELTS_VOCAB_GATEWAY_SECRET is required")
    if REQUIRE_ACCESS and not ALLOWED_EMAILS:
        raise RuntimeError("IELTS_VOCAB_ALLOWED_EMAILS is required when access enforcement is enabled")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), PublicGateway)
    print(f"Vocab Atelier public gateway running at http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
