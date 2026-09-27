import json

import numpy as np
import pandas as pd
from PIL import Image

import services.case_quality as case_quality


def test_load_manifest_returns_valid_case_records(tmp_path):
    path = tmp_path / "quality.json"
    path.write_text(json.dumps({
        "schema_version": 1,
        "cases": {
            "PanTS_00000001": {"ct": {"bytes": 123}},
            "bad": "not-an-object",
        },
    }))

    cases = case_quality.load_case_quality_manifest(str(path))

    assert cases == {"PanTS_00000001": {"ct": {"bytes": 123}}}


def test_load_manifest_degrades_for_invalid_schema(tmp_path):
    path = tmp_path / "quality.json"
    path.write_text(json.dumps({"schema_version": 99, "cases": {}}))

    assert case_quality.load_case_quality_manifest(str(path)) == {}


def test_merge_case_quality_sets_defaults_and_normalizes_values():
    frame = pd.DataFrame({
        "__case_str": ["PanTS_00000001", "PanTS_00000002", "PanTS_00000003"],
    })
    cases = {
        "PanTS_00000001": {
            "ct": {"bytes": 1000},
            "thumbnail": {"final_status": "undistorted"},
        },
        "PanTS_00000002": {
            "ct": {"bytes": "bad"},
            "thumbnail": {"final_status": "not-a-status"},
        },
    }

    merged = case_quality.merge_case_quality(frame, cases)

    assert merged["__ct_bytes"].iloc[0] == 1000
    assert pd.isna(merged["__ct_bytes"].iloc[1])
    assert merged["__thumbnail_status"].tolist() == [
        "undistorted",
        "unknown",
        "unknown",
    ]
    assert merged["__thumbnail_quality_rank"].tolist() == [0, 1, 1]


def test_inspect_thumbnail_marks_missing_as_unknown_candidate(tmp_path):
    result = case_quality.inspect_thumbnail(str(tmp_path / "missing.jpg"))

    assert result["status"] == "missing"
    assert result["reasons"] == ["thumbnail_missing"]


def test_inspect_thumbnail_rejects_blank_image(tmp_path):
    path = tmp_path / "blank.jpg"
    Image.new("L", (128, 128), color=0).save(path)

    result = case_quality.inspect_thumbnail(str(path))

    assert result["status"] == "fail"
    assert "thumbnail_blank" in result["reasons"]
    assert result["sha256"]


def test_inspect_thumbnail_accepts_technical_gradient(tmp_path):
    path = tmp_path / "gradient.png"
    gradient = np.tile(np.arange(128, dtype=np.uint8), (128, 1))
    Image.fromarray(gradient, mode="L").save(path)

    result = case_quality.inspect_thumbnail(str(path))

    assert result["status"] == "pass"
    assert result["width"] == 128
    assert result["height"] == 128
    assert result["metrics"]["dynamic_range"] > 100


def test_classify_thumbnail_uses_structured_image_message(tmp_path, monkeypatch):
    path = tmp_path / "thumbnail.png"
    Image.new("RGB", (128, 128), color=(20, 40, 80)).save(path)
    captured = {}

    def fake_chat_structured_json(**kwargs):
        captured.update(kwargs)
        return {
            "classification": "undistorted",
            "confidence": 0.95,
            "reasons": ["plausible_anatomical_proportions"],
        }

    monkeypatch.setattr(case_quality, "chat_structured_json", fake_chat_structured_json)

    result = case_quality.classify_thumbnail_with_vision(
        str(path),
        model="qwen3-vl:4b",
        timeout=10,
    )

    assert result["classification"] == "undistorted"
    assert captured["model"] == "qwen3-vl:4b"
    assert captured["schema"] == case_quality.VISION_RESULT_SCHEMA
    assert captured["messages"][1]["images"][0]


def test_resolve_final_status_is_conservative():
    technical_pass = {"status": "pass", "reasons": []}

    assert case_quality.resolve_final_thumbnail_status(
        technical_pass,
        {"classification": "undistorted", "confidence": 0.95, "reasons": []},
    ) == "undistorted"
    assert case_quality.resolve_final_thumbnail_status(
        technical_pass,
        {"classification": "distorted", "confidence": 0.95, "reasons": []},
    ) == "distorted"
    assert case_quality.resolve_final_thumbnail_status(
        technical_pass,
        {"classification": "distorted", "confidence": 0.4, "reasons": []},
    ) == "unknown"
    assert case_quality.resolve_final_thumbnail_status(
        {"status": "missing", "reasons": ["thumbnail_missing"]},
        None,
    ) == "unknown"
    assert case_quality.resolve_final_thumbnail_status(
        {"status": "fail", "reasons": ["thumbnail_blank"]},
        None,
    ) == "distorted"


def test_thumbnail_cache_key_changes_with_model_or_content():
    first = case_quality.thumbnail_cache_key("abc", "qwen3-vl:4b")

    assert first == case_quality.thumbnail_cache_key("abc", "qwen3-vl:4b")
    assert first != case_quality.thumbnail_cache_key("def", "qwen3-vl:4b")
    assert first != case_quality.thumbnail_cache_key("abc", "qwen3-vl:2b")
