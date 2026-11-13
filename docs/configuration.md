# Configuration

Switchyard reads `~/.config/switchyard/hosts.json` (or the file in `$SWITCHYARD_CONFIG`, or
`--config path`). Only `hosts` is required.

```json
{
  "hosts": [
    { "name": "gpu-a", "ssh": "gpu-a" },
    { "name": "gpu-b", "ssh": "gpu-b", "codex": "/home/you/.nvm/versions/node/v22.11.0/bin/codex",
      "runsDir": ["~/.local/state/switchyard/runs", "/scratch/you/runs"] },
    { "name": "laptop", "ssh": null }
  ],
  "port": 3456,
  "pollSeconds": 2
}
```

## Each host

| Key | Default | Meaning |
| --- | --- | --- |
| `name` | (required) | What the page shows. Letters, digits, `.`, `_`, `-`. |
| `ssh` | (required) | An alias from `~/.ssh/config`, or `null` for the machine the hub runs on. The connection must not prompt (use keys or an agent). |
| `claude`, `codex` | found automatically | Path to the binary on that host, if a login shell there can't find it. |
| `python` | `python3` | The Python on that host (3.8+). |
| `home` | the SSH user's home | Read another home directory (meant for tests: `claude agents` and tmux still report the SSH user's own sessions). |
| `runsDir` | `~/.local/state/switchyard/runs` | Where experiments on that host leave run records; a path or a list. See [runs-api.md](runs-api.md). |

## Global settings

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `3456` | The page's port, on 127.0.0.1 only. |
| `pollSeconds` | `2` | How often each server is read. |
| `reconnect` | `{"initialSeconds": 2, "maxSeconds": 60}` | Back-off when a server drops. |
| `ssh` | `{"serverAliveInterval": 15, "serverAliveCountMax": 3, "controlPersistSeconds": 60, "connectTimeoutSeconds": 45}` | SSH keep-alive and connection sharing. |
| `stateFile` | `~/.local/state/switchyard/dashboard.json` | Which sessions you removed or added on the page. |
| `statusLogFile` | `status-changes.jsonl` next to `stateFile` | Every status change seen, one JSON object per line. Never trimmed. |
| `stepLogFile` | `task-history.jsonl` next to `stateFile` | Every task ever seen in a session. |
| `notesFile` | `notes.json` next to `stateFile` | Your notes about sessions. Stays on this machine. |

## Keeping the hub running

`npm start` dies with its terminal. To keep it up:

**macOS.** Copy [`packaging/com.switchyard.hub.plist`](../packaging/com.switchyard.hub.plist) to
`~/Library/LaunchAgents/`, replace `YOU` and the `node` path, then:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.switchyard.hub.plist
```

It starts at login and restarts if it exits. A LaunchAgent does not inherit your terminal's
`ssh-agent`, so a passphrase-protected key leaves every server offline; the plist's comment says
how to deal with that.

**Linux (systemd).** Copy [`packaging/switchyard.service`](../packaging/switchyard.service) to
`~/.config/systemd/user/`, set `WorkingDirectory` to your clone and `ExecStart` to your own `node`
(the unit doesn't read your shell profile, so an nvm `node` isn't on its PATH; the unit's comment
has `sed` lines for both), then:

```bash
loginctl enable-linger "$USER"      # keep it running when you're logged out
systemctl --user daemon-reload
systemctl --user enable --now switchyard
journalctl --user -u switchyard -f
```

A systemd user unit doesn't get your login session's `ssh-agent` either: use keys without a
passphrase for these servers, or point `SSH_AUTH_SOCK` at a user-level agent (the unit has the line
to uncomment).

Either way the hub listens only on 127.0.0.1. To read a hub that runs on a server, forward the
port: `ssh -L 3456:127.0.0.1:3456 <that server>`.

## Running the hub on a server instead

Nothing stops you running the hub on one of your servers (list it with `"ssh": null`, the others
by alias) and forwarding the port to your laptop. The terminal view needs no hub at all: on any
machine, `switchyard` with no `hosts.json` shows that machine's sessions and runs.
