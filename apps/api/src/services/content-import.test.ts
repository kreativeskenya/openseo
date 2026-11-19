import { describe, expect, it } from "vitest";
import { cleanHtml, extractSpecs, extractWarranty, ImportError, normalizeCsv, parseCsv, sameProduct } from "./content-import";

describe("parseCsv", () => {
  it("handles quotes, commas, doubled quotes, CRLF and a BOM", () => {
    const text = '\uFEFFa,b\r\n"x, y","say ""hi"""\r\n1,2\r\n';
    expect(parseCsv(text)).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["1", "2"]]);
  });

  it("keeps newlines inside quoted cells", () => {
    expect(parseCsv('a,b\n"line1\nline2",x')).toEqual([["a", "b"], ["line1\nline2", "x"]]);
  });
});

describe("cleanHtml", () => {
  it("keeps the words, one line per item, and drops tags, styles, images and bullets", () => {
    const html = '<p style="color: red">Cigma&nbsp;pump</p><ul><li>• Self prime</li><li>3&quot; inlet</li></ul><img src="x.png">';
    expect(cleanHtml(html)).toBe('Cigma pump\nSelf prime\n3" inlet');
  });

  it("decodes numeric entities and survives odd ones", () => {
    expect(cleanHtml("a&#8211;b &#x41; &unknown; &#0;")).toContain("A");
  });
});

describe("extractWarranty", () => {
  it("reads the common phrasings", () => {
    expect(extractWarranty("24Months Warranty")).toBe("24 months");
    expect(extractWarranty("2 years warranty")).toBe("2 years");
    expect(extractWarranty("Warranty: 1 year")).toBe("1 year");
    expect(extractWarranty("12 months of warranty")).toBe("12 months");
    expect(extractWarranty("Comes with a manual")).toBeNull();
  });
});

describe("extractSpecs", () => {
  it("keeps short Key: value lines and skips notes and links", () => {
    const text = "Self priming\nFlow: 40 m3/h\nRating Power Voltage: 18,5V\nNote: call us\nhttp://x.com";
    expect(extractSpecs(text)).toEqual({ Flow: "40 m3/h", "Rating Power Voltage": "18,5V" });
  });
});

describe("normalizeCsv", () => {
  it("reads the simple format with brand, category, warranty and facts", () => {
    const text = [
      "name,brand,category,price_kes,warranty,product_url,description,facts",
      'Cigma Pump,Cigma UK,Water Pumps,85000,24 months,https://kreatives.co.ke/p/cigma,"3-inch, self-priming","Irrigation, firefighting"',
    ].join("\n");
    const out = normalizeCsv(text);
    expect(out.rows[0]).toMatchObject({
      name: "Cigma Pump",
      brand: "Cigma UK",
      category: "Water Pumps",
      priceKes: 85000,
      warranty: "24 months",
      url: "https://kreatives.co.ke/p/cigma",
      description: "3-inch, self-priming\nIrrigation, firefighting",
    });
  });

  it("skips rows without a name or a web address, merges duplicate URLs (last wins) and counts gaps", () => {
    const text = [
      "name,product_url,unit_price,sale_price",
      "A,https://x.test/a,100,",
      "A again,https://x.test/a,120,150",
      "No url,,50,",
      ",https://x.test/c,50,",
      "Free item,https://x.test/f,,",
    ].join("\n");
    const out = normalizeCsv(text);
    expect(out).toMatchObject({ total: 5, skipped: 2, duplicates: 1, noPrice: 1, noWarranty: 2 });
    expect(out.rows.map((r) => r.name)).toEqual(["A again", "Free item"]);
    // A sale price at or above the price is not a sale.
    expect(out.rows[0]).toMatchObject({ priceKes: 120, salePriceKes: null });
  });

  it("reports placeholder columns it ignores", () => {
    const out = normalizeCsv("name,product_url,est_shipping_days,current_stock\nA,https://x.test/a,1,3");
    expect(out.ignoredColumns).toEqual(["current_stock", "est_shipping_days"]);
  });

  it("rejects files without the needed columns or content", () => {
    expect(() => normalizeCsv("a,b\n1,2")).toThrow(ImportError);
    expect(() => normalizeCsv("")).toThrow(ImportError);
  });
});

describe("sameProduct", () => {
  const row = { url: "u", name: "n", brand: null, category: null, description: "d", specs: { b: "2", a: "1" }, priceKes: 10, salePriceKes: null, warranty: null };
  const stored = { name: "n", brand: "Acme", category: "Tools", description: "d", specs: { a: "1", b: "2" }, priceKes: 10, salePriceKes: null, warranty: null };

  it("ignores spec order and keeps a brand the file leaves blank", () => {
    expect(sameProduct(stored, row)).toBe(true);
  });

  it("notices a changed price or brand", () => {
    expect(sameProduct({ ...stored, priceKes: 11 }, row)).toBe(false);
    expect(sameProduct(stored, { ...row, brand: "Other" })).toBe(false);
  });
});
