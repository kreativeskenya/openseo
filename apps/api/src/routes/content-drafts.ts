import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dataDb, schema } from "../db";
import { DRAFT_STATUSES } from "../db/data-schema";
import { requireProject, requireUser } from "../lib/context";
import { AppError, badRequest, notFound, parse, uuidParam } from "../lib/errors";
import { generateJson } from "../lib/gemini";
import { getGemini } from "../lib/gemini-key";
import { buildInput, buildPrompt, checkDraft, normalizeContent } from "../services/content-writer";

const draftBody = z.object({ keyword: z.string().trim().max(100).nullish() });
const draftPatch = z.object({ status: z.enum(DRAFT_STATUSES), acknowledge: z.boolean().optional() });

async function ownedStore(userId: string, storeId: string) {
  const [store] = await dataDb.select().from(schema.contentStores).where(eq(schema.contentStores.id, uuidParam(storeId, "Store"))).limit(1);
  if (!store) throw notFound("Store");
  await requireProject(userId, store.projectId);
  return store;
}

async function ownedDraft(userId: string, draftId: string) {
  const [draft] = await dataDb.select().from(schema.contentDrafts).where(eq(schema.contentDrafts.id, uuidParam(draftId, "Draft"))).limit(1);
  if (!draft) throw notFound("Draft");
  await requireProject(userId, draft.projectId);
  return draft;
}

export async function contentDraftRoutes(app: FastifyInstance) {
  // Writes one draft for one product, now. It uses the user's own Gemini key and nothing else.
  app.post<{ Params: { productId: string } }>("/content/products/:productId/draft", async (request, reply) => {
    const user = await requireUser(request);
    const [product] = await dataDb.select().from(schema.contentProducts).where(eq(schema.contentProducts.id, uuidParam(request.params.productId, "Product"))).limit(1);
    if (!product) throw notFound("Product");
    const store = await ownedStore(user.id, product.storeId);
    const body = parse(draftBody, request.body ?? {});

    const facts = await dataDb
      .select()
      .from(schema.contentFacts)
      .where(
        and(
          eq(schema.contentFacts.projectId, store.projectId),
          eq(schema.contentFacts.verified, true),
          or(eq(schema.contentFacts.storeId, store.id), isNull(schema.contentFacts.storeId)),
        ),
      );
    const input = buildInput(product, facts, { keyword: body.keyword });
    const { system, prompt } = buildPrompt(input);
    const { apiKey, models } = await getGemini(user.id);

    let result: Awaited<ReturnType<typeof generateJson>>;
    try {
      result = await generateJson(apiKey, prompt, { models, system, temperature: 0.4 });
    } catch (error) {
      if (error instanceof Error && error.name === "GeminiError") throw new AppError(502, "writer_failed", error.message);
      throw error;
    }
    const content = normalizeContent(result.data);
    if (!content) throw new AppError(502, "writer_failed", "The writer answered in the wrong shape. Try again.");

    const [draft] = await dataDb
      .insert(schema.contentDrafts)
      .values({
        projectId: store.projectId,
        storeId: store.id,
        productId: product.id,
        productName: product.name,
        keyword: input.keyword,
        content,
        input,
        problems: checkDraft(content, input),
        model: result.model,
        promptTokens: result.promptTokens,
        outputTokens: result.outputTokens,
      })
      .returning();
    return reply.status(201).send({ ok: true, data: draft });
  });

  app.get<{ Params: { storeId: string }; Querystring: { status?: string } }>("/content/stores/:storeId/drafts", async (request) => {
    const user = await requireUser(request);
    const store = await ownedStore(user.id, request.params.storeId);
    const status = DRAFT_STATUSES.find((value) => value === request.query.status);
    const where = status ? and(eq(schema.contentDrafts.storeId, store.id), eq(schema.contentDrafts.status, status)) : eq(schema.contentDrafts.storeId, store.id);
    const rows = await dataDb.select().from(schema.contentDrafts).where(where).orderBy(desc(schema.contentDrafts.createdAt)).limit(100);
    return { ok: true, data: rows };
  });

  app.patch<{ Params: { draftId: string } }>("/content/drafts/:draftId", async (request) => {
    const user = await requireUser(request);
    const draft = await ownedDraft(user.id, request.params.draftId);
    const patch = parse(draftPatch, request.body);
    if (patch.status === "approved" && draft.problems.length > 0 && !patch.acknowledge) {
      throw badRequest("This draft has flagged items. Read them, then approve again with acknowledge set to true.");
    }
    const [updated] = await dataDb.update(schema.contentDrafts).set({ status: patch.status }).where(eq(schema.contentDrafts.id, draft.id)).returning();
    return { ok: true, data: updated };
  });

  app.delete<{ Params: { draftId: string } }>("/content/drafts/:draftId", async (request) => {
    const user = await requireUser(request);
    const draft = await ownedDraft(user.id, request.params.draftId);
    await dataDb.delete(schema.contentDrafts).where(eq(schema.contentDrafts.id, draft.id));
    return { ok: true, data: { id: draft.id } };
  });
}
