import { createHash } from "node:crypto";

/** Built-in model chain: the first is tried first, the rest are fallbacks. Change names here or in Settings. */
export const DEFAULT_GEMINI_MODELS: readonly string[] = ["gemini-3.5-flash", "gemini-3.5-flash-lite"];

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DAILY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const SHORT_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const MIN_GAP_MS = 1000;
const BAD_KEY = /API_KEY_INVALID|API key not valid|API key expired|reported as leaked/i;
const DAILY_QUOTA = /PerDay|per day|daily/i;

export class GeminiError extends Error {
  readonly status: number | null;
  /** True when no retry or other model can help, for example when Google rejected the key. */
  readonly fatal: boolean;
  constructor(message: string, status: number | null, fatal = false) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.fatal = fatal;
  }
}

export type GenerateOptions = {
  models?: readonly string[];
  json?: boolean;
  temperature?: number;
  system?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type GenerateResult = {
  text: string;
  model: string;
  fellBack: boolean;
  triedModels: string[];
  promptTokens: number;
  outputTokens: number;
};

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

// State is kept per API key (hashed) so quota cooldowns survive across calls but never hold the key itself.
const cooldowns = new Map<string, number>();
const lastCall = new Map<string, number>();

export function resetGeminiState() {
  cooldowns.clear();
  lastCall.clear();
}

const digest = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const backoff = (attempt: number) => Math.min(30_000, 2000 * 2 ** (attempt - 1)) + Math.random() * 500;

function redact(text: string, apiKey: string): string {
  const cleaned = apiKey ? text.split(apiKey).join("[key]") : text;
  return cleaned.replace(/\s+/g, " ").trim().slice(0, 240);
}

function retryDelayMs(res: Response, attempt: number): number {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(30_000, header * 1000) + Math.random() * 500;
  return backoff(attempt);
}

function extractText(data: GeminiResponse): string {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function buildBody(prompt: string, options: GenerateOptions) {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    ...(options.system ? { systemInstruction: { parts: [{ text: options.system }] } } : {}),
    generationConfig: {
      temperature: options.temperature ?? 0.3,
      ...(options.json ? { responseMimeType: "application/json" } : {}),
    },
  };
}

/**
 * One generation with retry and an ordered model fallback. Retries the same model briefly on 429 and 5xx,
 * then moves to the next. A rejected key stops everything at once. Never logs prompts or keys.
 */
export async function generate(apiKey: string, prompt: string, options: GenerateOptions = {}): Promise<GenerateResult> {
  const models = options.models?.length ? [...new Set(options.models)] : [...DEFAULT_GEMINI_MODELS];
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const owner = digest(apiKey);
  const tried: string[] = [];
  let lastMessage = "No model was tried";
  let lastStatus: number | null = null;

  for (let index = 0; index < models.length; index++) {
    const model = models[index] as string;
    const isLast = index === models.length - 1;
    const coolKey = `${owner}|${model}`;
    // A model that just hit its quota is skipped, unless it is the last one left.
    if (!isLast && (cooldowns.get(coolKey) ?? 0) > now()) continue;
    tried.push(model);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const wait = (lastCall.get(owner) ?? 0) + MIN_GAP_MS - now();
      if (wait > 0) await sleep(wait);
      lastCall.set(owner, now());

      let res: Response;
      try {
        res = await fetchImpl(`${BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(buildBody(prompt, options)),
          signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
        });
      } catch (error) {
        lastStatus = null;
        lastMessage = `Network error calling ${model}: ${redact(error instanceof Error ? error.message : String(error), apiKey)}`;
        if (attempt < maxAttempts) {
          await sleep(backoff(attempt));
          continue;
        }
        cooldowns.set(coolKey, now() + SHORT_COOLDOWN_MS);
        break;
      }

      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as GeminiResponse;
        const text = extractText(data);
        if (!text) {
          lastStatus = 200;
          lastMessage = `${model} returned no text (${data.promptFeedback?.blockReason ?? data.candidates?.[0]?.finishReason ?? "empty"})`;
          break;
        }
        return {
          text,
          model,
          fellBack: model !== models[0],
          triedModels: tried,
          promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        };
      }

      const body = await res.text().catch(() => "");
      lastStatus = res.status;
      lastMessage = `Gemini ${res.status} on ${model}: ${redact(body, apiKey)}`;
      if (res.status === 401 || BAD_KEY.test(body)) {
        throw new GeminiError("Google rejected this API key. Create a new one in Google AI Studio.", res.status, true);
      }
      if (res.status === 429 || res.status >= 500) {
        if (res.status === 429 && DAILY_QUOTA.test(body)) {
          cooldowns.set(coolKey, now() + DAILY_COOLDOWN_MS);
          break;
        }
        if (attempt < maxAttempts) {
          await sleep(retryDelayMs(res, attempt));
          continue;
        }
        cooldowns.set(coolKey, now() + SHORT_COOLDOWN_MS);
        break;
      }
      // 400, 403, 404 and other client errors: this model cannot serve the request, so try the next one.
      break;
    }
  }
  throw new GeminiError(`All Gemini models failed. ${lastMessage}`, lastStatus);
}

const stripFences = (text: string) => text.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\x60{3}\s*$/, "");

/** Like generate(), but asks for JSON and parses it. One retry on invalid JSON, with temperature 0. */
export async function generateJson<T = unknown>(
  apiKey: string,
  prompt: string,
  options: Omit<GenerateOptions, "json"> = {},
): Promise<GenerateResult & { data: T }> {
  let lastError = "invalid JSON";
  for (let i = 0; i < 2; i++) {
    const result = await generate(apiKey, prompt, { ...options, json: true, temperature: i === 0 ? (options.temperature ?? 0.2) : 0 });
    try {
      return { ...result, data: JSON.parse(stripFences(result.text)) as T };
    } catch {
      lastError = `${result.model} returned invalid JSON`;
    }
  }
  throw new GeminiError(lastError, null);
}

/** Model names this key can generate with. Free, and a quick way to check that a key works. */
export async function listModels(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  let res: Response;
  try {
    res = await fetchImpl(`${BASE_URL}/models?pageSize=100`, { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new GeminiError(`Could not reach Google: ${redact(error instanceof Error ? error.message : String(error), apiKey)}`, null);
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    if (res.status === 401 || res.status === 403 || BAD_KEY.test(body)) {
      throw new GeminiError("Google rejected this API key. Create a new one in Google AI Studio.", res.status, true);
    }
    throw new GeminiError(`Google returned ${res.status}: ${redact(body, apiKey)}`, res.status);
  }
  let parsed: { models?: { name?: string; supportedGenerationMethods?: string[] }[] } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new GeminiError("Google returned an unreadable model list", res.status);
  }
  return (parsed.models ?? [])
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
    .map((model) => (model.name ?? "").replace(/^models\//, ""))
    .filter(Boolean);
}
