/**
 * Model providers. Anthropic runs on Managed Agents (a server-side session and
 * sandbox, see orchestrator.ts). The others speak the OpenAI-compatible chat
 * completions API, and the agent loop runs in the host instead (local-agent.ts).
 */

export type ProviderId = "anthropic" | "gemini" | "openrouter";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Where to get a key. */
  keyUrl: string;
  keyPlaceholder: string;
  /** A cheap sanity check before saving, not a validation. */
  looksLikeKey(key: string): boolean;
  /** Chat-completions base URL; absent for Anthropic, which uses its SDK. */
  baseUrl?: string;
  defaultModel: string;
  /** Who receives the page contents, for the privacy notice. */
  dataNote: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    keyUrl: "https://console.anthropic.com",
    keyPlaceholder: "sk-ant-...",
    looksLikeKey: (k) => k.startsWith("sk-ant-"),
    defaultModel: "claude-sonnet-5-5",
    dataNote: "Pages are sent to the Anthropic API and deleted when each build ends.",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza...",
    looksLikeKey: (k) => k.length >= 20 && !/\s/.test(k),
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    // An alias Google keeps pointed at the current Flash model, so it doesn't go stale.
    defaultModel: "gemini-flash-latest",
    dataNote:
      "Pages are sent to the Gemini API. On Google's free tier, what you send may be used to improve Google's products.",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter (free models)",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-...",
    looksLikeKey: (k) => k.startsWith("sk-or-"),
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "google/gemma-4-31b-it:free",
    dataNote:
      "Pages are sent to OpenRouter and the model's host. Free models' hosts may log or train on what you send.",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && value in PROVIDERS;
}

export interface ModelOption {
  id: string;
  label: string;
}

/**
 * Models the provider currently offers that can call tools. OpenRouter's free
 * list changes week to week, so it is read live rather than hard-coded.
 */
export async function listProviderModels(
  provider: Exclude<ProviderId, "anthropic">,
  apiKey: string | null,
  signal?: AbortSignal,
): Promise<ModelOption[]> {
  if (provider === "openrouter") {
    // Public endpoint; no key needed.
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal });
    if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);
    const body = (await res.json()) as {
      data: Array<{ id: string; name?: string; supported_parameters?: string[] }>;
    };
    const free = body.data
      .filter((m) => m.id.endsWith(":free") && m.supported_parameters?.includes("tools"))
      .map((m) => ({ id: m.id, label: m.name ?? m.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
    // The free router isn't a ":free" id, but it is free and the most available choice.
    const router = body.data.some((m) => m.id === "openrouter/free")
      ? [{ id: "openrouter/free", label: "Any available free model (router)" }]
      : [];
    return [...router, ...free];
  }

  if (!apiKey) return [];
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    headers: { "x-goog-api-key": apiKey },
    signal,
  });
  if (!res.ok) throw new Error(`Gemini models: HTTP ${res.status}`);
  const body = (await res.json()) as {
    models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
  };
  return (body.models ?? [])
    .filter((m) => m.name.includes("gemini") && m.supportedGenerationMethods?.includes("generateContent"))
    .filter((m) => !/(image|tts|audio|live|embedding)/i.test(m.name))
    .map((m) => {
      const id = m.name.replace(/^models\//, "");
      return { id, label: m.displayName ? `${m.displayName} (${id})` : id };
    });
}
