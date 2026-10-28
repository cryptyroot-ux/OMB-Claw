// Caching adapter wrapper: wraps a ModelAdapter and caches identical generate()
// requests. On a cache hit, replays the cached events instead of calling the
// upstream adapter. Only caches non-streaming (completed) responses.

import type { ModelAdapter, ModelEvent, ModelGenerateRequest } from "./contracts.ts";
import { createResponseCache, cacheKey } from "./response-cache.ts";

export function createCachingAdapter(adapter: ModelAdapter, options?: { maxSize?: number; ttlMs?: number }): ModelAdapter {
  const cache = createResponseCache<ModelEvent[]>({ maxSize: options?.maxSize ?? 100, defaultTtlMs: options?.ttlMs ?? 60_000 });

  return {
    providerId: adapter.providerId,
    discoverModels: () => adapter.discoverModels(),
    capabilities: (modelId) => adapter.capabilities(modelId),
    async *generate(request: ModelGenerateRequest): AsyncIterable<ModelEvent> {
      const key = cacheKey({
        model: request.model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        tools: request.tools,
      });

      const cached = cache.get(key);
      if (cached) {
        for (const event of cached) yield event;
        return;
      }

      const collected: ModelEvent[] = [];
      for await (const event of adapter.generate(request)) {
        collected.push(event);
        yield event;
      }
      // Only cache if we got a completion (not interrupted).
      if (collected.some((e) => e.type === "completed")) {
        cache.set(key, collected);
      }
    },
  };
}