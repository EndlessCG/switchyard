"""Tests for the collector's `--conversation` mode."""
import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import collector as c
from helpers import make_codex

COLLECTOR = Path(__file__).resolve().parent.parent / "collector.py"


# ── claude_items ─────────────────────────────────────────────────────────────

def test_claude_string_user_message():
    line = {"type": "user", "timestamp": "t1", "isSidechain": False,
            "message": {"role": "user", "content": "hello there"}}
    assert c.claude_items(line, 5) == [
        {"n": 5, "role": "user", "kind": "text", "text": "hello there",
         "tool": None, "callId": None, "isError": False, "ts": "t1"},
    ]


def test_claude_user_text_block():
    line = {"type": "user", "timestamp": "t2",
            "message": {"role": "user", "content": [{"type": "text", "text": "a block"}]}}
    got = c.claude_items(line, 1)
    assert got == [
        {"n": 1, "role": "user", "kind": "text", "text": "a block",
         "tool": None, "callId": None, "isError": False, "ts": "t2"},
    ]


def test_claude_assistant_text_block():
    line = {"type": "assistant", "timestamp": "t3",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "hi!"}]}}
    got = c.claude_items(line, 2)
    assert got == [
        {"n": 2, "role": "assistant", "kind": "text", "text": "hi!",
         "tool": None, "callId": None, "isError": False, "ts": "t3"},
    ]


def test_claude_thinking_is_dropped():
    line = {"type": "assistant", "timestamp": "t4",
            "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "hmm"}]}}
    assert c.claude_items(line, 3) == []


def test_claude_tool_use_becomes_tool_call_with_input_as_json_text():
    line = {"type": "assistant", "timestamp": "t5", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "call-1", "name": "Bash", "input": {"command": "ls -la"}},
    ]}}
    got = c.claude_items(line, 4)
    assert got == [
        {"n": 4, "role": "tool", "kind": "tool_call", "text": json.dumps({"command": "ls -la"}, ensure_ascii=False),
         "tool": "Bash", "callId": "call-1", "isError": False, "ts": "t5"},
    ]


def test_claude_tool_result_with_string_content():
    line = {"type": "user", "timestamp": "t6", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "call-1", "content": "the output", "is_error": False},
    ]}}
    got = c.claude_items(line, 6)
    assert got == [
        {"n": 6, "role": "tool", "kind": "tool_result", "text": "the output",
         "tool": None, "callId": "call-1", "isError": False, "ts": "t6"},
    ]


def test_claude_tool_result_with_list_content_including_an_image_block():
    line = {"type": "user", "timestamp": "t7", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "call-2", "is_error": False, "content": [
            {"type": "text", "text": "see below"},
            {"type": "image", "source": {"type": "base64", "data": "..."}},
        ]},
    ]}}
    got = c.claude_items(line, 7)
    assert len(got) == 1
    assert got[0]["callId"] == "call-2"
    assert "see below" in got[0]["text"]
    assert "[image]" in got[0]["text"]


def test_claude_tool_result_is_error_true():
    line = {"type": "user", "timestamp": "t8", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "call-3", "content": "boom", "is_error": True},
    ]}}
    got = c.claude_items(line, 8)
    assert got[0]["isError"] is True


def test_claude_isSidechain_line_is_skipped():
    line = {"type": "user", "timestamp": "t9", "isSidechain": True,
            "message": {"role": "user", "content": "from a subagent"}}
    assert c.claude_items(line, 9) == []


def test_claude_attachment_and_ai_title_lines_are_skipped():
    assert c.claude_items({"type": "attachment", "timestamp": "t10"}, 10) == []
    assert c.claude_items({"type": "ai-title", "timestamp": "t11"}, 11) == []


# ── codex_items ──────────────────────────────────────────────────────────────

def test_codex_event_user_message():
    line = {"timestamp": "ct1", "type": "event_msg", "payload": {"type": "user_message", "message": "do the thing"}}
    got = c.codex_items(line, 1)
    assert got == [
        {"n": 1, "role": "user", "kind": "text", "text": "do the thing",
         "tool": None, "callId": None, "isError": False, "ts": "ct1"},
    ]


def test_codex_item_completed_user_message():
    # The newer rollout schema: the user's turn is an item_completed event, not user_message.
    line = {"timestamp": "ct1b", "type": "event_msg", "payload": {
        "type": "item_completed", "thread_id": "th", "turn_id": "tu",
        "item": {"type": "UserMessage", "id": "u1",
                 "content": [{"type": "text", "text": "examine gpu 3 and 7", "text_elements": []}]},
    }}
    got = c.codex_items(line, 1)
    assert got == [
        {"n": 1, "role": "user", "kind": "text", "text": "examine gpu 3 and 7",
         "tool": None, "callId": None, "isError": False, "ts": "ct1b"},
    ]


def test_codex_item_completed_other_items_are_dropped():
    for item in ({"type": "AgentMessage", "id": "m1", "content": [{"type": "Text", "text": "dup"}]},
                 {"type": "CommandExecution", "id": "e1", "command": ["ls"]},
                 {"type": "Reasoning", "id": "r1", "summary_text": []}):
        line = {"timestamp": "ct1c", "type": "event_msg", "payload": {"type": "item_completed", "item": item}}
        assert c.codex_items(line, 1) == []


def test_codex_response_item_assistant_output_text():
    line = {"timestamp": "ct2", "type": "response_item", "payload": {
        "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "here you go"}],
    }}
    got = c.codex_items(line, 2)
    assert got == [
        {"n": 2, "role": "assistant", "kind": "text", "text": "here you go",
         "tool": None, "callId": None, "isError": False, "ts": "ct2"},
    ]


def test_codex_response_item_user_message_is_not_rendered():
    line = {"timestamp": "ct3", "type": "response_item", "payload": {
        "type": "message", "role": "user", "content": [{"type": "input_text", "text": "<env>...</env>"}],
    }}
    assert c.codex_items(line, 3) == []


def test_codex_function_call_and_its_output_unwraps_json_output_string():
    call = {"timestamp": "ct4", "type": "response_item", "payload": {
        "type": "function_call", "name": "shell", "call_id": "call-9", "arguments": '{"cmd": "ls"}',
    }}
    got = c.codex_items(call, 4)
    assert got == [
        {"n": 4, "role": "tool", "kind": "tool_call", "text": '{"cmd": "ls"}',
         "tool": "shell", "callId": "call-9", "isError": False, "ts": "ct4"},
    ]
    out = {"timestamp": "ct5", "type": "response_item", "payload": {
        "type": "function_call_output", "call_id": "call-9", "output": json.dumps({"output": "file1\nfile2"}),
    }}
    got2 = c.codex_items(out, 5)
    assert got2 == [
        {"n": 5, "role": "tool", "kind": "tool_result", "text": "file1\nfile2",
         "tool": None, "callId": "call-9", "isError": False, "ts": "ct5"},
    ]


def test_codex_function_call_output_with_a_plain_non_json_string_shows_it_raw():
    out = {"timestamp": "ct6", "type": "response_item", "payload": {
        "type": "function_call_output", "call_id": "call-8", "output": "just plain text",
    }}
    got = c.codex_items(out, 6)
    assert got[0]["text"] == "just plain text"


def test_codex_custom_tool_call_and_its_output():
    call = {"timestamp": "ct7", "type": "response_item", "payload": {
        "type": "custom_tool_call", "name": "apply_patch", "call_id": "call-7", "input": "*** Begin Patch",
    }}
    got = c.codex_items(call, 7)
    assert got == [
        {"n": 7, "role": "tool", "kind": "tool_call", "text": "*** Begin Patch",
         "tool": "apply_patch", "callId": "call-7", "isError": False, "ts": "ct7"},
    ]
    out = {"timestamp": "ct8", "type": "response_item", "payload": {
        "type": "custom_tool_call_output", "call_id": "call-7", "output": "patch applied",
    }}
    got2 = c.codex_items(out, 8)
    assert got2 == [
        {"n": 8, "role": "tool", "kind": "tool_result", "text": "patch applied",
         "tool": None, "callId": "call-7", "isError": False, "ts": "ct8"},
    ]


def test_codex_reasoning_and_agent_message_are_dropped():
    reasoning = {"timestamp": "ct9", "type": "response_item", "payload": {"type": "reasoning", "summary": []}}
    agent_message = {"timestamp": "ct10", "type": "event_msg", "payload": {"type": "agent_message", "message": "dup"}}
    assert c.codex_items(reasoning, 9) == []
    assert c.codex_items(agent_message, 10) == []


# ── end to end, as a subprocess (mirrors test_stream.py's _start/_read_until) ─

def _start(tmp_path, *extra):
    args = [sys.executable, "-", "--conversation", *extra, "--home", str(tmp_path), "--poll", "0.2"]
    p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    p.stdin.write(COLLECTOR.read_text(encoding="utf-8"))
    p.stdin.close()
    # A dedicated thread blocks on line iteration and hands lines to the test thread through a
    # queue. select()-then-readline() on the raw fd is unsafe here: a text-mode readline() can
    # pull several already-flushed lines out of the OS pipe in one raw read (they're small and
    # arrive back-to-back), leaving later lines sitting unnoticed in Python's own buffer while
    # select() reports no *new* OS-level bytes to read.
    q: "queue.Queue" = queue.Queue()

    def pump():
        for line in p.stdout:
            q.put(line)
        q.put(None)  # EOF

    threading.Thread(target=pump, daemon=True).start()
    p.lines = q
    return p


def _read_until(p, pred, deadline_s=10):
    got, end = [], time.time() + deadline_s
    while time.time() < end:
        try:
            line = p.lines.get(timeout=0.2)
        except queue.Empty:
            continue
        if line is None:
            break
        got.append(json.loads(line))
        if pred(got[-1]):
            return got
    raise AssertionError(f"condition not met; got {got}; stderr: {p.stderr.read() if p.poll() is not None else ''}")


def _write_claude_transcript(tmp_path, session_id, lines):
    d = tmp_path / ".claude" / "projects" / "-home-u-proj"
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{session_id}.jsonl"
    with open(f, "w", encoding="utf-8") as fh:
        for line in lines:
            fh.write(json.dumps(line) + "\n")
    return f


def _user_line(text, ts="t"):
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": text}}


def _assistant_line(text, ts="t"):
    return {"type": "assistant", "timestamp": ts, "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def test_e2e_claude_conversation_sends_hello_items_then_synced(tmp_path):
    _write_claude_transcript(tmp_path, "s-1", [_user_line("hi"), _assistant_line("hello")])
    p = _start(tmp_path, "claude:s-1")
    try:
        got = _read_until(p, lambda m: m["type"] == "conv-synced")
        assert got[0] == {"type": "conv-hello", "protocol": 2, "agent": "claude", "key": "claude:s-1",
                          "path": str(tmp_path / ".claude" / "projects" / "-home-u-proj" / "s-1.jsonl")}
        item_msgs = [m for m in got if m["type"] == "items"]
        assert len(item_msgs) == 2
        assert item_msgs[0]["items"][0]["text"] == "hi"
        assert item_msgs[1]["items"][0]["text"] == "hello"
        assert got[-1] == {"type": "conv-synced"}
    finally:
        p.stdin  # no-op; stdin already closed
        if p.poll() is None:
            p.kill()
            p.wait()


def test_e2e_appending_two_lines_sends_exactly_their_items(tmp_path):
    f = _write_claude_transcript(tmp_path, "s-2", [_user_line("first")])
    p = _start(tmp_path, "claude:s-2")
    try:
        _read_until(p, lambda m: m["type"] == "conv-synced")
        with open(f, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(_assistant_line("second")) + "\n")
            fh.write(json.dumps(_user_line("third")) + "\n")
        got = _read_until(p, lambda m: m["type"] == "items" and m["items"][0]["text"] == "third")
        item_msgs = [m for m in got if m["type"] == "items"]
        assert [m["items"][0]["text"] for m in item_msgs] == ["second", "third"]
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()


def test_e2e_truncating_the_file_sends_conv_reset_and_a_resend(tmp_path):
    f = _write_claude_transcript(tmp_path, "s-3", [_user_line("one"), _assistant_line("two")])
    p = _start(tmp_path, "claude:s-3")
    try:
        _read_until(p, lambda m: m["type"] == "conv-synced")
        with open(f, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(_user_line("replaced")) + "\n")
        # Wait for a conv-reset, then the resend's own conv-synced.
        got = _read_until(p, lambda m: m["type"] == "conv-reset")
        assert got[-1] == {"type": "conv-reset"}
        got2 = _read_until(p, lambda m: m["type"] == "conv-synced")
        item_msgs = [m for m in got2 if m["type"] == "items"]
        assert len(item_msgs) == 1
        assert item_msgs[0]["items"][0]["text"] == "replaced"
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()


def test_e2e_unknown_session_gives_conv_error_and_exits_1(tmp_path):
    p = _start(tmp_path, "claude:does-not-exist")
    got = _read_until(p, lambda m: m["type"] == "conv-error")
    assert p.wait(timeout=20) == 1
    assert len(got) == 1
    assert "does-not-exist" in got[0]["message"]


def test_e2e_codex_thread_resolves_through_the_state_database(tmp_path):
    rollout = tmp_path / "rollout.jsonl"
    with open(rollout, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"timestamp": "t1", "type": "event_msg",
                             "payload": {"type": "user_message", "message": "codex hi"}}) + "\n")
    make_codex(tmp_path, threads=[{"id": "th-1", "rollout_path": str(rollout)}])
    p = _start(tmp_path, "codex:th-1")
    try:
        got = _read_until(p, lambda m: m["type"] == "conv-synced")
        assert got[0]["type"] == "conv-hello" and got[0]["agent"] == "codex" and got[0]["path"] == str(rollout)
        item_msgs = [m for m in got if m["type"] == "items"]
        assert item_msgs[0]["items"][0]["text"] == "codex hi"
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()


def test_e2e_an_unreadable_line_gives_conv_warn(tmp_path):
    d = tmp_path / ".claude" / "projects" / "-home-u-proj"
    d.mkdir(parents=True, exist_ok=True)
    f = d / "s-4.jsonl"
    with open(f, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(_user_line("ok")) + "\n")
        fh.write("{not json\n")
    p = _start(tmp_path, "claude:s-4")
    try:
        got = _read_until(p, lambda m: m["type"] == "conv-warn")
        assert "1 unreadable line" in got[-1]["message"]
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()
