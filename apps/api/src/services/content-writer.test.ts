import { describe, expect, it } from "vitest";
import type { DraftContent } from "../db/data-schema";
import { buildInput, checkDraft, dropTemplate, normalizeContent, TROUBLESHOOTING_NOTE } from "./content-writer";

const now = new Date("2026-11-19T00:00:00Z");
const product = { name: "Vestwood 1KW", brand: null, category: null, description: "Output: 1000W", specs: {}, priceKes: 40000, salePriceKes: 35000, warranty: null, priceUpdatedAt: new Date("2026-11-10T00:00:00Z") };
const empty: DraftContent = { title: "t", metaDescription: "m", intro: "An intro.", bestFor: [], worksWith: [], specs: {}, faqs: [], troubleshooting: [] };

describe("dropTemplate", () => {
  it("removes the store's template lines and the repeated product name, and keeps product data", () => {
    const raw = [
      "0.65kVA Microtek UPS",
      "The 0.65kVA Microtek UPS available in Kenya from kenyasolar.co.ke. Ideal for homes, shops, farms and light commercial use.",
      "Specifications",
      "Reliable performance",
      "Genuine quality",
      "Key features",
      "Built for demanding work in Kenyan conditions",
      "What's in the box",
      "See supplier packing notes; confirm contents when ordering.",
      "Warranty and after-sales support",
      "Warranty cover included",
      "Spare parts available",
      "Delivery",
      "Flat-rate delivery countrywide, delivered in 1 day.",
      "Frequently Asked Questions",
      "What is the capacity?",
      "Capacity: 0.65kVA, for small devices.",
      "Order the 0.65kVA Microtek UPS online from kenyasolar.co.ke. Countrywide delivery.",
    ].join("\n");
    expect(dropTemplate(raw, "0.65kVA Microtek UPS")).toBe("What is the capacity?\nCapacity: 0.65kVA, for small devices.");
  });
});

describe("buildInput", () => {
  it("gives the current sale price with its date, never the regular price", () => {
    const input = buildInput(product, [], { now });
    expect(input).toMatchObject({ priceKes: 35000, priceAsOf: "2026-11-10" });
    expect(JSON.stringify(input)).not.toContain("40000");
  });

  it("leaves the price out when it is too old or has no date", () => {
    expect(buildInput({ ...product, priceUpdatedAt: new Date("2026-10-01T00:00:00Z") }, [], { now }).priceKes).toBeNull();
    expect(buildInput({ ...product, priceUpdatedAt: null }, [], { now }).priceKes).toBeNull();
  });

  it("keeps only verified facts that have a source", () => {
    const facts = [
      { kind: "delivery", statement: "A", source: "page", verified: true },
      { kind: "delivery", statement: "B", source: "page", verified: false },
      { kind: "payment", statement: "C", source: null, verified: true },
    ];
    expect(buildInput(product, facts, { now }).facts).toEqual([{ kind: "delivery", statement: "A" }]);
  });
});

describe("checkDraft", () => {
  const input = buildInput(product, [], { now });

  it("flags a number that is not in the input, and a warranty nobody set", () => {
    const problems = checkDraft({ ...empty, intro: "It comes with a 24 months warranty." }, input);
    expect(problems.some((p) => p.includes("24 months"))).toBe(true);
    expect(problems.some((p) => p.includes("talks about warranty"))).toBe(true);
  });

  it("accepts a delivery claim that matches a verified fact", () => {
    const withFact = buildInput(product, [{ kind: "delivery", statement: "Delivery in Nairobi takes 1 day", source: "Courier page", verified: true }], { now });
    expect(checkDraft({ ...empty, intro: "Delivery in Nairobi takes 1 day." }, withFact)).toEqual([]);
  });

  it("flags words the data does not support", () => {
    expect(checkDraft({ ...empty, intro: "A genuine product." }, input).some((p) => p.includes("genuine"))).toBe(true);
  });

  it("always asks for a read of the troubleshooting section", () => {
    const content = { ...empty, troubleshooting: [{ problem: "No power", checks: ["Check the connections with the unit switched off."] }] };
    expect(checkDraft(content, input)).toContain(TROUBLESHOOTING_NOTE);
  });
});

describe("normalizeContent", () => {
  it("rejects the wrong shape and drops empty entries", () => {
    expect(normalizeContent("nope")).toBeNull();
    const out = normalizeContent({ title: " T ", faqs: [{ question: "", answer: "a" }, { question: "q", answer: "a" }] });
    expect(out).toMatchObject({ title: "T", faqs: [{ question: "q", answer: "a" }], bestFor: [] });
  });
});
