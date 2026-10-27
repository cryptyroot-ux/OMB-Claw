// Native hook system (Claude Code-inspired): PreToolUse, PostToolUse, PreCompact, Stop.
// Hooks are user-configurable callbacks invoked at key points in the agent loop.
// They can observe, block, or annotate. They never throw into the loop (errors are logged).

export type HookEvent = "pre_tool_use" | "post_tool_use" | "pre_compact" | "stop" | "session_start" | "session_end";

export interface HookContext {
  readonly runId: string;
  readonly threadId: string;
  readonly botId: string;
  readonly capabilityId?: string;
  readonly callId?: string;
  readonly arguments?: unknown;
  readonly result?: { readonly ok: boolean; readonly content: string };
  readonly reason?: string;
}

export interface HookResult {
  readonly allow: boolean;
  readonly message?: string;
  readonly modifiedArguments?: unknown;
}

export type HookHandler = (context: HookContext) => HookResult | Promise<HookResult>;

export interface HookRegistry {
  register(event: HookEvent, handler: HookHandler): () => void;
  run(event: HookEvent, context: HookContext): Promise<{ allow: boolean; messages: string[]; modifiedArguments?: unknown }>;
  clear(): void;
}

export function createHookRegistry(): HookRegistry {
  const handlers = new Map<HookEvent, HookHandler[]>();

  return {
    register(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return () => {
        const list = handlers.get(event);
        if (list) {
          const idx = list.indexOf(handler);
          if (idx >= 0) list.splice(idx, 1);
        }
      };
    },

    async run(event, context) {
      const list = handlers.get(event) ?? [];
      const messages: string[] = [];
      let allow = true;
      let modifiedArguments: unknown;
      for (const handler of list) {
        try {
          const result = await handler(context);
          if (result.allow === false) allow = false;
          if (result.message) messages.push(result.message);
          if (result.modifiedArguments !== undefined) modifiedArguments = result.modifiedArguments;
        } catch (error) {
          messages.push(`Hook error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { allow, messages, modifiedArguments };
    },

    clear() { handlers.clear(); },
  };
}
