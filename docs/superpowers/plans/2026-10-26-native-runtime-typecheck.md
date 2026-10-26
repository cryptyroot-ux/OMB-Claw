# Native Runtime Typecheck Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing native runtime prototype typecheck without `any` casts while preserving runtime behavior.

**Architecture:** Keep the exported `RunState` immutable and hold mutable lifecycle fields behind a private mapped type. Keep nullable assistant content in the protocol-neutral message contract, and give test doubles concrete adapter/runtime/event types.

**Tech Stack:** TypeScript, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-26-native-runtime-typecheck-design.md`

## Global Constraints

- Keep the work on branch `feature/native-agent-engine` in the isolated worktree.
- Do not change production integrations, deploy, or push.
- `pnpm typecheck` passes.
- `pnpm vitest run server/agent-runtime/` passes.
- The changes contain no `any` casts in the touched runtime/test code and do not claim that the known limitations are resolved.

## Review Focus

- Assistant tool-call response with no text must preserve `content: null`; pin this in Task 1.
- No further runtime input classes are introduced by this type-only repair. Cancellation, retries/recovery, provider transport, and approval policy are explicit non-goals and remain open limitations.

---

### Task 1: Type-safe runtime state and tests

**Files:**
- Modify: `server/agent-runtime/contracts.ts`
- Modify: `server/agent-runtime/runtime.ts`
- Modify: `server/agent-runtime/model-adapter.ts`
- Modify: `server/agent-runtime/runtime.test.ts`

**Interfaces:**
- Consumes: existing `RunState`, `ModelMessage`, `ModelGenerateRequest`, `ModelAdapter`, `CapabilityRuntime`, and `AgentEvent` contracts.
- Produces: `ModelMessage.content` accepts `string | null`; runtime stores `MutableRunState` internally while `AgentEngine.getState()` continues returning public `RunState`.

- [x] **Step 1: Add the regression assertion and concrete test types first**

In `runtime.test.ts`, make the fake adapter capture `ModelGenerateRequest`s and allow the first tool-call response to have empty text. Assert that the next model request contains an assistant tool-call message with `content: null`, and assert the completed run state reports two model rounds and one tool call. In the same test-only change, type captured requests and event arrays with their exported contracts, and return `CapabilityRuntime & { invocations: string[] }` from the fake helper with `invoke(call: CapabilityCall)`; remove test-side `any` casts.

- [x] **Step 2: Run the focused test and confirm the intended failure**

Run: `pnpm vitest run server/agent-runtime/runtime.test.ts`
Expected: the nullable-content assertion fails because the current runtime coerces absent assistant text to `""`.

- [x] **Step 3: Implement the contract and internal state types**

In `contracts.ts`, make `ModelMessage.content` `string | null`. In `runtime.ts`, define a private mapped type removing `readonly` from `RunState`, store that type in the private run map, and remove `any` casts while retaining the existing public `RunState` return type. Preserve `result.text || null` for assistant tool-call messages. Remove unused imports, and prefix intentionally unused parameters with `_` in `runtime.ts` and `model-adapter.ts`; do not change `interrupt` behavior or make the adapter perform network calls.

- [x] **Step 4: Run focused and repository verification**

Run: `pnpm vitest run server/agent-runtime/`
Expected: all native runtime tests pass.

Run: `pnpm typecheck`
Expected: TypeScript build and server typecheck pass without diagnostics.

Run: `pnpm test`
Expected: attempt the repository suite and record its result. If the broad suite runs excessively long and reports failures outside this prototype, stop only with user approval; do not describe the full suite as passing.

The user approved stopping the run after more than an hour and multiple unrelated Cloud/hosted E2E failures. For this type-only repair, acceptance remains the focused runtime suite plus `pnpm typecheck`; the full-suite failure summary is recorded in the SDD ledger.

- [x] **Step 5: Review the diff and commit this bounded change**

Confirm only the four implementation/test files changed beyond this design and plan, no `any` casts remain in touched runtime/test code, and no behavior outside the approved spec was added. Commit with `fix: make native runtime prototype type-safe`.
