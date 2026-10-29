// Plugin loader: dynamically loads custom capability providers and hooks from
// plugin manifests. Plugins are npm packages or local paths with a manifest
// declaring capabilities and hooks.

import { pathToFileURL } from "node:url";
import type { CapabilityDescriptor } from "./contracts.ts";
import type { CapabilityHandler } from "./capability-runtime.ts";

export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly hooks?: ReadonlyArray<string>;
  readonly main?: string;
}

export interface PluginCapability {
  readonly descriptor: CapabilityDescriptor;
  readonly handler: CapabilityHandler;
}

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly module: unknown;
  readonly capabilities: ReadonlyArray<string>;
  readonly hooks: ReadonlyArray<string>;
  readonly capabilityHandlers: ReadonlyMap<string, CapabilityHandler>;
}

export interface PluginLoaderOptions {
  readonly searchPaths: ReadonlyArray<string>;
  readonly allowUnsafe?: boolean;
}

export async function loadPlugin(manifest: PluginManifest, basePath: string): Promise<LoadedPlugin> {
  const main = manifest.main ?? "index.js";
  const url = pathToFileURL(`${basePath}/${main}`).href;
  const module = await import(url);

  // Extract capability handlers from the plugin module.
  // Convention: module exports a `capabilities` object mapping capability
  // names to handler functions, or individual `handle_<name>` functions.
  const capabilityHandlers = new Map<string, CapabilityHandler>();

  // Check for a `capabilities` export (object mapping name -> handler)
  const mod = module as Record<string, unknown>;
  if (mod.capabilities && typeof mod.capabilities === "object") {
    const caps = mod.capabilities as Record<string, unknown>;
    for (const [name, handler] of Object.entries(caps)) {
      if (typeof handler === "function") {
        capabilityHandlers.set(name, handler as CapabilityHandler);
      }
    }
  }

  // Check for individual `handle_<name>` exports
  for (const cap of manifest.capabilities ?? []) {
    const handlerName = `handle_${cap}`;
    if (typeof mod[handlerName] === "function") {
      capabilityHandlers.set(cap, mod[handlerName] as CapabilityHandler);
    }
  }

  return {
    manifest,
    module,
    capabilities: manifest.capabilities ?? [],
    hooks: manifest.hooks ?? [],
    capabilityHandlers,
  };
}

export function validateManifest(manifest: unknown): manifest is PluginManifest {
  if (!manifest || typeof manifest !== "object") return false;
  const m = manifest as Record<string, unknown>;
  if (typeof m.name !== "string" || !m.name) return false;
  if (typeof m.version !== "string" || !m.version) return false;
  if (m.capabilities !== undefined && !Array.isArray(m.capabilities)) return false;
  if (m.hooks !== undefined && !Array.isArray(m.hooks)) return false;
  if (m.main !== undefined && typeof m.main !== "string") return false;
  return true;
}

export function createPluginRegistry() {
  const plugins = new Map<string, LoadedPlugin>();
  return {
    register(plugin: LoadedPlugin): void {
      plugins.set(plugin.manifest.name, plugin);
    },
    get(name: string): LoadedPlugin | undefined {
      return plugins.get(name);
    },
    list(): ReadonlyArray<LoadedPlugin> {
      return [...plugins.values()];
    },
    /** Get all capability handlers from all registered plugins. */
    getCapabilityHandlers(): ReadonlyMap<string, { handler: CapabilityHandler; pluginName: string }> {
      const handlers = new Map<string, { handler: CapabilityHandler; pluginName: string }>();
      for (const plugin of plugins.values()) {
        for (const [name, handler] of plugin.capabilityHandlers) {
          handlers.set(name, { handler, pluginName: plugin.manifest.name });
        }
      }
      return handlers;
    },
    /** Get all capability names from all registered plugins. */
    getCapabilityNames(): ReadonlyArray<string> {
      return [...plugins.values()].flatMap((p) => p.capabilities);
    },
    unregister(name: string): boolean {
      return plugins.delete(name);
    },
    size(): number {
      return plugins.size;
    },
  };
}
