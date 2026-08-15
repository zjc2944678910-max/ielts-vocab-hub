import os
import unittest
from unittest.mock import patch

import public_server


class PublicGatewayTests(unittest.TestCase):
    def test_signed_cookie_rejects_tampering(self):
        visitor = "a" * 64
        with patch.object(public_server, "GATEWAY_SECRET", "s" * 48):
            signed = public_server.signed_cookie(visitor)
            self.assertEqual(public_server.valid_cookie(signed), visitor)
            self.assertIsNone(public_server.valid_cookie(signed[:-1] + "0"))

    def test_static_allowlist_blocks_private_project_files(self):
        self.assertIn("/index.html", public_server.STATIC_FILES)
        self.assertNotIn("/proxy.py", public_server.STATIC_FILES)
        self.assertNotIn("/start-public.sh", public_server.STATIC_FILES)
        self.assertNotIn("/data/catalog.db", public_server.STATIC_FILES)

    def test_authenticated_email_and_cookie_visitors_are_stable_and_distinct(self):
        handler = object.__new__(public_server.PublicGateway)
        handler.headers = {"Cf-Access-Authenticated-User-Email": "Person@Example.com"}
        email_visitor, email_cookie, mode, legacy = handler.visitor_identity()
        self.assertFalse(email_cookie)
        self.assertEqual(mode, "access")
        self.assertEqual(legacy, "")

        with patch.object(public_server, "GATEWAY_SECRET", "s" * 48):
            cookie_visitor = "b" * 64
            handler.headers = {"Cookie": f"{public_server.COOKIE_NAME}={public_server.signed_cookie(cookie_visitor)}"}
            restored, needs_cookie, mode, legacy = handler.visitor_identity()
        self.assertEqual(restored, cookie_visitor)
        self.assertFalse(needs_cookie)
        self.assertEqual(mode, "anonymous")
        self.assertEqual(legacy, "")
        self.assertNotEqual(email_visitor, cookie_visitor)

    def test_access_identity_exposes_legacy_cookie_only_for_confirmed_claim(self):
        handler = object.__new__(public_server.PublicGateway)
        with patch.object(public_server, "GATEWAY_SECRET", "s" * 48):
            old = "c" * 64
            handler.headers = {
                "Cf-Access-Authenticated-User-Email": " Person@Example.com ",
                "Cookie": f"{public_server.COOKIE_NAME}={public_server.signed_cookie(old)}",
            }
            visitor, set_cookie, mode, legacy = handler.visitor_identity()
        self.assertEqual(visitor, public_server.hashlib.sha256(b"access:person@example.com").hexdigest())
        self.assertFalse(set_cookie)
        self.assertEqual(mode, "access")
        self.assertEqual(legacy, old)

    def test_require_access_rejects_anonymous_cookie(self):
        handler = object.__new__(public_server.PublicGateway)
        handler.headers = {}
        with patch.object(public_server, "REQUIRE_ACCESS", True):
            visitor, set_cookie, mode, legacy = handler.visitor_identity()
        self.assertIsNone(visitor)
        self.assertFalse(set_cookie)
        self.assertEqual(mode, "anonymous")

    def test_require_access_needs_assertion_and_email_after_tunnel_validation(self):
        handler = object.__new__(public_server.PublicGateway)
        with patch.object(public_server, "REQUIRE_ACCESS", True):
            handler.headers = {"Cf-Access-Authenticated-User-Email": "person@example.com"}
            visitor, _, mode, _ = handler.visitor_identity()
            self.assertIsNone(visitor)
            self.assertEqual(mode, "anonymous")
            handler.headers = {
                "Cf-Access-Authenticated-User-Email": "person@example.com",
                "Cf-Access-Jwt-Assertion": "validated-upstream-token",
            }
            visitor, _, mode, _ = handler.visitor_identity()
        self.assertIsNotNone(visitor)
        self.assertEqual(mode, "access")

    def test_access_allowlist_rejects_other_authenticated_emails(self):
        handler = object.__new__(public_server.PublicGateway)
        handler.headers = {
            "Cf-Access-Authenticated-User-Email": "other@example.com",
            "Cf-Access-Jwt-Assertion": "validated-upstream-token",
        }
        with (
            patch.object(public_server, "REQUIRE_ACCESS", True),
            patch.object(public_server, "ALLOWED_EMAILS", {"person@example.com"}),
        ):
            visitor, set_cookie, mode, legacy = handler.visitor_identity()
        self.assertIsNone(visitor)
        self.assertFalse(set_cookie)
        self.assertEqual(mode, "anonymous")
        self.assertEqual(legacy, "")

    def test_access_allowlist_normalizes_authenticated_email(self):
        handler = object.__new__(public_server.PublicGateway)
        handler.headers = {
            "Cf-Access-Authenticated-User-Email": " Person@Example.com ",
            "Cf-Access-Jwt-Assertion": "validated-upstream-token",
        }
        with (
            patch.object(public_server, "REQUIRE_ACCESS", True),
            patch.object(public_server, "ALLOWED_EMAILS", {"person@example.com"}),
        ):
            visitor, _, mode, _ = handler.visitor_identity()
        self.assertEqual(visitor, public_server.hashlib.sha256(b"access:person@example.com").hexdigest())
        self.assertEqual(mode, "access")

    def test_authentik_uid_is_stable_fallback_when_email_is_missing(self):
        handler = object.__new__(public_server.PublicGateway)
        handler.headers = {
            "Cf-Access-Jwt-Assertion": "authentik-forward-auth",
            "X-Authentik-Username": " Person ",
            "X-Authentik-Uid": "stable-authentik-user-id",
        }
        with (
            patch.object(public_server, "REQUIRE_ACCESS", True),
            patch.object(public_server, "ALLOWED_AUTHENTIK_USERS", {"person"}),
        ):
            visitor, set_cookie, mode, legacy = handler.visitor_identity()
        expected = public_server.hashlib.sha256(b"authentik:stable-authentik-user-id").hexdigest()
        self.assertEqual(visitor, expected)
        self.assertFalse(set_cookie)
        self.assertEqual(mode, "access")
        self.assertEqual(legacy, "")

    def test_authentik_uid_rejects_unlisted_username(self):
        handler = object.__new__(public_server.PublicGateway)
        handler.headers = {
            "Cf-Access-Jwt-Assertion": "authentik-forward-auth",
            "X-Authentik-Username": "other",
            "X-Authentik-Uid": "other-authentik-user-id",
        }
        with (
            patch.object(public_server, "REQUIRE_ACCESS", True),
            patch.object(public_server, "ALLOWED_AUTHENTIK_USERS", {"person"}),
        ):
            visitor, set_cookie, mode, legacy = handler.visitor_identity()
        self.assertIsNone(visitor)
        self.assertFalse(set_cookie)
        self.assertEqual(mode, "anonymous")
        self.assertEqual(legacy, "")

    def test_authentik_uid_accepts_missing_username_after_provider_authorization(self):
        handler = object.__new__(public_server.PublicGateway)
        handler.headers = {
            "Cf-Access-Jwt-Assertion": "authentik-forward-auth",
            "X-Authentik-Uid": "stable-authentik-user-id",
        }
        with (
            patch.object(public_server, "REQUIRE_ACCESS", True),
            patch.object(public_server, "ALLOWED_AUTHENTIK_USERS", {"person"}),
        ):
            visitor, _, mode, _ = handler.visitor_identity()
        expected = public_server.hashlib.sha256(b"authentik:stable-authentik-user-id").hexdigest()
        self.assertEqual(visitor, expected)
        self.assertEqual(mode, "access")

    def test_authentik_uid_requires_forward_auth_assertion(self):
        handler = object.__new__(public_server.PublicGateway)
        handler.headers = {
            "X-Authentik-Username": "person",
            "X-Authentik-Uid": "stable-authentik-user-id",
        }
        with (
            patch.object(public_server, "REQUIRE_ACCESS", True),
            patch.object(public_server, "ALLOWED_AUTHENTIK_USERS", {"person"}),
        ):
            visitor, _, mode, _ = handler.visitor_identity()
        self.assertIsNone(visitor)
        self.assertEqual(mode, "anonymous")


if __name__ == "__main__":
    unittest.main()
