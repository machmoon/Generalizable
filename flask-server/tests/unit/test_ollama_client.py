import pytest

import services.ollama_client as ollama_client


def test_chat_structured_json_sends_schema_and_image_messages(monkeypatch):
    captured = {}

    def fake_post_chat(payload, timeout):
        captured["payload"] = payload
        captured["timeout"] = timeout
        return {
            "message": {
                "content": '{"classification":"undistorted","confidence":0.9,"reasons":[]}'
            }
        }

    monkeypatch.setattr(ollama_client, "_post_chat", fake_post_chat)
    schema = {
        "type": "object",
        "properties": {"classification": {"type": "string"}},
    }
    messages = [
        {
            "role": "user",
            "content": "inspect",
            "images": ["base64-image"],
        }
    ]

    result = ollama_client.chat_structured_json(
        model="qwen3-vl:4b",
        messages=messages,
        schema=schema,
        timeout=9,
        temperature=0,
        seed=42,
    )

    assert result["classification"] == "undistorted"
    assert captured["timeout"] == 9
    assert captured["payload"]["messages"] == messages
    assert captured["payload"]["format"] == schema
    assert captured["payload"]["options"]["temperature"] == 0
    assert captured["payload"]["options"]["seed"] == 42


def test_chat_structured_json_requires_object_schema():
    with pytest.raises(ValueError, match="object schema"):
        ollama_client.chat_structured_json(
            model="qwen3-vl:4b",
            messages=[{"role": "user", "content": "inspect"}],
            schema={"type": "array"},
        )


# ---------------------------------------------------------------------------
# Vision model resolution.
#
# Image messages used to be sent to whatever BODYMAPS_OLLAMA_VISION_MODEL named,
# installed or not. When it was not (qwen3-vl needs Ollama 0.12.7+), the very
# first byte failed and the user was told the whole assistant was unavailable.
# ---------------------------------------------------------------------------

def _fake_tags(monkeypatch, names, ok=True):
    def fake_installed(force=False):
        return list(names), ok

    monkeypatch.setattr(ollama_client, "installed_model_names", fake_installed)


def test_the_configured_vision_model_wins_when_it_is_installed(monkeypatch):
    _fake_tags(monkeypatch, ["llama3.1:latest", "qwen3-vl:4b"])

    assert ollama_client.resolve_vision_model() == "qwen3-vl:4b"


def test_an_installed_vision_model_is_used_when_the_configured_one_is_missing(monkeypatch):
    _fake_tags(monkeypatch, ["llama3.1:latest", "llava:13b"])

    assert ollama_client.resolve_vision_model() == "llava:13b"


def test_no_vision_model_installed_resolves_to_none(monkeypatch):
    _fake_tags(monkeypatch, ["llama3.1:latest", "qwen3:4b"])

    assert ollama_client.resolve_vision_model() is None


def test_an_unreachable_tag_listing_is_not_treated_as_nothing_installed(monkeypatch):
    # "The listing timed out" is not evidence a model is absent — try anyway.
    _fake_tags(monkeypatch, [], ok=False)

    assert ollama_client.resolve_vision_model() == ollama_client.DEFAULT_OLLAMA_VISION_MODEL


def test_a_bare_name_matches_the_latest_tag(monkeypatch):
    _fake_tags(monkeypatch, ["llama3.1:latest"])

    assert ollama_client.model_is_installed("llama3.1")


def test_qwen3_vl_is_not_classified_as_a_reasoning_model():
    # It is an instruct model: sending it "/no_think" only injects stray text
    # into a vision prompt.
    assert not ollama_client.is_reasoning_model("qwen3-vl:4b")
    assert ollama_client.is_reasoning_model("qwen3:4b")


def test_vision_families_are_recognized():
    for name in ["qwen3-vl:4b", "llava:13b", "llama3.2-vision:11b", "minicpm-v", "gemma3:4b"]:
        assert ollama_client.is_vision_model(name), name
    for name in ["llama3.1:latest", "qwen3:4b", "mistral:7b"]:
        assert not ollama_client.is_vision_model(name), name


# ---------------------------------------------------------------------------
# chat_stream request shape
# ---------------------------------------------------------------------------

def test_images_are_refused_by_a_text_only_model():
    with pytest.raises(ollama_client.OllamaModelMissing):
        list(
            ollama_client.chat_stream(
                model="llama3.1:latest",
                system_prompt="s",
                user_prompt="u",
                images=["base64"],
            )
        )


class _FakeResponse:
    def __init__(self, lines):
        self._lines = lines

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def raise_for_status(self):
        return None

    def iter_lines(self, decode_unicode=False):
        return iter(self._lines)


def _capture_stream(monkeypatch):
    captured = {}

    def fake_post(url, json=None, timeout=None, stream=None):
        captured["payload"] = json
        return _FakeResponse(['{"message":{"content":"hi"},"done":true}'])

    monkeypatch.setattr(ollama_client.requests, "post", fake_post)
    return captured


def test_an_image_turn_gets_a_wider_context_window(monkeypatch):
    # Four 768px panes plus a long question overflow the 8k text window, and
    # Ollama then evicts the OLDEST tokens — the system prompt carrying every
    # instruction about how to read a screenshot.
    captured = _capture_stream(monkeypatch)

    list(
        ollama_client.chat_stream(
            model="qwen3-vl:4b",
            system_prompt="s",
            user_prompt="u",
            images=["a", "b", "c", "d"],
        )
    )

    assert captured["payload"]["options"]["num_ctx"] >= ollama_client.OLLAMA_VISION_NUM_CTX
    assert captured["payload"]["messages"][-1]["images"] == ["a", "b", "c", "d"]


def test_no_think_is_not_injected_into_a_vision_prompt(monkeypatch):
    captured = _capture_stream(monkeypatch)

    list(
        ollama_client.chat_stream(
            model="qwen3-vl:4b",
            system_prompt="s",
            user_prompt="read these views",
            images=["a"],
        )
    )

    assert "/no_think" not in captured["payload"]["messages"][-1]["content"]


def test_prior_turns_are_sent_as_real_conversation_messages(monkeypatch):
    captured = _capture_stream(monkeypatch)

    list(
        ollama_client.chat_stream(
            model="llama3.1:latest",
            system_prompt="s",
            user_prompt="here are the labs",
            history=[
                {"role": "user", "content": "68-year-old woman with jaundice"},
                {"role": "assistant", "content": "What is her bilirubin?"},
            ],
        )
    )

    roles = [m["role"] for m in captured["payload"]["messages"]]
    assert roles == ["system", "user", "assistant", "user"]


def test_too_many_images_are_capped(monkeypatch):
    captured = _capture_stream(monkeypatch)

    list(
        ollama_client.chat_stream(
            model="qwen3-vl:4b",
            system_prompt="s",
            user_prompt="u",
            images=[str(i) for i in range(12)],
        )
    )

    sent = captured["payload"]["messages"][-1]["images"]
    assert len(sent) == ollama_client.OLLAMA_MAX_IMAGES
