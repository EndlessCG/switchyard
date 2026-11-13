import json
import os
import select
import subprocess
import sys
import time
from pathlib import Path

import collector as c
from helpers import (append_rollout, event, fake_claude, fake_codex, failing_codex, fakenode_codex,
                     make_codex, noisy_shell, plan_call, shell_without_sentinel, slow_shell, wrapper_function_shell,
                     write_task)

COLLECTOR = Path(__file__).resolve().parent.parent / "collector.py"
LIVE = [{"pid": os.getpid(), "cwd": "/w", "kind": "interactive", "startedAt": 1,
         "sessionId": "s-1", "name": "demo", "status": "idle"}]


def test_configured_paths_skip_the_shell_lookup(tmp_path):
    got = c.find_binaries("/x/claude", "/y/codex", shell=(slow_shell(tmp_path),), timeout=0.5)
    assert got == {"claude": "/x/claude", "codex": "/y/codex", "notes": [], "path": None}


def test_shell_lookup_ignores_banner_noise(tmp_path, monkeypatch):
    fake_claude(tmp_path, [])
    fake_codex(tmp_path)
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")
    got = c.find_binaries(shell=(noisy_shell(tmp_path),))
    assert got["claude"] == str(tmp_path / "claude") and got["codex"] == str(tmp_path / "codex")
    assert got["notes"] == []


def test_slow_shell_lookup_becomes_a_note(tmp_path):
    got = c.find_binaries(shell=(slow_shell(tmp_path),), timeout=0.5)
    assert got["claude"] is None and got["codex"] is None
    assert "longer than 0.5 s" in got["notes"][0]


def test_shell_lookup_captures_the_shells_path(tmp_path, monkeypatch):
    """(a) The sentinel line after the `command -v` lines becomes `find_binaries`' "path"."""
    fake_claude(tmp_path, [])
    fake_codex(tmp_path)
    fake_path = f"{tmp_path}:{os.environ['PATH']}"  # keeps a real `sh` on PATH for noisy_shell's exec
    monkeypatch.setenv("PATH", fake_path)
    got = c.find_binaries(shell=(noisy_shell(tmp_path),))
    assert got["claude"] == str(tmp_path / "claude") and got["codex"] == str(tmp_path / "codex")
    assert got["path"] == fake_path
    assert got["notes"] == []


def test_shell_function_wrapper_resolves_to_the_executable_on_path(tmp_path, monkeypatch):
    """A `claude` shell function (a ~/.bashrc wrapper) makes `command -v` print just "claude";
    the binary is still found, on the PATH the login shell reported."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_claude(bin_dir, [])
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")
    got = c.find_binaries(shell=(wrapper_function_shell(tmp_path),))
    assert got["claude"] == str(bin_dir / "claude")
    assert got["notes"] == []


def test_missing_sentinel_leaves_path_none_with_a_note(tmp_path):
    """(b) A shell that never prints the sentinel: path is None, plus a note, no failure."""
    fake_claude(tmp_path, [])
    got = c.find_binaries(shell=(shell_without_sentinel(tmp_path),))
    assert got["claude"] == str(tmp_path / "claude")
    assert got["path"] is None
    assert any("did not report its PATH" in n for n in got["notes"])


def test_path_with_tool_dirs_prepends_dedups_keeps_order_ignores_none():
    """(c) path_with_tool_dirs is a pure helper."""
    got = c.path_with_tool_dirs("/usr/bin:/a/dir", {"claude": "/a/dir/claude", "codex": "/b/dir/codex"})
    assert got == "/a/dir:/b/dir:/usr/bin"
    got2 = c.path_with_tool_dirs("/usr/bin", {"claude": None, "codex": "/b/dir/codex"})
    assert got2 == "/b/dir:/usr/bin"


def test_missing_tool_notes_claude_missing_with_dot_claude(tmp_path):
    """(d) .claude present, claude None: the note appears."""
    (tmp_path / ".claude").mkdir()
    notes = c.missing_tool_notes(tmp_path, {"claude": None, "codex": "/x/codex"})
    assert notes == [
        "Claude Code data is in ~/.claude but the claude command wasn't found "
        "(checked a login shell's PATH). Set this host's \"claude\" path in hosts.json."
    ]


def test_missing_tool_notes_no_dot_claude_no_note(tmp_path):
    """(d) .claude absent: no note, even though claude is None."""
    notes = c.missing_tool_notes(tmp_path, {"claude": None, "codex": None})
    assert notes == []


def test_missing_tool_notes_both_missing_both_dirs_present(tmp_path):
    """(d) both tools missing, both data dirs present: two notes."""
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".codex").mkdir()
    notes = c.missing_tool_notes(tmp_path, {"claude": None, "codex": None})
    assert len(notes) == 2


def test_path_with_tool_dirs_lets_binary_version_find_codexs_node(tmp_path, monkeypatch):
    """(e) The node-beside-codex case: fails on the bare PATH, works once its dir is prepended."""
    codex = fakenode_codex(tmp_path / "bin")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    version, reason = c.binary_version(str(codex))
    assert version is None

    monkeypatch.setenv("PATH", c.path_with_tool_dirs(os.environ["PATH"], {"claude": None, "codex": str(codex)}))
    version, reason = c.binary_version(str(codex))
    assert version == "codex-cli 9.9.9"


def test_agents_json_reruns_only_when_sessions_dir_changes(tmp_path):
    exe = fake_claude(tmp_path, LIVE)
    sessions_dir = tmp_path / ".claude" / "sessions"
    sessions_dir.mkdir(parents=True)
    (sessions_dir / "1.json").write_text("{}")
    col = c.Collector(tmp_path, exe, tmux_socket="switchyard-test-absent")
    col.snapshot(c.Errors())
    col.snapshot(c.Errors())
    assert (tmp_path / "calls.log").read_text().count("x") == 1
    time.sleep(0.01)
    (sessions_dir / "1.json").write_text('{"status": "busy"}')
    col.snapshot(c.Errors())
    assert (tmp_path / "calls.log").read_text().count("x") == 2


def _start(tmp_path, *extra, codex_bin=None):
    args = [sys.executable, "-", "--stream", "--home", str(tmp_path), "--claude-bin", fake_claude(tmp_path, LIVE),
            "--codex-bin", codex_bin or fake_codex(tmp_path), "--tmux-socket", "switchyard-test-absent", *extra]
    p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    p.stdin.write(COLLECTOR.read_text(encoding="utf-8"))  # exactly how the hub starts it
    p.stdin.close()
    p.stdin = None  # sent and closed: communicate() on Python <= 3.12 would try to flush it
    return p


def _read_until(p, pred, deadline_s=10):
    got, end = [], time.time() + deadline_s
    while time.time() < end:
        ready, _, _ = select.select([p.stdout], [], [], 0.2)
        if ready:
            line = p.stdout.readline()
            if not line:
                break
            got.append(json.loads(line))
            if pred(got[-1]):
                return got
    raise AssertionError(f"condition not met; got {got}; stderr: {p.stderr.read() if p.poll() is not None else ''}")


def test_once_reports_hello_sessions_errors_tick(tmp_path):
    write_task(tmp_path, "s-1", {"id": "1", "subject": "a", "status": "in_progress", "blocks": [], "blockedBy": []})
    r = append_rollout(tmp_path / "r.jsonl", plan_call(("x", "completed")), event("task_complete", "t1"))
    make_codex(tmp_path, threads=[{"id": "A", "rollout_path": str(r)}])
    p = _start(tmp_path, "--once")
    out, err = p.communicate(timeout=20)
    assert p.returncode == 0, err
    msgs = [json.loads(l) for l in out.splitlines()]
    hello = msgs[0]
    assert hello["type"] == "hello" and hello["protocol"] == 2 and hello["home"] == str(tmp_path)
    assert hello["claude"]["version"].startswith("2.1.271") and hello["codex"]["version"] == "codex-cli 0.153.4"
    kinds = {m["session"]["key"]: m["session"]["state"] for m in msgs if m["type"] == "session"}
    assert kinds == {"claude:s-1": "waiting", "codex:A": "done"}
    assert {"type": "errors", "errors": []} in msgs
    assert msgs[-1] == {"type": "tick"}


def test_configured_codexs_node_is_found_via_path_with_tool_dirs(tmp_path):
    """(f) The collector as a subprocess, with a configured nvm-style codex needing its own node."""
    codex = fakenode_codex(tmp_path / "bin")
    p = _start(tmp_path, "--once", codex_bin=str(codex))
    out, err = p.communicate(timeout=20)
    assert p.returncode == 0, err
    hello = json.loads(out.splitlines()[0])
    assert hello["codex"]["version"] == "codex-cli 9.9.9"
    assert "--version failed" not in " ".join(hello["notes"])


def test_version_failure_reason_appears_in_the_note(tmp_path):
    p = _start(tmp_path, "--once", codex_bin=failing_codex(tmp_path))
    out, err = p.communicate(timeout=20)
    assert p.returncode == 0, err
    hello = json.loads(out.splitlines()[0])
    assert hello["codex"]["version"] is None
    notes = " ".join(hello["notes"])
    assert "--version failed" in notes
    assert "No such file or directory" in notes


def test_stream_sends_changes_then_exits_when_hub_disconnects(tmp_path):
    p = _start(tmp_path, "--poll", "0.2")
    try:
        _read_until(p, lambda m: m["type"] == "tick")
        write_task(tmp_path, "s-1",
                  {"id": "1", "subject": "new step", "status": "pending", "blocks": [], "blockedBy": []})
        got = _read_until(p, lambda m: m["type"] == "session" and m["session"]["steps"])
        assert got[-1]["session"]["steps"][0]["title"] == "new step"
        p.stdout.close()  # the hub goes away
        assert p.wait(timeout=10) == 0
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()
        p.stderr.close()
