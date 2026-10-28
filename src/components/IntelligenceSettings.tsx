import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card, Switch } from "./SettingsPrimitives";

type Intelligence = NonNullable<ConfigStatus["intelligence"]>;

export function IntelligenceSettings() {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState<Intelligence | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const value = draft ?? state.config?.intelligence ?? { enabled: false };
  const change = (next: Intelligence) => { setDraft(next); setError(""); };
  const save = async () => {
    if (!draft || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ intelligence: { enabled: draft.enabled } }),
      });
      dispatch({ type: "configStatus", config });
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save intelligence settings.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[14px] font-medium">{t("settings.intelligence.title")}</div>
          <div className="text-[12px] text-ink-secondary">{t("settings.intelligence.intro")}</div>
        </div>
        <Switch
          checked={value.enabled}
          onClick={() => change({ enabled: !value.enabled })}
        />
      </div>
      {draft && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-full bg-accent px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
      {error && <div className="mt-2 text-[12px] text-red-500">{error}</div>}
    </Card>
  );
}