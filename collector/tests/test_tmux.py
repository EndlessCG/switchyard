import os
import shutil
import subprocess

import pytest

import collector as c


def test_pane_for_pid_walks_up_parents():
    parents = {50: 40, 40: 30, 30: 1}
    assert c.pane_for_pid(50, {30: "dri:2.1"}, parents.get) == "dri:2.1"
    assert c.pane_for_pid(50, {}, parents.get) is None


def test_pane_for_pid_survives_cycles():
    assert c.pane_for_pid(5, {}, {5: 6, 6: 5}.get) is None


def test_parent_pid_of_this_process():
    assert c.parent_pid(os.getpid()) == os.getppid()


def test_parent_pid_of_missing_process_is_none():
    assert c.parent_pid(2 ** 22 + 12345) is None


def test_no_tmux_server_means_no_panes():
    assert c.tmux_pane_pids("switchyard-test-absent") == {}


@pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux not installed")
def test_real_tmux_pane_lookup():
    sock = "switchyard-test"
    # -f /dev/null: ignore ~/.tmux.conf (the user's base-index 1 would change the target)
    subprocess.run(["tmux", "-L", sock, "-f", "/dev/null", "new-session", "-d", "-s", "sy", "sleep 60"],
                   check=True)
    try:
        panes = c.tmux_pane_pids(sock)
        assert list(panes.values()) == ["sy:0.0"]
        (pane_pid,) = panes
        assert c.pane_for_pid(pane_pid, panes) == "sy:0.0"
    finally:
        subprocess.run(["tmux", "-L", sock, "kill-server"], check=False)
