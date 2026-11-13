#!/usr/bin/env python3
"""Switchyard collector: reports the Claude Code and Codex sessions on this machine.

The hub sends this file to each server over SSH on stdin (`python3 - --stream`), so nothing
is installed there. It writes one JSON object per line to stdout.
Python >= 3.8, standard library only.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import platform
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

PROTOCOL = 2


class Errors:
    """Problems found during one poll. Each is reported to the hub, never dropped."""

    def __init__(self) -> None:
        self._counts: dict = {}

    def add(self, source: str, message: str) -> None:
        key = (source, message)
        self._counts[key] = self._counts.get(key, 0) + 1

    def extend(self, items: list) -> None:
        """Re-report problems found on an earlier poll, so a cached read doesn't drop them."""
        for it in items:
            key = (it["source"], it["message"])
            self._counts[key] = self._counts.get(key, 0) + it["count"]

    def as_list(self) -> list:
        return [{"source": s, "message": m, "count": n} for (s, m), n in sorted(self._counts.items())]


class Emitter:
    """Writes protocol messages. A session is re-sent only when its content changed."""

    def __init__(self, out) -> None:
        self.out = out
        self._sent: dict = {}
        self._sent_runs: dict = {}
        self._last_errors = None

    def send(self, msg: dict) -> None:
        self.out.write(json.dumps(msg, ensure_ascii=False, sort_keys=True) + "\n")
        self.out.flush()

    def sync_sessions(self, sessions: dict) -> None:
        for key in sorted(sessions):
            blob = json.dumps(sessions[key], ensure_ascii=False, sort_keys=True)
            if self._sent.get(key) != blob:
                self._sent[key] = blob
                self.send({"type": "session", "session": sessions[key]})
        for key in sorted(k for k in self._sent if k not in sessions):
            del self._sent[key]
            self.send({"type": "removed", "key": key})

    def sync_runs(self, runs: dict) -> None:
        for key in sorted(runs):
            blob = json.dumps(runs[key], ensure_ascii=False, sort_keys=True)
            if self._sent_runs.get(key) != blob:
                self._sent_runs[key] = blob
                self.send({"type": "run", "run": runs[key]})
        for key in sorted(k for k in self._sent_runs if k not in runs):
            del self._sent_runs[key]
            self.send({"type": "run-removed", "id": key})

    def sync_errors(self, errors: list) -> None:
        if errors != self._last_errors:
            self._last_errors = errors
            self.send({"type": "errors", "errors": errors})


def derive_state(raw: str, steps: list) -> str:
    """Session state from the agent's raw state and its steps.

    raw is 'working' | 'waiting' | 'idle' | 'stopped' | 'error'. A raw 'waiting' is the agent
    itself saying it's blocked on the user, so it's "waiting on you" whatever the steps say.
    """
    if raw in ("working", "waiting", "stopped", "error"):
        return raw
    if raw != "idle":
        raise ValueError(f"unknown raw state {raw!r}")
    if not steps:
        return "idle"
    if all(s["status"] == "done" for s in steps):
        return "done"
    return "waiting"


# ── Claude ────────────────────────────────────────────────────────────────────

TASK_STATUS = {"pending": "pending", "in_progress": "current", "completed": "done"}
# Values printed by `claude agents --json`. "waiting" (seen from Claude Code 2.1.273, with a
# `waitingFor` reason such as "input needed") means the session is blocked on the user.
AGENT_STATUS = {"busy": "working", "idle": "idle", "waiting": "waiting"}
# A background session whose process has exited has no "status", only its "state".
AGENT_STATE = {"working": "working", "done": "idle", "blocked": "waiting"}


def _step_sort_key(step: dict):
    i = step["id"]
    return (not i.isdigit(), int(i) if i.isdigit() else 0, i)


def read_claude_tasks(task_dir: Path, errors: Errors) -> list:
    """Steps from ~/.claude/tasks/<sessionId>/<id>.json."""
    steps = []
    for f in task_dir.glob("*.json"):
        try:
            st = f.stat()
            raw = f.read_text(encoding="utf-8")
        except FileNotFoundError:
            # Claude deleted the task between listing and reading; the next poll shows that.
            continue
        except UnicodeDecodeError as e:
            errors.add("claude.tasks", f"{f}: not valid UTF-8 ({e.reason})")
            continue
        try:
            t = json.loads(raw)
        except json.JSONDecodeError as e:
            errors.add("claude.tasks", f"{f}: malformed JSON ({e.msg}, line {e.lineno})")
            continue
        if not isinstance(t, dict):
            errors.add("claude.tasks", f"{f}: not a JSON object")
            continue
        status = TASK_STATUS.get(t.get("status"))
        if status is None:
            errors.add("claude.tasks", f"{f}: unknown status {t.get('status')!r}")
            continue
        steps.append({
            "id": str(t.get("id", f.stem)),
            "title": t.get("subject") or "",
            "status": status,
            "blockedBy": [str(x) for x in (t.get("blockedBy") or [])],
            "blocks": [str(x) for x in (t.get("blocks") or [])],
            "description": t.get("description"),
            "activeForm": t.get("activeForm"),
            "updatedAt": int(st.st_mtime * 1000),
        })
    steps.sort(key=_step_sort_key)
    return steps


def claude_live_sessions(claude_bin: str) -> list:
    """Live interactive and background sessions from `claude agents --json`."""
    out = subprocess.run([claude_bin, "agents", "--json"], capture_output=True, text=True,
                         check=True, stdin=subprocess.DEVNULL).stdout
    data = json.loads(out)
    if not isinstance(data, list):
        raise ValueError(f"`claude agents --json` printed a {type(data).__name__}, expected a list")
    return data


def _claude_session(sid, steps, raw, *, name, cwd, kind, pid, short, pane, updated, waiting_for=None) -> dict:
    return {
        "key": "claude:" + sid, "agent": "claude", "id": sid, "name": name, "cwd": cwd,
        "gitBranch": None, "kind": kind, "pid": pid, "short": short, "tmuxPane": pane,
        "state": derive_state(raw, steps), "waitingFor": waiting_for, "error": None, "goal": None,
        "updatedAt": updated,
        "steps": steps, "stepsSource": "claude-tasks" if steps else None,
    }


def claude_sessions(home: Path, live: list, errors: Errors, pane_of) -> dict:
    """Live sessions plus task folders whose session has ended (state 'stopped')."""
    tasks_root = home / ".claude" / "tasks"
    out = {}
    for a in live:
        sid = a["sessionId"]
        d = tasks_root / sid
        steps = read_claude_tasks(d, errors) if d.is_dir() else []
        if "status" in a:
            raw = AGENT_STATUS.get(a["status"])
            if raw is None:
                errors.add("claude.agents", f"session {sid}: unknown status {a['status']!r}")
        else:
            raw = AGENT_STATE.get(a.get("state"))
            if raw is None:
                errors.add("claude.agents", f"session {sid}: unknown state {a.get('state')!r}")
        raw = raw or "idle"
        pid = a.get("pid")
        out["claude:" + sid] = _claude_session(
            sid, steps, raw,
            name=a.get("name") or sid[:8], cwd=a.get("cwd"),
            kind="background" if a.get("kind") == "background" else "interactive",
            pid=pid, short=a.get("id"), pane=pane_of(pid) if pid else None,
            updated=max([s["updatedAt"] for s in steps] + [a.get("startedAt") or 0]),
            waiting_for=a.get("waitingFor") if raw == "waiting" else None)
    if tasks_root.is_dir():
        for d in sorted(tasks_root.iterdir()):
            key = "claude:" + d.name
            if key in out or not d.is_dir():
                continue
            steps = read_claude_tasks(d, errors)
            try:
                dir_mtime = int(d.stat().st_mtime * 1000)
            except FileNotFoundError:
                continue  # folder removed while scanning; the next poll shows that
            out[key] = _claude_session(
                d.name, steps, "stopped", name=d.name[:8], cwd=None, kind=None, pid=None,
                short=None, pane=None, updated=max([s["updatedAt"] for s in steps], default=dir_mtime))
    return out


# ── tmux ──────────────────────────────────────────────────────────────────────


def _tmux_socket_path(socket) -> Path:
    # tmux(1): sockets live in $TMUX_TMPDIR (default /tmp) under tmux-<uid>/<name>.
    return Path(os.environ.get("TMUX_TMPDIR") or "/tmp") / f"tmux-{os.getuid()}" / (socket or "default")


def tmux_pane_pids(socket=None) -> dict:
    """{pane_pid: 'session:window.pane'} for every pane of the tmux server; {} if none runs."""
    if not _tmux_socket_path(socket).exists():
        return {}
    cmd = ["tmux"] + (["-L", socket] if socket else []) + [
        "list-panes", "-a", "-F", "#{pane_pid} #{session_name}:#{window_index}.#{pane_index}"]
    r = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise RuntimeError(f"tmux list-panes failed: {r.stderr.strip()}")
    panes = {}
    for line in r.stdout.splitlines():
        pid, target = line.split(" ", 1)
        panes[int(pid)] = target
    return panes


def parent_pid(pid: int):
    """Parent pid via /proc (Linux) or `ps` (macOS). None if the process is gone."""
    if Path("/proc/self/stat").exists():
        try:
            text = Path(f"/proc/{pid}/stat").read_text()
        except FileNotFoundError:
            return None  # the process exited; there is nothing left to walk
        return int(text.rsplit(")", 1)[1].split()[1])
    r = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True)
    return int(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None


def pane_for_pid(pid, pane_pids: dict, parent_of=parent_pid):
    """The tmux pane a process runs in, found by walking up its parent processes."""
    seen = set()
    while pid and pid > 1 and pid not in seen:
        if pid in pane_pids:
            return pane_pids[pid]
        seen.add(pid)
        pid = parent_of(pid)
    return None


# ── Codex: rollout files ─────────────────────────────────────────────────────

LIFECYCLE = {"task_started": "working", "task_complete": "idle", "turn_aborted": "stopped"}
PLAN_STATUS = {"pending": "pending", "in_progress": "current", "completed": "done"}
# Exact event names in the rollout format; only lines containing one are parsed as JSON.
_MARKERS = (b'"update_plan"', b'"task_started"', b'"task_complete"', b'"turn_aborted"')


class RolloutReader:
    """Latest plan and latest turn-lifecycle event of each Codex rollout file.

    The first read scans the file once (a scan of 177 MB took 0.46 s); later reads parse
    only the bytes appended since then. A file that shrank is scanned again from the start.
    """

    def __init__(self) -> None:
        self._files: dict = {}

    def read(self, path: str, errors: Errors) -> dict:
        try:
            size = Path(path).stat().st_size
        except FileNotFoundError:
            self._files.pop(path, None)
            errors.add("codex.rollout", f"{path}: rollout file is missing")
            return {"plan": None, "life": None}
        st = self._files.get(path)
        if st is None or size < st["offset"]:
            st = {"offset": 0, "plan": None, "life": None, "bad": 0}
            self._files[path] = st
        if size > st["offset"]:
            with open(path, "rb") as fh:
                fh.seek(st["offset"])
                data = fh.read(size - st["offset"])
            end = data.rfind(b"\n") + 1  # a partial last line waits for the next poll
            for line in data[:end].splitlines():
                if any(m in line for m in _MARKERS):
                    self._parse(line, st)
            st["offset"] += end
        if st["bad"]:
            errors.add("codex.rollout", f"{path}: {st['bad']} unreadable line(s) skipped")
        return {"plan": st["plan"], "life": st["life"]}

    @staticmethod
    def _parse(line: bytes, st: dict) -> None:
        try:
            d = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            st["bad"] += 1
            return
        if not isinstance(d, dict):
            st["bad"] += 1
            return
        p = d.get("payload") or {}
        if not isinstance(p, dict):
            st["bad"] += 1
            return
        if d.get("type") == "response_item" and p.get("type") == "function_call" and p.get("name") == "update_plan":
            try:
                args = json.loads(p.get("arguments") or "")
            except json.JSONDecodeError:
                st["bad"] += 1
                return
            plan = args.get("plan") if isinstance(args, dict) else None
            if not isinstance(plan, list):
                st["bad"] += 1
                return
            steps = []
            for i, item in enumerate(plan, 1):
                status = PLAN_STATUS.get(item.get("status")) if isinstance(item, dict) else None
                if status is None:
                    st["bad"] += 1  # a plan that can't be read completely is reported, not half-shown
                    return
                steps.append({"id": str(i), "title": item.get("step") or "", "status": status,
                              "blockedBy": [], "blocks": [], "description": None,
                              "activeForm": None, "updatedAt": None})
            st["plan"] = steps
        elif d.get("type") == "event_msg" and p.get("type") in LIFECYCLE:
            st["life"] = (p["type"], p.get("turn_id"))


# ── Codex: databases and sessions ────────────────────────────────────────────

REQUIRED_COLUMNS = {
    "threads": ("id", "rollout_path", "cwd", "title", "name", "git_branch", "archived",
                "updated_at_ms", "source"),
    "thread_turns": ("thread_id", "turn_id", "rollout_ordinal", "status", "error_json"),
    "thread_goals": ("thread_id", "objective"),
}
TURN_STATE = {"inProgress": "working", "completed": "idle", "failed": "error", "interrupted": "stopped"}


class SchemaError(Exception):
    """A Codex database lacks a table or column the collector relies on."""


def newest_db(codex_home: Path, pattern: str):
    """Highest-numbered file for a pattern like 'state_*.sqlite' (the number is Codex's schema version)."""
    best = None
    for f in codex_home.glob(pattern):
        n = f.stem.rsplit("_", 1)[-1]
        if n.isdigit() and (best is None or int(n) > best[0]):
            best = (int(n), f)
    return best[1] if best else None


def _query(db: Path, table: str, sql: str, params=()) -> list:
    conn = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True)
    try:
        cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        missing = [col for col in REQUIRED_COLUMNS[table] if col not in cols]
        if missing:
            raise SchemaError(f"{db.name}: table {table} is missing or lacks column(s) {', '.join(missing)}")
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(sql, params)]
    finally:
        conn.close()


def _turn_error(error_json):
    if not error_json:
        return "The last turn failed (Codex recorded no error details)."
    try:
        e = json.loads(error_json)
    except json.JSONDecodeError:
        return error_json
    if isinstance(e, dict) and isinstance(e.get("message"), str):
        return e["message"]
    return error_json


def codex_raw_state(tid, life, turns_by_id, latest_turn, errors):
    """Raw state of a thread (decision 2 in the plan header). Returns (raw, error_text)."""
    if life is not None:
        rec = turns_by_id.get((tid, life[1]))
        if rec is None:
            return LIFECYCLE[life[0]], None
    else:
        rec = latest_turn.get(tid)
        if rec is None:
            return "idle", None
    raw = TURN_STATE.get(rec["status"])
    if raw is None:
        errors.add("codex.history_db", f"thread {tid}: unknown turn status {rec['status']!r}")
        return "error", f"unknown turn status {rec['status']!r}"
    return raw, (_turn_error(rec["error_json"]) if raw == "error" else None)


def codex_sessions(home: Path, reader: RolloutReader, errors: Errors) -> dict:
    codex_home = home / ".codex"
    if not codex_home.is_dir():
        return {}
    state_db = newest_db(codex_home, "state_*.sqlite")
    if state_db is None:
        errors.add("codex.state_db", f"{codex_home}: no state_*.sqlite found")
        return {}
    try:
        threads = _query(state_db, "threads",
                         "SELECT id, rollout_path, cwd, title, name, git_branch, updated_at_ms, source "
                         "FROM threads WHERE archived = 0")
    except (sqlite3.Error, SchemaError) as e:
        errors.add("codex.state_db", str(e))
        return {}

    turns_by_id, latest_turn = {}, {}
    hist = newest_db(codex_home, "thread_history_*.sqlite")
    if hist is not None:
        try:
            rows = _query(hist, "thread_turns",
                          "SELECT thread_id, turn_id, rollout_ordinal, status, error_json "
                          "FROM thread_turns ORDER BY rollout_ordinal")
        except (sqlite3.Error, SchemaError) as e:
            errors.add("codex.history_db", str(e))
            rows = []
        for r in rows:
            turns_by_id[(r["thread_id"], r["turn_id"])] = r
            latest_turn[r["thread_id"]] = r  # ascending order: the last row per thread is the latest

    goals = {}
    gdb = newest_db(codex_home, "goals_*.sqlite")
    if gdb is not None:
        try:
            goals = {r["thread_id"]: r["objective"]
                     for r in _query(gdb, "thread_goals", "SELECT thread_id, objective FROM thread_goals")}
        except (sqlite3.Error, SchemaError) as e:
            errors.add("codex.goals_db", str(e))

    out = {}
    for t in threads:
        tid = t["id"]
        info = reader.read(t["rollout_path"], errors) if t["rollout_path"] else {"plan": None, "life": None}
        raw, err = codex_raw_state(tid, info["life"], turns_by_id, latest_turn, errors)
        steps = info["plan"] or []
        out["codex:" + tid] = {
            "key": "codex:" + tid, "agent": "codex", "id": tid,
            "name": t["name"] or t["title"] or tid[:8], "cwd": t["cwd"], "gitBranch": t["git_branch"],
            "kind": t["source"], "pid": None, "short": None, "tmuxPane": None,
            "state": derive_state(raw, steps), "waitingFor": None, "error": err, "goal": goals.get(tid),
            "updatedAt": t["updated_at_ms"], "steps": steps,
            "stepsSource": "codex-update_plan" if steps else None,
        }
    return out


# ── conversation: normalizing one transcript line into zero or more items ────


def _conv_item(n, role, kind, text, *, tool=None, call_id=None, is_error=False, ts=None):
    return {"n": n, "role": role, "kind": kind, "text": text, "tool": tool,
            "callId": call_id, "isError": is_error, "ts": ts}


def _claude_tool_result_text(content) -> str:
    """The text of a Claude `tool_result` block's `content` (a string, or a list of blocks;
    non-text blocks show as `[<type>]`, e.g. `[image]`)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for sub in content:
            if isinstance(sub, dict) and sub.get("type") == "text":
                parts.append(sub.get("text") or "")
            else:
                kind = sub.get("type") if isinstance(sub, dict) else type(sub).__name__
                parts.append(f"[{kind}]")
        return "\n\n".join(parts)
    return "" if content is None else str(content)


def claude_items(line_obj: dict, n: int) -> list:
    """Zero or more normalized items from one line of a Claude Code transcript. Pure and
    unit-testable."""
    if not isinstance(line_obj, dict) or line_obj.get("isSidechain"):
        return []
    t = line_obj.get("type")
    if t not in ("user", "assistant"):
        return []
    message = line_obj.get("message")
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    ts = line_obj.get("timestamp")
    items = []
    if t == "user":
        if isinstance(content, str):
            items.append(_conv_item(n, "user", "text", content, ts=ts))
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                bt = block.get("type")
                if bt == "text":
                    items.append(_conv_item(n, "user", "text", block.get("text") or "", ts=ts))
                elif bt == "tool_result":
                    items.append(_conv_item(n, "tool", "tool_result", _claude_tool_result_text(block.get("content")),
                                            call_id=block.get("tool_use_id"), is_error=bool(block.get("is_error")), ts=ts))
    elif isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            bt = block.get("type")
            if bt == "text":
                items.append(_conv_item(n, "assistant", "text", block.get("text") or "", ts=ts))
            elif bt == "tool_use":
                text = json.dumps(block.get("input"), ensure_ascii=False)
                items.append(_conv_item(n, "tool", "tool_call", text,
                                        tool=block.get("name"), call_id=block.get("id"), ts=ts))
            # "thinking" and anything else in an assistant block: hidden (brief decision).
    return items


def _codex_output_text(output) -> str:
    """The text of a Codex tool result's `output` (brief: it may be a JSON string holding
    `{"output": ...}`; if so, show the inner string, otherwise show the raw string)."""
    if isinstance(output, str):
        try:
            parsed = json.loads(output)
        except json.JSONDecodeError:
            return output
        if isinstance(parsed, dict) and isinstance(parsed.get("output"), str):
            return parsed["output"]
        return output
    return "" if output is None else json.dumps(output, ensure_ascii=False)


def codex_items(line_obj: dict, n: int) -> list:
    """Zero or more normalized items from one line of a Codex rollout. Pure and unit-testable."""
    if not isinstance(line_obj, dict):
        return []
    t = line_obj.get("type")
    payload = line_obj.get("payload")
    if not isinstance(payload, dict):
        return []
    pt = payload.get("type")
    ts = line_obj.get("timestamp")
    if t == "event_msg" and pt == "user_message":
        return [_conv_item(n, "user", "text", payload.get("message") or "", ts=ts)]
    # Newer Codex rollouts record the user's turn as an `item_completed` event holding a
    # `UserMessage` item instead of a `user_message` event; a rollout uses one form or the
    # other, never both. Other completed items (AgentMessage, CommandExecution, ...) repeat
    # what the response_item lines already show, so they stay hidden.
    if t == "event_msg" and pt == "item_completed":
        item = payload.get("item")
        if not (isinstance(item, dict) and item.get("type") == "UserMessage"):
            return []
        content = item.get("content")
        parts = [c.get("text") or "" for c in content if isinstance(c, dict) and c.get("type") == "text"] \
            if isinstance(content, list) else []
        return [_conv_item(n, "user", "text", "".join(parts), ts=ts)]
    if t == "response_item" and pt == "message" and payload.get("role") == "assistant":
        content = payload.get("content")
        parts = [c.get("text") or "" for c in content if isinstance(c, dict) and c.get("type") == "output_text"] \
            if isinstance(content, list) else []
        return [_conv_item(n, "assistant", "text", "".join(parts), ts=ts)]
    if t == "response_item" and pt in ("function_call", "custom_tool_call"):
        raw = payload.get("arguments") if pt == "function_call" else payload.get("input")
        text = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)
        return [_conv_item(n, "tool", "tool_call", text,
                           tool=payload.get("name"), call_id=payload.get("call_id"), ts=ts)]
    if t == "response_item" and pt in ("function_call_output", "custom_tool_call_output"):
        return [_conv_item(n, "tool", "tool_result", _codex_output_text(payload.get("output")),
                           call_id=payload.get("call_id"), ts=ts)]
    # reasoning, ghost_snapshot, turn_context, session_meta, token_count, agent_reasoning,
    # agent_message, and anything unknown: hidden (brief decision).
    return []


class ConversationKeyError(ValueError):
    """A `--conversation` key isn't `claude:<id>` or `codex:<id>`."""


def resolve_conversation_path(home: Path, key: str):
    """(agent, path) for a conversation key. Raises ConversationKeyError for a
    malformed key, or LookupError/SchemaError/sqlite3.Error if the transcript can't be found."""
    if ":" not in key:
        raise ConversationKeyError(f"malformed key {key!r}: expected 'claude:<id>' or 'codex:<id>'")
    agent, ident = key.split(":", 1)
    if agent == "claude":
        pattern = str(home / ".claude" / "projects" / "*" / f"{ident}.jsonl")
        matches = sorted(glob.glob(pattern))
        if not matches:
            raise LookupError(f"no Claude transcript found for session {ident!r} (looked for {pattern})")
        if len(matches) > 1:
            raise LookupError(f"found {len(matches)} Claude transcripts for session {ident!r}: {', '.join(matches)}")
        return agent, Path(matches[0])
    if agent == "codex":
        codex_home = home / ".codex"
        db = newest_db(codex_home, "state_*.sqlite")
        if db is None:
            raise LookupError(f"no state_*.sqlite found under {codex_home}")
        rows = _query(db, "threads", "SELECT rollout_path FROM threads WHERE id = ?", (ident,))
        if not rows:
            raise LookupError(f"no Codex thread {ident!r} found in {db}")
        rollout_path = rows[0]["rollout_path"]
        if not rollout_path:
            raise LookupError(f"Codex thread {ident!r} in {db} has no rollout_path recorded")
        return agent, Path(rollout_path)
    raise ConversationKeyError(f"unknown agent {agent!r} in key {key!r}: expected 'claude' or 'codex'")


class ConversationReset(Exception):
    """The transcript file shrank since it was last read (brief: "File shrank")."""


class ConversationTailer:
    """Reads a transcript incrementally, the same partial-last-line handling RolloutReader uses:
    a partial trailing line waits for the next call instead of being parsed early."""

    def __init__(self, path: Path, parse) -> None:
        self.path = path
        self.parse = parse  # claude_items or codex_items
        self.offset = 0
        self.line_no = 0

    def read_new(self):
        """([items] per source line that produced any, bad_line_count). Raises FileNotFoundError
        if the file is gone, ConversationReset if it shrank."""
        size = self.path.stat().st_size
        if size < self.offset:
            raise ConversationReset()
        if size == self.offset:
            return [], 0
        with open(self.path, "rb") as fh:
            fh.seek(self.offset)
            data = fh.read(size - self.offset)
        end = data.rfind(b"\n") + 1  # a partial last line waits for the next poll
        batches, bad = [], 0
        for raw in data[:end].splitlines():
            self.line_no += 1
            try:
                obj = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                bad += 1
                continue
            if not isinstance(obj, dict):
                bad += 1
                continue
            items = self.parse(obj, self.line_no)
            if items:
                batches.append(items)
        self.offset += end
        return batches, bad

    def reset(self) -> None:
        self.offset = 0
        self.line_no = 0


def _drain_and_sync(tailer: ConversationTailer, emitter: "Emitter") -> None:
    batches, bad = tailer.read_new()
    for items in batches:
        emitter.send({"type": "items", "items": items})
    if bad:
        emitter.send({"type": "conv-warn", "message": f"{bad} unreadable line(s) skipped"})
    emitter.send({"type": "conv-synced"})


def run_conversation(path: Path, agent: str, key: str, emitter: "Emitter", poll: float) -> int:
    """Streams one conversation, as JSON lines. Returns the process exit code."""
    tailer = ConversationTailer(path, claude_items if agent == "claude" else codex_items)
    emitter.send({"type": "conv-hello", "protocol": PROTOCOL, "agent": agent, "key": key, "path": str(path)})
    _drain_and_sync(tailer, emitter)
    while True:
        time.sleep(poll)
        try:
            batches, bad = tailer.read_new()
        except FileNotFoundError:
            emitter.send({"type": "conv-error", "message": f"{path} disappeared"})
            return 1
        except ConversationReset:
            emitter.send({"type": "conv-reset"})
            tailer.reset()
            _drain_and_sync(tailer, emitter)
            continue
        for items in batches:
            emitter.send({"type": "items", "items": items})
        if bad:
            emitter.send({"type": "conv-warn", "message": f"{bad} unreadable line(s) skipped"})


def run_conversation_main(home: Path, key: str, poll: float) -> int:
    emitter = Emitter(sys.stdout)
    try:
        agent, path = resolve_conversation_path(home, key)
    except (ConversationKeyError, LookupError, SchemaError, sqlite3.Error) as e:
        emitter.send({"type": "conv-error", "message": str(e)})
        return 1
    try:
        return run_conversation(path, agent, key, emitter, poll)
    except BrokenPipeError:
        # The hub closed the connection, so nobody is listening; exit quietly.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 0


# ── binaries ─────────────────────────────────────────────────────────────────

# `bash -lic` (login, interactive) took 1.76 s on a typical lab server (measured 2026-09-14). A login shell
# reads ~/.profile or ~/.bash_profile (which normally source ~/.bashrc), unlike `bash -ic`, so
# PATH entries such as ~/.local/bin that are only added at login are picked up.
SHELL_LOOKUP_TIMEOUT = 30

SENTINEL_PREFIX = "SWITCHYARD_PATH="


def find_binaries(claude=None, codex=None, shell=("bash", "-lic"), timeout=SHELL_LOOKUP_TIMEOUT) -> dict:
    """Paths of `claude` and `codex`, and the PATH a login shell sees. Configured paths win.
    Otherwise a login shell is asked, because nvm and ~/.local/bin are only on PATH there."""
    found = {"claude": claude, "codex": codex, "notes": [], "path": None}
    wanted = [n for n in ("claude", "codex") if not found[n]]
    if not wanted:
        return found
    cmd = "; ".join(f"command -v {n}" for n in wanted) + f'; printf \'{SENTINEL_PREFIX}%s\\n\' "$PATH"'
    try:
        r = subprocess.run([*shell, cmd], capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=timeout)
    except subprocess.TimeoutExpired:
        found["notes"].append(f"The interactive shell took longer than {timeout:g} s to start, so claude/codex "
                              f"weren't looked up. Set their paths for this host in hosts.json.")
        return found
    except FileNotFoundError:
        found["notes"].append(f"{shell[0]} isn't installed, so claude/codex weren't looked up. "
                              f"Set their paths for this host in hosts.json.")
        return found
    for line in r.stdout.splitlines():
        if line.startswith(SENTINEL_PREFIX):
            found["path"] = line[len(SENTINEL_PREFIX):]
            continue
        p = line.strip()
        name = os.path.basename(p)
        # an interactive shell may print banners; keep only absolute paths to the wanted binaries
        if p.startswith("/") and name in wanted and not found[name] and os.access(p, os.X_OK):
            found[name] = p
    # `command -v` prints a shell function's or alias's own name or definition, not a path (a
    # `claude` wrapper function in ~/.bashrc, say). The executable is then whatever the login
    # shell's PATH resolves the name to, which is what running it from a script would find.
    if found["path"] is not None:
        for name in wanted:
            if not found[name]:
                found[name] = shutil.which(name, path=found["path"])
    if found["path"] is None:
        found["notes"].append("the login shell did not report its PATH; tools run with the SSH session's PATH")
    return found


def path_with_tool_dirs(path_str: str, bins: dict) -> str:
    """Prepend each configured binary's own directory to PATH (in `bins`' order, deduplicated,
    None values ignored). nvm, fnm and npm put the interpreter beside the script, so this lets a
    configured nvm `codex` find its `node`."""
    parts = path_str.split(os.pathsep) if path_str else []
    dirs = [str(Path(p).parent) for p in bins.values() if p]
    for d in reversed(dirs):
        if d in parts:
            parts.remove(d)
        parts.insert(0, d)
    return os.pathsep.join(parts)


def missing_tool_notes(home: Path, bins: dict) -> list:
    """A note for each tool whose data directory exists but whose binary wasn't found, so a
    running session never silently disappears from the dashboard."""
    notes = []
    if (home / ".claude").is_dir() and not bins.get("claude"):
        notes.append("Claude Code data is in ~/.claude but the claude command wasn't found "
                     "(checked a login shell's PATH). Set this host's \"claude\" path in hosts.json.")
    if (home / ".codex").is_dir() and not bins.get("codex"):
        notes.append("Codex data is in ~/.codex but the codex command wasn't found "
                     "(checked a login shell's PATH). Set this host's \"codex\" path in hosts.json.")
    return notes


def binary_version(path):
    """(version, None) on success, or (None, reason) so the hub sees why `--version` failed."""
    if not path:
        return None, None
    try:
        r = subprocess.run([path, "--version"], capture_output=True, text=True, check=True,
                           stdin=subprocess.DEVNULL)
    except subprocess.CalledProcessError as e:
        reason = e.stderr.strip() if e.stderr and e.stderr.strip() else f"exit {e.returncode}"
        return None, reason
    except (FileNotFoundError, PermissionError) as e:
        return None, str(e)
    return (r.stdout.strip().splitlines() or [""])[0], None


# ── stream ────────────────────────────────────────────────────────────────────


def dir_signature(path: Path) -> tuple:
    """(name, mtime_ns, size) of each entry; () if the directory doesn't exist."""
    if not path.is_dir():
        return ()
    sig = []
    for e in os.scandir(path):
        try:
            st = e.stat()
        except FileNotFoundError:
            continue  # removed while scanning; the signature still changes on the next poll
        sig.append((e.name, st.st_mtime_ns, st.st_size))
    return tuple(sorted(sig))


def _alive(pid) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # it exists but belongs to someone else
    return True


# ── run progress records ────────────────────────────────────────────────────
# A run is reported by the experiment itself, as one JSON file per run. Switchyard only ever
# reads these: it never creates, edits or deletes one.
RUN_VERSION = 1
RUN_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
# Exactly the fields of a run record (docs/runs-api.md). A record may hold others; they are dropped, so nothing
# unexpected on disk reaches the hub or the page.
RUN_FIELDS = ("id", "label", "status", "done", "total", "unit", "gpus", "pid", "session", "cwd",
              "startedAt", "updatedAt", "finished", "error", "eta", "note")


def default_runs_dir() -> Path:
    return Path.home() / ".local" / "state" / "switchyard" / "runs"


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


# os.kill() needs a pid that fits a C int (pid_t): a float, a bool, a string or an out-of-range
# int raises TypeError/OverflowError, and the collector dying takes that host's sessions, tasks
# and runs off the page until the record is deleted. PID_MAX is pid_t's range, not a tuning knob.
PID_MAX = 2 ** 31 - 1


def _is_pid(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value <= PID_MAX


def read_run(path: Path, errors: Errors):
    """One record, projected to RUN_FIELDS plus mtime/alive/dir. None when it can't be used."""
    def bad(why):
        errors.add("runs", f"{path}: {why}")
        return None

    try:
        text = path.read_text(encoding="utf-8")
        stat = path.stat()
    except FileNotFoundError:
        return None  # removed between the scan and the read; the next poll sees that
    except OSError as e:
        return bad(f"can't be read ({e})")
    try:
        rec = json.loads(text)
    except json.JSONDecodeError as e:
        return bad(f"isn't valid JSON ({e})")
    if not isinstance(rec, dict):
        return bad("isn't a JSON object")
    if rec.get("version") != RUN_VERSION:
        return bad(f"has version {rec.get('version')!r}; this collector reads version {RUN_VERSION}")
    run_id = rec.get("id")
    if not isinstance(run_id, str) or not RUN_ID.match(run_id):
        return bad(f"has id {run_id!r}, which must match {RUN_ID.pattern}")
    if run_id != path.stem:
        return bad(f"has id {run_id!r} but is named {path.name}")
    for key in ("done", "total"):
        if rec.get(key) is not None and not _is_number(rec[key]):
            return bad(f"has a non-numeric {key} ({rec[key]!r})")
    out = {k: rec[k] for k in RUN_FIELDS if k in rec}
    out["mtime"] = stat.st_mtime
    pid = rec.get("pid")
    if pid is None:
        out["alive"] = None  # no pid: liveness is simply unknown, which is not a problem
    elif _is_pid(pid):
        out["alive"] = _alive(pid)
    else:
        # One bad field costs the field, not the run.
        errors.add("runs", f"{path}: has an unusable pid ({pid!r}); liveness is unknown")
        out["alive"] = None
    out["dir"] = str(path.parent)
    return out


def read_runs(dirs: list, errors: Errors) -> dict:
    """{id: run} across every runs directory. The first directory given wins an id clash."""
    out: dict = {}
    for d in dirs:
        if not d.is_dir():
            continue  # nothing has reported a run here
        for path in sorted(d.glob("*.json")):
            run = read_run(path, errors)
            if run is None:
                continue
            if run["id"] in out:
                errors.add("runs", f"{path}: run id {run['id']!r} is already reported from "
                                   f"{out[run['id']]['dir']}, so this one is ignored")
                continue
            out[run["id"]] = run
    return out


class Collector:
    def __init__(self, home: Path, claude_bin, tmux_socket=None, runs_dirs=()) -> None:
        self.home = home
        self.claude_bin = claude_bin
        self.tmux_socket = tmux_socket
        self.rollouts = RolloutReader()
        self._agents_sig = None
        self._agents: list = []
        # Resolved and de-duplicated: the same directory given twice (a trailing slash, a
        # symlink, an explicit copy of the default) would otherwise report every run in it as a
        # duplicate of itself.
        seen = []
        for d in ([Path(d).expanduser() for d in runs_dirs] or [default_runs_dir()]):
            resolved = d.resolve()
            if resolved not in seen:
                seen.append(resolved)
        self.runs_dirs = seen
        self._runs_sigs: dict = {}
        self._runs: dict = {}
        self._runs_errors: list = []

    def _live_claude(self, errors: Errors) -> list:
        if not self.claude_bin:
            return []
        sig = dir_signature(self.home / ".claude" / "sessions")
        stale = any(not _alive(a.get("pid")) for a in self._agents)
        if sig != self._agents_sig or stale:
            try:
                self._agents = claude_live_sessions(self.claude_bin)
                self._agents_sig = sig
            except subprocess.CalledProcessError as e:
                errors.add("claude.agents", f"`claude agents --json` exited with {e.returncode}: {e.stderr.strip()}")
            except (json.JSONDecodeError, ValueError) as e:
                errors.add("claude.agents", f"`claude agents --json` printed something unreadable: {e}")
        return self._agents

    def snapshot(self, errors: Errors) -> dict:
        try:
            panes = tmux_pane_pids(self.tmux_socket)
        except (RuntimeError, FileNotFoundError) as e:
            errors.add("tmux", str(e))
            panes = {}
        out = claude_sessions(self.home, self._live_claude(errors), errors,
                              pane_of=lambda pid: pane_for_pid(pid, panes))
        out.update(codex_sessions(self.home, self.rollouts, errors))
        return out

    def runs(self, errors: Errors) -> dict:
        """Every reported run, re-reading a directory only when its signature changed."""
        sigs = {str(d): dir_signature(d) for d in self.runs_dirs}
        if sigs != self._runs_sigs:
            found = Errors()
            self._runs = read_runs(self.runs_dirs, found)
            self._runs_sigs = sigs
            # Kept so a cached read still reports its bad records: the hub only re-sends an
            # error list that changed, so dropping them here would erase them from the page.
            self._runs_errors = found.as_list()
        errors.extend(self._runs_errors)
        return self._runs


def run_stream(collector: Collector, emitter: Emitter, poll: float, once: bool, hello: dict) -> None:
    emitter.send(hello)
    while True:
        errors = Errors()
        emitter.sync_sessions(collector.snapshot(errors))
        emitter.sync_runs(collector.runs(errors))
        emitter.sync_errors(errors.as_list())
        emitter.send({"type": "tick"})
        if once:
            return
        time.sleep(poll)


# ── removing a session ───────────────────────────────────────────────────────

SESSION_KEY = re.compile(r"^(claude|codex):([A-Za-z0-9._-]+)$")


class RemoveError(Exception):
    """A session can't be removed; the message says why, for the person who asked."""


def _run_tool(cmd: list) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL)
    out = (r.stdout + r.stderr).strip()
    if r.returncode != 0:
        raise RemoveError(f"`{' '.join(cmd[1:])}` failed: {out.splitlines()[-1] if out else f'exit {r.returncode}'}")
    return out


def remove_session(home: Path, key: str, bins: dict) -> str:
    """Removes one session the agent's own way, and says what was done. Nothing is removed that
    the agent itself wouldn't remove, and no conversation transcript is deleted:
    - Codex: `codex archive` (Switchyard reads unarchived threads only; `codex unarchive` undoes it).
    - Claude background session: `claude rm`, which refuses when that isn't safe and keeps the
      conversation.
    - Claude session that isn't running: its task list folder, which is all Switchyard shows of it.
    - Claude session running in a terminal: refused; it has to be quit there."""
    m = SESSION_KEY.match(key)
    if not m:
        raise RemoveError(f"malformed session key {key!r}")
    agent, ident = m.groups()
    if agent == "codex":
        if not bins["codex"]:
            raise RemoveError("the codex command wasn't found on this host")
        _run_tool([bins["codex"], "archive", ident])
        return f"archived it (codex archive {ident}); `codex unarchive {ident}` brings it back"
    if not bins["claude"]:
        raise RemoveError("the claude command wasn't found on this host, so whether the session is running can't be told")
    live = next((a for a in claude_live_sessions(bins["claude"]) if a.get("sessionId") == ident), None)
    if live is not None and live.get("kind") == "background":
        short = live.get("id") or ident
        _run_tool([bins["claude"], "rm", short])
        return f"removed it (claude rm {short}); its conversation is kept (claude --resume)"
    if live is not None:
        raise RemoveError(f"it is running in a terminal (pid {live.get('pid')}); quit it there")
    tasks = home / ".claude" / "tasks" / ident
    if not tasks.is_dir():
        raise RemoveError("it isn't running and has no task list here to delete")
    shutil.rmtree(tasks)
    return f"deleted its task list (~/.claude/tasks/{ident}); its conversation is kept"


def setup_tools(args) -> dict:
    """claude/codex as the login shell finds them (or as configured), with that shell's PATH."""
    bins = find_binaries(args.claude_bin, args.codex_bin)
    if args.claude_bin and args.codex_bin:
        # The lookup was skipped; find `node` etc. beside each configured binary instead.
        os.environ["PATH"] = path_with_tool_dirs(os.environ.get("PATH", ""),
                                                 {"claude": bins["claude"], "codex": bins["codex"]})
    elif bins["path"]:
        os.environ["PATH"] = bins["path"]
    return bins


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="collector", description="Switchyard collector")
    ap.add_argument("--stream", action="store_true", help="report sessions continuously")
    ap.add_argument("--once", action="store_true", help="with --stream: one poll, then exit")
    ap.add_argument("--conversation", metavar="KEY", help="stream one session's full conversation "
                    "('claude:<sessionId>' or 'codex:<threadId>'); mutually exclusive with --stream")
    ap.add_argument("--remove-session", metavar="KEY", help="remove one session the agent's own way "
                    "and print one JSON line saying what was done")
    ap.add_argument("--poll", type=float, default=2.0, help="seconds between polls")
    ap.add_argument("--home", help="home directory to read (default: yours)")
    ap.add_argument("--claude-bin")
    ap.add_argument("--codex-bin")
    ap.add_argument("--runs-dir", action="append", metavar="PATH",
                    help="where experiments leave run progress records; repeatable "
                         "(default: ~/.local/state/switchyard/runs)")
    ap.add_argument("--tmux-socket", help="tmux -L socket name (tests only)")
    args = ap.parse_args(argv)
    modes = [m for m in (args.stream, args.conversation, args.remove_session) if m]
    if len(modes) > 1:
        ap.error("--stream, --conversation and --remove-session are mutually exclusive")
    if not modes:
        ap.error("nothing to do: pass --stream, --conversation or --remove-session")
    home = Path(args.home) if args.home else Path.home()
    if args.conversation:
        return run_conversation_main(home, args.conversation, args.poll)
    bins = setup_tools(args)
    if args.remove_session:
        try:
            print(json.dumps({"ok": True, "message": remove_session(home, args.remove_session, bins)}))
            return 0
        except RemoveError as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            return 1
    notes = list(bins["notes"])
    tools = {}
    for name in ("claude", "codex"):
        version, reason = binary_version(bins[name])
        if bins[name] and version is None:
            notes.append(f"{bins[name]} --version failed: {reason}")
        tools[name] = {"path": bins[name], "version": version} if bins[name] else None
    notes.extend(missing_tool_notes(home, bins))
    hello = {"type": "hello", "protocol": PROTOCOL, "python": platform.python_version(),
             "hostname": platform.node(), "home": str(home), "notes": notes, **tools}
    try:
        run_stream(Collector(home, bins["claude"], args.tmux_socket, args.runs_dir or ()),
                   Emitter(sys.stdout), args.poll, args.once, hello)
    except BrokenPipeError:
        # The hub closed the connection, so nobody is listening; exit quietly.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
    return 0


if __name__ == "__main__":
    sys.exit(main())
