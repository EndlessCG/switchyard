# Reporting a run's progress

Switchyard shows every **run** on every configured server as a progress bar, with the GPUs it is
using, its status, and an ETA. A run is whatever you want it to be — a training job, a sweep, an
eval pass — and it reports its own progress from inside its own code.

The point is that nobody has to ask an agent how far along something is. If your experiment
reports, the dashboard answers.

## How it works

The experiment writes one small JSON file per run, on the machine the experiment runs on:

```
~/.local/state/switchyard/runs/<run-id>.json
```

Switchyard's collector reads those files on each poll, like it reads Claude's task folders.
Nothing is installed, no port is opened, and **Switchyard never writes in that directory**: it
will not delete your record when the run ends, and cleaning up is yours to do (or not).

## Two different settings, and the mistake they cause

| Who | Setting | Meaning |
|---|---|---|
| The experiment (the writer) | `$SWITCHYARD_RUNS_DIR` | where to put records |
| Switchyard (the reader) | `runsDir` in `~/.config/switchyard/hosts.json` | where to look for them |

The collector runs over SSH in a non-interactive shell, so it never sees the environment your
experiment ran in. **If you set `$SWITCHYARD_RUNS_DIR` and change nothing else, your run will not
appear on the dashboard.** Either leave the default alone, or add the directory to that host's
entry in `hosts.json`:

```json
{ "name": "box3", "ssh": "box3", "runsDir": "/scratch/you/runs" }
```

`runsDir` also takes a list, when records land in more than one place.

## The record

```json
{
  "version": 1,
  "id": "grpo-r3",
  "label": "GRPO 7B · round 3",
  "status": "Running",
  "done": 680,
  "total": 1000,
  "unit": "steps",
  "gpus": [0, 1, 4, 7],
  "pid": 418221,
  "session": "claude:4f1c…",
  "cwd": "/home/alice/rl-lab",
  "startedAt": 1792012345678,
  "updatedAt": 1792012999000,
  "finished": false,
  "error": null
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | `1`. Any other value is reported as an error and the record is ignored. |
| `id` | yes | Stable identity, and the file name. Must match `[A-Za-z0-9._-]{1,64}`. |
| `label` | no | What the dashboard calls the run. Defaults to the id. |
| `status` | no | **Your own wording.** Switchyard prints it and never interprets it. |
| `done`, `total` | no | Progress in whatever you are counting now. Leave both out for a run that has no bar yet — "Waiting for 4 GPUs" is a perfectly good row. |
| `unit` | no | What you are counting: `steps`, `samples`, `epochs`. |
| `gpus` | no | `0` or `"0"` means a GPU on this host; `"box2:7"` names one on another host, for work this run launched there. |
| `pid` | no | The process to watch. With it, the dashboard can say "no longer running" when that process is gone; without it, liveness is simply unknown. |
| `session` | no | The agent session that owns the run (`claude:<id>` / `codex:<id>`), if you know it. |
| `cwd` | no | Where the run lives. |
| `startedAt`, `updatedAt` | no | Epoch ms. |
| `finished` | no | `true` when it is over, however it ended. **This is how Switchyard knows a run is done — never the status string**, because the status vocabulary is yours. |
| `error` | no | Why it ended badly. Shown prominently. |
| `eta` | no | Seconds remaining, if you know better than a measured rate. Overrides Switchyard's own estimate and is labelled "reported". |
| `note` | no | One short line of your choosing. |

A record is the **whole** state of the run, not a patch: whatever writes it must include the
fields it wants kept. The helper below does that for you.

## Reporting from Python

Copy `clients/switchyard_progress.py` next to your experiment (it is standard library only,
Python 3.8+), or import it from this repo:

```python
from switchyard_progress import Run

run = Run("grpo-r3", label="GRPO 7B · round 3", gpus=[0, 1, 4, 7])
run.status("Waiting for 4 GPUs")        # on the dashboard already, with no bar
...
run.status("Running")
for step in range(1000):
    train(step)
    run.progress(step + 1, 1000, unit="steps")

run.progress(0, 50, unit="batches", status="Evaluating")   # a new phase: new total, new status
for i, batch in enumerate(eval_batches, 1):
    evaluate(batch)
    run.progress(i, 50)

run.done()                              # or: run.failed("CUDA OOM on box3:1")
```

`Run` fills in `pid`, `cwd`, `startedAt`/`updatedAt` itself, and `session` from
`$CLAUDE_SESSION_ID` / `$CODEX_THREAD_ID` when the agent exports one. `run.update(**fields)` sets
anything else (`note=`, `eta=`, `gpus=`), and `run.clear()` deletes the record.

**Phases:** one bar, and the status says which phase it is in. When a phase ends, report a new
`total` and a new status, as above. Switchyard notices the changed total and starts measuring the
new phase from scratch, so an eval pass is never extrapolated from training throughput.

**One run id, one writer.** Under `torchrun --nproc_per_node=8` (or any multi-process launcher)
every rank would write the same file: atomically, so nothing corrupts, but `pid` and `startedAt`
would flip between ranks and `done` could go backwards, which resets the measured ETA. Report
from rank 0 only:

```python
run = Run("grpo-r3", ...) if rank == 0 else None
...
if run: run.progress(step + 1, 1000, unit="steps")
```

**A failed report never fails your job.** If the disk is full or the quota is gone, the helper
prints one `switchyard_progress: could not write …` line to stderr and carries on — you lose the
bar, not the run. The CLI exits 0 for the same reason, since it is usually called from a loop
under `set -e`.

## Reporting from a shell

```bash
export RUN=sweep-7
python3 clients/switchyard_progress.py --id $RUN --label "LR sweep" --gpus 0,1 --pid $$ \
  --status "Running" --done 0 --total 3
for lr in 1e-5 3e-5 1e-4; do
  ./train.sh "$lr"
  python3 clients/switchyard_progress.py --id $RUN --done $((++n))
done
python3 clients/switchyard_progress.py --id $RUN --finished --status "Done"
```

The CLI **merges** over the record already on disk, so later calls need only what changed —
`--label`, `--gpus` and `startedAt` survive. Pass `--pid $$` (the driving shell) if you want
liveness: the CLI process itself exits immediately, so it records no pid of its own.

## Reporting from anything else

The format is the contract, so a few lines are a complete implementation:

```python
import json, os, time
rec = {"version": 1, "id": "grpo-r3", "status": "Running", "done": 680, "total": 1000,
       "gpus": [0, 1], "pid": os.getpid(), "finished": False,
       "updatedAt": int(time.time() * 1000)}
path = os.path.expanduser("~/.local/state/switchyard/runs/grpo-r3.json")
os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(rec, f)
os.replace(tmp, path)   # atomic: a reader never sees half a record
```

Three rules if you write it yourself: **write the whole record every time**, **replace
atomically** (write a temp file in the same directory, then `os.replace`), and **only record a
`pid` that will still be alive** — `os.getpid()` is right for a long-running process, and wrong
for a script that is re-invoked per iteration, where it would make every row read "no longer
running". A `pid` that is not a plain positive integer is reported as an error and ignored.

## What Switchyard does with it

- **Measures the ETA itself**, from how fast `done` actually moves — and shows the rate beside
  it, so you can sanity-check the arithmetic. No rate yet, or nothing advancing: it says
  `measuring…` and how long since the run last advanced, instead of inventing a number.
- **Says when nothing is advancing.** The row carries "no change for 14m" from the last time
  `done` moved — not from the last time the file was written, so a loop that keeps writing while
  stuck cannot look fresh.
- **Never checks what you claim.** If the record says `box2 GPU 0,1,7`, the page says so; nothing
  runs `nvidia-smi` to verify it.
- **Never interprets your status**, and never deletes your record.
