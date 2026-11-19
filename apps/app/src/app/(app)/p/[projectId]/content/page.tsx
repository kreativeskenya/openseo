"use client";

import { StoresPage } from "@/components/content/stores";
import { ProjectPage } from "@/components/research/project-page";

export default function ContentPage() {
  return <ProjectPage>{(project) => <StoresPage project={project} />}</ProjectPage>;
}
