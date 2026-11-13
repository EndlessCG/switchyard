import io
import json

import pytest

import collector as c


def lines(buf):
    return [json.loads(l) for l in buf.getvalue().splitlines()]


def test_derive_state_rules():
    done = [{"status": "done"}]
    mixed = [{"status": "done"}, {"status": "pending"}]
    assert c.derive_state("working", mixed) == "working"
    assert c.derive_state("stopped", done) == "stopped"
    assert c.derive_state("error", []) == "error"
    assert c.derive_state("idle", []) == "idle"
    assert c.derive_state("idle", done) == "done"
    assert c.derive_state("idle", mixed) == "waiting"


def test_derive_state_rejects_unknown_raw_state():
    with pytest.raises(ValueError):
        c.derive_state("busy", [])


def test_emitter_sends_only_changes_and_removals():
    buf = io.StringIO()
    e = c.Emitter(buf)
    e.sync_sessions({"a": {"key": "a", "n": 1}, "b": {"key": "b", "n": 1}})
    e.sync_sessions({"a": {"key": "a", "n": 1}, "b": {"key": "b", "n": 2}})
    e.sync_sessions({"b": {"key": "b", "n": 2}})
    got = [(m["type"], m.get("key") or m["session"]["key"]) for m in lines(buf)]
    assert got == [("session", "a"), ("session", "b"), ("session", "b"), ("removed", "a")]


def test_errors_are_counted_and_sent_only_when_they_change():
    buf = io.StringIO()
    e = c.Emitter(buf)
    errs = c.Errors()
    errs.add("x", "bad")
    errs.add("x", "bad")
    e.sync_errors(errs.as_list())
    e.sync_errors(errs.as_list())
    e.sync_errors([])
    assert lines(buf) == [
        {"type": "errors", "errors": [{"source": "x", "message": "bad", "count": 2}]},
        {"type": "errors", "errors": []},
    ]
