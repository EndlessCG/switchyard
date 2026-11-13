# Teach your agents

Switchyard shows what agents already write down: a session's task list becomes its metro line,
and an experiment's run record becomes its progress bar. Agents don't always do either unasked.
Paste these rules into your global instructions and they will:

- **Claude Code:** `~/.claude/CLAUDE.md`
- **Codex:** `~/.codex/AGENTS.md`

Edit the wording freely; Switchyard only reads the results.

## For Claude Code (`~/.claude/CLAUDE.md`)

```markdown
## Keep a task list for multi-step work
For any request with 3 or more distinct steps, create the full task list up front with
TaskCreate (short imperative subjects). Link dependent steps with TaskUpdate `addBlockedBy`.
Mark a task `in_progress` when you start it and `completed` only when it is actually done, and
add new tasks as you discover them. Keep the list current for the whole session: every new
request, launched run, and promised follow-up gets its own task.

## Report run progress
Whenever you launch an experiment or any long job, make it report its own progress with
`switchyard_progress` (stdlib only; copy `clients/switchyard_progress.py` from Switchyard):
- `Run(id, label=..., gpus=[...])` as the job starts, `run.progress(done, total, unit=...)` in
  the loop, `run.done()` or `run.failed(err)` at the end.
- The status string is yours ("Waiting for 4 GPUs", "Training", "Evaluating"); report each phase
  change as a new `total` and status, and report while still waiting for resources.
- From a shell script: `python3 switchyard_progress.py --id ID --done N --total M --pid $$`.
```

## For Codex (`~/.codex/AGENTS.md`)

```markdown
## Keep a plan for multi-step work
For any request with 3 or more distinct steps, call `update_plan` with the full list of steps up
front, keep exactly one step `in_progress`, and mark steps `completed` only when they're done.
Update the plan when steps are added or change.

## Report run progress
Whenever you launch an experiment or any long job, make it report its own progress with
`switchyard_progress` (stdlib only): `Run(id, label=..., gpus=[...])` at the start,
`run.progress(done, total, unit=...)` in the loop, `run.done()` or `run.failed(err)` at the end.
From a shell script: `python3 switchyard_progress.py --id ID --done N --total M --pid $$`.
```

## Where run records go

By default `~/.local/state/switchyard/runs/<id>.json` on the machine the job runs on, which is
where Switchyard looks. If a job writes elsewhere (`$SWITCHYARD_RUNS_DIR` or `runs_dir=`), add
that folder to the host's `runsDir` in `hosts.json`. Details in [runs-api.md](runs-api.md).
