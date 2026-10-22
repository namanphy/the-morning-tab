import {
  DEFAULT_MODEL,
  DEFAULT_BLOCKED_SITES,
  MODEL_CHOICES,
  PROVIDERS,
  STORAGE_KEYS as AGENT_KEYS,
  isProviderId,
  type Edition,
  type HomepageModel,
  type KVStore,
  type ProviderId,
} from "@homepage/agent-core";

/**
 * Everything the extension persists, in one place. All of it lives in
 * chrome.storage.local — including the API key, which anyone with access to the
 * browser profile can read. Fine for a tool you run yourself; not for one you
 * distribute (see ARCHITECTURE.md → Privacy).
 */
export const KEYS = {
  ...AGENT_KEYS,
  homepage: "homepageData",
  systemPrompt: "systemPrompt",
  blockedSites: "blockedSites",
  /** The Anthropic model; the other providers keep theirs under their own keys. */
  model: "model",
  provider: "provider",
  geminiApiKey: "geminiApiKey",
  openrouterApiKey: "openrouterApiKey",
  geminiModel: "geminiModel",
  openrouterModel: "openrouterModel",
  autoRebuild: "autoRebuild",
  /** ISO timestamp of the last auto-build *attempted* (success or not). */
  lastAutoBuildAttempt: "lastAutoBuildAttempt",
  /** Throttled mirror of the live build state, for tabs that open while the worker sleeps. */
  buildSnapshot: "buildSnapshot",
} as const;

export interface Homepage {
  /** The homepage's content; the layout is the extension's own (Newspaper.tsx). */
  edition: Edition;
  /** ISO timestamp of when it was built. */
  timestamp: string;
}

/** Where each provider's key lives. Anthropic keeps the original `apiKey` slot. */
export const API_KEY_KEYS: Record<ProviderId, string> = {
  anthropic: KEYS.apiKey,
  gemini: KEYS.geminiApiKey,
  openrouter: KEYS.openrouterApiKey,
};

export interface Settings {
  provider: ProviderId;
  apiKeys: Record<ProviderId, string | null>;
  /** The active provider's key. */
  apiKey: string | null;
  systemPrompt: string;
  blockedSites: string[];
  /** The Anthropic model. */
  model: HomepageModel;
  geminiModel: string;
  openrouterModel: string;
  /** Unset means on — auto-rebuild is opt-out. */
  autoRebuild: boolean;
}

/** The `KVStore` agent-core persists its agent/environment/session IDs through. */
export const extensionStore: KVStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const result = await browser.storage.local.get(key);
    return result[key] as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await browser.storage.local.remove(key);
  },
};

export async function loadSettings(): Promise<Settings> {
  const s = await browser.storage.local.get([
    ...Object.values(API_KEY_KEYS),
    KEYS.provider,
    KEYS.systemPrompt,
    KEYS.blockedSites,
    KEYS.model,
    KEYS.geminiModel,
    KEYS.openrouterModel,
    KEYS.autoRebuild,
  ]);
  const model = s[KEYS.model] as string | undefined;
  const storedProvider: unknown = s[KEYS.provider];
  const provider: ProviderId = isProviderId(storedProvider) ? storedProvider : "anthropic";
  const key = (id: ProviderId) => (s[API_KEY_KEYS[id]] as string | undefined) || null;
  const apiKeys = { anthropic: key("anthropic"), gemini: key("gemini"), openrouter: key("openrouter") };
  return {
    provider,
    apiKeys,
    apiKey: apiKeys[provider],
    systemPrompt: (s[KEYS.systemPrompt] as string | undefined) ?? "",
    blockedSites: (s[KEYS.blockedSites] as string[] | undefined) ?? [...DEFAULT_BLOCKED_SITES],
    // Fall back if a stored model is no longer offered.
    model: MODEL_CHOICES.find((m) => m.id === model)?.id ?? DEFAULT_MODEL,
    // Free-form: these providers' model lists change too often to validate against.
    geminiModel: (s[KEYS.geminiModel] as string | undefined) || PROVIDERS.gemini.defaultModel,
    openrouterModel: (s[KEYS.openrouterModel] as string | undefined) || PROVIDERS.openrouter.defaultModel,
    autoRebuild: s[KEYS.autoRebuild] !== false,
  };
}

export async function saveSetting<
  K extends "provider" | "systemPrompt" | "blockedSites" | "model" | "geminiModel" | "openrouterModel" | "autoRebuild",
>(
  key: K,
  value: Settings[K],
): Promise<void> {
  await browser.storage.local.set({ [KEYS[key]]: value });
}

export async function saveApiKey(provider: ProviderId, key: string | null): Promise<void> {
  if (key) await browser.storage.local.set({ [API_KEY_KEYS[provider]]: key });
  else await browser.storage.local.remove(API_KEY_KEYS[provider]);
}

/** The model the given provider builds with. */
export function modelFor(settings: Settings, provider: ProviderId = settings.provider): string {
  if (provider === "gemini") return settings.geminiModel;
  if (provider === "openrouter") return settings.openrouterModel;
  return settings.model;
}

export async function loadHomepage(): Promise<Homepage | undefined> {
  const homepage = await extensionStore.get<Partial<Homepage> & { code?: string }>(KEYS.homepage);
  // Homepages from before the fixed layout were model-written code; they don't
  // render any more, and the next build replaces them.
  return homepage?.edition && homepage.timestamp ? { edition: homepage.edition, timestamp: homepage.timestamp } : undefined;
}

export async function saveHomepage(edition: Edition): Promise<Homepage> {
  const homepage: Homepage = { edition, timestamp: new Date().toISOString() };
  await extensionStore.set(KEYS.homepage, homepage);
  return homepage;
}
