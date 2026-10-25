import type {
  CapabilityRuntime,
  CapabilityDescriptor,
  CapabilityCall,
  CapabilityResult,
  CapabilityGrant,
} from "./contracts.ts";

export interface CapabilityHandler {
  (call: CapabilityCall, context: { grant: CapabilityGrant; signal: AbortSignal }): Promise<CapabilityResult>;
}

export class InMemoryCapabilityRuntime implements CapabilityRuntime {
  private descriptors = new Map<string, CapabilityDescriptor>();
  private handlers = new Map<string, CapabilityHandler>();

  register(descriptor: CapabilityDescriptor, handler: CapabilityHandler): void {
    this.descriptors.set(descriptor.id, descriptor);
    this.handlers.set(descriptor.id, handler);
  }

  list(context: { botId: string; threadId: string; grant: CapabilityGrant }): CapabilityDescriptor[] {
    const result: CapabilityDescriptor[] = [];
    for (const [id, desc] of this.descriptors) {
      if (context.grant.allowed.size > 0 && !context.grant.allowed.has(id)) continue;
      if (context.grant.denied.has(id)) continue;
      result.push(desc);
    }
    return result;
  }

  async invoke(call: CapabilityCall, context: { grant: CapabilityGrant; signal: AbortSignal }): Promise<CapabilityResult> {
    const handler = this.handlers.get(call.capabilityId);
    if (!handler) {
      return { callId: call.callId, ok: false, content: `Unknown capability: ${call.capabilityId}`, error: "unknown_capability" };
    }
    if (context.grant.denied.has(call.capabilityId)) {
      return { callId: call.callId, ok: false, content: `Capability denied: ${call.capabilityId}`, error: "denied" };
    }
    if (context.grant.allowed.size > 0 && !context.grant.allowed.has(call.capabilityId)) {
      return { callId: call.callId, ok: false, content: `Capability not allowed: ${call.capabilityId}`, error: "not_allowed" };
    }
    try {
      return await handler(call, context);
    } catch (error) {
      return { callId: call.callId, ok: false, content: error instanceof Error ? error.message : String(error), error: "execution_error" };
    }
  }

  async cancel(_callId: string): Promise<void> {
    // No-op in this minimal implementation
  }
}