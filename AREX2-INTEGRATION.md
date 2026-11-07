# AREX-2 integration into pi (score boundary + T*)

Date: 2026-11-07. Status: source complete + tested; binary build in progress.

## Context

AREX-2 (BAAI, arXiv 2609.38288) is a 27B agent finetune of Qwen3.8-27B whose
core claim is that test-time self-improvement — `gain ≈ r̄·T*` (reflection ×
productive rounds) — is a learnable meta-skill that lives in the weights, not
the harness. It is now the box's served model on :8045 (see asgard-vllm skill
"AREX-2 27B INT8" section).

The architectural consequence for pi: the harness should stop *driving* the
iteration loop from prompts and start *measuring* it. This change adds the two
missing primitives — a first-class score signal and a T* metric — to pi core.

## What was built

### 1. `score` tool (harness side of the score boundary)
- `packages/coding-agent/src/core/tools/score.ts`
- Runs a verifiable scorer (tests/typecheck/benchmark) and reports a numeric
  result as a typed, machine-readable signal (`details.score`,
  `structuredContent.score`) instead of opaque stderr.
- Scorer contract: last non-empty stdout line is the number (`score:` prefix
  stripped; fallback = last finite number token). Non-zero exit with a
  parseable number is still a valid low score (a red suite with partial credit
  is a legitimate observation), flagged `isError`.
- Renderers in `tools/renderers/score.ts` (headline = parsed score + exit status).
- Registered in `createAllToolDefinitions`/`createAllTools`/`createTool*`
  switches, `ToolName`, `allToolNames`, `ToolsOptions`, and renderers index.
- **Active by default**: added to `DEFAULT_TOOL_NAMES` in settings-manager.ts.

### 2. `SelfImprovementTracker` (T* metric)
- `packages/agent/src/self-improvement.ts` (pure, no loop deps, exported from
  pi-agent-core index).
- Folds `score` tool results into a per-task best-so-far curve; reports
  `rounds`, `best`, `productiveRounds` (= T*), and the full observation list.
- `AgentSession` owns one tracker: reset at each user `message_start` (task
  boundary), observes every toolResult `message_end`, logs the curve at
  `agent_end` when rounds > 0 (`[self-improvement] rounds=.. best=.. productive(T*)=..`).
- Public accessor: `session.getSelfImprovement()`.

## Why this shape
- The tracker is a pure observer over tool results — no model/loop coupling,
  unit-testable in isolation, reusable by forge/eval runners.
- The score tool reuses `BashOperations` (same shell/exec path as bash), so it
  inherits commandPrefix, spawn hooks, abort, timeout.
- Score is opt-in per task (the model calls it only when a verifier exists);
  being default-active just means it's *available* without config.

## Tests
- `packages/agent/test/self-improvement.test.ts` (5 tests): curve, T*, reset,
  non-score ignoring, non-finite ignoring.
- `packages/coding-agent/test/score-tool.test.ts` (7 tests): parseScore cases +
  live tool execution (score parse, non-zero-exit low score).
- Updated tool-name expectations in default-tools-setting / settings-manager /
  regression 3592 for the new default tool.
- Pre-existing unrelated failures on clean main: version-check (fetch mock),
  agent-session-boundaries (compaction) — verified via git stash.

## Activation
`npm run build:binary` (bun-compiled ELF at dist/pi, on PATH). Running pi
sessions keep their loaded copy until relaunch; new sessions pick up the new
binary. The live binary bundles agent-core, so both the score tool and the
tracker ship together.

## End-to-end verification (2026-11-07)

Ran a real task against the served AREX-2 (:8045) through the rebuilt binary:
"guess a hidden phrase, write answer.txt, run `python3 check.py` via the score
tool, iterate to maximize". Result:

```
[self-improvement] rounds=6 best=28.6 productive(T*)=3
```

AREX-2 called the score tool 6 times, read each score, and rewrote its guess —
the reflective loop running on the new score boundary. T*=3 of 6 rounds was
productive (it stalled after round 3), which is exactly the signal the metric
exists to surface: the model converged on a local optimum and kept spending
budget without improvement.

## Forge integration (done 2026-11-07)

The forge runs works on pi-durable's `CodingTools`, so the score tool had to
land in pi-durable, not just coding-agent:

- `packages/durable/src/tools/score.ts` (pi-durable `defineTool`, reuses
  `ExecutionEnv.exec`): same scorer contract, returns `details: {score,
  exitCode}` on the committed `pi.tool-result` entry (that's what the forge
  reads) plus `structuredOutput` for programmatic callers. No `label` field
  (pi-durable ToolRegistration has none).
- Added to `createCodingTools()` in `packages/durable/src/tools/index.ts`.
- **Built into BOTH durable trees**: `pi-src/packages/durable` (1.4.0) and
  `pi-durable-mw/packages/durable` (1.3.0, the `durable/multi-reader` branch
  whose dist the forge actually loads via the node_modules symlink — the
  forge needs the local build for the `readOnly` observer option, so pi-src's
  durable dist is NOT what runs).
- `pi-packages/forge/extensions/forge.ts`:
  - `selfImprovementFromEntries()` computes the per-work curve (rounds, best,
    productiveRounds=T*) from `pi.tool-result` entries where
    `model[0].toolName === "score"` and `details.score` is finite.
  - `workStatus()` (used by `forge survey <work>` and the survey work list)
    now includes `selfImprovement` when the work called score.
  - forge preamble tells works to use the score tool at round boundaries.
- Verified: `bun pi-packages/forge/smoke-arex-score.ts` — durable conversation
  on AREX-2 with `createCodingTools()`, iterative scorer task; the score tool
  was called and returned a parseable score into the store (FORGE-SCORE PASS).
  (The model is strong: it hit 100 in 1 round by decoding the base64 target —
  the plumbing is proven; multi-round T* shows up on harder tasks.)

## Trajectory harvester (done 2026-11-07)

The paper's "path forward": keep WHOLE trajectories with high final scores
and valid processes (failures included), not (state, action, reward) tuples.

- `pi-packages/forge/quest-viewer/harvest.ts` + `forge harvest` CLI command
  (registered in `forge-cli.ts`):
  - Reads the durable store via the same race-tolerant raw reader as
    `forge lore`/`tail` (safe from any session).
  - Converts each work's visible entries to chat-format messages: system
    (deduped, first), user task, assistant (text + thinking + tool_calls
    with id/name/arguments), tool results (tool_call_id linked). Bookkeeping
    entries (forge.*, submissions) skipped.
  - Outcome heuristic: score-curve best/100 when the work used the score
    tool; else proxies (done +2, clean sentinel +1, final text +1).
  - `validProcess` = done + has user task + has assistant + ends on
    assistant (clean completion, not abort mid-tool).
  - `--export out.jsonl` → one trajectory per line with metadata
    (workId, label, status, parent, outcome, validProcess, score curve,
    sentinel, usageTotal, messages).
  - `--own-only` drops the forked prefix at the fork point (novel suffix
    only); `--min-outcome`, `--no-aborted`, `--max-tool-chars`,
    `--max-thinking-chars`, `--no-thinking`, `--json`.
- Verified on the live store: 75 works → 47 trajectories at `--min-outcome 3`,
  all well-formed (system,user first; every tool message linked to a
  tool_call id). ~15 MB with thinking stripped.
- Documented in `pi-packages/forge/USAGE.md` (shell section).

## Not done (follow-ups)
- Retiring prompt-side iteration rules (AGENTS.md "keep going") now that the
  model carries them — candidate experiment.
- Commit the pi-src + pi-durable-mw + forge changes (left uncommitted for
  review).
- Actually fine-tune on harvested trajectories (needs a training setup;
  the export is ready for it).

## Files
- packages/agent/src/self-improvement.ts (new)
- packages/agent/src/index.ts (export)
- packages/agent/test/self-improvement.test.ts (new)
- packages/coding-agent/src/core/tools/score.ts (new)
- packages/coding-agent/src/core/tools/renderers/score.ts (new)
- packages/coding-agent/src/core/tools/index.ts (registration)
- packages/coding-agent/src/core/tools/renderers/index.ts (renderers)
- packages/coding-agent/src/core/settings-manager.ts (DEFAULT_TOOL_NAMES)
- packages/coding-agent/src/core/agent-session.ts (tracker + accessor + log)
- packages/coding-agent/test/score-tool.test.ts (new)
- packages/coding-agent/test/default-tools-setting.test.ts (expectations)
- packages/coding-agent/test/settings-manager.test.ts (expectations)
- packages/coding-agent/test/suite/regressions/3592-*.test.ts (expectations)
