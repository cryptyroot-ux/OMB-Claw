# OMB Native Engine — Evaluation Harness

This directory is the evaluation surface for the OMB native agent engine. It is intentionally separate from the
unit and e2e tests: those prove components work; this proves the engine solves tasks, at what cost, and how
reliably.

## Task format

Each task is a JSON file in `evals/tasks/`:

```json
{
  "id": "native-text-reply",
  "description": "The bot replies through the native loop",
  "prompt": "Say hello through the native loop.",
  "expectedReply": "Native eval verified.",
  "providerReply": "Native eval verified.",
  "budget": { "maxTokens": 100000, "maxWallTimeMs": 60000 }
}
```

Fields:

- `id` — unique task id.
- `description` — human-readable.
- `prompt` — the user message sent to the bot.
- `expectedReply` — substring that must appear in a bot message for the task to count as resolved.
- `providerReply` — what the loopback provider answers (deterministic).
- `budget` — optional hard caps forwarded to the native run.

## How to run

```sh
node --experimental-strip-types evals/runners/run-evals.ts
```

The runner launches an isolated OMB server and a loopback chat-completions provider per task, configures the
OpenAI-compatible provider, creates a bot, sends the prompt, waits for the turn, and records metrics from the
`agent_runs` journal. It writes a JSON report to `evals/results/<timestamp>.json`.

## Metrics

Per task and aggregate:

- `resolved` — whether the expected reply appeared.
- `status` — the run's final status (`completed`, `failed`, `interrupted`, `recovery_required`).
- `modelRounds`, `toolCalls` — from `agent_runs`.
- `wallTimeMs` — from send to settled turn.
- `requestCount` — provider requests observed.
- `compactions` — `agent_compactions` rows.
- `retries` — model rounds beyond the first.
- `recoveryRequired` — whether the run ended in `recovery_required`.

Aggregate: resolve rate, mean cost proxy (tokens), mean wall time, mean retries, mean compactions.

## Independence

The runner sets `PATH=/nonexistent-native-agent-path` and uses only the API provider, so no external agent
engine can be launched. This is the same isolation as the native acceptance fixtures.

## Current scope

This harness is a skeleton. It proves the native loop can complete a deterministic turn and records the metrics
above. Real task suites (repo edits, SWE-bench Verified, Terminal-Bench) are added later; see the roadmap in
`docs/superpowers/specs/2026-10-27-native-engine-external-research.md`.
