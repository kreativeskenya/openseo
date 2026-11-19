import { describe, expect, it } from "vitest";
import { readyUser } from "./client";

type User = Awaited<ReturnType<typeof readyUser>>;

const HEADER = "name,description,added_by,unit_price,sale_price,product_url,current_stock,est_shipping_days,meta_description";
const PUMP = `"Pump A","<p style=""color: red"">Self priming</p><ul><li>Flow: 40 m3/h</li><li>24Months Warranty</li></ul>",admin,85000,,https://shop.test/p/a,3,1,"Buy Pump A with countrywide delivery"`;
const BATTERY = `Battery B,"Plain description, with a comma",admin,"7,680",,https://shop.test/p/b,3,1,x`;
const NO_URL = `No URL,desc,admin,100,,,3,1,x`;
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

const newStore = (user: User, domain = "https://www.shop.test/") =>
  user.api.ok("POST", `/projects/${user.project.id}/content/stores`, { name: "Shop", domain });
const importUrl = (storeId: string, mode: "preview" | "commit") => `/content/stores/${storeId}/products/import?mode=${mode}`;

describe("content stores", () => {
  it("creates a store, rejects a duplicate domain and lists counts", async () => {
    const user = await readyUser();
    const store = await newStore(user);
    expect(store).toMatchObject({ name: "Shop", domain: "shop.test" });
    const duplicate = await user.api.post(`/projects/${user.project.id}/content/stores`, { name: "Again", domain: "shop.test" });
    expect(duplicate.status).toBe(409);
    const listed = await user.api.ok("GET", `/projects/${user.project.id}/content/stores`);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ productCount: 0, factCount: 0 });
  });

  it("keeps stores private to the project's owner and 404s malformed ids", async () => {
    const owner = await readyUser();
    const other = await readyUser();
    const store = await newStore(owner);
    expect((await other.api.get(`/projects/${owner.project.id}/content/stores`)).status).toBe(404);
    expect((await other.api.patch(`/content/stores/${store.id}`, { name: "Mine now" })).status).toBe(404);
    expect((await other.api.delete(`/content/stores/${store.id}`)).status).toBe(404);
    expect((await owner.api.get(`/content/stores/not-a-uuid/products`)).status).toBe(404);
  });
});

describe("product import", () => {
  it("previews without saving, then saves, and a second import changes nothing", async () => {
    const user = await readyUser();
    const store = await newStore(user);
    const file = csv(PUMP, BATTERY, NO_URL);

    const preview = await user.api.ok("POST", importUrl(store.id, "preview"), { csv: file });
    expect(preview).toMatchObject({ mode: "preview", total: 3, created: 2, updated: 0, unchanged: 0, skipped: 1, noPrice: 0 });
    expect(preview.ignoredColumns).toEqual(["current_stock", "est_shipping_days", "meta_description"]);
    expect((await user.api.ok("GET", `/content/stores/${store.id}/products`)).total).toBe(0);

    const commit = await user.api.ok("POST", importUrl(store.id, "commit"), { csv: file });
    expect(commit).toMatchObject({ mode: "commit", created: 2 });

    const listed = await user.api.ok("GET", `/content/stores/${store.id}/products`);
    expect(listed.total).toBe(2);
    const pump = listed.items.find((p: { name: string }) => p.name === "Pump A");
    expect(pump).toMatchObject({
      url: "https://shop.test/p/a",
      priceKes: 85000,
      warranty: "24 months",
      description: "Self priming\nFlow: 40 m3/h\n24Months Warranty",
      specs: { Flow: "40 m3/h" },
    });
    expect(pump.priceUpdatedAt).not.toBeNull();
    // Placeholder stock and templated meta text are never stored.
    expect(JSON.stringify(pump)).not.toContain("countrywide");
    expect(listed.items.find((p: { name: string }) => p.name === "Battery B")).toMatchObject({ priceKes: 7680 });

    const again = await user.api.ok("POST", importUrl(store.id, "commit"), { csv: file });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect((await user.api.ok("GET", `/content/stores/${store.id}/products`)).total).toBe(2);
  });

  it("updates a changed price in place and keeps a brand edited by hand", async () => {
    const user = await readyUser();
    const store = await newStore(user);
    await user.api.ok("POST", importUrl(store.id, "commit"), { csv: csv(PUMP) });
    const [first] = (await user.api.ok("GET", `/content/stores/${store.id}/products`)).items;
    await user.api.ok("PATCH", `/content/products/${first.id}`, { brand: "Cigma" });

    const cheaper = PUMP.replace(",85000,", ",79000,");
    const result = await user.api.ok("POST", importUrl(store.id, "commit"), { csv: csv(cheaper) });
    expect(result).toMatchObject({ created: 0, updated: 1, priceChanges: 1 });
    const [after] = (await user.api.ok("GET", `/content/stores/${store.id}/products`)).items;
    expect(after).toMatchObject({ id: first.id, priceKes: 79000, brand: "Cigma" });
  });

  it("rejects bad input and keeps other users out", async () => {
    const user = await readyUser();
    const other = await readyUser();
    const store = await newStore(user);
    expect((await user.api.post(importUrl(store.id, "preview"), { csv: "" })).status).toBe(400);
    expect((await user.api.post(importUrl(store.id, "preview"), { csv: "a,b\n1,2" })).status).toBe(400);
    expect((await user.api.post(`/content/stores/${store.id}/products/import?mode=yes`, { csv: csv(PUMP) })).status).toBe(400);
    expect((await other.api.post(importUrl(store.id, "commit"), { csv: csv(PUMP) })).status).toBe(404);
  });

  it("edits, searches and deletes products", async () => {
    const user = await readyUser();
    const store = await newStore(user);
    await user.api.ok("POST", importUrl(store.id, "commit"), { csv: csv(PUMP, BATTERY) });
    const found = await user.api.ok("GET", `/content/stores/${store.id}/products?q=batt`);
    expect(found.total).toBe(1);
    const edited = await user.api.ok("PATCH", `/content/products/${found.items[0].id}`, { priceKes: 8000, brand: "  Acme " });
    expect(edited).toMatchObject({ priceKes: 8000, brand: "Acme" });
    expect((await user.api.patch(`/content/products/${found.items[0].id}`, {})).status).toBe(400);
    await user.api.ok("DELETE", `/content/products/${found.items[0].id}`);
    expect((await user.api.ok("GET", `/content/stores/${store.id}/products`)).total).toBe(1);
  });
});

describe("store facts", () => {
  it("lets a fact be verified only when it has a source", async () => {
    const user = await readyUser();
    const url = `/projects/${user.project.id}/content/facts`;
    expect((await user.api.post(url, { kind: "delivery", statement: "Delivery in 1 to 3 days", verified: true })).status).toBe(400);
    const fact = await user.api.ok("POST", url, { kind: "delivery", statement: "Delivery in 1 to 3 days", verified: true, source: "Courier contract, March 2026" });
    expect(fact).toMatchObject({ verified: true, source: "Courier contract, March 2026" });
  });

  it("withdraws verification when the wording changes", async () => {
    const user = await readyUser();
    const fact = await user.api.ok("POST", `/projects/${user.project.id}/content/facts`, { kind: "payment", statement: "We accept M-Pesa", verified: true, source: "Till number page" });
    const reworded = await user.api.ok("PATCH", `/content/facts/${fact.id}`, { statement: "We accept M-Pesa and cards" });
    expect(reworded).toMatchObject({ verified: false, source: "Till number page" });
    expect((await user.api.patch(`/content/facts/${fact.id}`, { verified: true, source: "  " })).status).toBe(400);
  });

  it("adds many facts at once, unverified, for one store, and keeps them private", async () => {
    const user = await readyUser();
    const other = await readyUser();
    const store = await newStore(user);
    const url = `/projects/${user.project.id}/content/facts`;
    const added = await user.api.ok("POST", `${url}/bulk`, { kind: "delivery", storeId: store.id, lines: "- Delivery in Nairobi in 1 day\n\n* Countrywide by courier\nok" });
    expect(added).toHaveLength(2);
    expect(added.every((f: { verified: boolean; source: unknown }) => !f.verified && f.source === null)).toBe(true);
    expect(await user.api.ok("GET", `${url}?storeId=${store.id}`)).toHaveLength(2);
    expect((await other.api.get(url)).status).toBe(404);
    expect((await other.api.patch(`/content/facts/${added[0].id}`, { statement: "Changed by someone else" })).status).toBe(404);
    expect((await user.api.get(`${url}?storeId=${(await newStore(other)).id}`)).status).toBe(404);
  });
});
