// OpenMausBot Native Agent Runtime contracts.
//
// These contracts define the boundary between the OMB-owned agent engine and
// replaceable provider/model adapters plus OMB-owned capability execution.
// They are intentionally protocol-neutral: no provider wire format, CLI, or
// capability transport is allowed to leak through these interfaces.

export type RunId = string;
export type ThreadId = string;
export type BotId = string;
export type EngineId = string;
export type ProviderId = string;
export type ModelId = string;
export type CapabilityId = string;
export type CapabilityCallId = string;

export interface ProviderModelRef {
  providerId: ProviderId;
  modelId: ModelId;
}

export type CapabilitySupport = "supported" | "unsupported" | "unknown";
export type CapabilityLimit = { readonly status: "known"; readonly value: number } | { readonly status: "unknown" };

export interface ModelCapabilities {
  readonly tools: CapabilitySupport;
  readonly parallelTools: CapabilitySupport;
  readonly streaming: CapabilitySupport;
  readonly contextWindow: CapabilityLimit;
  readonly imageInput: CapabilitySupport;
  readonly imageOutput: CapabilitySupport;
  readonly audioInput: CapabilitySupport;
  readonly audioOutput: CapabilitySupport;
  readonly structuredOutput: CapabilitySupport;
  readonly toolSchemaLimit: CapabilityLimit;
}

export interface ModelCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly contextWindow?: number;
  readonly variants?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

export interface ModelCatalog {
  readonly default: string;
  readonly options: ReadonlyArray<ModelCatalogEntry>;
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly toolCallId?: string;
  readonly toolCalls?: ReadonlyArray<ModelToolCall>;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ModelToolResult {
  readonly toolCallId: string;
  readonly ok: boolean;
  readonly content: string;
  readonly images?: ReadonlyArray<{ readonly mimeType: string; readonly data: string }>;
}

export interface ModelGenerateRequest {
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly model: string;
  readonly tools: ReadonlyArray<CapabilityDescriptor>;
  readonly signal: AbortSignal;
}

export type ModelEvent =
  | { readonly type: "content.delta"; readonly kind: "assistant_text" | "reasoning_text"; readonly delta: string }
  | { readonly type: "tool_calls"; readonly calls: ReadonlyArray<ModelToolCall> }
  | { readonly type: "usage"; readonly input: number; readonly output: number; readonly cachedInput?: number; readonly costUsd?: number }
  | { readonly type: "completed"; readonly finishReason: string | null };

export type ModelAdapterErrorCode = "transient" | "unsupported_capability" | "invalid_request" | "terminal";

export interface ModelAdapterError extends Error {
  readonly code: ModelAdapterErrorCode;
  readonly retryable: boolean;
  readonly retrySafe: boolean;
  readonly requestStarted: boolean;
}

export interface ModelAdapter {
  readonly providerId: ProviderId;
  discoverModels(): Promise<ModelCatalog>;
  capabilities(modelId: ModelId): ModelCapabilities;
  generate(request: ModelGenerateRequest): AsyncIterable<ModelEvent>;
}

export interface ModelAdapterRegistry {
  resolve(ref: ProviderModelRef): ModelAdapter;
}

export interface CapabilityGrant {
  readonly botId: BotId;
  readonly threadId: ThreadId;
  readonly approvalMode: "ask" | "auto-edits" | "approve-for-me" | "full";
  readonly allowed: ReadonlySet<CapabilityId>;
  readonly denied: ReadonlySet<CapabilityId>;
}

export interface CapabilityDescriptor {
  readonly id: CapabilityId;
  readonly name: string;
  readonly description: string;
  readonly schema: unknown;
  readonly risk: "read" | "write" | "destructive";
  readonly sideEffect: boolean;
  readonly timeoutMs: number;
}

export interface CapabilityCall {
  readonly runId: RunId;
  readonly callId: CapabilityCallId;
  readonly capabilityId: CapabilityId;
  readonly arguments: unknown;
  readonly botId: BotId;
  readonly threadId: ThreadId;
}

export interface CapabilityResult {
  readonly callId: CapabilityCallId;
  readonly ok: boolean;
  readonly content: string;
  readonly images?: ReadonlyArray<{ readonly mimeType: string; readonly data: string }>;
  readonly uncertain?: boolean;
  readonly error?: string;
}

export interface CapabilitySession {
  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor>;
  validate(call: CapabilityCall, grant: CapabilityGrant): void;
  invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult>;
  close(): Promise<void>;
}

export type AgentRunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted" | "recovery_required";
export type CapabilityCallStatus = "dispatching" | "succeeded" | "failed" | "recovery_required";

export interface AgentRunRecord {
  readonly runId: RunId;
  readonly engineId: EngineId;
  readonly providerModel: ProviderModelRef;
  readonly status: AgentRunStatus;
  readonly threadId: ThreadId;
  readonly botId: BotId;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly modelRounds: number;
  readonly toolCalls: number;
  readonly failureCode?: string;
}

export interface AgentCapabilityCallRecord {
  readonly runId: RunId;
  readonly callId: CapabilityCallId;
  readonly capabilityId: CapabilityId;
  readonly risk: CapabilityDescriptor["risk"];
  readonly status: CapabilityCallStatus;
  readonly startedAt: number;
  readonly settledAt?: number;
}

export interface AgentRunStore {
  createRun(record: AgentRunRecord): void;
  getRun(runId: RunId): AgentRunRecord | undefined;
  updateRunProgress(runId: RunId, progress: { readonly modelRounds: number; readonly toolCalls: number; readonly updatedAt: number }): void;
  transitionRun(runId: RunId, expected: AgentRunStatus, next: AgentRunStatus, updatedAt: number, failureCode?: string): boolean;
  beginCapabilityCall(record: AgentCapabilityCallRecord): void;
  settleCapabilityCall(runId: RunId, callId: CapabilityCallId, status: CapabilityCallStatus, settledAt: number): void;
  recoverUnsettledRuns(now: number): void;
}

export type AgentEvent =
  | { readonly type: "run.started"; readonly runId: RunId; readonly engineId: EngineId; readonly providerModel: ProviderModelRef }
  | { readonly type: "model.delta"; readonly runId: RunId; readonly kind: "assistant_text" | "reasoning_text"; readonly delta: string }
  | { readonly type: "usage"; readonly runId: RunId; readonly input: number; readonly output: number; readonly cachedInput?: number; readonly costUsd?: number }
  | { readonly type: "tool.calls"; readonly runId: RunId; readonly calls: ReadonlyArray<ModelToolCall> }
  | { readonly type: "tool.result"; readonly runId: RunId; readonly callId: CapabilityCallId; readonly result: CapabilityResult }
  | { readonly type: "turn.completed"; readonly runId: RunId; readonly ok: boolean; readonly stopReason: string | null }
  | { readonly type: "run.failed"; readonly runId: RunId; readonly message: string }
  | { readonly type: "run.interrupted"; readonly runId: RunId }
  | { readonly type: "run.recovery_required"; readonly runId: RunId; readonly callId: CapabilityCallId };

export interface AgentRunRequest {
  readonly botId: BotId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly providerModel: ProviderModelRef;
  readonly grant: CapabilityGrant;
  readonly capabilities: CapabilitySession;
  readonly signal: AbortSignal;
}

export interface AgentRunHandle {
  readonly runId: RunId;
  readonly done: Promise<void>;
}

export interface AgentEngine {
  readonly engineId: EngineId;
  run(request: AgentRunRequest): Promise<AgentRunHandle>;
  interrupt(runId: RunId): Promise<void>;
  getState(runId: RunId): AgentRunRecord | undefined;
  onEvent(threadId: string, listener: (event: AgentEvent) => void): () => void;
}
