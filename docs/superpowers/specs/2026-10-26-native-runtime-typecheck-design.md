# Native runtime typecheck repair

## Intent

Make the existing `server/agent-runtime/` prototype typecheck without `any`
casts, while adding no new runtime actions. Preserve the loop's intended
representation of absent assistant text as `null`; this corrects the
uncommitted typecheck workaround that coerced it to an empty string. This is a
correctness cleanup for the prototype, not approval to expand or integrate the
runtime.

## Goals

- Keep public `RunState` read-only and represent mutable lifecycle state with a
  private internal type.
- Keep assistant tool-call messages capable of representing absent text as
  `null`, as intended by the original loop.
- Give runtime test doubles and event assertions concrete types.
- Remove unused imports and satisfy `noUnusedParameters` without changing the
  `interrupt` contract or behavior.
- Verify the focused runtime tests and repository typecheck.

## Non-goals and known limitations

- Do not implement cancellation, retries/recovery, streaming, persistence,
  provider HTTP calls, or capability approval policy.
- Do not integrate the prototype with the existing production turn path.
- `interrupt` remains a no-op; the OpenAI-compatible adapter remains a stub.
- Passing typecheck does not establish production readiness or CLI-free
  independence.

## Approaches considered

1. **Type-safe repair only (selected):** model the internal mutable state and
   test doubles accurately, with no behavior expansion. This is the smallest
   reversible step and matches the request to continue precisely.
2. **Harden the runtime now:** add real cancellation, capability enforcement,
   event/stream behavior, and a functioning provider adapter. This changes
   behavior and needs a separate design plus acceptance criteria.
3. **Stop after investigation:** avoid edits and report the errors. This leaves
   the existing prototype uncompilable and does not advance the selected
   incremental migration path.

## Constraints and acceptance

- Keep the work on branch `feature/native-agent-engine` in the isolated
  worktree.
- Do not change production integrations, deploy, or push.
- `pnpm typecheck` passes.
- `pnpm vitest run server/agent-runtime/` passes.
- The changes contain no `any` casts in the touched runtime/test code and do not
  claim that the known limitations above are resolved.

## Implementation choices left to the builder

Use a mapped mutable internal state type while retaining the read-only public
contract. Model tool-call assistant content as nullable if required by the
existing loop's intended semantics. Type the test helper's invocation record
and events directly. Rename the unused `interrupt` parameter using the
repository's TypeScript convention; do not implement cancellation in this
change.
