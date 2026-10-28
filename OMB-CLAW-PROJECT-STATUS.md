# OMB-Claw Project Status Documentation

**Last Updated:** 2026-10-28
**Branch:** `feature/fetch-lazy-fix` (commit `e34ccfc06`)
**Remote:** `omb-claw/feature/fetch-lazy-fix`

---

## 1. Project Overview

### 1.1 What is OMB-Claw?

**OMB-Claw** is a standalone AI agent platform built as a private development fork of **OpenMausBot** (Apache-2.0). Unlike the upstream app, OMB-Claw does not require Claude Code, Codex, OpenCode, Hermes, Pi, or Antigravity to run a bot. External CLI/ACP engines are not registered or launched. Model access is through API providers only.

### 1.2 Core Architecture: Three Non-Mixing Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Orchestration                                     │
│  Session Tree, Subagents, Delegation, Plan Artifacts,       │
│  Control Plane, External Benchmarks, Background Compaction  │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Capability System                                 │
│  MCP Servers, Native Tools, Skills, Browser/Computer Use,   │
│  Approval/Grant/Scope, Tool Search, Hooks, Sandbox,         │
│  Checkpoints/Rollback, Fallback Provider Chains             │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Native Agent Engine  ✅ COMPLETE                  │
│  OMB-owned turn loop, SQLite run journal, Model Adapters,   │
│  Capability Runtime Bridge                                  │
└─────────────────────────────────────────────────────────────┘
```

**Dependency Direction:** Layer 1 → Layer 2 → Layer 3 (one-directional, no cycles)

### 1.3 Project Goals

1. **Self-contained agent runtime** — OMB owns the turn loop; model providers are replaceable adapters
2. **Capability-governed execution** — Every tool/MCP/skill goes through grant/approval/scope
3. **Multi-agent orchestration** — Session branching, subagents, delegation, planning
4. **Production-ready reliability** — Checkpoints, fallback providers, budgets, observability
5. **Benchmark-validated** — SWE-bench, Terminal-Bench, CodeClash integration

---

## 2. Layer 1: Native Agent Engine — ✅ COMPLETE (Milestone 1 + Production Opt-in)

### 2.1 Completed Components

| Component | File | Tests | Status |
|---|---|---|---|
| Native turn loop (AgentEngine) | `server/agent-runtime/runtime.ts` | 46 | ✅ |
| SQLite run/capability journal | `server/agent-runtime/run-store.ts` | 46 | ✅ |
| OpenAI-compatible model adapter | `server/agent-runtime/model-adapter.ts` | 50 | ✅ |
| Anthropic/Gemini/Responses adapters | `server/agent-runtime/*-adapter.ts` | 143 driver tests | ✅ |
| 8 Native API Drivers | `server/drivers/*.ts` (openai, grok, groq, meta, minimax, mistral, cerebras) | Integrated | ✅ |
| Capability Runtime Bridge | `server/agent-runtime/chat-capability-runtime.ts` | Integrated | ✅ |
| Grant policy (centralized) | `CompositeCapabilityRuntime` | Unit tested | ✅ |
| Key rejection (`noteKeyRejected`) | All 4 adapters | Migration done | ✅ |
| Summarization compaction | `runtime.ts` | Budget caps tested | ✅ |
| Steering / Nudge parity | `runtime.ts` + `announcement.ts` | Parity tests pass | ✅ |
| **Legacy loop removal** | `native-turn-runtime.ts` | **DONE in `e34ccfc06`** | ✅ |

### 2.2 Verification Gate (Passed)

- **Tests:** 12 files / 230+ tests passed (`server/agent-runtime/` + `server/drivers/openai-chat*.test.ts`)
- **Lint:** `oxlint --deny-warnings .` — clean
- **Typecheck:** `tsc -b && tsc -p tsconfig.server.json` — clean
- **Locale:** `i18n:check` — 13 languages, 6331 strings valid

### 2.3 Key Commits (Layer 1)

| Commit | Description |
|---|---|
| `e34ccfc06` | **feat: remove legacy turn loop, route all turns through native engine** (HEAD) |
| `082966c70` | feat: ask_user native capability + capabilityFailure persistence across rounds |
| `a0d91c579` | feat: granular tool scoping for built-in tools in native path |
| `afdaf389a` | fix: stream truncation message parity in native path |
| `f8e4ce2e8` | feat: tool scoping for built-in tools in native path |

---

## 3. Layer 2: Capability System — ~60% Done (Phase B/C/D/E)

*Source: `docs/superpowers/plans/2026-10-28-phase-b-c-d-e-research.md`*

### 3.1 Already Implemented (Code Exists + Wired)

| # | Capability | File | Integration Point | Notes |
|---|---|---|---|---|
| 1 | **Tool Search** (Claude ToolSearch pattern) | `server/agent-runtime/tool-search-capability-provider.ts` | `turn-runtime.ts:245` | MCP tools deferred until searched |
| 2 | **Hooks** (Pre/PostToolUse/Stop/PreCompact) | `server/agent-runtime/hooks.ts` | `runtime.ts:668,707,780` | Registry + run() wired |
| 3 | **Checkpoints** (shadow git) | `server/checkpoints.ts` | `runtime.ts:679,723` | `createCheckpoint()` called before mutating tools |
| 4 | **Sandbox Boundary** (workspace-write/read-only/full/custom) | `server/agent-runtime/sandbox.ts` | `native-shell-tool.ts`, `turn-runtime.ts` | Heuristic path containment + read-only write block + custom allowlist; per-turn `sandboxMode` + `OMB_SANDBOX_MODE` env |

### 3.2 Partially Implemented (Needs Completion)

| # | Capability | Current State | Missing |
|---|---|---|---|
| 4 | **Checkpoints/Rollback** | Checkpoint created | `rollback()` on failure, `run.checkpoint_available` event |
| 5 | **Hooks** | Registry + pre/post tool use | Block/modify tool calls, user-configurable handlers |

### 3.3 Not Started (Spec Only)

| # | Capability | Spec Location | Effort |
|---|---|---|---|
| 6 | **Sandbox Boundary** (workspace-write/read-only/full/custom) | Phase B/C/D/E §3 | Medium |
| 7 | **Fallback Provider Chains** | Phase B/C/D/E §5 | Medium |
| 8 | **Live Capability Probe** (real API call) | Phase B/C/D/E §7 | Small (needs API key) |
| 9 | **Skills as Capabilities** | Phase B/C/D/E + Audit F6 | Medium |

### 3.4 Execution Priority (from source docs)

1. **Sandbox Boundary** — Security, medium effort, no external deps
2. **Hooks** — Complete block/modify logic + user config
3. **Checkpoints/Rollback** — Wire rollback + event emission
4. **Fallback Provider Chains** — Reliability, try next provider on terminal error
5. **Live Capability Probe** — Implement real probe + document (mock already works)

---

## 4. Layer 3: Orchestration — 0% Implemented (Specs Only)

*Source: `docs/superpowers/specs/2026-10-28-remaining-gaps-research.md` + `plans/`*

### 4.1 Session Tree (Pi-style) — Large Refactor

| Task | Status | Effort |
|---|---|---|
| Add `parent_thread_id`, `branch_point_message_id` to `thread_state` | ❌ Not in `message-db.ts` | Large (4-6 slices) |
| `forkThread(parentThreadId, fromMessageId)` API | ❌ | |
| Branch summary (compaction on fork) | ❌ | |
| `resumeThread(threadId)` API | ❌ | |
| UI: branch selector, "regenerate" creates branch | ❌ | |

**Data Model Change Required:** `message-db.ts` schema migration (nullable columns for backward-compat)

### 4.2 External Benchmarks — Large + External Dependencies

| Benchmark | Status | Requirements |
|---|---|---|
| **SWE-bench Verified** (500 tasks) | ❌ Skeleton only (`evals/`) | Docker, ~10GB disk, network, dataset download |
| **Terminal-Bench** | ❌ | Dataset pin + harness version |
| **CodeClash** | ❌ | Git repos + test harness |
| **ProgramBench** | ❌ | Third-party audit |

**Harness Exists:** `evals/runners/run-evals.ts`, `evals/tasks/`, `evals/results/`

### 4.3 Subagents / Delegation — Plans Only

| Plan | Status |
|---|---|
| `delegation-mailbox.md` | Spec only |
| `delegation-task-board.md` | Spec only |
| `control-plane-roadmap.md` | Spec only |
| `memory-review-loop.md` | Spec only |

### 4.4 Background Compaction

| Status | Note |
|---|---|
| ❌ In progress | README: "remains in progress" |

---

## 5. Complete Work Breakdown

### 5.1 ✅ DONE (Verified Complete)

- [x] Native Agent Engine (Layer 1) — full implementation + tests
- [x] Legacy loop removal — **completed in this session** (`e34ccfc06`)
- [x] 8 native API drivers with key rejection
- [x] SQLite run journal + capability call logging
- [x] Tool scoping (granular per-tool via `allowsTool()`)
- [x] Summarization compaction with budget caps
- [x] Tool Search capability provider (code + wired)
- [x] Hooks registry (code + wired to runtime)
- [x] Checkpoints shadow git (code + `createCheckpoint()` called)
- [x] Live capability probe (mock-based test exists)

### 5.2 🔄 IN PROGRESS / PARTIAL

- [ ] **Checkpoints Rollback** — `createCheckpoint()` called but no rollback logic
- [ ] **Hooks Block/Modify** — `pre_tool_use` runs but handler results not fully applied

### 5.3 📋 TODO — Layer 2 (Priority Order)

| Priority | Task | File(s) to Create/Modify | Estimated Effort |
|---|---|---|---|
| 1 | **Sandbox Boundary** | ✅ DONE — `server/agent-runtime/sandbox.ts`, `native-shell-tool.ts`, `turn-runtime.ts` | Medium |
| 2 | **Hooks Completion** | `hooks.ts` (apply `modifiedArguments`, `allow: false`), config loader | Medium |
| 3 | **Checkpoints Rollback** | `checkpoints.ts` (`rollback()`), `runtime.ts` (emit event, offer rollback) | Medium |
| 4 | **Fallback Provider Chains** | `runtime.ts` (adapter resolution loop), `contracts.ts` (fallbackProviders) | Medium |
| 5 | **Live Capability Probe** | `capability-probe.ts` (real probe), docs | Small |
| 6 | **Skills as Capabilities** | `skill-capability-provider.ts`, skill lifecycle | Medium |

### 5.4 📋 TODO — Layer 3 (Deferred, Large)

| Task | Dependency | Effort |
|---|---|---|
| Session Tree (schema + fork API) | Layer 2 stable | Large (4-6 slices) |
| External Benchmarks (SWE-bench loader) | Native file/shell/git tools | Large + Docker |
| Subagents / Delegation | Session tree | Large |
| Plan Artifacts / Control Plane | Session tree | Large |
| Background Compaction | Compaction logic done | Medium |

---

## 6. Current Branch Status

### 6.1 Active Branch: `feature/fetch-lazy-fix` (local + `omb-claw` remote)

```
e34ccfc06 (HEAD) feat: remove legacy turn loop, route all turns through native engine
082966c70        feat: ask_user native capability + capabilityFailure persistence
a0d91c579        feat: granular tool scoping for built-in tools in native path
afdaf389a        fix: stream truncation message parity in native path
f8e4ce2e8        feat: tool scoping for built-in tools in native path
```

**Working tree:** Clean (all changes committed)

### 6.2 Other Branches

| Branch | Description |
|---|---|
| `feature/layer1-compaction` | Milestone 1 + opt-in + upstream catch-up |
| `feature/native-agent-engine` | Baseline native engine |
| `main` | Upstream OpenMausBot (behind by 5 commits) |
| `omb-claw/main` | OMB-Claw main (behind by 5 commits) |

---

## 7. Next Steps Recommendation

### Immediate (This Session / Next Session)

**Option A: Layer 2 Slice 1 — Sandbox Boundary** (Recommended)
- Security-critical, no external deps
- Creates `sandbox.ts` with mode enum + shell tool integration
- Adds `sandboxMode` to bot config

**Option B: Layer 2 Slice 2 — Hooks Completion**
- Already wired, just need block/modify logic + user config
- Lower risk, high extensibility value

**Option C: Layer 2 Slice 3 — Checkpoints Rollback**
- `createCheckpoint()` already called, just need rollback + event
- Directly improves reliability

### Short-term (1-2 weeks)

1. Complete all 5 Layer 2 priority items (Sandbox → Hooks → Rollback → Fallback → Live Probe)
2. Run full test suite after each slice
3. Push each slice as separate commit to `feature/fetch-lazy-fix`

### Medium-term (1 month)

1. **Session Tree** — Start with schema migration (nullable columns)
2. **External Benchmarks** — Add SWE-bench task loader (no run yet)
3. **Background Compaction** — Complete in-progress work

### Long-term (2+ months)

1. Subagents / Delegation / Plan Artifacts
2. Full SWE-bench / Terminal-Bench runs
3. Production hardening

---

## 8. Key Files Reference

### Core Engine (Layer 1)
```
server/agent-runtime/runtime.ts          # Main turn loop
server/agent-runtime/model-adapter.ts    # OpenAI-compat streaming + refusal handling
server/agent-runtime/turn-runtime.ts     # Turn orchestration, capability providers
server/agent-runtime/native-turn-runtime.ts  # Native path only (legacy removed)
server/agent-runtime/run-store.ts        # SQLite journal
server/agent-runtime/contracts.ts        # Type definitions
server/agent-runtime/hooks.ts            # Hook registry
server/agent-runtime/checkpoints.ts      # Shadow git checkpoints
```

### Capability Providers (Layer 2)
```
server/agent-runtime/tool-search-capability-provider.ts
server/agent-runtime/native-file-capability-provider.ts
server/agent-runtime/native-shell-capability-provider.ts
server/agent-runtime/native-git-capability-provider.ts
server/agent-runtime/native-web-capability-provider.ts
server/agent-runtime/chat-capability-runtime.ts      # MCP bridge
server/agent-runtime/capability-runtime.ts           # Composite runtime
```

### Drivers (Layer 1)
```
server/drivers/openai-compat.ts
server/drivers/grok.ts
server/drivers/groq.ts
server/drivers/meta.ts
server/drivers/minimax.ts
server/drivers/mistral.ts
server/drivers/cerebras.ts
```

### Evaluation Harness
```
evals/runners/run-evals.ts
evals/tasks/
evals/results/
```

### Documentation (Source of Truth)
```
docs/superpowers/plans/2026-10-26-omb-native-runtime-milestone-1.md
docs/superpowers/plans/2026-10-26-omb-native-runtime-production-opt-in.md
docs/superpowers/specs/2026-10-28-phase-b-c-d-e-research.md
docs/superpowers/specs/2026-10-28-remaining-gaps-research.md
```

---

## 9. Quick Commands

```bash
# Run all agent-runtime + driver tests
cd /tmp/opencode/OpenMausBot-native-runtime-audit/source-main/feature/native-agent-engine
npx vitest run server/agent-runtime/ server/drivers/openai-chat.test.ts

# Lint + Typecheck + Locale
npm run lint && npm run typecheck && npm run i18n:check

# Check current branch status
git log --oneline -5
git status

# View legacy loop removal diff
git diff 082966c70..e34ccfc06 -- server/agent-runtime/native-turn-runtime.ts
```

---

## 10. Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-10-28 | Legacy loop removed in `e34ccfc06` | All tests migrated to native path, 181/181 pass |
| 2026-10-28 | `refusal` field added to `ModelAdapterError` | Needed for `tool_use_failed` retry logic |
| 2026-10-28 | `noteKeyAccepted` import fixed in `model-adapter.ts` | Was causing `ReferenceError` misclassified as `transient` |
| 2026-10-28 | Tool scoping via `allowsTool(scope, { kind: "native", name })` | Granular per-tool, per-capability-provider control |

---

**End of Document**

*This document is the single source of truth for OMB-Claw project status. Update after each slice completion.*