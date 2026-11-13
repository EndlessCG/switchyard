"""Builders for a fake home directory. Tests never read the real ~/.claude or ~/.codex."""
import json
import sqlite3
import stat
from pathlib import Path


def write_task(home: Path, session_id: str, task: dict) -> Path:
    d = home / ".claude" / "tasks" / session_id
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{task['id']}.json").write_text(json.dumps(task), encoding="utf-8")
    return d


def _exe(path: Path, body: str) -> str:
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def fake_claude(tmp_path: Path, agents) -> str:
    """A stand-in `claude`: `--version` prints a version; `agents --json` prints `agents` and
    appends a line to calls.log, so tests can count how often it ran."""
    data = tmp_path / "agents.json"
    data.write_text(json.dumps(agents), encoding="utf-8")
    return _exe(tmp_path / "claude",
                'if [ "$1" = "--version" ]; then echo "2.1.271 (Claude Code)"; exit 0; fi\n'
                f'echo x >> "{tmp_path}/calls.log"\n'
                f'cat "{data}"\n')


def fake_codex(tmp_path: Path) -> str:
    return _exe(tmp_path / "codex", 'echo "codex-cli 0.153.4"\n')


def failing_codex(tmp_path: Path) -> str:
    """A stand-in `codex` whose `--version` fails, as if node wasn't on PATH."""
    return _exe(tmp_path / "codex", "echo \"env: 'node': No such file or directory\" >&2\nexit 127\n")


def noisy_shell(tmp_path: Path) -> str:
    """Behaves like `sh -c CMD`, but first prints the kind of banner a .bashrc might."""
    return _exe(tmp_path / "noisy-sh", 'echo "Welcome to the cluster"\necho "/not/a/binary"\nexec sh -c "$1"\n')


def wrapper_function_shell(tmp_path: Path) -> str:
    """bash with `claude` defined as a shell function, as a ~/.bashrc wrapper would: there
    `command -v claude` prints the function's name, not a path."""
    path = tmp_path / "wrapper-sh"
    path.write_text('#!/bin/bash\nclaude() { :; }\neval "$1"\n')
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def slow_shell(tmp_path: Path) -> str:
    return _exe(tmp_path / "slow-sh", "sleep 5\n")


def shell_without_sentinel(tmp_path: Path) -> str:
    """A 'weird' interactive shell: it finds a tool but never runs the printf sentinel,
    as if it doesn't support printf or ignores the trailing part of the command."""
    return _exe(tmp_path / "no-sentinel-sh", f'echo "{tmp_path}/claude"\n')


def fakenode_codex(bin_dir: Path) -> Path:
    """A `codex` whose shebang needs `node` on PATH (like an nvm/fnm install), plus a
    `fakenode` interpreter placed beside it. Returns the codex path."""
    bin_dir.mkdir(parents=True, exist_ok=True)
    _exe(bin_dir / "fakenode", 'sh "$1"\n')
    codex_path = bin_dir / "codex"
    codex_path.write_text("#!/usr/bin/env fakenode\necho \"codex-cli 9.9.9\"\n")
    codex_path.chmod(codex_path.stat().st_mode | stat.S_IEXEC)
    return codex_path


def plan_call(*steps):
    """A rollout line recording an `update_plan` call. steps: (text, status) pairs."""
    args = {"plan": [{"step": s, "status": st} for s, st in steps]}
    return {"timestamp": "t", "type": "response_item",
            "payload": {"type": "function_call", "name": "update_plan", "arguments": json.dumps(args)}}


def event(kind: str, turn_id: str):
    return {"timestamp": "t", "type": "event_msg", "payload": {"type": kind, "turn_id": turn_id}}


def append_rollout(path: Path, *records, partial=None) -> Path:
    with open(path, "a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
        if partial is not None:
            f.write(partial)
    return path


THREAD_DEFAULTS = {"rollout_path": None, "cwd": "/home/u/proj", "title": "a title", "name": None,
                   "git_branch": None, "archived": 0, "updated_at_ms": 1000, "source": "cli"}
THREAD_COLUMNS = ["id", "rollout_path", "cwd", "title", "name", "git_branch", "archived",
                  "updated_at_ms", "source"]


def make_codex(home: Path, threads=(), turns=(), goals=(), history=True, drop_columns=(), goals_db=True) -> Path:
    """Minimal Codex databases with the columns the collector reads."""
    ch = home / ".codex"
    ch.mkdir(parents=True, exist_ok=True)
    cols = [c for c in THREAD_COLUMNS if c not in drop_columns]
    s = sqlite3.connect(ch / "state_5.sqlite")
    s.execute(f"CREATE TABLE threads ({', '.join(cols)})")
    for t in threads:
        row = dict(THREAD_DEFAULTS, **t)
        s.execute(f"INSERT INTO threads ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                  [row[c] for c in cols])
    s.commit()
    s.close()
    if history:
        h = sqlite3.connect(ch / "thread_history_1.sqlite")
        h.execute("CREATE TABLE thread_turns (thread_id, turn_id, rollout_ordinal, status, error_json)")
        for t in turns:
            h.execute("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)",
                      [t["thread_id"], t["turn_id"], t["rollout_ordinal"], t["status"], t.get("error_json")])
        h.commit()
        h.close()
    if goals_db:
        g = sqlite3.connect(ch / "goals_1.sqlite")
        g.execute("CREATE TABLE thread_goals (thread_id, objective)")
        g.executemany("INSERT INTO thread_goals VALUES (?, ?)", list(goals))
        g.commit()
        g.close()
    return ch


def write_run(runs_dir: Path, record: dict) -> Path:
    """A run progress record, as an experiment's reporter would leave it."""
    runs_dir.mkdir(parents=True, exist_ok=True)
    path = runs_dir / f"{record['id']}.json"
    path.write_text(json.dumps(record), encoding="utf-8")
    return path
