// Plugin loader: dynamically loads custom capability providers and hooks from
// plugin manifests. Plugins are npm packages or local paths with a manifest
// declaring capabilities and hooks.

import { pathToFileURL } from "node:url";

export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly hooks?: ReadonlyArray<string>;
  readonly main?: string;
}

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly module: unknown;
  readonly capabilities: ReadonlyArray<string>;
  readonly hooks: ReadonlyArray<string>;
}

export interface PluginLoaderOptions {
  readonly searchPaths: ReadonlyArray<string>;
  readonly allowUnsafe?: boolean;
}

export async function loadPlugin(manifest: PluginManifest, basePath: string): Promise<LoadedPlugin> {
  const main = manifest.main ?? "index.js";
  const url = pathToFileURL(`${basePath}/${main}`).href;
  const module = await import(url);
  return {
    manifest,
    module,
    capabilities: manifest.capabilities ?? [],
    hooks: manifest.hooks ?? [],
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
    unregister(name: string): boolean {
      return plugins.delete(name);
    },
    size(): number {
      return plugins.size;
    },
  };
}