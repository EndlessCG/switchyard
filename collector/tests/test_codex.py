import collector as c
from helpers import append_rollout, event, plan_call


def test_latest_plan_and_lifecycle_win(tmp_path):
    r = append_rollout(tmp_path / "r.jsonl",
                       plan_call(("a", "in_progress"), ("b", "pending")),
                       event("task_started", "t1"),
                       plan_call(("a", "completed"), ("b", "in_progress")),
                       {"type": "event_msg", "payload": {"type": "token_count"}})
    info = c.RolloutReader().read(str(r), c.Errors())
    assert [(s["id"], s["title"], s["status"]) for s in info["plan"]] == [("1", "a", "done"), ("2", "b", "current")]
    assert info["life"] == ("task_started", "t1")


def test_reads_only_appended_complete_lines(tmp_path):
    r = append_rollout(tmp_path / "r.jsonl", event("task_started", "t1"), partial='{"type": "event_msg", "pay')
    reader = c.RolloutReader()
    assert reader.read(str(r), c.Errors())["life"] == ("task_started", "t1")
    # finish the partial line, then append a completion
    with open(r, "a", encoding="utf-8") as f:
        f.write('load": {"type": "task_complete", "turn_id": "t1"}}\n')
    append_rollout(r, plan_call(("确认 Qwen3-8B 服务", "completed")))
    info = reader.read(str(r), c.Errors())
    assert info["life"] == ("task_complete", "t1")
    assert info["plan"][0]["title"] == "确认 Qwen3-8B 服务"


def test_file_that_shrank_is_rescanned(tmp_path):
    r = append_rollout(tmp_path / "r.jsonl", event("task_started", "t1"), event("task_complete", "t1"))
    reader = c.RolloutReader()
    reader.read(str(r), c.Errors())
    r.write_text("")
    append_rollout(r, event("turn_aborted", "t2"))
    assert reader.read(str(r), c.Errors())["life"] == ("turn_aborted", "t2")


def test_invalid_utf8_line_counts_as_unreadable(tmp_path):
    r = tmp_path / "r.jsonl"
    with open(r, "ab") as f:
        f.write(b'{"type":"event_msg","payload":{"type":"task_started","turn_id":"\xff"}}\n')
    append_rollout(r, event("task_complete", "t1"))
    errs = c.Errors()
    info = c.RolloutReader().read(str(r), errs)
    assert info["life"] == ("task_complete", "t1")
    assert "1 unreadable line(s)" in errs.as_list()[0]["message"]


def test_unreadable_lines_stay_reported(tmp_path):
    r = append_rollout(tmp_path / "r.jsonl", event("task_started", "t1"))
    with open(r, "a", encoding="utf-8") as f:
        f.write('{"task_complete" broken\n')
    reader = c.RolloutReader()
    for _ in range(2):  # reported on every poll, not only the poll that read the line
        errs = c.Errors()
        reader.read(str(r), errs)
        assert "1 unreadable line(s)" in errs.as_list()[0]["message"]


def test_plan_with_unknown_status_is_reported_not_half_shown(tmp_path):
    r = append_rollout(tmp_path / "r.jsonl", plan_call(("a", "completed"), ("b", "blocked")))
    errs = c.Errors()
    assert c.RolloutReader().read(str(r), errs)["plan"] is None
    assert "unreadable line(s)" in errs.as_list()[0]["message"]


def test_missing_rollout_is_reported(tmp_path):
    errs = c.Errors()
    info = c.RolloutReader().read(str(tmp_path / "gone.jsonl"), errs)
    assert info == {"plan": None, "life": None}
    assert "missing" in errs.as_list()[0]["message"]


def test_line_whose_payload_is_not_an_object_counts_as_unreadable(tmp_path):
    r = append_rollout(tmp_path / "r.jsonl", {"type": "event_msg", "payload": "task_started"},
                       event("task_complete", "t1"))
    errs = c.Errors()
    info = c.RolloutReader().read(str(r), errs)
    assert info["life"] == ("task_complete", "t1")
    assert "1 unreadable line(s)" in errs.as_list()[0]["message"]


from helpers import make_codex


def sessions(home):
    errs = c.Errors()
    return c.codex_sessions(home, c.RolloutReader(), errs), errs.as_list()


def test_newest_db_picks_highest_schema_version(tmp_path):
    (tmp_path / "state_4.sqlite").write_text("")
    (tmp_path / "state_5.sqlite").write_text("")
    (tmp_path / "state_x.sqlite").write_text("")
    assert c.newest_db(tmp_path, "state_*.sqlite").name == "state_5.sqlite"
    assert c.newest_db(tmp_path, "goals_*.sqlite") is None


def test_no_codex_home_means_no_sessions_and_no_errors(tmp_path):
    assert sessions(tmp_path) == ({}, [])


def test_failed_turn_record_wins_over_rollout_event(tmp_path):
    r = append_rollout(tmp_path / "a.jsonl", plan_call(("x", "in_progress")), event("task_started", "t9"))
    make_codex(tmp_path,
               threads=[{"id": "A", "rollout_path": str(r), "title": "change sft config", "source": "vscode",
                         "git_branch": "main", "updated_at_ms": 5}],
               turns=[{"thread_id": "A", "turn_id": "t9", "rollout_ordinal": 3, "status": "failed",
                       "error_json": '{"message": "sandbox denied"}'}],
               goals=[("A", "Ship the SFT run")])
    out, errs = sessions(tmp_path)
    s = out["codex:A"]
    assert s["state"] == "error" and s["error"] == "sandbox denied"
    assert s["name"] == "change sft config" and s["kind"] == "vscode" and s["gitBranch"] == "main"
    assert s["goal"] == "Ship the SFT run" and s["stepsSource"] == "codex-update_plan"
    assert s["pid"] is None and s["tmuxPane"] is None and s["updatedAt"] == 5
    assert errs == []


def test_rollout_event_decides_when_no_turn_record(tmp_path):
    r = append_rollout(tmp_path / "a.jsonl", event("task_started", "t1"))
    make_codex(tmp_path, threads=[{"id": "A", "rollout_path": str(r), "name": "named"}])
    out, _ = sessions(tmp_path)
    assert out["codex:A"]["state"] == "working" and out["codex:A"]["name"] == "named"


def test_latest_turn_record_decides_without_rollout_events(tmp_path):
    r = append_rollout(tmp_path / "a.jsonl", plan_call(("x", "completed")))
    make_codex(tmp_path, threads=[{"id": "A", "rollout_path": str(r)}],
               turns=[{"thread_id": "A", "turn_id": "t1", "rollout_ordinal": 1, "status": "completed"},
                      {"thread_id": "A", "turn_id": "t2", "rollout_ordinal": 2, "status": "interrupted"}])
    out, _ = sessions(tmp_path)
    assert out["codex:A"]["state"] == "stopped"


def test_idle_thread_state_comes_from_its_plan(tmp_path):
    done = append_rollout(tmp_path / "d.jsonl", plan_call(("x", "completed")))
    open_ = append_rollout(tmp_path / "o.jsonl", plan_call(("x", "completed"), ("y", "pending")))
    make_codex(tmp_path, threads=[{"id": "D", "rollout_path": str(done)},
                                  {"id": "O", "rollout_path": str(open_)},
                                  {"id": "N", "rollout_path": None},
                                  {"id": "Z", "archived": 1}])
    out, _ = sessions(tmp_path)
    assert out["codex:D"]["state"] == "done"
    assert out["codex:O"]["state"] == "waiting"
    assert out["codex:N"]["state"] == "idle" and out["codex:N"]["steps"] == []
    assert "codex:Z" not in out


def test_unknown_turn_status_is_an_error(tmp_path):
    make_codex(tmp_path, threads=[{"id": "A"}],
               turns=[{"thread_id": "A", "turn_id": "t1", "rollout_ordinal": 1, "status": "paused"}])
    out, errs = sessions(tmp_path)
    assert out["codex:A"]["state"] == "error"
    assert "unknown turn status 'paused'" in errs[0]["message"]


def test_schema_change_is_reported_by_column_name(tmp_path):
    make_codex(tmp_path, threads=[{"id": "A"}], drop_columns=("source",))
    out, errs = sessions(tmp_path)
    assert out == {}
    assert errs[0]["source"] == "codex.state_db" and "source" in errs[0]["message"]


def test_codex_folder_without_state_db_is_reported(tmp_path):
    (tmp_path / ".codex").mkdir()
    out, errs = sessions(tmp_path)
    assert out == {}
    assert errs[0]["source"] == "codex.state_db" and "no state_*.sqlite found" in errs[0]["message"]


def test_without_history_db_the_rollout_event_decides(tmp_path):
    r = append_rollout(tmp_path / "a.jsonl", event("task_started", "t1"))
    make_codex(tmp_path, threads=[{"id": "A", "rollout_path": str(r)}], history=False)
    out, errs = sessions(tmp_path)
    assert out["codex:A"]["state"] == "working"
    assert errs == []


def test_without_goals_db_goal_is_none(tmp_path):
    make_codex(tmp_path, threads=[{"id": "A"}], goals_db=False)
    out, errs = sessions(tmp_path)
    assert out["codex:A"]["goal"] is None
    assert errs == []
