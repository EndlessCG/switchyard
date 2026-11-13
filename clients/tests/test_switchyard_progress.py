import json
import os

import pytest

import switchyard_progress as sp


def rec_of(d, run_id="grpo-r3"):
    return json.loads((d / f"{run_id}.json").read_text(encoding="utf-8"))


def test_run_writes_a_complete_record(tmp_path):
    r = sp.Run("grpo-r3", label="GRPO round 3", gpus=[0, 1], runs_dir=tmp_path)
    r.progress(7, 10, unit="steps", status="Running")
    rec = rec_of(tmp_path)
    assert rec["version"] == 1 and rec["id"] == "grpo-r3" and rec["label"] == "GRPO round 3"
    assert (rec["done"], rec["total"], rec["unit"], rec["status"]) == (7, 10, "steps", "Running")
    assert rec["gpus"] == [0, 1] and rec["pid"] == os.getpid() and rec["cwd"] == os.getcwd()
    assert rec["finished"] is False and rec["startedAt"] <= rec["updatedAt"]


def test_update_keeps_earlier_fields_and_moves_updated_at(tmp_path):
    r = sp.Run("grpo-r3", label="GRPO round 3", gpus=[0, 1], runs_dir=tmp_path)
    first = rec_of(tmp_path)
    r.progress(5, 10)
    r.progress(6, 10)
    later = rec_of(tmp_path)
    assert later["label"] == "GRPO round 3" and later["gpus"] == [0, 1]
    assert later["startedAt"] == first["startedAt"]
    assert later["updatedAt"] >= first["updatedAt"]
    assert later["done"] == 6


def test_status_only_run_has_no_bar_fields(tmp_path):
    sp.Run("dllm-ar", runs_dir=tmp_path).status("Waiting for 2 GPUs")
    rec = rec_of(tmp_path, "dllm-ar")
    assert rec["status"] == "Waiting for 2 GPUs"
    assert "done" not in rec and "total" not in rec


def test_a_new_phase_replaces_the_counting_basis(tmp_path):
    r = sp.Run("grpo-r3", runs_dir=tmp_path)
    r.progress(1000, 1000, unit="steps", status="Running")
    r.progress(0, 50, unit="batches", status="Evaluating")
    rec = rec_of(tmp_path)
    assert (rec["done"], rec["total"], rec["unit"], rec["status"]) == (0, 50, "batches", "Evaluating")


def test_done_and_failed_set_finished(tmp_path):
    a = sp.Run("a", runs_dir=tmp_path)
    a.done()
    assert rec_of(tmp_path, "a")["finished"] is True
    assert rec_of(tmp_path, "a")["error"] is None
    b = sp.Run("b", runs_dir=tmp_path)
    b.failed("CUDA OOM on box3:1")
    rec = rec_of(tmp_path, "b")
    assert rec["finished"] is True and rec["error"] == "CUDA OOM on box3:1"


def test_clear_removes_the_record(tmp_path):
    r = sp.Run("a", runs_dir=tmp_path)
    assert r.path.exists()
    r.clear()
    assert not r.path.exists()
    r.clear()  # already gone: not an error


def test_write_is_atomic_leaving_no_tmp_file(tmp_path):
    sp.Run("a", runs_dir=tmp_path).progress(1, 2)
    assert [p.name for p in sorted(tmp_path.iterdir())] == ["a.json"]


@pytest.mark.parametrize("bad", ["a/b", "", "x" * 65, "a b", "a:b"])
def test_bad_id_is_rejected(tmp_path, bad):
    with pytest.raises(ValueError):
        sp.Run(bad, runs_dir=tmp_path)


def test_runs_dir_prefers_argument_then_env_then_default(tmp_path, monkeypatch):
    monkeypatch.setenv("SWITCHYARD_RUNS_DIR", str(tmp_path / "from-env"))
    assert sp.runs_dir(str(tmp_path / "given")) == tmp_path / "given"
    assert sp.runs_dir() == tmp_path / "from-env"
    monkeypatch.delenv("SWITCHYARD_RUNS_DIR")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert sp.runs_dir() == tmp_path / "home" / ".local" / "state" / "switchyard" / "runs"


def test_cli_creates_a_record_when_none_exists(tmp_path):
    assert sp.main(["--id", "a", "--runs-dir", str(tmp_path), "--status", "Running",
                    "--done", "7", "--total", "10"]) == 0
    rec = rec_of(tmp_path, "a")
    assert (rec["status"], rec["done"], rec["total"], rec["version"]) == ("Running", 7, 10, 1)


def test_cli_merges_over_an_existing_record(tmp_path):
    sp.main(["--id", "a", "--runs-dir", str(tmp_path), "--label", "L", "--gpus", "0,1",
             "--done", "1", "--total", "10"])
    first = rec_of(tmp_path, "a")
    sp.main(["--id", "a", "--runs-dir", str(tmp_path), "--done", "4"])
    rec = rec_of(tmp_path, "a")
    assert rec["label"] == "L" and rec["gpus"] == [0, 1] and rec["total"] == 10
    assert rec["startedAt"] == first["startedAt"] and rec["done"] == 4


def test_cli_writes_no_pid_unless_asked(tmp_path):
    sp.main(["--id", "a", "--runs-dir", str(tmp_path)])
    assert "pid" not in rec_of(tmp_path, "a")
    sp.main(["--id", "a", "--runs-dir", str(tmp_path), "--pid", "42"])
    assert rec_of(tmp_path, "a")["pid"] == 42


def test_cli_parses_gpu_list(tmp_path):
    sp.main(["--id", "a", "--runs-dir", str(tmp_path), "--gpus", "0,1,box2:7"])
    assert rec_of(tmp_path, "a")["gpus"] == [0, 1, "box2:7"]


def test_cli_finished_and_error_flags(tmp_path):
    sp.main(["--id", "a", "--runs-dir", str(tmp_path), "--finished", "--error", "boom"])
    rec = rec_of(tmp_path, "a")
    assert rec["finished"] is True and rec["error"] == "boom"


def test_cli_clear_removes_the_record(tmp_path):
    sp.main(["--id", "a", "--runs-dir", str(tmp_path)])
    assert sp.main(["--id", "a", "--runs-dir", str(tmp_path), "--clear"]) == 0
    assert not (tmp_path / "a.json").exists()


def test_cli_rejects_a_bad_id(tmp_path):
    with pytest.raises(ValueError):
        sp.main(["--id", "a/b", "--runs-dir", str(tmp_path)])


def test_a_failed_write_warns_but_does_not_kill_the_experiment(tmp_path, capsys, monkeypatch):
    """A progress report must never be what ends a 12-hour training run."""
    r = sp.Run("a", runs_dir=tmp_path)

    def boom(*args, **kwargs):
        raise OSError(122, "Disk quota exceeded")

    monkeypatch.setattr(sp, "write_record", boom)
    r.progress(1, 10)  # must not raise
    assert "Disk quota exceeded" in capsys.readouterr().err


def test_the_cli_starts_fresh_when_the_existing_record_is_corrupt(tmp_path, capsys):
    (tmp_path / "a.json").write_text("{truncated", encoding="utf-8")
    assert sp.main(["--id", "a", "--runs-dir", str(tmp_path), "--done", "3"]) == 0
    assert json.loads((tmp_path / "a.json").read_text())["done"] == 3
    assert "a.json" in capsys.readouterr().err
