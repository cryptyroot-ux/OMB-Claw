# OMB Native-Only Runtime Production Enablement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the OMB Agent Runtime the default loop for OpenAI-compatible API bots while disabling external agent engines in this build.

**Architecture:** External CLI/ACP drivers remain in the tree but are removed from the provider registry and never launched. API model providers remain supported. `OpenAICompatDriver` builds the native engine and uses it for every turn; `server/index.ts` marks every OpenAI-compatible turn with `agentEngine:"omb-native"`. Other API drivers keep their existing OMB-owned direct API loop until migrated.

**Spec:**
- `docs/superpowers/specs/2026-10-26-omb-native-agent-platform-design.md`
- `docs/superpowers/specs/2026-10-26-omb-cli-free-acceptance-contract.md`

## Global Constraints

- No external agent engine may be registered, selectable, or launched in this build.
- Default behavior for API-model bots stays available; OpenAI-compatible bots use the native loop.
- Image input remains rejected and image tool results fail closed.
- No live API smoke, canary, push, or deployment without separate approval.
- Full repository suite remains not green; use focused suites, lint, and typecheck.

## Review Focus

- Stored bots pointing at an external engine must become unavailable, not silently launch a CLI.
- The registry must not expose external engines through `/api/instances` or onboarding.
- An OpenAI-compatible turn must use the native engine and persist an `agent_runs` row.
- A non-OpenAI-compatible API driver must remain on its existing OMB-owned loop.

---

### Task 1: Engine support policy

**Files:**
- Create: `server/agent-runtime/engine-support.ts`
- Create: `server/agent-runtime/engine-support.test.ts`

**Interfaces:**
- `isExternalAgentEngine(driverKind: string): boolean`
- `supportedAgentDrivers<T extends { readonly driverKind: string }>(drivers: readonly T[]): readonly T[]`

- [x] Test external CLI/ACP kinds as unsupported and API providers as supported.
- [x] Confirm RED, implement, confirm GREEN.

### Task 2: Registry and per-turn selection

**Files:**
- Modify: `server/index.ts`
- Modify: `server/contracts.ts`
- Modify: `server/drivers/openai-chat.ts`
- Modify: `server/drivers/openai-compat.ts`
- Modify: `server/agent-runtime/model-adapter.ts`
- Test: `server/agent-runtime/driver-opt-in.test.ts`

- [x] Filter `BUILT_IN_DRIVERS` through `supportedAgentDrivers` at registry construction.
- [x] Add `SendTurnInput.agentEngine?: "omb-native"`.
- [x] Mark direct and room OpenAI-compatible turns with `agentEngine:"omb-native"`.
- [x] Build the native engine inside `OpenAICompatDriver` and use it only when the turn carries the flag.
- [x] Add an integration test with a real OpenAI-compatible HTTP fixture and a real MCP tool, asserting native execution and legacy fallback.

### Task 3: Verification

- [x] Run `pnpm vitest run server/agent-runtime/ server/drivers/openai-chat-tools.test.ts server/drivers/openai-chat.test.ts server/drivers/openai-chat-protocol.test.ts server/drivers/chat-tool-approval.test.ts` → 12 files / 230 tests passed.
- [x] Run `pnpm typecheck` and `pnpm lint` → passed.
- [x] Run the full isolated server fixture `server/native-only.e2e.test.ts` → 1/1 passed: real loopback provider, real MCP tool, real approval card, settled turn, artifact written, `agent_runs` completed with 2 rounds/1 call, and `claude` not available.
- [x] Commit locally.
- [x] Report full-suite status as not green; push only with approval.

**Known gap:** `server/openai-tools.e2e.test.ts` still asserts the legacy OpenAI-compatible loop and fails its request-count assumptions under native execution. It needs a native-aware replacement/update; the focused native-only fixture is the current proof.
