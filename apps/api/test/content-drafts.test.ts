import { beforeEach, describe, expect, it, vi } from "vitest";
import { readyUser } from "./client";

const mocks = vi.hoisted(() => ({ generateJson: vi.fn() }));
vi.mock("../src/lib/gemini", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/gemini")>()), generateJson: mocks.generateJson }));
vi.mock("../src/lib/gemini-key", () => ({ getGemini: async () => ({ apiKey: "test-key-0123456789", models: ["m1"] }) }));


const CSV = [
  "name,description,unit_price,slug,regular_price,sale_price",
  'Vestwood 1KW,"<p>Vestwood 1KW Portable Power Station</p><p>Output: 1000W</p><p>Warranty cover included</p>",35000,vestwood-kenya,40000,35000',
].join("\n");

const GOOD = {
  title: "Vestwood 1KW Portable Power Station",
  metaDescription: "A 1000W portable power station for homes and shops.",
  intro: "The Vestwood 1KW is a portable power station with 1000W of output.",
  bestFor: [],
  worksWith: [],
  specs: { Output: "1000W" },
  faqs: [{ question: "What is the output?", answer: "It is rated at 1000W." }],
  troubleshooting: [],
};
const reply = (data: unknown) => ({ data, text: "", model: "m1", fellBack: false, triedModels: ["m1"], promptTokens: 10, outputTokens: 20 });

async function setup() {
  const user = await readyUser();
  const store = await user.api.ok("POST", `/projects/${user.project.id}/content/stores`, { name: "Shop", domain: "shop.test" });
  await user.api.ok("POST", `/content/stores/${store.id}/products/import?mode=commit`, { csv: CSV });
  const [product] = (await user.api.ok("GET", `/content/stores/${store.id}/products`)).items;
  return { user, store, product };
}

beforeEach(() => mocks.generateJson.mockReset());

describe("content drafts", () => {
  it("saves a clean draft with the input it was written from", async () => {
    mocks.generateJson.mockResolvedValue(reply(GOOD));
    const { user, store, product } = await setup();
    const draft = await user.api.ok("POST", `/content/products/${product.id}/draft`, { keyword: "1kw power station kenya" });
    expect(draft).toMatchObject({ status: "draft", productName: "Vestwood 1KW", problems: [], keyword: "1kw power station kenya", model: "m1" });
    expect(draft.content.title).toBe(GOOD.title);
    expect(draft.input.priceKes).toBe(35000);
    expect(await user.api.ok("GET", `/content/stores/${store.id}/drafts`)).toHaveLength(1);
  });

  it("flags an invented warranty and refuses approval until it is acknowledged", async () => {
    mocks.generateJson.mockResolvedValue(reply({ ...GOOD, intro: "It comes with a 5 year warranty." }));
    const { user, product } = await setup();
    const draft = await user.api.ok("POST", `/content/products/${product.id}/draft`, {});
    expect(draft.problems.some((p: string) => p.includes("5 year"))).toBe(true);
    expect(draft.problems.some((p: string) => p.includes("talks about warranty"))).toBe(true);

    expect((await user.api.patch(`/content/drafts/${draft.id}`, { status: "approved" })).status).toBe(400);
    const approved = await user.api.ok("PATCH", `/content/drafts/${draft.id}`, { status: "approved", acknowledge: true });
    expect(approved.status).toBe("approved");
  });

  it("gives the writer only verified facts, the current price and no template lines", async () => {
    mocks.generateJson.mockResolvedValue(reply(GOOD));
    const { user, store, product } = await setup();
    const facts = `/projects/${user.project.id}/content/facts`;
    await user.api.ok("POST", facts, { kind: "delivery", statement: "Delivery in Nairobi takes 1 day", verified: true, source: "Courier page", storeId: store.id });
    await user.api.ok("POST", facts, { kind: "payment", statement: "Pay on collection only", storeId: store.id });
    await user.api.ok("POST", `/content/products/${product.id}/draft`, {});
    const prompt = mocks.generateJson.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("Delivery in Nairobi takes 1 day");
    expect(prompt).not.toContain("Pay on collection only");
    expect(prompt).not.toContain("Warranty cover included");
    expect(prompt).not.toContain("40000");
  });

  it("saves nothing and answers 502 when the writer answers in the wrong shape", async () => {
    mocks.generateJson.mockResolvedValue(reply("not the shape we asked for"));
    const { user, store, product } = await setup();
    const res = await user.api.post(`/content/products/${product.id}/draft`, {});
    expect(res.status).toBe(502);
    expect(await user.api.ok("GET", `/content/stores/${store.id}/drafts`)).toHaveLength(0);
  });

  it("keeps drafts private to the project's owner", async () => {
    mocks.generateJson.mockResolvedValue(reply(GOOD));
    const { user, store, product } = await setup();
    const other = await readyUser();
    const draft = await user.api.ok("POST", `/content/products/${product.id}/draft`, {});
    expect((await other.api.post(`/content/products/${product.id}/draft`, {})).status).toBe(404);
    expect((await other.api.get(`/content/stores/${store.id}/drafts`)).status).toBe(404);
    expect((await other.api.patch(`/content/drafts/${draft.id}`, { status: "discarded" })).status).toBe(404);
    expect((await other.api.delete(`/content/drafts/${draft.id}`)).status).toBe(404);
    await user.api.ok("DELETE", `/content/drafts/${draft.id}`);
    expect(await user.api.ok("GET", `/content/stores/${store.id}/drafts`)).toHaveLength(0);
  });
});
