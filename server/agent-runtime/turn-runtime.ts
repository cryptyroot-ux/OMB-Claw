import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { ASK_USER_TOOL, ASK_USER_TOOL_DEFINITION } from "../../shared/ask-question.ts";
import { allowsTool, parseToolScope } from "../../shared/tool-scope.ts";
import { mountChatTools, type ChatToolSession } from "../drivers/chat-mcp-tools.ts";
import type { ChatImagePart } from "../drivers/chat-images.ts";
import { ChatProtocolError } from "../drivers/openai-chat-protocol.ts";
import type { createChatToolApproval } from "../drivers/chat-tool-approval.ts";
import { toolSchemaProfileFor } from "../tool-schema-profile.ts";
import { createChatCapabilitySession } from "./chat-capability-runtime.ts";
import { CompositeCapabilityRuntime, SessionCapabilityProvider, SkillCapabilityProvider } from "./capability-runtime.ts";
import { NativeFileCapabilityProvider } from "./native-file-capability-provider.ts";
import { NativeGitCapabilityProvider } from "./native-git-capability-provider.ts";
import { NativeWebCapabilityProvider } from "./native-web-capability-provider.ts";
import { ToolSearchCapabilityProvider } from "./tool-search-capability-provider.ts";
import { NativeShellCapabilityProvider } from "./native-shell-capability-provider.ts";
import { workspaceDir } from "../workspace.ts";
import type { AgentEngine, CapabilityGrant, CapabilitySession } from "./contracts.ts";

export interface NativeSteerState {
  queue: string[];
  impl?: (text: string) => Promise<"steered" | "refused">;
}

export interface NativeTurnContext {
  turn: SendTurnInput;
  messages: ReadonlyArray<{ role: "system" | "user" | "assistant" | "tool"; content: unknown; tool_call_id?: string }>;
  model: string;
  turnId: string;
  abort: AbortController;
  approval: ReturnType<typeof createChatToolApproval>;
  engine: AgentEngine;
  driverKind: string;
  apiUrl: string;
  toolsEnabled: () => boolean;
  computerUse: boolean;
  nudgeAnnouncedAction: boolean;
  emit: (event: RuntimeEvent) => void;
  base: (threadId: string, turnId: string) => { eventId: string; provider: string; threadId: string; turnId: string; createdAt: string };
  safeText: (text: string) => string;
  preview: (value: unknown) => string | undefined;
  steer: NativeSteerState;
  onSettled: () => void;
}

/** The OMB-owned native turn: mount capabilities, run the engine, bridge events, and close everything. The driver
 * supplies admission, approval, and the prepared messages; it never owns the model/tool cycle. */
export async function runNativeTurn(context: NativeTurnContext): Promise<void> {
  const { turn, messages, model, turnId, abort, approval, engine } = context;
  let tools: ChatToolSession | undefined;
  let capabilitySession: CapabilitySession | undefined;
  let unsubscribe = () => {};
  let completed = false;
  let roundText = "";
  const usage = { input: 0, output: 0 };
  let hasUsage = false;

  const finish = (ok: boolean, stopReason: string | null, failure?: string) => {
    if (completed) return;
    completed = true;
    if (ok && roundText.trim()) {
      context.emit({ ...context.base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text: context.safeText(roundText) });
    }
    if (failure) {
      context.emit({
        ...context.base(turn.threadId, turnId),
        type: "runtime.error",
        message: context.safeText(failure).slice(0, 2_000),
        terminal: !abort.signal.aborted,
      });
    }
    context.emit({
      ...context.base(turn.threadId, turnId),
      type: "turn.completed",
      ok,
      stopReason: abort.signal.aborted ? "interrupted" : stopReason,
      cost: null,
      ...(hasUsage ? { usage } : {}),
    });
  };

  try {
    if (messages.slice(0, -1).some((message) => Array.isArray(message.content))) {
      throw new ChatProtocolError("The native runtime cannot replay structured content from earlier turns; this turn was not sent.");
    }
    const composed = messages.at(-1)?.content;
    if (typeof composed !== "string" && !Array.isArray(composed)) {
      throw new ChatProtocolError("The native runtime received no user content for this turn; it was not sent.");
    }
    const nativeText = typeof composed === "string"
      ? composed
      : composed.find((part) => part.type === "text")?.text ?? turn.text;
    const nativeImages = Array.isArray(composed)
      ? composed.filter((part): part is ChatImagePart => part.type === "image_url").map((part) => {
          const match = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url);
          if (!match) throw new ChatProtocolError("The image transport is invalid; this turn was not sent.");
          return { mimeType: match[1]!, data: match[2]! };
        })
      : [];

    const parsed = parseToolScope(turn.toolScope);
    if (!parsed.ok) throw new Error(parsed.error);
    const scope = parsed.scope;
    tools = await mountChatTools(
      context.toolsEnabled() ? turn.integrations : undefined,
      abort.signal,
      context.computerUse,
      scope,
      turn.mcpCallTimeoutMs,
      toolSchemaProfileFor({ url: context.apiUrl, model }),
    );
    for (const { server, reason } of tools.skipped) {
      context.emit({ ...context.base(turn.threadId, turnId), type: "runtime.notice", message: `MCP server "${server}" was skipped for this turn: ${context.safeText(reason)}` });
    }
    const questionAllowed = context.toolsEnabled() && allowsTool(scope, { kind: "native", name: ASK_USER_TOOL });
    if (questionAllowed && !tools.definitions.some((definition) => definition.function.name === ASK_USER_TOOL)) {
      tools.definitions.push(ASK_USER_TOOL_DEFINITION);
    }
    const grant: CapabilityGrant = {
      botId: turn.botId ?? "",
      threadId: turn.threadId,
      approvalMode: turn.approvalMode === "full" ? "full" : "ask",
      allowed: new Set(),
      denied: new Set(),
    };
    const mcpSession = createChatCapabilitySession({ session: tools, approval });
    const fileRoot = turn.botId ? workspaceDir(turn.botId) : process.cwd();
    const providers: any[] = [
      new SessionCapabilityProvider("mcp", "mcp", mcpSession, "MCP tools"),
    ];
    // Native built-in tools (file, shell, git, web, tool_search) are always available,
    // like Claude Code's built-in tools. They are not gated by the MCP tools flag.
    providers.push(new NativeFileCapabilityProvider({ root: fileRoot }));
    providers.push(new NativeShellCapabilityProvider({ root: fileRoot }));
    providers.push(new NativeGitCapabilityProvider({ root: fileRoot }));
    providers.push(new NativeWebCapabilityProvider({ root: fileRoot }));
    providers.push(new ToolSearchCapabilityProvider(() => mcpSession));
    providers.push(new SkillCapabilityProvider(turn.botId ?? "", undefined));
    const composite = new CompositeCapabilityRuntime(providers);
    await composite.mountAll({ grant, signal: abort.signal });
    capabilitySession = composite;

    const nativeMessages = messages.slice(0, -1).map((message) => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content : null,
      ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
    }));

    unsubscribe = engine.onEvent(turn.threadId, (event) => {
      switch (event.type) {
        case "model.delta":
          if (event.kind === "assistant_text") roundText += event.delta;
          context.emit({ ...context.base(turn.threadId, turnId), type: "content.delta", streamKind: event.kind, delta: context.safeText(event.delta) });
          break;
        case "usage":
          usage.input += event.input;
          usage.output += event.output;
          hasUsage = true;
          context.emit({ ...context.base(turn.threadId, turnId), type: "thread.token-usage.updated", ...usage });
          break;
        case "tool.calls":
          roundText = "";
          for (const call of event.calls) {
            context.emit({
              ...context.base(turn.threadId, turnId),
              type: "item.started",
              itemType: "tool",
              itemId: call.id,
              title: call.name,
              input: context.preview(call.arguments),
            });
          }
          break;
        case "tool.result":
          context.emit({
            ...context.base(turn.threadId, turnId),
            type: "item.completed",
            itemType: "tool",
            itemId: event.callId,
            ok: event.result.ok,
            output: context.preview({ ok: event.result.ok, result: event.result.content }),
          });
          break;
        case "turn.completed":
          finish(event.ok, event.stopReason ?? null);
          break;
        case "run.failed": {
          const stopReason = event.code === "capability_failed" ? "tool_error"
            : event.code === "incomplete_action" ? "incomplete_action"
            : "error";
          finish(false, stopReason, event.message);
          break;
        }
        case "run.interrupted":
          finish(false, "interrupted");
          break;
        case "run.recovery_required":
          finish(false, "recovery_required", "The operation may have taken effect. Inspect its state before continuing.");
          break;
        case "run.compacted":
          context.emit({ ...context.base(turn.threadId, turnId), type: "runtime.notice", message: `Older context was summarized to fit the model window (${event.tokenEstimate} estimated tokens after compaction).` });
          break;
        case "run.started":
          break;
      }
    });

    const handle = await engine.run({
      botId: turn.botId ?? "",
      threadId: turn.threadId,
      text: nativeText,
      messages: nativeMessages,
      providerModel: { providerId: context.driverKind, modelId: model },
      grant,
      capabilities: capabilitySession,
      signal: abort.signal,
      ...(turn.budget ? { budget: turn.budget } : {}),
      ...(nativeImages.length ? { images: nativeImages } : {}),
      ...(context.nudgeAnnouncedAction ? { nudgeAnnouncedAction: true } : {}),
      ...(turn.toolErrorCorrectiveRounds !== undefined ? { toolErrorCorrectiveRounds: turn.toolErrorCorrectiveRounds } : {}),
    });
    context.steer.impl = (text) => engine.steer(handle.runId, text);
    for (const text of context.steer.queue.splice(0)) await context.steer.impl(text);
    await handle.done;
    if (!completed) finish(false, abort.signal.aborted ? "interrupted" : "error");
  } catch (error) {
    finish(false, abort.signal.aborted ? "interrupted" : "error", error instanceof Error ? error.message : String(error));
  } finally {
    approval.close();
    unsubscribe();
    try {
      if (capabilitySession) await capabilitySession.close();
      else await tools?.close();
    } catch {
      if (!completed) finish(false, "error", "Tool processes could not be stopped; their execution state is uncertain.");
    }
    context.onSettled();
  }
}
