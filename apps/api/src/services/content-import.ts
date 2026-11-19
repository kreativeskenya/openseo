/** Reads a store's product export (CSV) into clean product rows. Pure functions: no database, no network. */

export const MAX_IMPORT_ROWS = 5000;
const MAX_DESCRIPTION = 4000;
const MAX_SPECS = 25;

export class ImportError extends Error {}

export type ImportRow = {
  url: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string;
  specs: Record<string, string>;
  priceKes: number | null;
  salePriceKes: number | null;
  warranty: string | null;
};

export type ImportParse = {
  rows: ImportRow[];
  total: number;
  skipped: number;
  duplicates: number;
  noPrice: number;
  noWarranty: number;
  ignoredColumns: string[];
};

const COLUMNS = {
  name: ["name", "title", "product_name"],
  url: ["product_url", "url", "link"],
  description: ["description", "details"],
  facts: ["facts"],
  brand: ["brand"],
  category: ["category"],
  price: ["unit_price", "price_kes", "price"],
  sale: ["sale_price", "discount_price"],
  warranty: ["warranty"],
} as const;

// Columns in store exports that are placeholders or templated text, so they are never used as facts.
const IGNORED = ["current_stock", "est_shipping_days", "meta_title", "meta_description", "stock", "quantity"];

const SPEC_KEY_DENY = new Set(["note", "notes", "warning", "advantages", "description", "technical description", "features", "feature", "contact", "call", "tel", "phone", "whatsapp", "email"]);

export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((x) => x !== "")) rows.push(row);
  }
  return rows;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", quot: '"', lt: "<", gt: ">", apos: "'", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };
const codePoint = (n: number) => (n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "");

/** Store descriptions are HTML full of inline styles. Keep the words, one line per paragraph or list item. */
export function cleanHtml(html: string): string {
  return html
    .replace(/\u0000/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|ul|ol|h[1-6]|tr|table)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[•·▪●]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** "24Months Warranty", "2 years warranty", "Warranty: 1 year" all become "24 months", "2 years", "1 year". */
export function extractWarranty(text: string): string | null {
  const m =
    text.match(/(\d{1,3})\s*-?\s*(months?|years?|yrs?)\s*(?:of\s*)?warranty/i) ??
    text.match(/warranty[^\n\d]{0,20}(\d{1,3})\s*(months?|years?|yrs?)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const year = /^y/i.test(m[2] as string);
  return `${n} ${year ? (n === 1 ? "year" : "years") : n === 1 ? "month" : "months"}`;
}

/** "Key: value" lines from the product's own description. Faithful to the text; editable afterwards. */
export function extractSpecs(description: string): Record<string, string> {
  const specs: Record<string, string> = {};
  for (const line of description.split("\n")) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9 /()%.+-]{1,38}?)\s*[:=]\s*(\S.{0,150})$/);
    if (!m) continue;
    const key = (m[1] as string).trim();
    const value = (m[2] as string).trim();
    if (key.split(/\s+/).length > 5 || SPEC_KEY_DENY.has(key.toLowerCase()) || value.startsWith("//")) continue;
    if (!(key in specs)) specs[key] = value;
    if (Object.keys(specs).length >= MAX_SPECS) break;
  }
  return specs;
}

function parsePrice(raw: string): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export function normalizeCsv(text: string): ImportParse {
  const [head, ...body] = parseCsv(text);
  if (!head) throw new ImportError("The file is empty");
  const header = head.map((h) => h.trim().toLowerCase());
  const col = (names: readonly string[]) => {
    for (const name of names) {
      const i = header.indexOf(name);
      if (i >= 0) return i;
    }
    return -1;
  };
  const nameCol = col(COLUMNS.name);
  const urlCol = col(COLUMNS.url);
  if (nameCol < 0 || urlCol < 0) throw new ImportError("The CSV needs a name column and a product_url column");
  if (body.length > MAX_IMPORT_ROWS) throw new ImportError(`Import at most ${MAX_IMPORT_ROWS} products at a time`);
  const descCol = col(COLUMNS.description);
  const factsCol = col(COLUMNS.facts);
  const brandCol = col(COLUMNS.brand);
  const categoryCol = col(COLUMNS.category);
  const priceCol = col(COLUMNS.price);
  const saleCol = col(COLUMNS.sale);
  const warrantyCol = col(COLUMNS.warranty);
  const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");

  const byUrl = new Map<string, ImportRow>();
  let skipped = 0;
  let duplicates = 0;
  for (const row of body) {
    const name = cell(row, nameCol).replace(/\s+/g, " ").slice(0, 300);
    const url = cell(row, urlCol);
    if (!name || !/^https?:\/\/\S+$/i.test(url)) {
      skipped++;
      continue;
    }
    const description = [cleanHtml(cell(row, descCol)), cleanHtml(cell(row, factsCol))].filter(Boolean).join("\n").slice(0, MAX_DESCRIPTION);
    const price = parsePrice(cell(row, priceCol));
    let sale = parsePrice(cell(row, saleCol));
    if (price === null || (sale !== null && sale >= price)) sale = null;
    const warranty = cell(row, warrantyCol).slice(0, 60) || extractWarranty(description);
    if (byUrl.has(url)) duplicates++;
    byUrl.set(url, {
      url,
      name,
      brand: cell(row, brandCol).slice(0, 80) || null,
      category: cell(row, categoryCol).slice(0, 80) || null,
      description,
      specs: extractSpecs(description),
      priceKes: price,
      salePriceKes: sale,
      warranty: warranty || null,
    });
  }
  const rows = [...byUrl.values()];
  return {
    rows,
    total: body.length,
    skipped,
    duplicates,
    noPrice: rows.filter((r) => r.priceKes === null).length,
    noWarranty: rows.filter((r) => r.warranty === null).length,
    ignoredColumns: IGNORED.filter((name) => header.includes(name)),
  };
}

const stable = (o: Record<string, string>) => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

type Stored = Pick<ImportRow, "name" | "brand" | "category" | "description" | "specs" | "priceKes" | "salePriceKes" | "warranty">;

/** Whether a stored product already matches an imported row. A brand or category the file leaves blank is kept as edited. */
export function sameProduct(a: Stored, b: ImportRow): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.priceKes === b.priceKes &&
    a.salePriceKes === b.salePriceKes &&
    a.warranty === b.warranty &&
    stable(a.specs) === stable(b.specs) &&
    (b.brand === null || a.brand === b.brand) &&
    (b.category === null || a.category === b.category)
  );
}
