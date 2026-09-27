from __future__ import annotations

import json
import asyncio
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest
from flask import Flask
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import api.live_rooms as live_rooms_api
import services.live_room_store as live_room_store_module
from services.live_quiz import QUIZ_PACK_ID, consistency_for
from services.live_room_store import LiveRoomError, LiveRoomStore, RoomUnauthorized
from live_rooms_ws import LiveRoomWebSocketService


class AlwaysAllow:
    def allow(self, *_args, **_kwargs):
        return True


class Clock:
    def __init__(self) -> None:
        self.value = datetime(2026, 8, 6, 12, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.value


@pytest.fixture
def quiz_store(tmp_path: Path):
    pants = tmp_path / "pants"
    image_dir = pants / "image_only" / "PanTS_00000035"
    mask_dir = pants / "mask_only" / "PanTS_00000035"
    image_dir.mkdir(parents=True)
    mask_dir.mkdir(parents=True)
    affine = np.eye(4)
    ct = np.zeros((32, 20, 3), dtype=np.int16)
    mask = np.zeros_like(ct, dtype=np.uint8)
    mask[3:27, 8:10, 1] = 28
    nib.save(nib.Nifti1Image(ct, affine), image_dir / "ct.nii.gz")
    nib.save(nib.Nifti1Image(mask, affine), mask_dir / "combined_labels.nii.gz")
    clock = Clock()
    return LiveRoomStore(tmp_path / "sessions", pants, now=clock), clock


def create_quiz(quiz_store, timer=30):
    store, _ = quiz_store
    metadata, room_key, host_claim = store.create_quiz_room(
        "35",
        "low",
        quiz_pack_id=QUIZ_PACK_ID,
        quiz_timer_seconds=timer,
    )
    host_id, _, is_host = store.resolve_participant_identity(
        metadata["room_id"], room_key, host_claim=host_claim
    )
    assert is_host is True
    host_lease = "host-lease"
    store.connect_quiz_host(metadata["room_id"], room_key, host_id, host_lease)
    return store, metadata, room_key, host_id, host_lease


def roster(*participants: str):
    return [{"participant_id": item, "name": item.upper()} for item in participants]


def answer(store, metadata, key, participant, choice, connected):
    return store.answer_quiz(
        metadata["room_id"], key, participant, participant.upper(), choice, set(connected)
    )


def test_quiz_creation_hashes_one_time_host_claim_and_keeps_review_default(quiz_store):
    store, _ = quiz_store
    review, _ = store.create_room("35", "low")
    assert review["mode"] == "review"

    metadata, room_key, host_claim = store.create_quiz_room("35", "low")
    room_dir = store.root / metadata["room_id"]
    stored = json.loads((room_dir / "metadata.json").read_text())
    assert metadata["mode"] == "quiz"
    assert metadata["quiz_pack_id"] == QUIZ_PACK_ID
    assert room_key not in stored and host_claim not in stored
    assert len(stored["key_hash"]) == len(stored["quiz_host_claim_hash"]) == 64
    assert (room_dir / "quiz_answers.json").stat().st_mode & 0o777 == 0o600
    host_id, resume, is_host = store.resolve_participant_identity(
        metadata["room_id"], room_key, host_claim=host_claim
    )
    assert host_id and resume and is_host is True
    repeated_id, repeated_resume, repeated_is_host = store.resolve_participant_identity(
        metadata["room_id"], room_key, host_claim=host_claim
    )
    assert repeated_id == host_id
    assert repeated_resume and repeated_resume != resume
    assert repeated_is_host is True
    with pytest.raises(live_room_store_module.ParticipantUnauthorized):
        store.resolve_participant_identity(metadata["room_id"], room_key, host_id, resume)
    store.connect_quiz_host(metadata["room_id"], room_key, host_id, "ack-lease")
    assert store.acknowledge_quiz_host_claim(
        metadata["room_id"], room_key, host_id, "ack-lease"
    ) is True
    assert store.acknowledge_quiz_host_claim(
        metadata["room_id"], room_key, host_id, "ack-lease"
    ) is False
    with pytest.raises(RoomUnauthorized) as reused:
        store.resolve_participant_identity(metadata["room_id"], room_key, host_claim=host_claim)
    assert reused.value.code == "invalid_host_claim"

    with pytest.raises(LiveRoomError, match="does not match"):
        store.create_quiz_room("34", "low")
    with pytest.raises(LiveRoomError, match="timer"):
        store.create_quiz_room("35", "low", quiz_timer_seconds=45)


def test_legacy_protocol_1_host_secret_hash_migrates_atomically(quiz_store):
    store, _ = quiz_store
    metadata, room_key, host_secret = store.create_quiz_room("35", "low")
    room_dir = store.root / metadata["room_id"]
    stored = json.loads((room_dir / "metadata.json").read_text())
    stored["quiz_host_secret_hash"] = stored.pop("quiz_host_claim_hash")
    (room_dir / "metadata.json").write_text(json.dumps(stored))

    host_id, resume, is_host = store.resolve_participant_identity(
        metadata["room_id"], room_key, host_claim=host_secret
    )
    migrated = json.loads((room_dir / "metadata.json").read_text())
    assert host_id and resume and is_host is True
    assert "quiz_host_secret_hash" not in migrated
    assert migrated["quiz_host_claim_hash"] == live_room_store_module.hash_room_key(host_secret)
    assert migrated["quiz_host_participant_id"] == host_id
    assert migrated["participant_credentials"][host_id]["quiz_host"] is True
    store.connect_quiz_host(metadata["room_id"], room_key, host_id, "legacy-migrated-lease")
    leased = json.loads((room_dir / "metadata.json").read_text())
    assert leased["quiz_host_lease_id"] == "legacy-migrated-lease"
    store.acknowledge_quiz_host_claim(
        metadata["room_id"], room_key, host_id, "legacy-migrated-lease"
    )


def test_host_authorization_answer_privacy_and_immutable_submission(quiz_store):
    store, metadata, key, host_id, host_lease = create_quiz(quiz_store)
    room_id = metadata["room_id"]
    blank_mask, _ = store.get_mask_snapshot(room_id, key)
    assert int(np.max(np.asanyarray(nib.load(str(blank_mask)).dataobj))) == 0
    with pytest.raises(LiveRoomError) as locked_reveal:
        store.get_quiz_reveal_segmentation(room_id, key)
    assert locked_reveal.value.code == "quiz_reveal_locked"
    with pytest.raises(LiveRoomError) as locked_export:
        store.build_export(room_id, key)
    assert locked_export.value.code == "quiz_export_locked"

    with pytest.raises(RoomUnauthorized):
        store.start_quiz(room_id, key, host_id, "forged", roster("p1"))

    quiz, _ = store.start_quiz(room_id, key, host_id, host_lease, roster("p1", "p2"))
    assert quiz["phase"] == "question_open"
    assert quiz["eligible_count"] == 2
    answer(store, metadata, key, "p1", "pancreas", {"p1", "p2"})
    with pytest.raises(LiveRoomError) as duplicate:
        answer(store, metadata, key, "p1", "liver", {"p1", "p2"})
    assert duplicate.value.code == "duplicate_quiz_answer"
    with pytest.raises(LiveRoomError, match="Invalid answer"):
        answer(store, metadata, key, "p2", "forged", {"p1", "p2"})

    snapshot_text = json.dumps(store.get_snapshot(room_id, key))
    event_text = (store.root / room_id / "events.jsonl").read_text()
    forbidden = ("correct_choice_id", "ground_truth", "reveal_mask", "explanation", '"claims"')
    for field in forbidden:
        assert field not in snapshot_text
        assert field not in event_text
    assert "answered_at" not in snapshot_text
    assert "response_ms" not in snapshot_text
    assert "answered_at" not in event_text
    assert store.quiz_context(room_id, key, "p1")["own_submissions"]["organ"]["choice_id"] == "pancreas"
    assert store.quiz_context(room_id, key, "p2")["own_submissions"] == {}
    with pytest.raises(LiveRoomError) as locked_export:
        store.build_export(room_id, key)
    assert locked_export.value.code == "quiz_export_locked"


def test_quiz_revision_persists_for_events_and_nonfinal_answers(quiz_store):
    store, metadata, key, host_id, host_lease = create_quiz(quiz_store)
    room_id = metadata["room_id"]
    initial = store.quiz_context(room_id, key)["state"]
    assert initial["revision"] == 1

    opened, opened_event = store.start_quiz(
        room_id, key, host_id, host_lease, roster("p1", "p2")
    )
    assert opened["revision"] == initial["revision"] + 1
    assert opened_event["payload"]["quiz"]["revision"] == opened["revision"]

    answered, _, event = answer(
        store, metadata, key, "p1", "pancreas", {"p1", "p2"}
    )
    assert event is None
    assert answered["response_count"] == 1
    assert answered["revision"] == opened["revision"] + 1

    restarted = LiveRoomStore(store.root.parent, store.pants_path, now=quiz_store[1])
    persisted = restarted.quiz_context(room_id, key)["state"]
    assert persisted["revision"] == answered["revision"]


def test_old_quiz_state_without_revision_is_reconciled_and_persisted(quiz_store):
    store, _ = quiz_store
    metadata, key, _ = store.create_quiz_room("35", "low")
    room_dir = store.root / metadata["room_id"]
    quiz = json.loads((room_dir / "quiz.json").read_text())
    quiz.pop("revision")
    (room_dir / "quiz.json").write_text(json.dumps(quiz))

    state = store.quiz_context(metadata["room_id"], key)["state"]

    assert state["revision"] == 0
    assert json.loads((room_dir / "quiz.json").read_text())["revision"] == 0


def test_full_round_scores_time_and_consistency_with_late_joiner(quiz_store):
    store, metadata, key, host_id, host_lease = create_quiz(quiz_store)
    clock = quiz_store[1]
    room_id = metadata["room_id"]
    store = LiveRoomStore(store.root.parent, store.pants_path, now=clock)
    assert store.quiz_context(room_id, key)["state"]["phase"] == "lobby"
    store.start_quiz(room_id, key, host_id, host_lease, roster("p1", "p2"))
    store = LiveRoomStore(store.root.parent, store.pants_path, now=clock)
    assert store.quiz_context(room_id, key)["state"]["phase"] == "question_open"
    choices = [
        {"p1": "pancreas", "p2": "liver"},
        {"p1": "yes", "p2": "yes", "p3": "yes"},
        {"p1": "tail", "p2": "head", "p3": "tail"},
        {"p1": "focal_tail_23mm", "p2": "focal_head_23mm", "p3": "focal_tail_23mm"},
    ]
    participants = ["p1", "p2"]
    for index, selected in enumerate(choices):
        if index == 1:
            participants.append("p3")
        for participant in participants:
            state, _, event = answer(store, metadata, key, participant, selected[participant], participants)
        assert event is not None
        assert state["phase"] == "question_closed"
        store = LiveRoomStore(store.root.parent, store.pants_path, now=clock)
        assert store.quiz_context(room_id, key)["state"]["phase"] == "question_closed"
        revealed, _ = store.reveal_quiz_question(room_id, key, host_id, host_lease)
        assert revealed["phase"] == "question_revealed"
        store = LiveRoomStore(store.root.parent, store.pants_path, now=clock)
        assert store.quiz_context(room_id, key)["state"]["phase"] == "question_revealed"
        if index < 3:
            advanced, _ = store.advance_quiz(
                room_id, key, host_id, host_lease, roster(*participants, *([] if index else ["p3"]))
            )
            assert advanced["phase"] == "question_open"
            store = LiveRoomStore(store.root.parent, store.pants_path, now=clock)
        else:
            completed, _ = store.advance_quiz(room_id, key, host_id, host_lease, roster(*participants))
            assert completed["phase"] == "completed"
            store = LiveRoomStore(store.root.parent, store.pants_path, now=clock)

    final = store.quiz_context(room_id, key, "p1")["state"]
    rows = {item["participant_id"]: item for item in final["leaderboard"]}
    assert rows["p1"]["score"] == 4
    assert rows["p1"]["consistency"]["status"] == "consistent"
    assert rows["p2"]["score"] == 1
    assert rows["p2"]["consistency"]["status"] == "consistent"
    assert rows["p3"]["consistency"]["status"] == "incomplete"
    assert final["reveal"]["viewer_cue"]["show_lesion_overlay"] is True
    assert store.get_quiz_reveal_segmentation(room_id, key)

    blank_mask, _ = store.get_mask_snapshot(room_id, key)
    with zipfile.ZipFile(store.build_export(room_id, key)) as archive:
        summary = json.loads(archive.read("quiz-summary.json"))
        manifest = json.loads(archive.read("manifest.json"))
        assert summary["pack_id"] == QUIZ_PACK_ID
        assert len(summary["revealed_distributions"]) == 4
        assert "quiz_answers.json" not in archive.namelist()
        assert archive.read("edited_labelmap.nii.gz") != blank_mask.read_bytes()
        assert "research and education" in manifest["disclaimer"]


def test_timer_expiry_pause_promotion_and_host_lease_rotation(quiz_store):
    store, clock = quiz_store
    store, metadata, key, host_id, host_lease = create_quiz(quiz_store, timer=15)
    room_id = metadata["room_id"]
    p1, _, _ = store.resolve_participant_identity(room_id, key)
    p2, _, _ = store.resolve_participant_identity(room_id, key)
    opened, _ = store.start_quiz(
        room_id, key, host_id, host_lease,
        [{"participant_id": p1, "name": "P1"}],
    )
    assert opened["deadline_at"]
    clock.value += timedelta(seconds=5)
    paused, _ = store.disconnect_quiz_host(room_id, host_id, host_lease)
    assert paused["timer_paused"] is True
    assert 9 <= paused["remaining_seconds"] <= 10

    resumed, _, _ = store.promote_quiz_host(room_id, p1, "p1-lease")
    assert resumed["timer_paused"] is False
    with pytest.raises(RoomUnauthorized):
        store.close_quiz_question(room_id, key, host_id, host_lease)
    clock.value += timedelta(seconds=11)
    due = store.close_quiz_if_due(room_id)
    assert due and due[0]["phase"] == "question_closed"
    store.reveal_quiz_question(room_id, key, p1, "p1-lease")

    store.disconnect_quiz_host(room_id, p1, "p1-lease")
    second_promotion, _, _ = store.promote_quiz_host(room_id, p2, "p2-lease")
    assert second_promotion["host_connected"] is True
    with pytest.raises(RoomUnauthorized):
        store.advance_quiz(
            room_id, key, p1, "p1-lease", [{"participant_id": p2, "name": "P2"}]
        )
    store.advance_quiz(
        room_id, key, p2, "p2-lease", [{"participant_id": p1, "name": "P1"}]
    )


def test_stale_host_lease_cannot_pause_or_control_replacement(quiz_store):
    store, metadata, key, host_id, first_lease = create_quiz(quiz_store)
    room_id = metadata["room_id"]
    store.connect_quiz_host(room_id, key, host_id, "replacement-lease")

    assert store.disconnect_quiz_host(room_id, host_id, first_lease) is None
    assert store.quiz_context(room_id, key)["state"]["host_connected"] is True
    with pytest.raises(RoomUnauthorized) as stale:
        store.start_quiz(room_id, key, host_id, first_lease, roster("p1"))
    assert stale.value.code == "invalid_host_lease"
    state, _ = store.start_quiz(room_id, key, host_id, "replacement-lease", roster("p1"))
    assert state["phase"] == "question_open"


def test_failed_promotion_rolls_authority_back_to_resumable_host(quiz_store):
    store, metadata, key, host_id, host_lease = create_quiz(quiz_store)
    room_id = metadata["room_id"]
    candidate_id, candidate_resume, _ = store.resolve_participant_identity(room_id, key)
    store.disconnect_quiz_host(room_id, host_id, host_lease)
    _, _, previous_host = store.promote_quiz_host(room_id, candidate_id, "candidate-lease")

    rollback = store.rollback_quiz_host_promotion(
        room_id, candidate_id, "candidate-lease", previous_host
    )
    assert rollback is not None
    _, _, candidate_is_host = store.resolve_participant_identity(
        room_id, key, candidate_id, candidate_resume
    )
    assert candidate_is_host is False
    store.connect_quiz_host(room_id, key, host_id, "resumed-host-lease")
    with pytest.raises(RoomUnauthorized):
        store.connect_quiz_host(room_id, key, candidate_id, "candidate-new-lease")


def test_restart_reconciles_stale_host_lease_and_quiz_quota_is_atomic(quiz_store, monkeypatch):
    store, metadata, key, host_id, host_lease = create_quiz(quiz_store)
    room_id = metadata["room_id"]
    store.start_quiz(room_id, key, host_id, host_lease, roster("p1"))

    restarted = LiveRoomStore(store.root.parent, store.pants_path, now=quiz_store[1])
    assert restarted.reconcile_stale_host_leases() == 1
    paused = restarted.quiz_context(room_id, key)["state"]
    assert paused["host_connected"] is False
    assert paused["timer_paused"] is True
    restarted.connect_quiz_host(room_id, key, host_id, "restart-lease")
    assert restarted.quiz_context(room_id, key)["state"]["host_connected"] is True
    candidate_id, _, _ = restarted.resolve_participant_identity(room_id, key)
    revision = restarted.quiz_context(room_id, key)["state"]["revision"]

    monkeypatch.setattr(live_room_store_module, "MAX_EVENTS", restarted.get_metadata(room_id, key)["latest_seq"])
    paused, pause_event = restarted.disconnect_quiz_host(room_id, host_id, "restart-lease")
    assert pause_event is None
    assert paused["host_connected"] is False
    assert paused["revision"] == revision + 1
    resumed, resume_event = restarted.connect_quiz_host(room_id, key, host_id, "full-room-lease")
    assert resume_event is None
    assert resumed["host_connected"] is True
    assert resumed["revision"] == paused["revision"] + 1
    paused_again, pause_again_event = restarted.disconnect_quiz_host(
        room_id, host_id, "full-room-lease"
    )
    assert pause_again_event is None
    assert paused_again["revision"] == resumed["revision"] + 1
    promoted, promotion_event, _ = restarted.promote_quiz_host(
        room_id, candidate_id, "candidate-full-room-lease"
    )
    assert promotion_event is None
    assert promoted["host_connected"] is True
    assert promoted["revision"] == paused_again["revision"] + 1
    assert restarted.quiz_context(room_id, key)["state"]["revision"] == promoted["revision"]
    with pytest.raises(live_room_store_module.RoomFull):
        restarted.close_quiz_question(
            room_id, key, candidate_id, "candidate-full-room-lease"
        )
    assert restarted.quiz_context(room_id, key)["state"]["phase"] == "question_open"


def test_final_answer_and_automatic_close_are_retryable_when_log_is_full(quiz_store, monkeypatch):
    store, metadata, key, host_id, host_lease = create_quiz(quiz_store)
    room_id = metadata["room_id"]
    store.start_quiz(room_id, key, host_id, host_lease, roster("p1"))
    current_limit = store.get_metadata(room_id, key)["latest_seq"]
    monkeypatch.setattr(live_room_store_module, "MAX_EVENTS", current_limit)

    with pytest.raises(live_room_store_module.RoomFull):
        answer(store, metadata, key, "p1", "pancreas", {"p1"})
    context = store.quiz_context(room_id, key, "p1")
    assert context["state"]["phase"] == "question_open"
    assert context["own_submissions"] == {}

    monkeypatch.setattr(live_room_store_module, "MAX_EVENTS", 50_000)
    closed, submission, event = answer(store, metadata, key, "p1", "pancreas", {"p1"})
    assert submission["choice_id"] == "pancreas"
    assert event is not None
    assert closed["phase"] == "question_closed"


def test_quiz_transaction_recovers_internal_state_after_append_failure(quiz_store, monkeypatch):
    store, metadata, key, host_id, host_lease = create_quiz(quiz_store)
    room_id = metadata["room_id"]
    room_dir = store.root / room_id
    atomic_json = live_room_store_module._atomic_json
    failed = False

    def fail_quiz_once(path, value):
        nonlocal failed
        if not failed and path.name == "quiz.json" and (room_dir / "events.jsonl").stat().st_size:
            failed = True
            raise OSError("injected quiz persistence failure")
        return atomic_json(path, value)

    monkeypatch.setattr(live_room_store_module, "_atomic_json", fail_quiz_once)
    with pytest.raises(OSError, match="injected"):
        store.start_quiz(room_id, key, host_id, host_lease, roster("p1"))
    assert json.loads((room_dir / "metadata.json").read_text())["latest_seq"] == 0

    monkeypatch.setattr(live_room_store_module, "_atomic_json", atomic_json)
    restarted = LiveRoomStore(store.root.parent, store.pants_path, now=quiz_store[1])
    context = restarted.quiz_context(room_id, key)
    assert context["state"]["phase"] == "question_open"
    assert context["state"]["current_question"]["id"] == "organ"
    assert restarted.get_metadata(room_id, key)["latest_seq"] == 1


def test_quiz_lock_also_blocks_undo(quiz_store):
    store, metadata, key, host_id, host_lease = create_quiz(quiz_store)
    room_id = metadata["room_id"]
    store.commit_event(
        room_id, key, event_id="quiz-note", event_type="note.upsert",
        participant_id="p1", name="P1",
        payload={"note": {"id": "note-1", "text": "finding", "world": [1, 2, 3]}},
    )
    store.start_quiz(room_id, key, host_id, host_lease, roster("p1"))
    with pytest.raises(LiveRoomError, match="locked"):
        store.undo_latest(room_id, key, "p1", "P1")


def test_consistency_flags_contradictions_but_not_coherent_wrong_chain():
    assert consistency_for({
        "organ": "liver",
        "presence": "yes",
        "location": "head",
        "conclusion": "focal_head_23mm",
    })["status"] == "consistent"
    assert consistency_for({
        "organ": "pancreas",
        "presence": "no",
        "location": "tail",
        "conclusion": "focal_tail_23mm",
    })["status"] == "inconsistent"
    assert consistency_for({"organ": "pancreas"})["status"] == "incomplete"


def test_rest_quiz_creation_returns_one_time_claim_outside_share_url(quiz_store, monkeypatch):
    store, _ = quiz_store
    monkeypatch.setattr(live_rooms_api, "_store", store)
    monkeypatch.setattr(live_rooms_api, "_creation_limiter", AlwaysAllow())
    app = Flask(__name__)
    app.register_blueprint(live_rooms_api.live_rooms_blueprint, url_prefix="/api")
    response = app.test_client().post("/api/live-rooms", json={
        "case_id": "35",
        "resolution": "low",
        "mode": "quiz",
        "quiz_pack_id": QUIZ_PACK_ID,
        "quiz_timer_seconds": 30,
    })
    assert response.status_code == 201
    body = response.get_json()
    assert body["quiz_host_claim"]
    assert body["quiz_host_claim"] not in body["share_url"]
    assert body["quiz_host_secret"] == body["quiz_host_claim"]
    assert body["share_url"].endswith(f"#{body['room_key']}")


def test_failed_ready_delivery_keeps_claim_reusable_until_ack(quiz_store):
    store, _ = quiz_store
    metadata, key, host_claim = store.create_quiz_room("35", "low")
    room_id = metadata["room_id"]

    class FailedReadySocket:
        async def send(self, encoded):
            if json.loads(encoded).get("type") == "room.ready":
                raise OSError("ready transport lost")

        async def close(self, **_kwargs):
            return None

    async def scenario():
        service = LiveRoomWebSocketService(store)
        with pytest.raises(OSError, match="transport lost"):
            await service.join(FailedReadySocket(), room_id, {
                "type": "hello", "protocol": 1, "room_key": key,
                "quiz_host_claim": host_claim, "name": "Host", "last_seq": 0,
            })
        assert not service.rooms.get(room_id)

    asyncio.run(scenario())
    claimed_id = json.loads(
        (store.root / room_id / "metadata.json").read_text()
    )["quiz_host_claim_participant_id"]
    repeated_id, resume, is_host = store.resolve_participant_identity(
        room_id, key, host_claim=host_claim
    )
    assert repeated_id == claimed_id
    assert resume and is_host is True
    store.connect_quiz_host(room_id, key, repeated_id, "delivered-lease")
    store.acknowledge_quiz_host_claim(room_id, key, repeated_id, "delivered-lease")
    with pytest.raises(RoomUnauthorized) as takeover:
        store.resolve_participant_identity(room_id, key, host_claim=host_claim)
    assert takeover.value.code == "invalid_host_claim"


def test_unclaimed_quiz_reserves_host_socket_and_identity_capacity(quiz_store, monkeypatch):
    store, _ = quiz_store
    metadata, key, host_claim = store.create_quiz_room("35", "low")
    room_id = metadata["room_id"]
    monkeypatch.setattr(live_room_store_module, "MAX_PARTICIPANT_IDENTITIES", 2)
    attendee_id, _, _ = store.resolve_participant_identity(room_id, key)
    assert attendee_id
    with pytest.raises(live_room_store_module.ParticipantLimit):
        store.resolve_participant_identity(room_id, key)
    host_id, _, is_host = store.resolve_participant_identity(
        room_id, key, host_claim=host_claim
    )
    assert host_id and is_host is True

    async def scenario():
        socket_store, _ = quiz_store
        socket_metadata, socket_key, socket_claim = socket_store.create_quiz_room("35", "low")
        service = LiveRoomWebSocketService(socket_store)
        sockets = []
        try:
            async with serve(service.handler, "127.0.0.1", 0, max_size=512 * 1024) as server:
                port = server.sockets[0].getsockname()[1]
                uri = f"ws://127.0.0.1:{port}/ws/live-rooms/{socket_metadata['room_id']}"
                for index in range(7):
                    websocket = await connect(uri)
                    sockets.append(websocket)
                    await websocket.send(json.dumps({
                        "type": "hello", "protocol": 1, "room_key": socket_key,
                        "name": f"Student {index}", "last_seq": 0,
                    }))
                    assert json.loads(await websocket.recv())["type"] == "room.ready"
                rejected = await connect(uri)
                sockets.append(rejected)
                await rejected.send(json.dumps({
                    "type": "hello", "protocol": 1, "room_key": socket_key,
                    "name": "Eighth student", "last_seq": 0,
                }))
                assert json.loads(await rejected.recv())["code"] == "participant_limit"

                host = await connect(uri)
                sockets.append(host)
                await host.send(json.dumps({
                    "type": "hello", "protocol": 1, "room_key": socket_key,
                    "quiz_host_claim": socket_claim, "name": "Host", "last_seq": 0,
                }))
                ready = json.loads(await host.recv())
                assert ready["type"] == "room.ready"
                assert ready["self"]["role"] == "host"
        finally:
            await asyncio.gather(
                *(websocket.close() for websocket in sockets), return_exceptions=True
            )

    monkeypatch.setattr(live_room_store_module, "MAX_PARTICIPANT_IDENTITIES", 128)
    asyncio.run(scenario())


def test_connected_host_and_seven_students_fit_quiz_socket_capacity(quiz_store):
    store, _ = quiz_store
    metadata, key, host_claim = store.create_quiz_room("35", "low")

    async def scenario():
        service = LiveRoomWebSocketService(store)
        sockets = []
        try:
            async with serve(service.handler, "127.0.0.1", 0, max_size=512 * 1024) as server:
                port = server.sockets[0].getsockname()[1]
                uri = f"ws://127.0.0.1:{port}/ws/live-rooms/{metadata['room_id']}"
                host = await connect(uri)
                sockets.append(host)
                await host.send(json.dumps({
                    "type": "hello", "protocol": 1, "room_key": key,
                    "quiz_host_claim": host_claim, "name": "Host", "last_seq": 0,
                }))
                assert json.loads(await host.recv())["self"]["role"] == "host"

                for index in range(7):
                    student = await connect(uri)
                    sockets.append(student)
                    await student.send(json.dumps({
                        "type": "hello", "protocol": 1, "room_key": key,
                        "name": f"Student {index}", "last_seq": 0,
                    }))
                    ready = json.loads(await student.recv())
                    assert ready["type"] == "room.ready"
                    assert ready["self"]["role"] == "student"
                assert len(service.rooms[metadata["room_id"]]) == 8
        finally:
            await asyncio.gather(
                *(websocket.close() for websocket in sockets), return_exceptions=True
            )

    asyncio.run(scenario())


def test_modern_claim_waits_for_ack_after_resume_and_legacy_claim_auto_acks(quiz_store):
    store, _ = quiz_store
    modern, modern_key, modern_claim = store.create_quiz_room("35", "low")
    legacy, legacy_key, legacy_secret = store.create_quiz_room("35", "low")

    async def receive_until(websocket, expected_type, limit=20):
        for _ in range(limit):
            message = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
            if message.get("type") == expected_type:
                return message
        raise AssertionError(f"Did not receive {expected_type}")

    async def wait_until_left(service, room_id):
        for _ in range(100):
            if room_id not in service.rooms:
                return
            await asyncio.sleep(0.01)
        raise AssertionError("Host did not leave room")

    async def scenario():
        service = LiveRoomWebSocketService(store)
        async with serve(service.handler, "127.0.0.1", 0, max_size=512 * 1024) as server:
            port = server.sockets[0].getsockname()[1]
            modern_uri = f"ws://127.0.0.1:{port}/ws/live-rooms/{modern['room_id']}"
            async with connect(modern_uri) as first:
                await first.send(json.dumps({
                    "type": "hello", "protocol": 1, "room_key": modern_key,
                    "quiz_host_claim": modern_claim, "name": "Host", "last_seq": 0,
                }))
                ready = json.loads(await first.recv())
                participant_id = ready["self"]["participant_id"]
                resume_credential = ready["resume_credential"]
                assert store.quiz_host_claim_pending(modern["room_id"], modern_key) is True

            await wait_until_left(service, modern["room_id"])
            assert store.quiz_host_claim_pending(modern["room_id"], modern_key) is True
            async with connect(modern_uri) as resumed:
                await resumed.send(json.dumps({
                    "type": "hello", "protocol": 1, "room_key": modern_key,
                    "participant_id": participant_id,
                    "resume_credential": resume_credential,
                    "name": "Host", "last_seq": 0,
                }))
                resumed_ready = json.loads(await resumed.recv())
                assert resumed_ready["self"]["role"] == "host"
                await resumed.send(json.dumps({"type": "host.claim_ack"}))
                await receive_until(resumed, "host.claim_acknowledged")
                assert store.quiz_host_claim_pending(modern["room_id"], modern_key) is False

            legacy_uri = f"ws://127.0.0.1:{port}/ws/live-rooms/{legacy['room_id']}"
            async with connect(legacy_uri) as old_client:
                await old_client.send(json.dumps({
                    "type": "hello", "protocol": 1, "room_key": legacy_key,
                    "quiz_host_secret": legacy_secret, "name": "Legacy host", "last_seq": 0,
                }))
                legacy_ready = json.loads(await old_client.recv())
                assert legacy_ready["quiz_host_secret"] == legacy_secret
                await old_client.send(json.dumps({"type": "ping"}))
                await receive_until(old_client, "pong")
                assert store.quiz_host_claim_pending(legacy["room_id"], legacy_key) is False

    asyncio.run(scenario())


def test_nonfinal_answer_broadcasts_revised_quiz_state(quiz_store):
    store, _ = quiz_store
    metadata, key, host_claim = store.create_quiz_room("35", "low")

    async def receive_until(websocket, expected_type, limit=30):
        received = []
        for _ in range(limit):
            message = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
            received.append(message)
            if message.get("type") == expected_type:
                return message
        raise AssertionError(f"Did not receive {expected_type}: {received}")

    async def scenario():
        service = LiveRoomWebSocketService(store)
        async with serve(service.handler, "127.0.0.1", 0, max_size=512 * 1024) as server:
            port = server.sockets[0].getsockname()[1]
            uri = f"ws://127.0.0.1:{port}/ws/live-rooms/{metadata['room_id']}"
            async with connect(uri) as host, connect(uri) as first, connect(uri) as second:
                for websocket, name in ((first, "First"), (second, "Second")):
                    await websocket.send(json.dumps({
                        "type": "hello", "protocol": 1, "room_key": key,
                        "name": name, "last_seq": 0,
                    }))
                    assert json.loads(await websocket.recv())["type"] == "room.ready"
                await host.send(json.dumps({
                    "type": "hello", "protocol": 1, "room_key": key,
                    "quiz_host_claim": host_claim, "name": "Host", "last_seq": 0,
                }))
                assert json.loads(await host.recv())["self"]["role"] == "host"
                await host.send(json.dumps({"type": "host.claim_ack"}))
                await receive_until(host, "host.claim_acknowledged")
                await host.send(json.dumps({"type": "quiz.start"}))
                await receive_until(first, "quiz.personal")
                await receive_until(second, "quiz.personal")

                await first.send(json.dumps({
                    "type": "quiz.answer", "choice_id": "pancreas",
                }))
                await receive_until(first, "quiz.answer.accepted")
                first_state = await receive_until(first, "quiz.state")
                second_state = await receive_until(second, "quiz.state")
                assert first_state["quiz"]["phase"] == "question_open"
                assert first_state["quiz"]["response_count"] == 1
                assert first_state["quiz"]["revision"] > 0
                assert second_state["quiz"]["revision"] == first_state["quiz"]["revision"]

    asyncio.run(scenario())


def test_websocket_roles_private_answers_and_host_promotion(quiz_store):
    store = quiz_store[0]
    metadata, key, host_claim = store.create_quiz_room("35", "low")

    async def receive_until(websocket, expected_type, limit=20):
        received = []
        for _ in range(limit):
            message = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
            received.append(message)
            if message.get("type") == expected_type:
                return message, received
        raise AssertionError(f"Did not receive {expected_type}: {received}")

    async def scenario():
        service = LiveRoomWebSocketService(store)
        async with serve(service.handler, "127.0.0.1", 0, max_size=512 * 1024) as server:
            port = server.sockets[0].getsockname()[1]
            uri = f"ws://127.0.0.1:{port}/ws/live-rooms/{metadata['room_id']}"

            async with connect(uri) as host, connect(uri) as student:
                await student.send(json.dumps({
                    "type": "hello", "protocol": 1, "room_key": key,
                    "name": "Student", "last_seq": 0,
                }))
                student_ready = json.loads(await student.recv())
                assert student_ready["self"]["role"] == "student"
                assert metadata["room_id"] not in service.promotion_tasks

                await host.send(json.dumps({
                    "type": "hello", "protocol": 1, "room_key": key,
                    "quiz_host_claim": host_claim,
                    "name": "Host", "last_seq": 0,
                }))
                host_ready = json.loads(await host.recv())
                assert host_ready["self"]["role"] == "host"
                await receive_until(student, "presence.changed")
                await host.send(json.dumps({"type": "host.claim_ack"}))
                await receive_until(host, "host.claim_acknowledged")

                await host.send(json.dumps({"type": "quiz.start"}))
                await receive_until(student, "quiz.personal")
                await student.send(json.dumps({"type": "quiz.answer", "choice_id": "pancreas"}))
                accepted, student_frames = await receive_until(student, "quiz.answer.accepted")
                assert accepted["submission"]["choice_id"] == "pancreas"

                closed, host_frames = await receive_until(host, "quiz.state")
                while closed.get("quiz", {}).get("phase") != "question_closed":
                    closed, more = await receive_until(host, "quiz.state")
                    host_frames.extend(more)
                public_frames = json.dumps(host_frames)
                for field in ("correct_choice_id", "ground_truth", "reveal_mask", "explanation", '"claims"'):
                    assert field not in public_frames
                assert "answered_at" not in public_frames
                assert "response_ms" not in public_frames

            # Host socket is gone. Promote the longest-connected student without
            # waiting through the production 15-second grace in this unit test.
            async with connect(uri) as replacement:
                await replacement.send(json.dumps({
                    "type": "hello", "protocol": 1, "room_key": key,
                    "name": "Replacement", "last_seq": 0,
                }))
                replacement_ready = json.loads(await replacement.recv())
                promotion = service.promotion_tasks.pop(metadata["room_id"], None)
                if promotion:
                    promotion.cancel()
                await service._promotion_worker(metadata["room_id"], 0)
                promoted, _ = await receive_until(replacement, "quiz.host.promoted")
                assert "quiz_host_claim" not in promoted
                assert promoted["quiz"]["revision"] > 0
                promoted_state, _ = await receive_until(replacement, "quiz.state")
                assert promoted_state["quiz"]["revision"] == promoted["quiz"]["revision"]
                promoted_id = replacement_ready["self"]["participant_id"]
                promoted_resume = replacement_ready["resume_credential"]

            async with connect(uri) as resumed_host:
                await resumed_host.send(json.dumps({
                    "type": "hello", "protocol": 1, "room_key": key,
                    "participant_id": promoted_id,
                    "resume_credential": promoted_resume,
                    "name": "Replacement", "last_seq": store.get_metadata(metadata["room_id"], key)["latest_seq"],
                }))
                resumed_ready = json.loads(await resumed_host.recv())
                assert resumed_ready["self"]["role"] == "host"

    asyncio.run(scenario())
