"use client";

import { useParams } from "next/navigation";
import { StoreView } from "@/components/content/store-view";
import { ProjectPage } from "@/components/research/project-page";

export default function ContentStorePage() {
  const { storeId } = useParams<{ storeId: string }>();
  return <ProjectPage>{(project) => <StoreView project={project} storeId={storeId} />}</ProjectPage>;
}
