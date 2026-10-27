Fix plan for remaining 12 failing openai-chat.test.ts tests:

1. model-adapter.ts: Non-SSE JSON error body in stream path (MiniMax base_resp, OpenAI error)
2. turn-runtime.ts: Don't apply plainFailureMessage for "upstream" httpErrorLabel (402 raw)
3. runtime.ts: capabilityFailure persistence - don't reset when correctiveRounds === 0
4. model-adapter.ts: Refused tool call (tool_use_failed) as transient retryable error
5. contracts.ts: Add turn.retrying to AgentEvent
6. runtime.ts: Emit turn.retrying AgentEvent when retrying transient errors
7. turn-runtime.ts: Forward turn.retrying as RuntimeEvent
8. model-adapter.ts: Only set emitted=true for assistant_text, not reasoning_text (enables retry after reasoning-only output)
9. ask_user denial: capabilityFailure must be set when ask_user question is denied/unanswered
