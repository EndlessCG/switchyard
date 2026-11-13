import pytest

import collector as c
from helpers import fake_claude, write_task


def T(i, status, **kw):
    return {"id": str(i), "subject": f"step {i}", "description": "", "status": status,
            "blocks": [], "blockedBy": [], **kw}


LIVE_BG = {"pid": 61145, "id": "c8a6c41b", "cwd": "/home/u/notes", "kind": "background",
           "startedAt": 1000, "sessionId": "c8a6c41b-7743", "name": "Tmux config",
           "status": "busy", "state": "working"}
LIVE_INT = {"pid": 15429, "cwd": "/home/u/proj", "kind": "interactive", "startedAt": 2000,
            "sessionId": "361028f7-1f96", "name": "", "status": "idle"}


def test_read_tasks_normalises_and_sorts_numerically(tmp_path):
    d = write_task(tmp_path, "s1", T(10, "pending", blockedBy=["2"]))
    write_task(tmp_path, "s1", T(2, "completed", blocks=["10"]))
    write_task(tmp_path, "s1", T(3, "in_progress", activeForm="Doing 3"))
    (d / ".highwatermark").write_text("10")
    (d / ".lock").write_text("")
    errs = c.Errors()
    steps = c.read_claude_tasks(d, errs)
    assert [s["id"] for s in steps] == ["2", "3", "10"]
    assert [s["status"] for s in steps] == ["done", "current", "pending"]
    assert steps[2]["blockedBy"] == ["2"] and steps[0]["blocks"] == ["10"]
    assert steps[1]["activeForm"] == "Doing 3" and steps[1]["title"] == "step 3"
    assert isinstance(steps[0]["updatedAt"], int)
    assert errs.as_list() == []


def test_read_tasks_reports_invalid_utf8_and_still_reads_others(tmp_path):
    d = write_task(tmp_path, "s1", T(1, "pending"))
    (d / "2.json").write_bytes(b'\xff\xfe{')
    errs = c.Errors()
    steps = c.read_claude_tasks(d, errs)
    assert [s["id"] for s in steps] == ["1"]
    msgs = [e["message"] for e in errs.as_list()]
    assert any("2.json" in m and "not valid UTF-8" in m for m in msgs)


def test_read_tasks_reports_malformed_non_object_and_unknown_status(tmp_path):
    d = write_task(tmp_path, "s1", T(1, "pending"))
    (d / "2.json").write_text("{not json")
    (d / "4.json").write_text("[1, 2]")
    write_task(tmp_path, "s1", T(3, "blocked"))
    errs = c.Errors()
    steps = c.read_claude_tasks(d, errs)
    assert [s["id"] for s in steps] == ["1"]
    msgs = [e["message"] for e in errs.as_list()]
    assert any("2.json" in m and "malformed JSON" in m for m in msgs)
    assert any("4.json" in m and "not a JSON object" in m for m in msgs)
    assert any("3.json" in m and "unknown status 'blocked'" in m for m in msgs)


def test_live_sessions_runs_agents_json(tmp_path):
    exe = fake_claude(tmp_path, [{"pid": 1, "sessionId": "abc"}])
    assert c.claude_live_sessions(exe) == [{"pid": 1, "sessionId": "abc"}]


def test_live_sessions_rejects_non_list(tmp_path):
    exe = fake_claude(tmp_path, {"oops": 1})
    with pytest.raises(ValueError):
        c.claude_live_sessions(exe)


def test_claude_sessions_merges_live_sessions_and_tasks(tmp_path):
    write_task(tmp_path, "c8a6c41b-7743", T(1, "completed"))
    write_task(tmp_path, "c8a6c41b-7743", T(2, "in_progress"))
    errs = c.Errors()
    out = c.claude_sessions(tmp_path, [LIVE_BG, LIVE_INT], errs,
                            pane_of=lambda pid: "dri:2.1" if pid == 15429 else None)
    bg = out["claude:c8a6c41b-7743"]
    assert bg["state"] == "working" and bg["kind"] == "background" and bg["short"] == "c8a6c41b"
    assert bg["stepsSource"] == "claude-tasks" and len(bg["steps"]) == 2
    assert bg["updatedAt"] > 1000
    it = out["claude:361028f7-1f96"]
    assert it["name"] == "361028f7" and it["state"] == "idle"
    assert it["steps"] == [] and it["stepsSource"] is None
    assert it["tmuxPane"] == "dri:2.1" and it["updatedAt"] == 2000
    assert errs.as_list() == []


def test_unknown_agent_status_is_reported(tmp_path):
    weird = dict(LIVE_INT, status="thinking")
    errs = c.Errors()
    out = c.claude_sessions(tmp_path, [weird], errs, pane_of=lambda pid: None)
    assert out["claude:361028f7-1f96"]["state"] == "idle"
    assert "unknown status 'thinking'" in errs.as_list()[0]["message"]


def test_background_session_without_status_uses_its_state(tmp_path):
    # Claude Code 2.1.318 lists a background session whose process has exited with no pid and
    # no "status", only "state"; "blocked" means it's waiting on you.
    stopped = {k: v for k, v in LIVE_BG.items() if k not in ("pid", "status")}
    errs = c.Errors()
    for state, want in [("blocked", "waiting"), ("done", "idle"), ("working", "working")]:
        out = c.claude_sessions(tmp_path, [dict(stopped, state=state)], errs, pane_of=lambda pid: None)
        assert out["claude:c8a6c41b-7743"]["state"] == want
    assert errs.as_list() == []


def test_unknown_background_state_is_reported(tmp_path):
    stopped = {k: v for k, v in LIVE_BG.items() if k not in ("pid", "status")}
    errs = c.Errors()
    c.claude_sessions(tmp_path, [dict(stopped, state="paused")], errs, pane_of=lambda pid: None)
    assert "unknown state 'paused'" in errs.as_list()[0]["message"]


def test_waiting_agent_status_is_waiting_on_you_with_its_reason(tmp_path):
    # Claude Code 2.1.273 prints status "waiting" plus a waitingFor reason for a session that's
    # blocked on the user: that's "waiting on you" even with no steps, and not an error.
    waiting = dict(LIVE_INT, status="waiting", waitingFor="input needed")
    errs = c.Errors()
    out = c.claude_sessions(tmp_path, [waiting, LIVE_BG], errs, pane_of=lambda pid: None)
    s = out["claude:361028f7-1f96"]
    assert s["state"] == "waiting" and s["waitingFor"] == "input needed"
    assert out["claude:c8a6c41b-7743"]["waitingFor"] is None
    assert errs.as_list() == []


def test_waiting_for_is_kept_only_while_the_status_is_waiting(tmp_path):
    stale = dict(LIVE_INT, status="idle", waitingFor="input needed")
    out = c.claude_sessions(tmp_path, [stale], c.Errors(), pane_of=lambda pid: None)
    assert out["claude:361028f7-1f96"]["waitingFor"] is None


def test_raw_waiting_wins_over_steps():
    assert c.derive_state("waiting", [{"status": "done"}]) == "waiting"
    assert c.derive_state("waiting", []) == "waiting"


def test_task_folder_without_live_session_is_stopped(tmp_path):
    write_task(tmp_path, "ended-1", T(1, "completed"))
    out = c.claude_sessions(tmp_path, [], c.Errors(), pane_of=lambda pid: None)
    s = out["claude:ended-1"]
    assert s["state"] == "stopped" and s["pid"] is None and s["kind"] is None
    assert s["name"] == "ended-1"[:8]
