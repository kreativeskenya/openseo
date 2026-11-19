/** What the writer is given, the rules it follows, and the check on what it wrote. Pure functions: no database, no network. */
import { z } from "zod";
import type { DraftContent } from "../db/data-schema";

export const MAX_PRICE_AGE_DAYS = 30;
export const TROUBLESHOOTING_NOTE = "Troubleshooting is general advice, not taken from your product data. Read it before approving.";

export type ProductLike = {
  name: string;
  brand: string | null;
  category: string | null;
  description: string;
  specs: Record<string, string>;
  priceKes: number | null;
  salePriceKes: number | null;
  warranty: string | null;
  priceUpdatedAt: Date | null;
};
export type FactLike = { kind: string; statement: string; source: string | null; verified: boolean };

export type WriterInput = {
  name: string;
  brand: string | null;
  category: string | null;
  description: string;
  specs: Record<string, string>;
  priceKes: number | null;
  priceAsOf: string | null;
  warranty: string | null;
  facts: { kind: string; statement: string }[];
  keyword: string | null;
};

// Lines the store's template puts on every product. They are not facts about the product.
const TEMPLATE: RegExp[] = [
  /^specifications$/i,
  /^key features$/i,
  /^what'?s in the box$/i,
  /^delivery$/i,
  /^frequently asked questions$/i,
  /^warranty and after-sales support$/i,
  /^warranty cover included$/i,
  /^sales and service centre support$/i,
  /^spare parts available$/i,
  /^reliable performance$/i,
  /^durable build for kenyan conditions$/i,
  /^genuine quality$/i,
  /^built for demanding work in kenyan conditions$/i,
  /^specifications matched to the model listed$/i,
  /^spare parts and service support available/i,
  /^see supplier packing notes/i,
  /^flat-rate delivery/i,
  /^order the .* online from /i,
  /available in kenya from .*\.co\.ke/i,
];

export function dropTemplate(description: string, name: string): string {
  const own = name.trim().toLowerCase();
  return description
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line.toLowerCase() !== own && !TEMPLATE.some((re) => re.test(line)))
    .join("\n");
}

/** The only information the writer may use. Old prices, regular prices and unverified facts are left out. */
export function buildInput(product: ProductLike, facts: FactLike[], options: { keyword?: string | null; now?: Date; maxAgeDays?: number } = {}): WriterInput {
  const now = options.now ?? new Date();
  const maxAge = (options.maxAgeDays ?? MAX_PRICE_AGE_DAYS) * 86_400_000;
  const current = product.salePriceKes ?? product.priceKes;
  const updated = product.priceUpdatedAt;
  const fresh = current !== null && updated !== null && now.getTime() - updated.getTime() <= maxAge;
  return {
    name: product.name,
    brand: product.brand,
    category: product.category,
    description: dropTemplate(product.description, product.name).slice(0, 3000),
    specs: product.specs,
    priceKes: fresh ? current : null,
    priceAsOf: fresh && updated ? updated.toISOString().slice(0, 10) : null,
    warranty: product.warranty,
    facts: facts.filter((fact) => fact.verified && fact.source).map((fact) => ({ kind: fact.kind, statement: fact.statement })),
    keyword: options.keyword?.trim() || null,
  };
}

const RULES = [
  "You write product page content for an online shop in Kenya. Plain English, no hype, written for a buyer.",
  "Use ONLY the INPUT. Never add a spec, model, capacity, voltage, compatibility, certification, brand claim, warranty length, delivery time or cost, stock level, discount or saving that is not in the INPUT.",
  "Never write: best, number one, cheapest, genuine, original, certified, guaranteed, in stock, free delivery, or any saving or percentage off.",
  "Mention the price only if priceKes is present, as 'KES <amount> as of <priceAsOf>'. Otherwise do not mention price at all.",
  "State delivery, payment, warranty or location claims only if a matching entry exists in INPUT.facts. If none exists, say nothing about that topic.",
  "bestFor: 2 to 4 uses, only where the name, description or specs support them. Otherwise an empty list.",
  "worksWith: only compatibility the INPUT states. Otherwise an empty list.",
  "specs: copy name and value pairs from the INPUT. Never calculate or guess a value.",
  "faqs: up to 6 questions a buyer would ask, each answered from the INPUT in one to three sentences. Write fewer if the INPUT cannot answer more.",
  "troubleshooting: 2 to 4 entries of general, safe first checks only: check connections with the equipment switched off, check settings, read the error code in the manual, contact a qualified technician. Never tell anyone to open the unit, touch live wiring or modify it. No numbers.",
  "title: under 60 characters, product name first. metaDescription: under 155 characters, says what it is and who it suits.",
  "If INPUT.keyword is set, use that phrase naturally in the title and intro. Do not repeat it unnaturally.",
];

export function buildPrompt(input: WriterInput): { system: string; prompt: string } {
  const shape = '{"title": string, "metaDescription": string, "intro": string, "bestFor": string[], "worksWith": string[], "specs": {"Name": "value"}, "faqs": [{"question": string, "answer": string}], "troubleshooting": [{"problem": string, "checks": string[]}]}';
  return {
    system: RULES.join("\n"),
    prompt: `INPUT (the only source you may use):\n${JSON.stringify(input, null, 2)}\n\nReturn JSON only, with exactly these keys:\n${shape}`,
  };
}

const strings = z.array(z.string()).default([]);
const contentSchema = z.object({
  title: z.string().default(""),
  metaDescription: z.string().default(""),
  intro: z.string().default(""),
  bestFor: strings,
  worksWith: strings,
  specs: z.record(z.string(), z.string()).default({}),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  troubleshooting: z.array(z.object({ problem: z.string(), checks: strings })).default([]),
});

const clip = (value: string, max: number) => value.trim().slice(0, max);

/** The writer's JSON, trimmed to safe sizes. null when it is not the shape we asked for. */
export function normalizeContent(raw: unknown): DraftContent | null {
  const parsed = contentSchema.safeParse(raw);
  if (!parsed.success) return null;
  const c = parsed.data;
  return {
    title: clip(c.title, 120),
    metaDescription: clip(c.metaDescription, 300),
    intro: clip(c.intro, 2000),
    bestFor: c.bestFor.slice(0, 6).map((s) => clip(s, 300)).filter(Boolean),
    worksWith: c.worksWith.slice(0, 6).map((s) => clip(s, 300)).filter(Boolean),
    specs: Object.fromEntries(Object.entries(c.specs).slice(0, 40).map(([k, v]) => [clip(k, 60), clip(v, 200)] as [string, string]).filter(([k, v]) => k && v)),
    faqs: c.faqs.slice(0, 8).map((f) => ({ question: clip(f.question, 300), answer: clip(f.answer, 1200) })).filter((f) => f.question && f.answer),
    troubleshooting: c.troubleshooting
      .slice(0, 5)
      .map((t) => ({ problem: clip(t.problem, 300), checks: t.checks.slice(0, 6).map((s) => clip(s, 400)).filter(Boolean) }))
      .filter((t) => t.problem && t.checks.length),
  };
}

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const NUMBER_WITH_UNIT = /\d[\d,]*(?:\.\d+)?(?:\s?(?:months?|years?|days?|hours?|kwh|kva|kw|wh|ah|hz|w|v|%)(?![a-z]))?/gi;
const BANNED = /\b(?:number one|cheapest|lowest price|guarantee[ds]?|genuine|original|certified|discount(?:ed)?|in stock|free delivery)\b|#1|\d+\s?% off/gi;
const plain = (digits: string) => digits.replace(/,/g, "");

const CLAIMS: { topic: string; pattern: RegExp; kind: string; own?: (input: WriterInput) => boolean }[] = [
  { topic: "warranty", pattern: /\bwarrant(?:y|ies|ed)\b/i, kind: "warranty", own: (input) => Boolean(input.warranty) },
  { topic: "delivery", pattern: /\b(?:deliver(?:y|ed|s)?|shipping|ships?)\b/i, kind: "delivery" },
  { topic: "payment", pattern: /\b(?:m-?pesa|pay(?:ment|ments)?|instal+ments?)\b/i, kind: "payment" },
];

/** What in the draft is not backed by the input. A safety net, not proof: a person still reads the draft. */
export function checkDraft(content: DraftContent, input: WriterInput): string[] {
  const problems: string[] = [];
  const draft = [
    content.title,
    content.metaDescription,
    content.intro,
    ...content.bestFor,
    ...content.worksWith,
    ...Object.entries(content.specs).flat(),
    ...content.faqs.flatMap((f) => [f.question, f.answer]),
    ...content.troubleshooting.flatMap((t) => [t.problem, ...t.checks]),
  ].join("\n");
  const allowed = JSON.stringify(input).toLowerCase();

  if (!content.title || !content.intro) problems.push("The writer left out the title or the intro.");
  if (content.title.length > 70) problems.push(`The title is ${content.title.length} characters. Google cuts it off after about 60.`);
  if (content.metaDescription.length > 160) problems.push(`The meta description is ${content.metaDescription.length} characters. Google cuts it off after about 155.`);

  const known = new Set((allowed.match(NUMBER) ?? []).map(plain));
  const flagged = new Set<string>();
  for (const token of draft.match(NUMBER_WITH_UNIT) ?? []) {
    const digits = plain(token.match(/^\d[\d,]*(?:\.\d+)?/)?.[0] ?? "");
    const shown = token.replace(/,+$/, "");
    if (digits && !known.has(digits) && !flagged.has(shown)) {
      flagged.add(shown);
      problems.push(`The draft says "${shown}", which is not in the product data or your verified facts.`);
    }
  }
  for (const word of new Set((draft.match(BANNED) ?? []).map((w) => w.toLowerCase()))) {
    if (!allowed.includes(word)) problems.push(`The draft uses "${word}", which the product data does not support.`);
  }
  for (const claim of CLAIMS) {
    const backed = claim.own?.(input) || input.facts.some((fact) => fact.kind === claim.kind);
    if (claim.pattern.test(draft) && !backed) problems.push(`The draft talks about ${claim.topic}, but no ${claim.topic} is set on the product or verified in Facts.`);
  }
  if (content.troubleshooting.length) problems.push(TROUBLESHOOTING_NOTE);
  return problems.slice(0, 25);
}
