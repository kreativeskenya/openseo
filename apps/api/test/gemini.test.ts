import { beforeEach, describe, expect, it } from "vitest";
import { GeminiError, generate, generateJson, listModels, resetGeminiState } from "../src/lib/gemini";

type Step = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };
type Call = { url: string; model: string; headers: Record<string, string>; body: any };

const ok = (text: string): Step => ({
  body: { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } },
});

/** A fake fetch. The handler decides each reply from the model in the URL and how many times that model was called. */
function fakeFetch(handler: (call: { model: string; n: number }) => Step) {
  const calls: Call[] = [];
  const perModel = new Map<string, number>();
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const model = url.match(/models\/([^:/?]+):generateContent/)?.[1] ?? "";
    const n = (perModel.get(model) ?? 0) + 1;
    perModel.set(model, n);
    calls.push({ url, model, headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body ?? "{}")) });
    const step = handler({ model, n });
    return new Response(step.text ?? JSON.stringify(step.body ?? {}), { status: step.status ?? 200, headers: step.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const clock = { t: 1_000_000 };
const sleeps: number[] = [];
const base = (impl: typeof fetch) => ({
  fetchImpl: impl,
  sleep: async (ms: number) => {
    sleeps.push(ms);
  },
  now: () => clock.t,
});

beforeEach(() => {
  resetGeminiState();
  clock.t = 1_000_000;
  sleeps.length = 0;
});

describe("gemini generate", () => {
  it("answers from the first model and sends the key in a header, never in the URL", async () => {
    const key = "AIzaSyTESTKEY000000000001";
    const f = fakeFetch(() => ok("hello"));
    const result = await generate(key, "prompt", { models: ["m1", "m2"], ...base(f.impl) });
    expect(result).toMatchObject({ text: "hello", model: "m1", fellBack: false, promptTokens: 7, outputTokens: 3, triedModels: ["m1"] });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.headers["x-goog-api-key"]).toBe(key);
    expect(f.calls[0]!.url).not.toContain(key);
  });

  it("retries a 429 on the same model, honouring retry-after, before giving up on it", async () => {
    const f = fakeFetch(({ n }) => (n === 1 ? { status: 429, text: "slow down", headers: { "retry-after": "2" } } : ok("done")));
    const result = await generate("AIzaSyTESTKEY000000000002", "p", { models: ["m1", "m2"], ...base(f.impl) });
    expect(result.model).toBe("m1");
    expect(result.fellBack).toBe(false);
    expect(f.calls.map((c) => c.model)).toEqual(["m1", "m1"]);
    expect(sleeps.some((ms) => ms >= 2000)).toBe(true);
  });

  it("falls back to the next model after repeated 503s", async () => {
    const f = fakeFetch(({ model }) => (model === "m1" ? { status: 503, text: "overloaded" } : ok("from fallback")));
    const result = await generate("AIzaSyTESTKEY000000000003", "p", { models: ["m1", "m2"], ...base(f.impl) });
    expect(result).toMatchObject({ text: "from fallback", model: "m2", fellBack: true, triedModels: ["m1", "m2"] });
    expect(f.calls.map((c) => c.model)).toEqual(["m1", "m1", "m1", "m2"]);
  });

  it("moves on after one call when a model is unavailable (404)", async () => {
    const f = fakeFetch(({ model }) => (model === "m1" ? { status: 404, text: "model not found" } : ok("fine")));
    const result = await generate("AIzaSyTESTKEY000000000004", "p", { models: ["m1", "m2"], ...base(f.impl) });
    expect(result.model).toBe("m2");
    expect(f.calls.map((c) => c.model)).toEqual(["m1", "m2"]);
  });

  it("tries the next model when one returns no text (blocked or empty)", async () => {
    const f = fakeFetch(({ model }) => (model === "m1" ? { body: { candidates: [], promptFeedback: { blockReason: "SAFETY" } } } : ok("second")));
    const result = await generate("AIzaSyTESTKEY000000000005", "p", { models: ["m1", "m2"], ...base(f.impl) });
    expect(result).toMatchObject({ text: "second", model: "m2", fellBack: true });
  });

  it("stops at once on a rejected key and does not try the fallback", async () => {
    const f = fakeFetch(() => ({
      status: 400,
      body: { error: { message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] } },
    }));
    await expect(generate("AIzaSyTESTKEY000000000006", "p", { models: ["m1", "m2"], ...base(f.impl) })).rejects.toMatchObject({ name: "GeminiError", fatal: true });
    expect(f.calls).toHaveLength(1);
  });

  it("treats a leaked-key 403 as fatal, but a plain 403 on one model as a reason to fall back", async () => {
    const leaked = fakeFetch(() => ({ status: 403, text: "Your API key was reported as leaked. Please use another API key." }));
    await expect(generate("AIzaSyTESTKEY000000000007", "p", { models: ["m1", "m2"], ...base(leaked.impl) })).rejects.toMatchObject({ fatal: true });
    expect(leaked.calls).toHaveLength(1);

    resetGeminiState();
    const plain = fakeFetch(({ model }) => (model === "m1" ? { status: 403, text: "permission denied for this model" } : ok("ok")));
    const result = await generate("AIzaSyTESTKEY000000000008", "p", { models: ["m1", "m2"], ...base(plain.impl) });
    expect(result.model).toBe("m2");
  });

  it("skips a model that hit its daily quota on later calls", async () => {
    const key = "AIzaSyTESTKEY000000000009";
    const f = fakeFetch(({ model }) =>
      model === "m1" ? { status: 429, body: { error: { message: "Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier" } } } : ok("hi"),
    );
    const first = await generate(key, "p", { models: ["m1", "m2"], ...base(f.impl) });
    expect(first.model).toBe("m2");
    expect(f.calls.map((c) => c.model)).toEqual(["m1", "m2"]);

    const second = await generate(key, "p", { models: ["m1", "m2"], ...base(f.impl) });
    expect(second.model).toBe("m2");
    expect(f.calls.map((c) => c.model)).toEqual(["m1", "m2", "m2"]);

    // After the cooldown the first model is tried again.
    clock.t += 7 * 60 * 60 * 1000;
    await generate(key, "p", { models: ["m1", "m2"], ...base(f.impl) });
    expect(f.calls.map((c) => c.model).slice(3)).toEqual(["m1", "m2"]);
  });

  it("still tries the last model even while it is cooling down", async () => {
    const key = "AIzaSyTESTKEY000000000010";
    let quota = true;
    const f = fakeFetch(() => (quota ? { status: 429, text: "GenerateRequestsPerDay exhausted" } : ok("back")));
    await expect(generate(key, "p", { models: ["only"], ...base(f.impl) })).rejects.toBeInstanceOf(GeminiError);
    quota = false;
    const result = await generate(key, "p", { models: ["only"], ...base(f.impl) });
    expect(result.text).toBe("back");
  });

  it("never puts the key in an error message", async () => {
    const key = "AIzaSyLEAKCHECK1234567890";
    const f = fakeFetch(() => ({ status: 500, text: `Bad request near ${key}` }));
    const error = await generate(key, "p", { models: ["m1", "m2"], maxAttempts: 1, ...base(f.impl) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiError);
    expect((error as Error).message).not.toContain(key);
    expect((error as Error).message).toContain("[key]");
  });

  it("ignores thought parts and sends the system instruction and JSON mode", async () => {
    const f = fakeFetch(() => ({
      body: { candidates: [{ content: { parts: [{ text: "reasoning", thought: true }, { text: "answer" }] } }] },
    }));
    const result = await generate("AIzaSyTESTKEY000000000011", "p", { models: ["m1"], system: "Be brief", json: true, temperature: 0.1, ...base(f.impl) });
    expect(result.text).toBe("answer");
    expect(f.calls[0]!.body.systemInstruction.parts[0].text).toBe("Be brief");
    expect(f.calls[0]!.body.generationConfig).toMatchObject({ temperature: 0.1, responseMimeType: "application/json" });
  });
});

describe("gemini generateJson", () => {
  it("parses JSON wrapped in a code fence", async () => {
    const fence = "`".repeat(3);
    const f = fakeFetch(() => ok(`${fence}json\n{"b":2}\n${fence}`));
    const result = await generateJson<{ b: number }>("AIzaSyTESTKEY000000000012", "p", { models: ["m1"], ...base(f.impl) });
    expect(result.data).toEqual({ b: 2 });
  });

  it("retries once on invalid JSON with temperature 0", async () => {
    const f = fakeFetch(({ n }) => (n === 1 ? ok("not json") : ok('{"a":1}')));
    const result = await generateJson<{ a: number }>("AIzaSyTESTKEY000000000013", "p", { models: ["m1"], ...base(f.impl) });
    expect(result.data).toEqual({ a: 1 });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.body.generationConfig).toMatchObject({ temperature: 0.2, responseMimeType: "application/json" });
    expect(f.calls[1]!.body.generationConfig.temperature).toBe(0);
  });

  it("throws after two invalid answers", async () => {
    const f = fakeFetch(() => ok("still not json"));
    await expect(generateJson("AIzaSyTESTKEY000000000014", "p", { models: ["m1"], ...base(f.impl) })).rejects.toBeInstanceOf(GeminiError);
    expect(f.calls).toHaveLength(2);
  });
});

describe("gemini listModels", () => {
  it("keeps only models that can generate and strips the models/ prefix", async () => {
    const f = fakeFetch(() => ({
      body: {
        models: [
          { name: "models/gemini-a", supportedGenerationMethods: ["generateContent", "countTokens"] },
          { name: "models/embed-b", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-c", supportedGenerationMethods: ["generateContent"] },
        ],
      },
    }));
    expect(await listModels("AIzaSyTESTKEY000000000015", f.impl)).toEqual(["gemini-a", "gemini-c"]);
  });

  it("flags a bad key as fatal and other failures as not fatal", async () => {
    const bad = fakeFetch(() => ({ status: 400, body: { error: { message: "API key not valid", details: [{ reason: "API_KEY_INVALID" }] } } }));
    await expect(listModels("AIzaSyTESTKEY000000000016", bad.impl)).rejects.toMatchObject({ fatal: true });
    const down = fakeFetch(() => ({ status: 500, text: "boom" }));
    await expect(listModels("AIzaSyTESTKEY000000000017", down.impl)).rejects.toMatchObject({ fatal: false });
  });
});
