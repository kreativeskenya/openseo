"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Button, Card, CardHeader, EmptyState, ErrorNote, Field, Input, PageHeader, Spinner } from "@/components/ui";
import { api, num } from "@/lib/api";
import type { Project } from "@/lib/hooks";

export type Store = { id: string; name: string; domain: string; notes: string | null; productCount: number; factCount: number };

export const storesKey = (projectId: string) => ["content-stores", projectId];
export const fetchStores = (projectId: string) => api<Store[]>(`/projects/${projectId}/content/stores`);

export function StoresPage({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const stores = useQuery({ queryKey: storesKey(project.id), queryFn: () => fetchStores(project.id) });
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const create = useMutation({
    mutationFn: () => api<Store>(`/projects/${project.id}/content/stores`, { method: "POST", body: { name: name.trim(), domain: domain.trim() } }),
    onSuccess: () => {
      setName("");
      setDomain("");
      void queryClient.invalidateQueries({ queryKey: storesKey(project.id) });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Content Studio" description="Stores, their products and the facts the writer may state. Nothing here uses AI or costs anything." />
      <Card>
        <CardHeader title="Add a store" description="One per website. Products are imported into a store from its CSV export." />
        <form
          className="flex flex-wrap items-end gap-3 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="min-w-48 flex-1">
            <Field label="Name">
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Kenya Solar" />
            </Field>
          </div>
          <div className="min-w-48 flex-1">
            <Field label="Domain">
              <Input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="kenyasolar.co.ke" />
            </Field>
          </div>
          <Button type="submit" loading={create.isPending} disabled={!name.trim() || domain.trim().length < 3}>
            Add store
          </Button>
        </form>
        {create.error && (
          <div className="px-4 pb-4">
            <ErrorNote error={create.error} />
          </div>
        )}
      </Card>

      {stores.isPending ? (
        <Spinner />
      ) : stores.error ? (
        <ErrorNote error={stores.error} />
      ) : stores.data.length === 0 ? (
        <EmptyState title="No stores yet">Add a store above, then import its products.</EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {stores.data.map((store) => (
              <li key={store.id}>
                <Link href={`/p/${project.id}/content/${store.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-sunken">
                  <div className="min-w-0">
                    <p className="font-medium">{store.name}</p>
                    <p className="font-mono text-xs text-muted">{store.domain}</p>
                  </div>
                  <p className="font-mono text-xs text-muted tabular">
                    {num(store.productCount)} products · {num(store.factCount)} facts
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
