import { useState } from "react";
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from "@homepage/agent-core";
import { btn } from "./ui";

export function ApiKeySetup({
  initialProvider,
  onSave,
}: {
  initialProvider: ProviderId;
  onSave: (provider: ProviderId, key: string) => void;
}) {
  const [provider, setProvider] = useState<ProviderId>(initialProvider);
  const [value, setValue] = useState("");
  const info = PROVIDERS[provider];
  const valid = info.looksLikeKey(value.trim());

  return (
    <div style={{ maxWidth: 520, margin: "12vh auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24 }}>Connect a model provider</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        The agent runs inside this extension and talks to the provider&apos;s API directly. Your key
        is stored in <code>chrome.storage.local</code> on this machine and is only sent to that
        provider.
      </p>
      <div role="radiogroup" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "16px 0" }}>
        {PROVIDER_IDS.map((id) => (
          <button
            key={id}
            role="radio"
            aria-checked={provider === id}
            onClick={() => {
              setProvider(id);
              setValue("");
            }}
            style={{
              ...btn,
              backgroundColor: provider === id ? "#0066cc" : "white",
              color: provider === id ? "white" : "#333",
              border: "1px solid #ccc",
            }}
          >
            {PROVIDERS[id].label}
          </button>
        ))}
      </div>
      <p style={{ color: "#555", fontSize: 14, lineHeight: 1.5 }}>
        Get a key at{" "}
        <a href={info.keyUrl} target="_blank" rel="noreferrer">
          {new URL(info.keyUrl).host}
        </a>
        . {info.dataNote}
      </p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={info.keyPlaceholder}
        aria-label={`${info.label} API key`}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: 12,
          fontSize: 14,
          borderRadius: 4,
          border: "1px solid #ddd",
          fontFamily: "ui-monospace, monospace",
        }}
      />
      <button
        style={{ ...btn, marginTop: 16, opacity: valid ? 1 : 0.5 }}
        disabled={!valid}
        onClick={() => onSave(provider, value.trim())}
      >
        Save key
      </button>
    </div>
  );
}
