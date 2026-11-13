#!/usr/bin/env python3
"""Report an experiment's progress to Switchyard.

Copy this file next to your experiment (or import it from here) and report as the run goes:

    from switchyard_progress import Run

    run = Run("grpo-r3", label="GRPO round 3", gpus=[0, 1, 4, 7])
    run.status("Waiting for 4 GPUs")
    ...
    run.status("Running")
    for step in range(1000):
        train(step)
        run.progress(step + 1, 1000, unit="steps")
    run.progress(0, 50, unit="batches", status="Evaluating")
    ...
    run.done()                        # or run.failed("CUDA OOM on box3:1")

Each call writes one small JSON file, atomically, to the runs directory on this machine;
Switchyard's collector reads it from there. The status text is yours: Switchyard displays it
and never interprets it. See docs/runs-api.md for the record format, which is the real
contract — this file is a convenience, not a dependency.

Python >= 3.8, standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

RECORD_VERSION = 1
# A run id is also its file name, and reaches the dashboard: same character set the hub already
# accepts for session keys, bounded so it stays a sane file name.
ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def _resolve_dir(override=None) -> Path:
    """The runs directory: the argument, else $SWITCHYARD_RUNS_DIR, else the default."""
    if override:
        return Path(override).expanduser()
    env = os.environ.get("SWITCHYARD_RUNS_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".local" / "state" / "switchyard" / "runs"


# Public name; `Run`'s keyword argument is called runs_dir too, hence the private alias above.
runs_dir = _resolve_dir


def check_id(run_id) -> str:
    if not isinstance(run_id, str) or not ID_RE.match(run_id):
        raise ValueError(f"run id must match {ID_RE.pattern}, got {run_id!r}")
    return run_id


def now_ms() -> int:
    return int(time.time() * 1000)


def _warn(message: str) -> None:
    """Reporting progress must never be what ends a run.

    A full disk or a quota at step 40,000 of a 12-hour job should cost you the progress bar, not
    the job — so the two calls that touch the filesystem report the failure here and carry on.
    Nothing else is caught: a bad id, a bad argument or a bug still raises.
    """
    print(f"switchyard_progress: {message}", file=sys.stderr, flush=True)


def write_record(path: Path, record: dict) -> None:
    """Write the whole record, atomically: a reader never sees half of one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def read_record(path: Path):
    """The record at `path`, or None when there isn't one. A corrupt file raises."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    return json.loads(text)


def _session_from_env():
    """The agent session that owns this run, when the agent exported it. Never guessed."""
    for var, agent in (("CLAUDE_SESSION_ID", "claude"), ("CODEX_THREAD_ID", "codex")):
        value = os.environ.get(var)
        if value:
            bare = value.split(":", 1)[1] if value.startswith(f"{agent}:") else value
            return f"{agent}:{bare}"
    return None


class Run:
    """One reported run. Holds the record in memory and rewrites it whole on every call."""

    def __init__(self, id, *, label=None, gpus=None, total=None, unit=None, status=None,
                 session=None, cwd=None, pid=None, runs_dir=None):
        self.id = check_id(id)
        self.dir = _resolve_dir(runs_dir)
        self._rec = {
            "version": RECORD_VERSION,
            "id": self.id,
            "finished": False,
            "error": None,
            "startedAt": now_ms(),
            "cwd": os.getcwd() if cwd is None else cwd,
            "pid": os.getpid() if pid is None else pid,
        }
        session = _session_from_env() if session is None else session
        if session is not None:
            self._rec["session"] = session
        # Written on construction: a run that is still waiting for GPUs should already be on
        # the dashboard, with a status and no bar.
        self.update(label=label, gpus=gpus, total=total, unit=unit, status=status)

    @property
    def path(self) -> Path:
        return self.dir / f"{self.id}.json"

    def update(self, **fields) -> None:
        """Merge `fields` into the record and write it. A field passed as None is removed."""
        for key, value in fields.items():
            if value is None:
                self._rec.pop(key, None)
            else:
                self._rec[key] = value
        self._rec["updatedAt"] = now_ms()
        try:
            write_record(self.path, self._rec)
        except OSError as e:
            _warn(f"could not write {self.path}: {e}")

    def status(self, status) -> None:
        self.update(status=status)

    def progress(self, done, total=None, *, unit=None, status=None) -> None:
        self.update(done=done, **{k: v for k, v in (("total", total), ("unit", unit),
                                                    ("status", status)) if v is not None})

    def done(self) -> None:
        self.update(finished=True)

    def failed(self, error) -> None:
        self.update(finished=True, error=error)

    def clear(self) -> None:
        """Remove the record. Switchyard never does this for you."""
        try:
            os.remove(self.path)
        except FileNotFoundError:
            pass  # already gone: the caller's intent is satisfied


def _number(text: str):
    """An int when it looks like one, so `--done 7` doesn't report 7.0."""
    value = float(text)
    return int(value) if value.is_integer() else value


def _gpu_list(text: str) -> list:
    """`0,1,box2:7` -> [0, 1, 'box2:7']: a bare index means this host."""
    out = []
    for part in (p.strip() for p in text.split(",")):
        if not part:
            continue
        out.append(int(part) if part.isdigit() else part)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="switchyard_progress",
        description="Report one update for a run, merging over whatever the record already says.")
    ap.add_argument("--id", required=True, help=f"run id, matching {ID_RE.pattern}")
    ap.add_argument("--runs-dir", help="where records go (default: $SWITCHYARD_RUNS_DIR, else "
                                      "~/.local/state/switchyard/runs)")
    ap.add_argument("--label")
    ap.add_argument("--status", help="your own wording; Switchyard never interprets it")
    ap.add_argument("--done", type=_number)
    ap.add_argument("--total", type=_number)
    ap.add_argument("--unit")
    ap.add_argument("--gpus", type=_gpu_list, help="e.g. 0,1 or 0,1,box2:7")
    ap.add_argument("--session", help="claude:<id> or codex:<id>")
    ap.add_argument("--cwd")
    ap.add_argument("--pid", type=int, help="the process to watch, usually $$ — without it, "
                                            "liveness is simply unknown")
    ap.add_argument("--eta", type=_number, help="seconds remaining, if you know better than a "
                                                "measured rate")
    ap.add_argument("--note")
    ap.add_argument("--error", help="why it ended badly")
    ap.add_argument("--finished", action="store_true", help="the run is over")
    ap.add_argument("--clear", action="store_true", help="delete this run's record")
    args = ap.parse_args(argv)

    run_id = check_id(args.id)
    path = _resolve_dir(args.runs_dir) / f"{run_id}.json"
    if args.clear:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass  # already gone
        return 0

    try:
        record = read_record(path)
    except json.JSONDecodeError as e:
        _warn(f"{path} is not valid JSON ({e}); starting a fresh record")
        record = None
    if record is None:
        record = {"version": RECORD_VERSION, "id": run_id, "finished": False, "error": None,
                  "startedAt": now_ms()}
    for name in ("label", "status", "done", "total", "unit", "gpus", "session", "cwd", "pid",
                 "eta", "note", "error"):
        value = getattr(args, name)
        if value is not None:
            record[name] = value
    if args.finished:
        record["finished"] = True
    record["updatedAt"] = now_ms()
    try:
        write_record(path, record)
    except OSError as e:
        # Exit 0 on purpose: this is often called from a loop under `set -e`, and a failed
        # progress report must not take the experiment down with it.
        _warn(f"could not write {path}: {e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
