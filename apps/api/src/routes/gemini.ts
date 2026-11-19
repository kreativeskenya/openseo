import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../db";
import { requireSessionUser } from "../lib/context";
import { encrypt } from "../lib/crypto";
import { badRequest, parse } from "../lib/errors";
import { DEFAULT_GEMINI_MODELS, GeminiError, generate, listModels } from "../lib/gemini";
import { getGemini } from "../lib/gemini-key";

async function geminiSettings(userId: string) {
  const [row] = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId)).limit(1);
  return {
    hasGeminiKey: Boolean(row?.geminiKeyEnc),
    geminiKeyHint: row?.geminiKeyHint ?? null,
    geminiKeyCheckedAt: row?.geminiKeyCheckedAt ?? null,
    geminiModels: row?.geminiModels ?? null,
    defaultGeminiModels: [...DEFAULT_GEMINI_MODELS],
  };
}

const modelName = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,78}$/, "Use the model name only, for example gemini-3.5-flash");

export async function geminiRoutes(app: FastifyInstance) {
  // Store (or replace) the Gemini key. It is checked with Google first, encrypted, and never returned.
  app.put("/settings/gemini-key", async (request) => {
    const user = await requireSessionUser(request);
    const { apiKey } = parse(z.object({ apiKey: z.string().trim().min(20).max(300).regex(/^[\w.-]+$/, "That does not look like an API key") }), request.body);
    try {
      await listModels(apiKey);
    } catch (error) {
      throw badRequest(error instanceof GeminiError ? error.message : "Could not check the key with Google");
    }
    const values = {
      geminiKeyEnc: encrypt(apiKey),
      geminiKeyHint: `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`,
      geminiKeyCheckedAt: new Date(),
    };
    await db
      .insert(schema.userSettings)
      .values({ userId: user.id, ...values })
      .onConflictDoUpdate({ target: schema.userSettings.userId, set: values });
    return { ok: true, data: await geminiSettings(user.id) };
  });

  app.delete("/settings/gemini-key", async (request) => {
    const user = await requireSessionUser(request);
    await db
      .update(schema.userSettings)
      .set({ geminiKeyEnc: null, geminiKeyHint: null, geminiKeyCheckedAt: null })
      .where(eq(schema.userSettings.userId, user.id));
    return { ok: true, data: await geminiSettings(user.id) };
  });

  // The ordered model chain: the first is tried first, the rest are fallbacks. null goes back to the default.
  app.put("/settings/gemini-models", async (request) => {
    const user = await requireSessionUser(request);
    const { models } = parse(z.object({ models: z.array(modelName).min(1).max(4).nullable() }), request.body);
    const value = models ? [...new Set(models)] : null;
    await db
      .insert(schema.userSettings)
      .values({ userId: user.id, geminiModels: value })
      .onConflictDoUpdate({ target: schema.userSettings.userId, set: { geminiModels: value } });
    return { ok: true, data: await geminiSettings(user.id) };
  });

  // Lists the models Google offers this key and makes one tiny generation through the configured chain.
  app.post("/settings/gemini-test", async (request) => {
    const user = await requireSessionUser(request);
    const { apiKey, models } = await getGemini(user.id);
    try {
      const available = await listModels(apiKey);
      const result = await generate(apiKey, "Reply with the single word: ok", { models, temperature: 0 });
      await db.update(schema.userSettings).set({ geminiKeyCheckedAt: new Date() }).where(eq(schema.userSettings.userId, user.id));
      return {
        ok: true,
        data: {
          usedModel: result.model,
          fellBack: result.fellBack,
          reply: result.text.trim().slice(0, 40),
          configured: models.map((name) => ({ name, listed: available.includes(name) })),
          availableCount: available.length,
        },
      };
    } catch (error) {
      if (error instanceof GeminiError) throw badRequest(error.message);
      throw error;
    }
  });
}
