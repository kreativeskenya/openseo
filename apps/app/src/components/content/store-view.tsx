"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Pagination } from "@/components/research/pagination";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, Field, Input, PageHeader, Select, Spinner, Textarea } from "@/components/ui";
import { api, dateOnly, num } from "@/lib/api";
import type { Project } from "@/lib/hooks";
import { fetchStores, type Store, storesKey } from "./stores";

type Product = {
  id: string;
  slug: string;
  url: string | null;
  name: string;
  brand: string | null;
  category: string | null;
  priceKes: number | null;
  salePriceKes: number | null;
  warranty: string | null;
  priceUpdatedAt: string | null;
};
type Fact = { id: string; kind: string; statement: string; source: string | null; verified: boolean; storeId: string | null };
type Preview = {
  mode: string;
  total: number;
  created: number;
  updated: number;
  priceChanges: number;
  unchanged: number;
  skipped: number;
  duplicates: number;
  priceConflicts: number;
  priceConflictExamples: string[];
  noPrice: number;
  noWarranty: number;
  ignoredColumns: string[];
  examples: { created: string[]; updated: string[] };
};

const FACT_KINDS = ["delivery", "payment", "warranty", "location", "contact", "policy", "other"];
const LIMIT = 50;
const kes = (value: number | null) => (value === null ? "no price" : `KES ${num(value)}`);

// ── Products ────────────────────────────────────────────────────────────────

function ProductRow({ product, onChanged }: { product: Product; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [brand, setBrand] = useState(product.brand ?? "");
  const [category, setCategory] = useState(product.category ?? "");
  const [warranty, setWarranty] = useState(product.warranty ?? "");
  const [price, setPrice] = useState(product.priceKes === null ? "" : String(product.priceKes));
  const priceNumber = price.trim() === "" ? null : Number(price);
  const priceOk = priceNumber === null || (Number.isFinite(priceNumber) && priceNumber > 0);

  const save = useMutation({
    mutationFn: () => api(`/content/products/${product.id}`, { method: "PATCH", body: { brand: brand.trim() || null, category: category.trim() || null, warranty: warranty.trim() || null, priceKes: priceNumber } }),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/content/products/${product.id}`, { method: "DELETE" }),
    onSuccess: onChanged,
  });

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{product.name}</p>
          <p className="font-mono text-xs text-muted">{product.slug}</p>
          <p className="mt-1 text-[13px] text-muted">
            {kes(product.priceKes)}
            {product.salePriceKes !== null && <> · sale {kes(product.salePriceKes)}</>}
            {product.priceUpdatedAt && <> · price as of {dateOnly(product.priceUpdatedAt)}</>}
            {product.brand && <> · {product.brand}</>}
            {product.category && <> · {product.category}</>}
            {product.warranty ? <> · warranty {product.warranty}</> : <> · warranty not set</>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setEditing((value) => !value)}>
            {editing ? "Cancel" : "Edit"}
          </Button>
          <Button
            size="sm"
            loading={remove.isPending}
            onClick={() => {
              if (window.confirm(`Delete "${product.name}"?`)) remove.mutate();
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      {editing && (
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (priceOk) save.mutate();
          }}
        >
          <Field label="Brand">
            <Input value={brand} onChange={(event) => setBrand(event.target.value)} />
          </Field>
          <Field label="Category">
            <Input value={category} onChange={(event) => setCategory(event.target.value)} />
          </Field>
          <Field label="Warranty" hint="Only what you know is true, e.g. 24 months">
            <Input value={warranty} onChange={(event) => setWarranty(event.target.value)} />
          </Field>
          <Field label="Price (KES)">
            <Input value={price} inputMode="decimal" onChange={(event) => setPrice(event.target.value)} />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit" loading={save.isPending} disabled={!priceOk}>
              Save product
            </Button>
          </div>
        </form>
      )}
      {(save.error || remove.error) && <ErrorNote error={save.error ?? remove.error} />}
    </li>
  );
}

function Products({ store }: { store: Store }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [offset, setOffset] = useState(0);
  const list = useQuery({
    queryKey: ["content-products", store.id, term, offset],
    queryFn: () => api<{ total: number; items: Product[] }>(`/content/stores/${store.id}/products`, { query: { q: term, limit: LIMIT, offset } }),
    placeholderData: (previous) => previous,
  });
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: ["content-products", store.id] });
    void queryClient.invalidateQueries({ queryKey: ["content-stores"] });
  };

  return (
    <Card>
      <CardHeader title="Products" description="Matched by slug, so importing the same file again updates instead of duplicating." />
      <form
        className="flex gap-2 px-4 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          setOffset(0);
          setTerm(text.trim());
        }}
      >
        <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="Search by name" className="max-w-sm" />
        <Button type="submit">Search</Button>
      </form>
      {list.isPending ? (
        <Spinner />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : list.data.items.length === 0 ? (
        <EmptyState title={term ? "No product matches" : "No products yet"}>{term ? "Try a different word." : "Use the Import tab to add products from a CSV."}</EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line border-t border-line">
            {list.data.items.map((product) => (
              <ProductRow key={product.id} product={product} onChanged={changed} />
            ))}
          </ul>
          <Pagination offset={offset} limit={LIMIT} count={list.data.items.length} total={list.data.total} onChange={setOffset} />
        </>
      )}
    </Card>
  );
}

// ── Facts ───────────────────────────────────────────────────────────────────

function FactRow({ fact, onChanged }: { fact: Fact; onChanged: () => void }) {
  const [source, setSource] = useState(fact.source ?? "");
  const verify = useMutation({
    mutationFn: (verified: boolean) => api(`/content/facts/${fact.id}`, { method: "PATCH", body: verified ? { verified: true, source: source.trim() } : { verified: false } }),
    onSuccess: onChanged,
  });
  const remove = useMutation({ mutationFn: () => api(`/content/facts/${fact.id}`, { method: "DELETE" }), onSuccess: onChanged });

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p>
            <Badge tone={fact.verified ? "pos" : "warn"}>{fact.verified ? "Verified" : "Unverified"}</Badge> <span className="font-mono text-xs uppercase text-muted">{fact.kind}</span>
          </p>
          <p className="mt-1 text-sm">{fact.statement}</p>
        </div>
        <Button
          size="sm"
          loading={remove.isPending}
          onClick={() => {
            if (window.confirm("Delete this fact?")) remove.mutate();
          }}
        >
          Delete
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-sm" value={source} onChange={(event) => setSource(event.target.value)} placeholder="Where this comes from (required to verify)" />
        {fact.verified ? (
          <Button size="sm" loading={verify.isPending} onClick={() => verify.mutate(false)}>
            Withdraw
          </Button>
        ) : (
          <Button size="sm" loading={verify.isPending} disabled={!source.trim()} onClick={() => verify.mutate(true)}>
            Verify
          </Button>
        )}
      </div>
      {(verify.error || remove.error) && <ErrorNote error={verify.error ?? remove.error} />}
    </li>
  );
}

function Facts({ project, store }: { project: Project; store: Store }) {
  const queryClient = useQueryClient();
  const key = ["content-facts", project.id, store.id];
  const facts = useQuery({ queryKey: key, queryFn: () => api<Fact[]>(`/projects/${project.id}/content/facts`, { query: { storeId: store.id } }) });
  const [kind, setKind] = useState("delivery");
  const [statement, setStatement] = useState("");
  const [source, setSource] = useState("");
  const [verified, setVerified] = useState(false);
  const [bulk, setBulk] = useState("");
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: storesKey(project.id) });
  };

  const add = useMutation({
    mutationFn: () => api(`/projects/${project.id}/content/facts`, { method: "POST", body: { kind, statement: statement.trim(), source: source.trim() || null, verified, storeId: store.id } }),
    onSuccess: () => {
      setStatement("");
      setSource("");
      setVerified(false);
      changed();
    },
  });
  const addBulk = useMutation({
    mutationFn: () => api(`/projects/${project.id}/content/facts/bulk`, { method: "POST", body: { kind, storeId: store.id, lines: bulk } }),
    onSuccess: () => {
      setBulk("");
      changed();
    },
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Add a fact" description="The writer states delivery, payment, warranty and similar claims only from verified facts. A verified fact needs a source." />
        <form
          className="grid gap-3 p-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <Field label="Kind">
            <Select value={kind} onChange={(event) => setKind(event.target.value)}>
              {FACT_KINDS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Source" hint="A page, contract or message you can point to">
            <Input value={source} onChange={(event) => setSource(event.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Statement">
              <Input value={statement} onChange={(event) => setStatement(event.target.value)} placeholder="Delivery in Nairobi takes 1 day" />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={verified} onChange={(event) => setVerified(event.target.checked)} /> Verified
          </label>
          <div>
            <Button type="submit" loading={add.isPending} disabled={statement.trim().length < 3 || (verified && !source.trim())}>
              Add fact
            </Button>
          </div>
        </form>
        {add.error && (
          <div className="px-4 pb-4">
            <ErrorNote error={add.error} />
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Paste several" description="One fact per line, all of the kind chosen above. They start unverified." />
        <div className="space-y-3 p-4">
          <Textarea rows={4} value={bulk} onChange={(event) => setBulk(event.target.value)} />
          <Button loading={addBulk.isPending} disabled={!bulk.trim()} onClick={() => addBulk.mutate()}>
            Add lines
          </Button>
          {addBulk.error && <ErrorNote error={addBulk.error} />}
        </div>
      </Card>

      <Card>
        <CardHeader title="Facts for this store" />
        {facts.isPending ? (
          <Spinner />
        ) : facts.error ? (
          <ErrorNote error={facts.error} />
        ) : facts.data.length === 0 ? (
          <EmptyState title="No facts yet">Nothing is claimed for this store until you add and verify facts.</EmptyState>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {facts.data.map((fact) => (
              <FactRow key={fact.id} fact={fact} onChanged={changed} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ── Import ──────────────────────────────────────────────────────────────────

function Figures({ data }: { data: Preview }) {
  const rows: [string, number][] = [
    ["Rows in file", data.total],
    ["New", data.created],
    ["Changed", data.updated],
    ["Price changes", data.priceChanges],
    ["Unchanged", data.unchanged],
    ["Skipped", data.skipped],
    ["Repeated slugs", data.duplicates],
    ["Conflicting prices", data.priceConflicts],
    ["No price", data.noPrice],
    ["No warranty read", data.noWarranty],
  ];
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-3">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="font-mono text-[11px] uppercase tracking-wide text-muted">{label}</dt>
          <dd className="mt-0.5 font-display text-xl font-semibold tabular">{num(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Import({ project, store }: { project: Project; store: Store }) {
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const send = (mode: "preview" | "commit") => api<Preview>(`/content/stores/${store.id}/products/import`, { method: "POST", query: { mode }, body: { csv } });
  const preview = useMutation({ mutationFn: () => send("preview") });
  const commit = useMutation({
    mutationFn: () => send("commit"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["content-products", store.id] });
      void queryClient.invalidateQueries({ queryKey: storesKey(project.id) });
    },
  });
  const shown = commit.data ?? preview.data;

  return (
    <Card>
      <CardHeader title="Import products" description="Choose the store's CSV export. You see what would change first; nothing is saved until you press Save import." />
      <div className="space-y-4 p-4">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            preview.reset();
            commit.reset();
            if (!file) return setCsv(null);
            setFileName(file.name);
            setCsv(await file.text());
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button loading={preview.isPending} disabled={!csv} onClick={() => preview.mutate()}>
            Preview {fileName && `(${fileName})`}
          </Button>
          <Button loading={commit.isPending} disabled={!csv || !preview.data || commit.isSuccess} onClick={() => commit.mutate()}>
            Save import
          </Button>
        </div>
        {(preview.error || commit.error) && <ErrorNote error={preview.error ?? commit.error} />}
        {commit.isSuccess && <p className="text-sm">Saved. {num(commit.data.created)} new, {num(commit.data.updated)} updated.</p>}
        {shown && (
          <div className="space-y-3">
            <p className="text-sm text-muted">{shown.mode === "commit" ? "Result" : "Preview, nothing saved yet"}</p>
            <Figures data={shown} />
            {shown.priceConflicts > 0 && (
              <p className="text-[13px]">
                <Badge tone="warn">Check prices</Badge> {num(shown.priceConflicts)} slugs appear more than once with different prices; the last row is kept. First few:{" "}
                <span className="font-mono text-xs">{shown.priceConflictExamples.join(", ")}</span>
              </p>
            )}
            {shown.ignoredColumns.length > 0 && <p className="text-[13px] text-muted">Ignored as placeholders: {shown.ignoredColumns.join(", ")}.</p>}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

const TABS = [
  { id: "products", label: "Products" },
  { id: "facts", label: "Facts" },
  { id: "import", label: "Import" },
] as const;

export function StoreView({ project, storeId }: { project: Project; storeId: string }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("products");
  const stores = useQuery({ queryKey: storesKey(project.id), queryFn: () => fetchStores(project.id) });
  if (stores.isPending) return <Spinner />;
  if (stores.error) return <ErrorNote error={stores.error} />;
  const store = stores.data.find((item) => item.id === storeId);
  if (!store) return <EmptyState title="Store not found">It may have been deleted.</EmptyState>;

  return (
    <div className="space-y-6">
      <PageHeader
        title={store.name}
        description={
          <>
            <span className="font-mono">{store.domain}</span> · {num(store.productCount)} products · {num(store.factCount)} facts ·{" "}
            <Link href={`/p/${project.id}/content`} className="underline">
              All stores
            </Link>
          </>
        }
      />
      <div className="flex gap-2">
        {TABS.map((item) => (
          <Button key={item.id} size="sm" onClick={() => setTab(item.id)} aria-pressed={tab === item.id}>
            {item.label}
          </Button>
        ))}
      </div>
      {tab === "products" && <Products store={store} />}
      {tab === "facts" && <Facts project={project} store={store} />}
      {tab === "import" && <Import project={project} store={store} />}
    </div>
  );
}
