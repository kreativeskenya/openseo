import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { decrypt } from "./crypto";
import { conflict } from "./errors";
import { DEFAULT_GEMINI_MODELS } from "./gemini";

/** The user's decrypted Gemini key and model chain. The key stays inside the server; no route returns it. */
export async function getGemini(userId: string): Promise<{ apiKey: string; models: string[] }> {
  const [row] = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId)).limit(1);
  if (!row?.geminiKeyEnc) throw conflict("Add your Gemini API key in Settings first");
  return { apiKey: decrypt(row.geminiKeyEnc), models: row.geminiModels?.length ? row.geminiModels : [...DEFAULT_GEMINI_MODELS] };
}
