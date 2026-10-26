import type {
  CapabilityCall,
  CapabilityDescriptor,
  CapabilityGrant,
  CapabilityResult,
  CapabilitySession,
} from "./contracts.ts";

export interface CapabilityHandler {
  (call: CapabilityCall, context: { grant: CapabilityGrant; signal: AbortSignal }): Promise<CapabilityResult>;
}

/**
 * In-process capability session used by fixtures and tests. It enforces the
 * same grant and lifecycle rules as production sessions without owning a
 * transport.
 */
export class InMemoryCapabilitySession implements CapabilitySession {
  private descriptors = new Map<string, CapabilityDescriptor>();
  private handlers = new Map<string, CapabilityHandler>();
  private closed = false;

  register(descriptor: CapabilityDescriptor, handler: CapabilityHandler): void {
    if (this.closed) throw new Error("Capability session is closed");
    this.descriptors.set(descriptor.id, descriptor);
    this.handlers.set(descriptor.id, handler);
  }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    return Array.from(this.descriptors.values()).filter((descriptor) => this.permitted(descriptor.id, grant));
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void {
    this.assertOpen();
    const descriptor = this.descriptors.get(call.capabilityId);
    if (!descriptor) throw new Error(`Unknown capability: ${call.capabilityId}`);
    if (grant.denied.has(call.capabilityId)) throw new Error(`Capability denied: ${call.capabilityId}`);
    if (grant.allowed.size > 0 && !grant.allowed.has(call.capabilityId)) {
      throw new Error(`Capability not allowed: ${call.capabilityId}`);
    }
  }

  async invoke(
    call: CapabilityCall,
    context: { grant: CapabilityGrant; signal: AbortSignal },
  ): Promise<CapabilityResult> {
    if (this.closed) {
      return { callId: call.callId, ok: false, content: "Capability session is closed", error: "closed" };
    }
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
      return {
        callId: call.callId,
        ok: false,
        content: error instanceof Error ? error.message : String(error),
        error: "execution_error",
      };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Capability session is closed");
  }

  private permitted(id: string, grant: CapabilityGrant): boolean {
    if (grant.denied.has(id)) return false;
    return grant.allowed.size === 0 || grant.allowed.has(id);
  }
}
