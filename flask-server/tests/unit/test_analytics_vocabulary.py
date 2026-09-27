"""The client and server both hold the list of tracked event names, and the
server drops anything not on its copy. A drift is therefore silent: the client
keeps firing an event and it simply never appears on the dashboard.

These tests read the TypeScript and compare, so the drift fails here instead.
"""

import pathlib
import re

import pytest

from services.analytics_store import ACTION_NAMES, ROUTE_PATTERNS

REPO = pathlib.Path(__file__).resolve().parents[3]
ANALYTICS_TS = REPO / "PanTS-Demo" / "src" / "helpers" / "analytics.ts"
SRC = REPO / "PanTS-Demo" / "src"


def _client_action_type() -> set[str]:
    """The names in the TrackedAction union."""
    text = ANALYTICS_TS.read_text()
    body = text.split("export type TrackedAction =", 1)[1].split(";", 1)[0]
    return set(re.findall(r'"([a-z_]+)"', body))


def _tracked_calls() -> set[str]:
    """Every name actually passed to track() anywhere in the app."""
    names: set[str] = set()
    for path in SRC.rglob("*.ts*"):
        if path.name.endswith(".test.ts") or path.name.endswith(".test.tsx"):
            continue
        if path == ANALYTICS_TS:
            continue
        names.update(re.findall(r'track\(\s*"([a-z_]+)"', path.read_text()))
        # track(cond ? "a" : "b")
        for a, b in re.findall(r'track\([^)]*\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"', path.read_text()):
            names.update({a, b})
    return names


@pytest.mark.skipif(not ANALYTICS_TS.exists(), reason="frontend not present")
def test_the_two_event_lists_match():
    assert _client_action_type() == set(ACTION_NAMES)


@pytest.mark.skipif(not ANALYTICS_TS.exists(), reason="frontend not present")
def test_every_name_the_app_fires_is_one_the_server_stores():
    unknown = _tracked_calls() - set(ACTION_NAMES)
    assert not unknown, f"these would be dropped on arrival: {sorted(unknown)}"


@pytest.mark.skipif(not ANALYTICS_TS.exists(), reason="frontend not present")
def test_every_declared_action_is_actually_fired_somewhere():
    """An event nobody sends is a promise the dashboard can't keep."""
    unused = set(ACTION_NAMES) - _tracked_calls()
    assert not unused, f"declared but never tracked: {sorted(unused)}"


@pytest.mark.skipif(not ANALYTICS_TS.exists(), reason="frontend not present")
def test_the_route_lists_match():
    text = ANALYTICS_TS.read_text()
    static = set(re.findall(r'"(/[a-z-]*(?:/[a-z-]+)*)"', text.split("STATIC_ROUTES", 1)[1].split("]", 1)[0]))
    params = set(re.findall(r'"(/[a-z]+/:[A-Za-z]+)"', text))
    assert static | params == set(ROUTE_PATTERNS)
