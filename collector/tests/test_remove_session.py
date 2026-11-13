import json
import stat
import subprocess
import sys
from pathlib import Path

import pytest

import collector as c

COLLECTOR = Path(__file__).resolve().parent.parent / "collector.py"


def tool(tmp_path: Path, name: str, agents=None, fail_with: str = "") -> str:
    """A stand-in `claude`/`codex` that logs its arguments to <name>.log, prints `agents` for
    `agents --json`, and for anything else exits 0 (or 1 printing `fail_with`)."""
    data = tmp_path / f"{name}-agents.json"
    data.write_text(json.dumps(agents or []), encoding="utf-8")
    body = (f'echo "$@" >> "{tmp_path}/{name}.log"\n'
            f'if [ "$1" = "agents" ]; then cat "{data}"; exit 0; fi\n'
            + (f'echo "{fail_with}"; exit 1\n' if fail_with else 'exit 0\n'))
    path = tmp_path / name
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def calls(tmp_path: Path, name: str) -> list:
    log = tmp_path / f"{name}.log"
    return log.read_text().splitlines() if log.exists() else []


def tasks_dir(home: Path, sid: str) -> Path:
    d = home / ".claude" / "tasks" / sid
    d.mkdir(parents=True)
    (d / "1.json").write_text("{}")
    return d


def test_codex_session_is_archived(tmp_path):
    bins = {"claude": None, "codex": tool(tmp_path, "codex")}
    msg = c.remove_session(tmp_path, "codex:019d-abc", bins)
    assert calls(tmp_path, "codex") == ["archive 019d-abc"]
    assert "codex unarchive 019d-abc" in msg


def test_background_claude_session_is_removed_with_claude_rm(tmp_path):
    agents = [{"sessionId": "s-1", "id": "c8a6c41b", "kind": "background", "status": "busy"}]
    bins = {"claude": tool(tmp_path, "claude", agents), "codex": None}
    msg = c.remove_session(tmp_path, "claude:s-1", bins)
    assert calls(tmp_path, "claude") == ["agents --json", "rm c8a6c41b"]
    assert "conversation is kept" in msg


def test_claude_refusing_rm_is_reported_not_forced(tmp_path):
    agents = [{"sessionId": "s-1", "id": "c8a6c41b", "kind": "background", "state": "blocked"}]
    bins = {"claude": tool(tmp_path, "claude", agents, fail_with="unpushed commits in worktree w1"), "codex": None}
    with pytest.raises(c.RemoveError, match="unpushed commits in worktree w1"):
        c.remove_session(tmp_path, "claude:s-1", bins)
    assert calls(tmp_path, "claude") == ["agents --json", "rm c8a6c41b"]


def test_claude_session_running_in_a_terminal_is_refused(tmp_path):
    agents = [{"sessionId": "s-1", "pid": 4242, "kind": "interactive", "status": "idle"}]
    d = tasks_dir(tmp_path, "s-1")
    bins = {"claude": tool(tmp_path, "claude", agents), "codex": None}
    with pytest.raises(c.RemoveError, match="running in a terminal \\(pid 4242\\)"):
        c.remove_session(tmp_path, "claude:s-1", bins)
    assert d.is_dir(), "a running session's task list is left alone"


def test_ended_claude_session_loses_only_its_task_list(tmp_path):
    d = tasks_dir(tmp_path, "ended-1")
    other = tasks_dir(tmp_path, "ended-2")
    transcript = tmp_path / ".claude" / "projects" / "p" / "ended-1.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text("{}")
    bins = {"claude": tool(tmp_path, "claude", []), "codex": None}
    msg = c.remove_session(tmp_path, "claude:ended-1", bins)
    assert not d.exists() and other.is_dir() and transcript.exists()
    assert "task list" in msg


def test_refusals_without_the_tool_or_with_a_bad_key(tmp_path):
    tasks_dir(tmp_path, "s-1")
    with pytest.raises(c.RemoveError, match="claude command wasn't found"):
        c.remove_session(tmp_path, "claude:s-1", {"claude": None, "codex": None})
    with pytest.raises(c.RemoveError, match="codex command wasn't found"):
        c.remove_session(tmp_path, "codex:x", {"claude": None, "codex": None})
    with pytest.raises(c.RemoveError, match="malformed"):
        c.remove_session(tmp_path, "claude:../../etc", {"claude": tool(tmp_path, "claude", []), "codex": None})
    assert (tmp_path / ".claude" / "tasks" / "s-1").is_dir()


def test_remove_session_mode_prints_one_json_line(tmp_path):
    codex = tool(tmp_path, "codex")
    claude = tool(tmp_path, "claude", [])
    ok = subprocess.run([sys.executable, str(COLLECTOR), "--remove-session", "codex:t-1", "--home", str(tmp_path),
                         "--claude-bin", claude, "--codex-bin", codex], capture_output=True, text=True)
    assert ok.returncode == 0 and json.loads(ok.stdout)["ok"] is True
    bad = subprocess.run([sys.executable, str(COLLECTOR), "--remove-session", "claude:nope", "--home", str(tmp_path),
                          "--claude-bin", claude, "--codex-bin", codex], capture_output=True, text=True)
    assert bad.returncode == 1 and json.loads(bad.stdout) == {"ok": False, "error": "it isn't running and has no task list here to delete"}
