import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import proxy


class Response:
    def __init__(self, payload=b"{}", headers=None):
        self.payload = payload
        self.headers = headers or {}

    def read(self, *_args):
        return self.payload

    def __iter__(self):
        return iter(self.payload.splitlines())


class TimeoutResponse(Response):
    def read(self, *_args):
        raise TimeoutError("upstream read timeout")

    def __iter__(self):
        raise TimeoutError("upstream stream timeout")
        yield b""


def model(model_id, *, paid=False, modalities=("text",), parameters=None):
    return {
        "id": model_id,
        "pricing": {"prompt": "0.001" if paid else "0", "completion": "0" if not paid else "0.002"},
        "architecture": {"output_modalities": list(modalities)},
        "supported_parameters": list(parameters or ["max_tokens", "temperature", "response_format", "structured_outputs"]),
    }


class OpenRouterRoutingTests(unittest.TestCase):
    def setUp(self):
        proxy.OPENROUTER_CATALOG_CACHE.update({"checked_at": 0, "models": {}, "error": ""})
        proxy.OPENROUTER_MODEL_HEALTH.clear()

    def test_free_model_requires_whitelist_price_text_and_capability(self):
        self.assertTrue(proxy.free_model_eligible(model(proxy.OPENROUTER_STRUCTURED_MODELS[0]), "translation"))
        self.assertFalse(proxy.free_model_eligible(model("vendor/paid:free", paid=True), "translation"))
        self.assertFalse(proxy.free_model_eligible(model(proxy.OPENROUTER_STRUCTURED_MODELS[0], modalities=("audio",)), "translation"))
        self.assertFalse(proxy.free_model_eligible(model(proxy.OPENROUTER_STRUCTURED_MODELS[0], parameters=["max_tokens", "temperature"]), "translation"))
        self.assertFalse(proxy.free_model_eligible(model("openrouter/auto"), "tutor"))
        self.assertTrue(proxy.free_model_eligible(model("community/new-free-model"), "study_qa"))

    def test_legacy_flat_config_remains_manual_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.multiple(
                proxy,
                CONFIG_DIR=root / "config",
                CONFIG_PATH=root / "config" / "api.json",
                DATA_DIR=root / "data",
                DB_PATH=root / "data" / "data.db",
            ):
                proxy.write_config({"base_url": "https://fallback.example/v1/chat/completions", "model": "fallback", "api_key": "secret"})
                settings = proxy.read_settings()
                self.assertFalse(settings["openrouter"]["enabled"])
                self.assertEqual(proxy.read_config()["model"], "fallback")
                public = proxy.public_config(None)
                self.assertEqual(public["routing_mode"], "smart_free")
                self.assertEqual(public["default_mode"], "smart_free")
                self.assertTrue(public["fallback_configured"])
                self.assertNotIn("api_key", public)

    def test_structured_request_requires_provider_parameters_and_healing(self):
        candidate = {"base_url": proxy.OPENROUTER_BASE_URL, "model": proxy.OPENROUTER_STRUCTURED_MODELS[0], "api_key": "key", "_profile": "openrouter_free"}
        response = Response()
        with patch("proxy.openrouter_candidates", return_value=[candidate]), patch("proxy.urllib.request.urlopen", return_value=response) as call:
            proxy.ai_request([], config={**candidate, "_manual_config": None}, task="translation", response_schema=proxy.TRANSLATION_RESPONSE_SCHEMA)
        body = json.loads(call.call_args.args[0].data)
        self.assertEqual(body["response_format"]["type"], "json_schema")
        self.assertTrue(body["provider"]["require_parameters"])
        self.assertTrue(body["provider"]["allow_fallbacks"])
        self.assertEqual(body["plugins"], [{"id": "response-healing"}])

    def test_note_stream_never_gets_json_schema_or_healing(self):
        candidate = {"base_url": proxy.OPENROUTER_BASE_URL, "model": proxy.OPENROUTER_TUTOR_MODELS[0], "api_key": "key", "_profile": "openrouter_free"}
        response = Response()
        with patch("proxy.openrouter_candidates", return_value=[candidate]), patch("proxy.urllib.request.urlopen", return_value=response) as call:
            proxy.ai_request([], config={**candidate, "_manual_config": None}, stream=True, task="note_draft")
        body = json.loads(call.call_args.args[0].data)
        self.assertNotIn("response_format", body)
        self.assertNotIn("plugins", body)

    def test_provider_rate_limit_moves_to_next_free_model(self):
        first = {"base_url": proxy.OPENROUTER_BASE_URL, "model": "first:free", "api_key": "key", "_profile": "openrouter_free"}
        second = {"base_url": proxy.OPENROUTER_BASE_URL, "model": "second:free", "api_key": "key", "_profile": "openrouter_free"}
        failure = proxy.AIUpstreamFailure("busy", http_status=429, category="provider_capacity", metadata={"provider_name": "provider"})
        with patch("proxy.openrouter_candidates", return_value=[first, second]), patch("proxy._send_ai_request_once", side_effect=[failure, Response()]) as send:
            result = proxy.ai_request([], config={**first, "_manual_config": None}, task="tutor")
        self.assertIsInstance(result, Response)
        self.assertEqual(send.call_count, 2)
        self.assertEqual(proxy.current_ai_route()["model"], "second:free")

    def test_provider_privacy_404_moves_to_next_free_model(self):
        body = {"error": {"message": "No endpoints available matching your guardrail restrictions and data policy."}}
        self.assertEqual(proxy.classify_openrouter_error(404, body), "retry_free")

    def test_account_limit_uses_manual_fallback(self):
        free = {"base_url": proxy.OPENROUTER_BASE_URL, "model": "free:free", "api_key": "key", "_profile": "openrouter_free"}
        manual = {"base_url": "https://fallback.example/v1/chat/completions", "model": "fallback", "api_key": "fallback-key"}
        failure = proxy.AIUpstreamFailure("quota", http_status=429, category="account_limit")
        with patch("proxy.openrouter_candidates", return_value=[free]), patch("proxy._send_ai_request_once", side_effect=[failure, Response()]) as send:
            result = proxy.ai_request([], config={**free, "_manual_config": manual}, task="tutor")
        self.assertIsInstance(result, Response)
        self.assertEqual(send.call_count, 2)
        self.assertEqual(proxy.current_ai_route()["source"], "fallback_model")
        self.assertTrue(proxy.current_ai_route()["fallback"])

    def test_paid_openrouter_model_is_never_called(self):
        with self.assertRaisesRegex(proxy.ApiFailure, "不会自动调用 OpenRouter 付费模型"):
            proxy.ai_request([], config={
                "base_url": proxy.OPENROUTER_BASE_URL,
                "model": "some/provider-paid-model",
                "api_key": "key",
            })

    def test_sse_error_is_classified_and_visible_text_blocks_retry(self):
        stream = [b'data: {"error":{"message":"provider unavailable","metadata":{"error_type":"provider_unavailable"}}}\n', b'data: [DONE]\n']
        with self.assertRaises(proxy.AIUpstreamFailure) as raised:
            proxy.read_ai_stream(stream)
        self.assertEqual(raised.exception.category, "retry_free")
        self.assertTrue(proxy.should_retry_free_stream(raised.exception, visible_text=False, route={"source": "free_model"}))
        self.assertFalse(proxy.should_retry_free_stream(raised.exception, visible_text=True, route={"source": "free_model"}))

    def test_response_and_stream_read_timeouts_are_routable(self):
        with self.assertRaises(proxy.AIUpstreamFailure) as json_error:
            proxy._json_content_from_response(TimeoutResponse(headers={"Retry-After": "3"}))
        self.assertEqual(json_error.exception.category, "retry_free")
        self.assertEqual(json_error.exception.http_status, 504)
        self.assertEqual(json_error.exception.metadata["retry_after"], "3")
        with self.assertRaises(proxy.AIUpstreamFailure) as stream_error:
            proxy.read_ai_stream(TimeoutResponse())
        self.assertEqual(stream_error.exception.category, "retry_free")
        self.assertEqual(stream_error.exception.http_status, 504)

    def test_manual_fallback_keeps_legacy_plain_payload(self):
        response = Response()
        manual = {"base_url": "https://fallback.example/v1/chat/completions", "model": "fallback", "api_key": "key"}
        with patch("proxy.urllib.request.urlopen", return_value=response) as call:
            proxy.ai_request([], config=manual, task="translation", response_schema=proxy.TRANSLATION_RESPONSE_SCHEMA)
        body = json.loads(call.call_args.args[0].data)
        self.assertNotIn("response_format", body)
        self.assertNotIn("plugins", body)

    def test_special_free_router_survives_successful_catalog_without_router_row(self):
        catalog = {proxy.OPENROUTER_STRUCTURED_MODELS[0]: model(proxy.OPENROUTER_STRUCTURED_MODELS[0])}
        with patch("proxy.fetch_openrouter_models", return_value=catalog):
            candidates = proxy.openrouter_candidates("key", "translation")
        self.assertIn(proxy.OPENROUTER_FREE_MODEL, [item["model"] for item in candidates])

    def test_tutor_uses_named_models_before_special_free_router(self):
        catalog = {model_id: model(model_id) for model_id in proxy.OPENROUTER_TUTOR_MODELS}
        with patch("proxy.fetch_openrouter_models", return_value=catalog):
            candidates = proxy.openrouter_candidates("key", "chat")
        self.assertEqual(candidates[0]["model"], proxy.OPENROUTER_TUTOR_MODELS[0])
        self.assertEqual(candidates[-1]["model"], proxy.OPENROUTER_FREE_MODEL)

    def test_chat_task_profiles_cover_writing_vocabulary_notes_and_general_questions(self):
        essay = "Please score my IELTS Writing Task 2 essay. " + "word " * 200
        self.assertEqual(proxy.classify_chat_task(essay), "ielts_writing")
        self.assertEqual(proxy.classify_chat_task("alleviate 和 mitigate 有什么区别，给我搭配和例句"), "vocabulary_qa")
        self.assertEqual(proxy.classify_chat_task("帮我制定今天的复习顺序"), "study_qa")
        self.assertEqual(proxy.classify_chat_task("总结这部分", has_note_context=True), "note_tutor")

    def test_fixed_free_model_is_validated_from_catalog_and_used_alone(self):
        selected = "community/new-free-model"
        with patch("proxy.fetch_openrouter_models", return_value={selected: model(selected)}):
            candidates = proxy.openrouter_candidates("key", "study_qa", requested_model=selected)
        self.assertEqual([item["model"] for item in candidates], [selected])
        self.assertEqual(candidates[0]["_selection_mode"], "fixed_free")

    def test_recent_failures_temporarily_demote_a_named_model_but_keep_router_last(self):
        catalog = {model_id: model(model_id) for model_id in proxy.OPENROUTER_TUTOR_MODELS}
        first = proxy.OPENROUTER_TUTOR_MODELS[0]
        proxy.record_model_health(first, "provider_error")
        proxy.record_model_health(first, "provider_error")
        with patch("proxy.fetch_openrouter_models", return_value=catalog):
            candidates = proxy.openrouter_candidates("key", "study_qa")
        self.assertNotEqual(candidates[0]["model"], first)
        self.assertEqual(candidates[-1]["model"], proxy.OPENROUTER_FREE_MODEL)

    def test_public_model_catalog_is_sanitized_and_excludes_paid_models(self):
        free_id = "community/free"
        paid_id = "community/paid"
        settings = {"version": 3, "manual": None, "openrouter": {"enabled": True, "api_key": "secret"}, "default_mode": "smart_free"}
        with patch("proxy.fetch_openrouter_models", return_value={free_id: model(free_id), paid_id: model(paid_id, paid=True)}):
            catalog = proxy.public_model_catalog(settings)
        self.assertEqual([item["id"] for item in catalog["models"]], [free_id])
        self.assertNotIn("api_key", json.dumps(catalog))


if __name__ == "__main__":
    unittest.main()
