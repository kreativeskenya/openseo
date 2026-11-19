"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input } from "@/components/ui";
import { api, dateTime } from "@/lib/api";
import type { Me } from "@/lib/auth";

const DEFAULT_PRIMARY = "gemini-3.5-flash";
const DEFAULT_FALLBACK = "gemini-3.5-flash-lite";

type TestResult = {
  usedModel: string;
  fellBack: boolean;
  reply: string;
  configured: { name: string; listed: boolean }[];
  availableCount: number;
};
type Wrapped<T> = T | { ok: boolean; data: T };
const unwrap = <T,>(value: Wrapped<T>): T =>
  value && typeof value === "object" && "ok" in value && "data" in value ? (value as { data: T }).data : (value as T);

export function GeminiKeyCard({ settings }: { settings: Me["settings"] }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [primary, setPrimary] = useState(settings.geminiModels?.[0] ?? DEFAULT_PRIMARY);
  const [fallback, setFallback] = useState(settings.geminiModels?.[1] ?? DEFAULT_FALLBACK);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["me"] });

  const save = useMutation({
    mutationFn: () => api("/settings/gemini-key", { method: "PUT", body: { apiKey: value.trim() } }),
    onSuccess: () => {
      setValue("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api("/settings/gemini-key", { method: "DELETE" }),
    onSuccess: refresh,
  });
  const saveModels = useMutation({
    mutationFn: () => api("/settings/gemini-models", { method: "PUT", body: { models: [primary.trim(), fallback.trim()].filter(Boolean) } }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: async () => unwrap((await api("/settings/gemini-test", { method: "POST", body: {} })) as Wrapped<TestResult>),
    onSuccess: refresh,
  });

  return (
    <Card>
      <CardHeader
        title="Gemini API key"
        description="Content Studio writes with your own Google AI Studio key. It is encrypted at rest and never shown again."
        action={settings.hasGeminiKey ? <Badge tone="pos">Connected</Badge> : <Badge tone="warn">Not set</Badge>}
      />
      <div className="space-y-4 p-4">
        {settings.hasGeminiKey && (
          <p className="text-[13px] text-muted">
            Current key <span className="font-mono text-ink">{settings.geminiKeyHint}</span>, checked {dateTime(settings.geminiKeyCheckedAt)}.
          </p>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="min-w-64 flex-1">
            <Field label={settings.hasGeminiKey ? "Replace key" : "API key"}>
              <Input value={value} onChange={(event) => setValue(event.target.value)} type="password" autoComplete="off" placeholder="Paste your Gemini API key" required />
            </Field>
          </div>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!value.trim()}>
            Save key
          </Button>
          {settings.hasGeminiKey && (
            <Button
              type="button"
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                if (window.confirm("Remove your Gemini key?")) remove.mutate();
              }}
            >
              Remove
            </Button>
          )}
        </form>
        <ErrorNote error={save.error ?? remove.error} />

        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            saveModels.mutate();
          }}
        >
          <div className="min-w-48 flex-1">
            <Field label="First model">
              <Input value={primary} onChange={(event) => setPrimary(event.target.value)} placeholder={DEFAULT_PRIMARY} required />
            </Field>
          </div>
          <div className="min-w-48 flex-1">
            <Field label="Fallback model (used if the first fails)">
              <Input value={fallback} onChange={(event) => setFallback(event.target.value)} placeholder={DEFAULT_FALLBACK} />
            </Field>
          </div>
          <Button type="submit" loading={saveModels.isPending} disabled={!primary.trim()}>
            Save models
          </Button>
        </form>
        <ErrorNote error={saveModels.error} />

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" loading={test.isPending} disabled={!settings.hasGeminiKey} onClick={() => test.mutate()}>
            Test connection
          </Button>
          {!settings.hasGeminiKey && <span className="text-xs text-muted">Save a key first.</span>}
        </div>
        <ErrorNote error={test.error} />
        {test.data && (
          <div className="rounded-md border border-line bg-sunken px-3 py-2.5 text-xs leading-relaxed text-muted">
            <p className="font-semibold text-ink">
              Connection works. Answered by <span className="font-mono">{test.data.usedModel}</span>
              {test.data.fellBack ? " (the fallback, because the first model failed)" : ""}.
            </p>
            <p className="mt-1">Google lists {test.data.availableCount} models for this key.</p>
            <ul className="mt-1 space-y-0.5">
              {test.data.configured.map((model) => (
                <li key={model.name}>
                  <span className="font-mono">{model.name}</span>: {model.listed ? "found" : "not in Google's list for this key, check the name"}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted">Free keys have daily and per-minute limits. If the first model is busy or out of quota, OpenSEO switches to the fallback automatically.</p>
      </div>
    </Card>
  );
}
