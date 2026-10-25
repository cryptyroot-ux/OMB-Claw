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

export interface ModelCapabilities {
  readonly tools: boolean;
  readonly parallelTools: boolean;
  readonly streaming: boolean;
  readonly contextWindow: number;
  readonly imageInput: boolean;
  readonly imageOutput: boolean;
  readonly structuredOutput: boolean;
  readonly toolSchemaLimit?: number;
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
  readonly content: string;
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
  readonly onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void;
  readonly onUsage?: (usage: { readonly input: number; readonly output: number; readonly cachedInput?: number; readonly costUsd?: number }) => void;
}

export type ModelEvent =
  | { readonly type: "content.delta"; readonly streamKind: "assistant_text" | "reasoning_text"; readonly delta: string }
  | { readonly type: "tool_calls"; readonly calls: ReadonlyArray<ModelToolCall> }
  | { readonly type: "usage"; readonly input: number; readonly output: number; readonly cachedInput?: number; readonly costUsd?: number }
  | { readonly type: "completed"; readonly finishReason: string | null }
  | { readonly type: "error"; readonly message: string };

export interface ModelAdapter {
  readonly providerId: ProviderId;
  discoverModels(): Promise<ModelCatalog>;
  capabilities(modelId: ModelId): ModelCapabilities;
  generate(request: ModelGenerateRequest): Promise<{ readonly text: string; readonly toolCalls: ReadonlyArray<ModelToolCall>; readonly finishReason: string | null; readonly usage?: { readonly input: number; readonly output: number; readonly cachedInput?: number; readonly costUsd?: number } }>;
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

export interface CapabilityRuntime {
  list(context: { readonly botId: BotId; readonly threadId: ThreadId; readonly grant: CapabilityGrant }): ReadonlyArray<CapabilityDescriptor>;
  invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult>;
  cancel(callId: CapabilityCallId): Promise<void>;
}

export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted";

export interface RunState {
  readonly runId: RunId;
  readonly engineId: EngineId;
  readonly providerModel: ProviderModelRef;
  readonly status: RunStatus;
  readonly threadId: ThreadId;
  readonly botId: BotId;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  readonly modelRounds: number;
  readonly toolCalls: number;
  readonly resumeCursor?: unknown;
}

export type AgentEvent =
  | { readonly type: "run.started"; readonly runId: RunId; readonly engineId: EngineId; readonly providerModel: ProviderModelRef }
  | { readonly type: "model.delta"; readonly runId: RunId; readonly streamKind: "assistant_text" | "reasoning_text"; readonly delta: string }
  | { readonly type: "tool.calls"; readonly runId: RunId; readonly calls: ReadonlyArray<ModelToolCall> }
  | { readonly type: "tool.result"; readonly runId: RunId; readonly callId: CapabilityCallId; readonly result: CapabilityResult }
  | { readonly type: "turn.completed"; readonly runId: RunId; readonly ok: boolean; readonly stopReason: string | null }
  | { readonly type: "run.failed"; readonly runId: RunId; readonly message: string }
  | { readonly type: "run.interrupted"; readonly runId: RunId };

export interface AgentEngine {
  readonly engineId: EngineId;
  run(request: {
    readonly botId: BotId;
    readonly threadId: ThreadId;
    readonly text: string;
    readonly providerModel: ProviderModelRef;
    readonly modelAdapter: ModelAdapter;
    readonly capabilityRuntime: CapabilityRuntime;
    readonly grant: CapabilityGrant;
    readonly signal: AbortSignal;
  }): Promise<{ readonly runId: RunId; readonly done: Promise<void> }>;
  interrupt(runId: RunId): Promise<void>;
  getState(runId: RunId): RunState | undefined;
}