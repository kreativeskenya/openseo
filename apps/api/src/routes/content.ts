import { zDomain } from "@openseo/shared";
import { and, asc, eq, ilike, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dataDb, schema } from "../db";
import { FACT_KINDS } from "../db/data-schema";
import { requireProject, requireUser } from "../lib/context";
import { toDomain } from "../lib/domain";
import { badRequest, conflict, isUniqueViolation, notFound, parse, uuidParam } from "../lib/errors";
import { ImportError, normalizeCsv, sameProduct, type ImportRow } from "../services/content-import";

const CSV_LIMIT = 10 * 1024 * 1024;
const blank = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};
const money = z.number().positive().max(1_000_000_000).nullable();
const factKind = z.enum(FACT_KINDS);

const storeInput = z.object({ name: z.string().trim().min(1).max(120), domain: zDomain(), notes: z.string().trim().max(2000).nullish() });
const storePatch = z.object({ name: z.string().trim().min(1).max(120).optional(), domain: zDomain().optional(), notes: z.string().trim().max(2000).nullable().optional() });
const productPatch = z.object({
  name: z.string().trim().min(1).max(300).optional(),
  brand: z.string().trim().max(80).nullable().optional(),
  category: z.string().trim().max(80).nullable().optional(),
  description: z.string().max(4000).optional(),
  specs: z.record(z.string().max(60), z.string().max(200)).refine((o) => Object.keys(o).length <= 40, "At most 40 specs").optional(),
  priceKes: money.optional(),
  salePriceKes: money.optional(),
  warranty: z.string().trim().max(60).nullable().optional(),
});
const factInput = z.object({
  kind: factKind,
  statement: z.string().trim().min(3).max(600),
  source: z.string().trim().max(300).nullish(),
  verified: z.boolean().default(false),
  storeId: z.string().nullish(),
});
const factBulk = z.object({ kind: factKind, storeId: z.string().nullish(), lines: z.string().max(20000) });
const factPatch = z.object({
  kind: factKind.optional(),
  statement: z.string().trim().min(3).max(600).optional(),
  source: z.string().trim().max(300).nullable().optional(),
  verified: z.boolean().optional(),
});

const NEEDS_SOURCE = "Add where this fact comes from before marking it verified";

async function loadStore(userId: string, storeId: string) {
  const [store] = await dataDb.select().from(schema.contentStores).where(eq(schema.contentStores.id, uuidParam(storeId, "Store"))).limit(1);
  if (!store) throw notFound("Store");
  await requireProject(userId, store.projectId);
  return store;
}

async function loadProduct(userId: string, productId: string) {
  const [product] = await dataDb.select().from(schema.contentProducts).where(eq(schema.contentProducts.id, uuidParam(productId, "Product"))).limit(1);
  if (!product) throw notFound("Product");
  await loadStore(userId, product.storeId);
  return product;
}

async function loadFact(userId: string, factId: string) {
  const [fact] = await dataDb.select().from(schema.contentFacts).where(eq(schema.contentFacts.id, uuidParam(factId, "Fact"))).limit(1);
  if (!fact) throw notFound("Fact");
  await requireProject(userId, fact.projectId);
  return fact;
}

async function storeInProject(projectId: string, storeId: string | null | undefined) {
  if (!storeId) return null;
  const [store] = await dataDb
    .select()
    .from(schema.contentStores)
    .where(and(eq(schema.contentStores.id, uuidParam(storeId, "Store")), eq(schema.contentStores.projectId, projectId)))
    .limit(1);
  if (!store) throw notFound("Store");
  return store;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

export async function contentRoutes(app: FastifyInstance) {
  // The dashboard sends the file as JSON ({"csv": "..."}); scripts can send it as text/csv.
  app.addContentTypeParser(["text/csv", "application/csv"], { parseAs: "string", bodyLimit: CSV_LIMIT }, (_request, body, done) => done(null, body));

  // ── Stores ────────────────────────────────────────────────────────────────
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/content/stores", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const rows = await dataDb
      .select({
        store: schema.contentStores,
        // Correlated subqueries name the outer table explicitly: a bare "id" would bind to the inner table.
        products: sql<number>`(select count(*)::int from content_products p where p.store_id = "content_stores"."id")`,
        facts: sql<number>`(select count(*)::int from content_facts f where f.store_id = "content_stores"."id")`,
      })
      .from(schema.contentStores)
      .where(eq(schema.contentStores.projectId, project.id))
      .orderBy(asc(schema.contentStores.name));
    return { ok: true, data: rows.map((r) => ({ ...r.store, productCount: r.products, factCount: r.facts })) };
  });

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/content/stores", async (request, reply) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const input = parse(storeInput, request.body);
    try {
      const [store] = await dataDb
        .insert(schema.contentStores)
        .values({ projectId: project.id, name: input.name, domain: toDomain(input.domain), notes: blank(input.notes) })
        .returning();
      return reply.status(201).send({ ok: true, data: store });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("This store is already in the project");
      throw error;
    }
  });

  app.patch<{ Params: { storeId: string } }>("/content/stores/:storeId", async (request) => {
    const user = await requireUser(request);
    const store = await loadStore(user.id, request.params.storeId);
    const patch = parse(storePatch, request.body);
    const set: Partial<typeof schema.contentStores.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.domain !== undefined) set.domain = toDomain(patch.domain);
    if (patch.notes !== undefined) set.notes = blank(patch.notes);
    if (!Object.keys(set).length) throw badRequest("Nothing to change");
    try {
      const [updated] = await dataDb.update(schema.contentStores).set(set).where(eq(schema.contentStores.id, store.id)).returning();
      return { ok: true, data: updated };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("This store is already in the project");
      throw error;
    }
  });

  app.delete<{ Params: { storeId: string } }>("/content/stores/:storeId", async (request) => {
    const user = await requireUser(request);
    const store = await loadStore(user.id, request.params.storeId);
    await dataDb.delete(schema.contentStores).where(eq(schema.contentStores.id, store.id));
    return { ok: true, data: { id: store.id } };
  });

  // ── Products ──────────────────────────────────────────────────────────────
  // mode=preview (default) reports what would change and writes nothing; mode=commit saves it.
  app.post<{ Params: { storeId: string }; Querystring: { mode?: string } }>(
    "/content/stores/:storeId/products/import",
    { bodyLimit: CSV_LIMIT },
    async (request) => {
      const user = await requireUser(request);
      const store = await loadStore(user.id, request.params.storeId);
      const rawMode = request.query.mode ?? "preview";
      if (rawMode !== "preview" && rawMode !== "commit") throw badRequest("mode must be preview or commit");
      const body = request.body as unknown;
      const csv = typeof body === "string" ? body : typeof (body as { csv?: unknown } | null)?.csv === "string" ? (body as { csv: string }).csv : "";
      if (!csv.trim()) throw badRequest('Send the CSV as the request body (text/csv) or as JSON: {"csv": "..."}');

      let parsed;
      try {
        parsed = normalizeCsv(csv);
      } catch (error) {
        if (error instanceof ImportError) throw badRequest(error.message);
        throw error;
      }

      const existing = new Map((await dataDb.select().from(schema.contentProducts).where(eq(schema.contentProducts.storeId, store.id))).map((p) => [p.slug, p]));
      const created: ImportRow[] = [];
      const updated: { row: ImportRow; id: string; priceChanged: boolean }[] = [];
      let unchanged = 0;
      for (const row of parsed.rows) {
        const found = existing.get(row.slug);
        if (!found) created.push(row);
        else if (sameProduct(found, row)) unchanged++;
        else updated.push({ row, id: found.id, priceChanged: found.priceKes !== row.priceKes || found.salePriceKes !== row.salePriceKes });
      }

      if (rawMode === "commit") {
        const now = new Date();
        for (let i = 0; i < created.length; i += 200) {
          await dataDb
            .insert(schema.contentProducts)
            .values(created.slice(i, i + 200).map((row) => ({ storeId: store.id, ...row, priceUpdatedAt: row.priceKes === null ? null : now })))
            .onConflictDoNothing();
        }
        for (const u of updated) {
          await dataDb
            .update(schema.contentProducts)
            .set({
              name: u.row.name,
              description: u.row.description,
              specs: u.row.specs,
              priceKes: u.row.priceKes,
              salePriceKes: u.row.salePriceKes,
              warranty: u.row.warranty,
              ...(u.row.url !== null ? { url: u.row.url } : {}),
              ...(u.row.brand !== null ? { brand: u.row.brand } : {}),
              ...(u.row.category !== null ? { category: u.row.category } : {}),
              ...(u.priceChanged ? { priceUpdatedAt: u.row.priceKes === null ? null : now } : {}),
            })
            .where(eq(schema.contentProducts.id, u.id));
        }
      }

      return {
        ok: true,
        data: {
          mode: rawMode,
          total: parsed.total,
          created: created.length,
          updated: updated.length,
          priceChanges: updated.filter((u) => u.priceChanged).length,
          unchanged,
          skipped: parsed.skipped,
          duplicates: parsed.duplicates,
          noPrice: parsed.noPrice,
          noWarranty: parsed.noWarranty,
          ignoredColumns: parsed.ignoredColumns,
          examples: { created: created.slice(0, 5).map((r) => r.name), updated: updated.slice(0, 5).map((u) => u.row.name) },
        },
      };
    },
  );

  app.get<{ Params: { storeId: string }; Querystring: { q?: string; limit?: string; offset?: string } }>("/content/stores/:storeId/products", async (request) => {
    const user = await requireUser(request);
    const store = await loadStore(user.id, request.params.storeId);
    const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
    const offset = Math.max(0, Number(request.query.offset) || 0);
    const q = request.query.q?.trim().slice(0, 100);
    const where = q
      ? and(eq(schema.contentProducts.storeId, store.id), ilike(schema.contentProducts.name, `%${escapeLike(q)}%`))
      : eq(schema.contentProducts.storeId, store.id);
    const [{ count } = { count: 0 }] = await dataDb.select({ count: sql<number>`count(*)::int` }).from(schema.contentProducts).where(where);
    const items = await dataDb.select().from(schema.contentProducts).where(where).orderBy(asc(schema.contentProducts.name)).limit(limit).offset(offset);
    return { ok: true, data: { total: count, items } };
  });

  app.patch<{ Params: { productId: string } }>("/content/products/:productId", async (request) => {
    const user = await requireUser(request);
    const product = await loadProduct(user.id, request.params.productId);
    const patch = parse(productPatch, request.body);
    const set: Partial<typeof schema.contentProducts.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.brand !== undefined) set.brand = blank(patch.brand);
    if (patch.category !== undefined) set.category = blank(patch.category);
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.specs !== undefined) set.specs = patch.specs;
    if (patch.warranty !== undefined) set.warranty = blank(patch.warranty);
    if (patch.salePriceKes !== undefined) set.salePriceKes = patch.salePriceKes;
    if (patch.priceKes !== undefined) set.priceKes = patch.priceKes;
    if (!Object.keys(set).length) throw badRequest("Nothing to change");
    const priceMoved =
      (patch.priceKes !== undefined && patch.priceKes !== product.priceKes) || (patch.salePriceKes !== undefined && patch.salePriceKes !== product.salePriceKes);
    if (priceMoved) set.priceUpdatedAt = (set.priceKes ?? product.priceKes) === null ? null : new Date();
    const [updated] = await dataDb.update(schema.contentProducts).set(set).where(eq(schema.contentProducts.id, product.id)).returning();
    return { ok: true, data: updated };
  });

  app.delete<{ Params: { productId: string } }>("/content/products/:productId", async (request) => {
    const user = await requireUser(request);
    const product = await loadProduct(user.id, request.params.productId);
    await dataDb.delete(schema.contentProducts).where(eq(schema.contentProducts.id, product.id));
    return { ok: true, data: { id: product.id } };
  });

  // ── Facts the writer may state as store-wide claims (delivery, payment, warranty, location…) ──
  app.get<{ Params: { projectId: string }; Querystring: { storeId?: string } }>("/projects/:projectId/content/facts", async (request) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const store = await storeInProject(project.id, request.query.storeId);
    const where = store
      ? and(eq(schema.contentFacts.projectId, project.id), eq(schema.contentFacts.storeId, store.id))
      : eq(schema.contentFacts.projectId, project.id);
    const rows = await dataDb.select().from(schema.contentFacts).where(where).orderBy(asc(schema.contentFacts.kind), asc(schema.contentFacts.createdAt));
    return { ok: true, data: rows };
  });

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/content/facts", async (request, reply) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const input = parse(factInput, request.body);
    const store = await storeInProject(project.id, input.storeId);
    const source = blank(input.source);
    if (input.verified && !source) throw badRequest(NEEDS_SOURCE);
    const [fact] = await dataDb
      .insert(schema.contentFacts)
      .values({ projectId: project.id, storeId: store?.id ?? null, kind: input.kind, statement: input.statement, source, verified: input.verified })
      .returning();
    return reply.status(201).send({ ok: true, data: fact });
  });

  // One fact per line. They start unverified: nothing is written as a store-wide claim until you check it.
  app.post<{ Params: { projectId: string } }>("/projects/:projectId/content/facts/bulk", async (request, reply) => {
    const user = await requireUser(request);
    const project = await requireProject(user.id, request.params.projectId);
    const input = parse(factBulk, request.body);
    const store = await storeInProject(project.id, input.storeId);
    const statements = [
      ...new Set(
        input.lines
          .split(/\r?\n/)
          .map((line) => line.replace(/^[\s*•-]+/, "").trim())
          .filter((line) => line.length >= 3 && line.length <= 600),
      ),
    ].slice(0, 100);
    if (!statements.length) throw badRequest("Add at least one line of 3 or more characters");
    const rows = await dataDb
      .insert(schema.contentFacts)
      .values(statements.map((statement) => ({ projectId: project.id, storeId: store?.id ?? null, kind: input.kind, statement, source: null, verified: false })))
      .returning();
    return reply.status(201).send({ ok: true, data: rows });
  });

  app.patch<{ Params: { factId: string } }>("/content/facts/:factId", async (request) => {
    const user = await requireUser(request);
    const fact = await loadFact(user.id, request.params.factId);
    const patch = parse(factPatch, request.body);
    const statementChanged = patch.statement !== undefined && patch.statement !== fact.statement;
    // Rewording a fact withdraws its verification until you confirm it again.
    const verified = patch.verified ?? (statementChanged ? false : fact.verified);
    const source = patch.source !== undefined ? blank(patch.source) : fact.source;
    if (verified && !source) throw badRequest(NEEDS_SOURCE);
    const [updated] = await dataDb
      .update(schema.contentFacts)
      .set({ kind: patch.kind ?? fact.kind, statement: patch.statement ?? fact.statement, source, verified })
      .where(eq(schema.contentFacts.id, fact.id))
      .returning();
    return { ok: true, data: updated };
  });

  app.delete<{ Params: { factId: string } }>("/content/facts/:factId", async (request) => {
    const user = await requireUser(request);
    const fact = await loadFact(user.id, request.params.factId);
    await dataDb.delete(schema.contentFacts).where(eq(schema.contentFacts.id, fact.id));
    return { ok: true, data: { id: fact.id } };
  });
}
