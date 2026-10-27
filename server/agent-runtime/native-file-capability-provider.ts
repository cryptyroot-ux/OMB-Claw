import type { CapabilityCall, CapabilityDescriptor, CapabilityGrant, CapabilityProvider, CapabilityResult } from "./contracts.ts";
import { allowsTool } from "../../shared/tool-scope.ts";
import { FILE_TOOL_DESCRIPTORS, runFileTool, type FileToolContext } from "./native-file-tools.ts";

export class NativeFileCapabilityProvider implements CapabilityProvider {
  readonly id: string;
  readonly kind = "native-tool" as const;
  private readonly ctx: FileToolContext;
  private readonly scope: unknown;
  private closed = false;

  constructor(ctx: FileToolContext, scope?: unknown) {
    this.ctx = ctx;
    this.scope = scope;
    this.id = "native-file-tools";
  }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    if (grant.denied.has(this.id) && grant.allowed.size > 0 && !grant.allowed.has(this.id)) return [];
    return FILE_TOOL_DESCRIPTORS.filter((d) => allowsTool(this.scope, { kind: "native", name: d.name })).map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      schema: d.schema,
      risk: d.risk,
      sideEffect: d.sideEffect,
      timeoutMs: d.timeoutMs,
    }));
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void {
    if (this.closed) throw new Error("Capability provider is closed");
    if (!FILE_TOOL_DESCRIPTORS.some((d) => d.id === call.capabilityId)) throw new Error(`Unknown capability: ${call.capabilityId}`);
    if (grant.denied.has(call.capabilityId)) throw new Error(`Capability denied: ${call.capabilityId}`);
    if (grant.allowed.size > 0 && !grant.allowed.has(call.capabilityId)) throw new Error(`Capability not allowed: ${call.capabilityId}`);
  }

  async mount(): Promise<void> { /* no process */ }

  async invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult> {
    if (this.closed) return { callId: call.callId, ok: false, content: "closed", error: "closed" };
    try {
      this.validate(call, context.grant);
    } catch (error) {
      return { callId: call.callId, ok: false, content: error instanceof Error ? error.message : String(error), error: "denied" };
    }
    context.signal.throwIfAborted();
    const result = runFileTool(this.ctx, call.capabilityId, (call.arguments ?? {}) as Record<string, unknown>);
    return { callId: call.callId, ok: result.ok, content: result.content, ...(result.error ? { error: result.error } : {}) };
  }

  async close(): Promise<void> { this.closed = true; }

  describe(): string { return "native file tools (read, edit, write, glob, grep)"; }
}
