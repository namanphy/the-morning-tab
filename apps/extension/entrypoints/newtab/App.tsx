import { useCallback, useEffect, useState } from "react";
import { DEFAULT_BLOCKED_SITES, DEFAULT_MODEL, PROVIDERS, type HomepageModel, type ProviderId } from "@homepage/agent-core";
import { BUILD_STEPS } from "@/lib/protocol";
import { KEYS, extensionStore, loadHomepage, loadSettings, saveApiKey, saveSetting, type Homepage } from "@/lib/storage";
import { ApiKeySetup } from "./components/ApiKeySetup";
import { BuildProgress } from "./components/BuildProgress";
import { Newspaper } from "./components/Newspaper";
import { SettingsModal } from "./components/SettingsModal";
import { btn, errorBox } from "./components/ui";
import { useHomepageBuild } from "./useHomepageBuild";

export default function App() {
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [apiKeys, setApiKeys] = useState<Record<ProviderId, string | null>>({
    anthropic: null,
    gemini: null,
    openrouter: null,
  });
  const [systemPrompt, setSystemPrompt] = useState("");
  const [blockedSites, setBlockedSites] = useState<string[]>(DEFAULT_BLOCKED_SITES);
  const [models, setModels] = useState<Record<ProviderId, string>>({
    anthropic: DEFAULT_MODEL,
    gemini: PROVIDERS.gemini.defaultModel,
    openrouter: PROVIDERS.openrouter.defaultModel,
  });
  const [autoRebuild, setAutoRebuild] = useState(true);
  /** The latest edition; the layout around it is fixed. */
  const [homepage, setHomepage] = useState<Homepage | null>(null);
  /** A session left mid-flight, offered as "Resume interrupted build". */
  const [resumable, setResumable] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** Expand the full progress view over an existing homepage. */
  const [viewProgress, setViewProgress] = useState(false);
  /** The error the user dismissed, so a stale banner doesn't linger. */
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const { state, build, cancel } = useHomepageBuild(setHomepage);

  // Once a build finishes, drop back to the homepage view.
  useEffect(() => {
    if (!state.running) setViewProgress(false);
  }, [state.running]);

  // Scheduled rebuilds are driven by the worker's alarm, not by opening a tab;
  // useHomepageBuild surfaces any build already in flight.
  useEffect(() => {
    (async () => {
      try {
        const [settings, saved, activeSession] = await Promise.all([
          loadSettings(),
          loadHomepage(),
          extensionStore.get<string>(KEYS.activeSessionId),
        ]);
        setProvider(settings.provider);
        setApiKeys(settings.apiKeys);
        setSystemPrompt(settings.systemPrompt);
        setBlockedSites(settings.blockedSites);
        setModels({ anthropic: settings.model, gemini: settings.geminiModel, openrouter: settings.openrouterModel });
        setAutoRebuild(settings.autoRebuild);
        setResumable(activeSession ?? null);
        if (saved) setHomepage(saved);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveKey = useCallback(async (which: ProviderId, key: string) => {
    await saveApiKey(which, key);
    setApiKeys((keys) => ({ ...keys, [which]: key }));
  }, []);

  /** First-run setup: the provider whose key was just entered becomes the active one. */
  const saveFirstKey = useCallback(
    async (which: ProviderId, key: string) => {
      await saveKey(which, key);
      await saveSetting("provider", which);
      setProvider(which);
    },
    [saveKey],
  );

  const savePrompt = useCallback(
    async (prompt: string, sites: string[]) => {
      await Promise.all([saveSetting("systemPrompt", prompt), saveSetting("blockedSites", sites)]);
      setBlockedSites(sites);
      setSystemPrompt(prompt);
      setShowSettings(false);
      setHomepage(null);
      build();
    },
    [build],
  );

  // These persist immediately; the worker reads them on its next heartbeat or build.
  const changeProvider = useCallback(async (next: ProviderId) => {
    setProvider(next);
    await saveSetting("provider", next);
  }, []);
  const changeModel = useCallback(async (which: ProviderId, next: string) => {
    setModels((m) => ({ ...m, [which]: next }));
    if (which === "gemini") await saveSetting("geminiModel", next.trim());
    else if (which === "openrouter") await saveSetting("openrouterModel", next.trim());
    else await saveSetting("model", next as HomepageModel);
  }, []);
  const toggleAutoRebuild = useCallback(async (next: boolean) => {
    setAutoRebuild(next);
    await saveSetting("autoRebuild", next);
  }, []);

  if (loading) return <div style={{ padding: 20, textAlign: "center" }}>Loading…</div>;
  if (!Object.values(apiKeys).some(Boolean)) return <ApiKeySetup initialProvider={provider} onSave={saveFirstKey} />;

  // With no homepage to fall back to, a running build takes over the tab.
  if (state.running && (!homepage || viewProgress)) {
    return (
      <BuildProgress
        state={state}
        onCancel={cancel}
        onBack={homepage ? () => setViewProgress(false) : undefined}
      />
    );
  }

  const settingsModal = showSettings && (
    <SettingsModal
      initialPrompt={systemPrompt}
      blockedSites={blockedSites}
      provider={provider}
      onChangeProvider={changeProvider}
      apiKeys={apiKeys}
      onSaveKey={saveKey}
      models={models}
      onChangeModel={changeModel}
      autoRebuild={autoRebuild}
      onToggleAutoRebuild={toggleAutoRebuild}
      onClose={() => setShowSettings(false)}
      onSave={savePrompt}
    />
  );

  const toolbar = (
    <>
      {state.running ? (
        // A build is running in the background (from here, another tab, or the
        // scheduled rebuild). Let the user watch it without losing this page.
        <button className="paper-btn paper-btn-live" onClick={() => setViewProgress(true)} title="View build progress">
          <span className="paper-dot" />
          Printing {Math.min(state.stepIndex + 1, BUILD_STEPS.length)}/{BUILD_STEPS.length}
        </button>
      ) : (
        homepage && (
          <button className="paper-btn" onClick={() => build()} title="Rebuild now">
            ↻ Rebuild
          </button>
        )
      )}
      <button className="paper-btn" onClick={() => setShowSettings(true)} title="Settings">
        Settings
      </button>
    </>
  );

  if (!homepage) {
    return (
      <Newspaper edition={null} toolbar={toolbar}>
        <div className="paper-card">
          <h2>Today&apos;s edition</h2>
          <p>
            The agent reads your browsing history, opens the pages you actually follow, and fills
            this front page with what it finds today.
          </p>
          {state.error && <div className="paper-card-error">{state.error}</div>}
          <div className="paper-card-actions">
            <button className="paper-btn paper-btn-primary" onClick={() => build()}>
              Print today&apos;s edition
            </button>
            {resumable && (
              <button className="paper-btn" onClick={() => build({ resume: true })}>
                Resume interrupted build
              </button>
            )}
          </div>
          <p className="paper-card-note">
            {PROVIDERS[provider].label} · {models[provider]}
          </p>
        </div>
        {settingsModal}
      </Newspaper>
    );
  }

  const showError = state.error && dismissedError !== state.error;

  return (
    <>
      {showError && (
        <div
          style={{
            ...errorBox,
            position: "fixed",
            top: 16,
            left: 16,
            right: 16,
            maxWidth: 900,
            margin: "0 auto",
            zIndex: 999,
            padding: "10px 14px",
            borderRadius: 6,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <span style={{ flex: 1 }}>
            <b>Build failed.</b> {state.error}
          </span>
          <button style={{ ...btn, padding: "4px 10px", backgroundColor: "#a02620" }} onClick={() => build()}>
            Retry
          </button>
          <button
            onClick={() => setDismissedError(state.error)}
            style={{
              background: "transparent",
              border: "none",
              color: "#a02620",
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
            }}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <Newspaper edition={homepage.edition} builtAt={homepage.timestamp} toolbar={toolbar} />

      {settingsModal}
    </>
  );
}
