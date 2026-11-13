import io
import json
import os
import subprocess
import sys

import pytest

import collector as c
from helpers import fake_claude, fake_codex, write_run


def lines(buf):
    return [json.loads(l) for l in buf.getvalue().splitlines()]


def dead_pid() -> int:
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


def sources(errors):
    return [e["source"] for e in errors.as_list()]


def test_valid_record_is_projected_with_mtime_and_alive(tmp_path):
    write_run(tmp_path, {"version": 1, "id": "a", "status": "Running", "done": 7, "total": 10,
                         "gpus": [0, 1], "pid": os.getpid(), "surprise": "dropped"})
    runs = c.read_runs([tmp_path], c.Errors())
    assert runs["a"]["status"] == "Running" and runs["a"]["done"] == 7
    assert runs["a"]["alive"] is True and runs["a"]["mtime"] > 0
    assert runs["a"]["dir"] == str(tmp_path)
    assert "surprise" not in runs["a"]


def test_dead_pid_reports_alive_false_and_missing_pid_reports_none(tmp_path):
    write_run(tmp_path, {"version": 1, "id": "a", "pid": dead_pid()})
    write_run(tmp_path, {"version": 1, "id": "b"})
    runs = c.read_runs([tmp_path], c.Errors())
    assert runs["a"]["alive"] is False
    assert runs["b"]["alive"] is None


def test_malformed_record_is_skipped_and_reported(tmp_path):
    (tmp_path / "a.json").write_text("{not json", encoding="utf-8")
    (tmp_path / "b.json").write_text("[1, 2]", encoding="utf-8")
    (tmp_path / "c.json").write_text(json.dumps({"version": 1}), encoding="utf-8")
    errors = c.Errors()
    assert c.read_runs([tmp_path], errors) == {}
    assert sources(errors) == ["runs", "runs", "runs"]


def test_unknown_version_is_reported(tmp_path):
    write_run(tmp_path, {"version": 2, "id": "a"})
    errors = c.Errors()
    assert c.read_runs([tmp_path], errors) == {}
    assert "version" in errors.as_list()[0]["message"]


def test_id_must_match_the_file_name_and_the_pattern(tmp_path):
    (tmp_path / "a.json").write_text(json.dumps({"version": 1, "id": "b"}), encoding="utf-8")
    (tmp_path / "weird.json").write_text(json.dumps({"version": 1, "id": "a/b"}), encoding="utf-8")
    errors = c.Errors()
    assert c.read_runs([tmp_path], errors) == {}
    assert len(errors.as_list()) == 2


def test_non_numeric_done_or_total_is_reported(tmp_path):
    write_run(tmp_path, {"version": 1, "id": "a", "done": "lots", "total": 10})
    write_run(tmp_path, {"version": 1, "id": "b", "done": 1, "total": "many"})
    errors = c.Errors()
    assert c.read_runs([tmp_path], errors) == {}
    assert len(errors.as_list()) == 2


def test_duplicate_id_across_directories_keeps_the_first_and_reports(tmp_path):
    d1, d2 = tmp_path / "d1", tmp_path / "d2"
    write_run(d1, {"version": 1, "id": "a", "status": "first"})
    write_run(d2, {"version": 1, "id": "a", "status": "second"})
    errors = c.Errors()
    runs = c.read_runs([d1, d2], errors)
    assert runs["a"]["status"] == "first"
    assert len(errors.as_list()) == 1 and str(d2) in errors.as_list()[0]["message"]
    assert c.read_runs([d1, d2], c.Errors())["a"]["status"] == "first"  # stable, not alternating


def test_missing_directory_is_not_an_error(tmp_path):
    errors = c.Errors()
    assert c.read_runs([tmp_path / "nope"], errors) == {}
    assert errors.as_list() == []


def test_reading_runs_never_writes_in_the_directory(tmp_path):
    write_run(tmp_path, {"version": 1, "id": "a", "done": 1, "total": 2})
    before = c.dir_signature(tmp_path)
    c.read_runs([tmp_path], c.Errors())
    assert c.dir_signature(tmp_path) == before


def test_directory_is_reread_only_when_its_signature_changes(tmp_path, monkeypatch):
    runs_dir = tmp_path / "runs"
    write_run(runs_dir, {"version": 1, "id": "a"})
    col = c.Collector(tmp_path / "home", None, runs_dirs=[runs_dir])
    calls = []
    real = c.read_run
    monkeypatch.setattr(c, "read_run", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    first = col.runs(c.Errors())
    assert len(calls) == 1 and set(first) == {"a"}
    assert col.runs(c.Errors()) == first and len(calls) == 1
    write_run(runs_dir, {"version": 1, "id": "b"})
    assert set(col.runs(c.Errors())) == {"a", "b"} and len(calls) == 3


def test_sync_runs_sends_changes_and_removals():
    buf = io.StringIO()
    e = c.Emitter(buf)
    e.sync_runs({"a": {"id": "a", "done": 1}, "b": {"id": "b", "done": 1}})
    e.sync_runs({"a": {"id": "a", "done": 1}, "b": {"id": "b", "done": 2}})
    e.sync_runs({"b": {"id": "b", "done": 2}})
    got = [(m["type"], m.get("id") or m["run"]["id"]) for m in lines(buf)]
    assert got == [("run", "a"), ("run", "b"), ("run", "b"), ("run-removed", "a")]


def test_runs_and_sessions_are_tracked_separately():
    buf = io.StringIO()
    e = c.Emitter(buf)
    e.sync_sessions({"claude:a": {"key": "claude:a"}})
    e.sync_runs({"a": {"id": "a"}})
    e.sync_sessions({"claude:a": {"key": "claude:a"}})  # unchanged: nothing more sent
    assert [m["type"] for m in lines(buf)] == ["session", "run"]


def test_stream_emits_runs_and_protocol_2(tmp_path):
    write_run(tmp_path / "runs", {"version": 1, "id": "a", "done": 1, "total": 2})
    buf = io.StringIO()
    col = c.Collector(tmp_path / "home", None, runs_dirs=[tmp_path / "runs"])
    c.run_stream(col, c.Emitter(buf), poll=0, once=True,
                 hello={"type": "hello", "protocol": c.PROTOCOL})
    msgs = lines(buf)
    assert c.PROTOCOL == 2 and msgs[0]["protocol"] == 2
    assert [m["run"]["id"] for m in msgs if m["type"] == "run"] == ["a"]
    assert msgs[-1]["type"] == "tick"


def test_runs_dir_flag_is_repeatable(tmp_path, monkeypatch):
    a, b = tmp_path / "A", tmp_path / "B"
    write_run(a, {"version": 1, "id": "x"})
    write_run(b, {"version": 1, "id": "y"})
    home = tmp_path / "home"
    home.mkdir()
    buf = io.StringIO()
    monkeypatch.setenv("PATH", os.environ["PATH"])  # main() rewrites PATH; restore it afterwards
    monkeypatch.setattr(sys, "stdout", buf)
    rc = c.main(["--stream", "--once", "--home", str(home), "--poll", "0",
                 "--claude-bin", fake_claude(tmp_path, []), "--codex-bin", fake_codex(tmp_path),
                 "--runs-dir", str(a), "--runs-dir", str(b)])
    assert rc == 0
    assert sorted(m["run"]["id"] for m in lines(buf) if m["type"] == "run") == ["x", "y"]


def test_runs_dir_default_is_used_when_no_flag_is_given(tmp_path):
    col = c.Collector(tmp_path / "home", None)
    assert col.runs_dirs == [c.default_runs_dir()]


@pytest.mark.parametrize("pid", [418221.0, 1e30, 99999999999999999999, -1, 0, True, "123"])
def test_an_unusable_pid_is_reported_and_leaves_the_run_visible(tmp_path, pid):
    """A pid os.kill can't take must never reach it: that kills the collector, and with it
    every session and run on that host, in a loop the user can only break by deleting the file."""
    write_run(tmp_path, {"version": 1, "id": "a", "status": "Running", "pid": pid})
    errors = c.Errors()
    runs = c.read_runs([tmp_path], errors)
    assert runs["a"]["status"] == "Running"  # one bad field costs the field, not the run
    assert runs["a"]["alive"] is None
    assert len(errors.as_list()) == 1 and "pid" in errors.as_list()[0]["message"]


def test_a_stream_survives_every_unusable_pid(tmp_path):
    for i, pid in enumerate([418221.0, 1e30, 99999999999999999999, -1, True, "123"]):
        write_run(tmp_path / "runs", {"version": 1, "id": f"r{i}", "pid": pid})
    buf = io.StringIO()
    col = c.Collector(tmp_path / "home", None, runs_dirs=[tmp_path / "runs"])
    c.run_stream(col, c.Emitter(buf), poll=0, once=True, hello={"type": "hello", "protocol": c.PROTOCOL})
    assert len([m for m in lines(buf) if m["type"] == "run"]) == 6


def test_the_same_directory_configured_twice_is_read_once(tmp_path):
    write_run(tmp_path / "runs", {"version": 1, "id": "a"})
    col = c.Collector(tmp_path / "home", None,
                      runs_dirs=[tmp_path / "runs", f"{tmp_path}/runs/", tmp_path / "runs"])
    errors = c.Errors()
    assert set(col.runs(errors)) == {"a"}
    assert errors.as_list() == []  # a directory is not a duplicate of itself
