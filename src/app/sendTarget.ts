import { providerOf, type ModelProvider } from "../models.ts";
import { threadModelId } from "../threadModel.ts";
import type { Project, Thread } from "../types.ts";

export type SendTarget = {
  existing: Thread | null;
  modelId: string;
  projectId: string | null;
  provider: ModelProvider;
};

/** Resolve send ownership before consulting active UI auth or project state. */
export function resolveSendTarget(
  threads: readonly Thread[],
  targetId: string | null,
  activeProjectId: string | null,
  activeModelId: string,
): SendTarget | null {
  if (targetId != null) {
    const existing = threads.find((thread) => thread.id === targetId);
    if (!existing) return null;
    const modelId = threadModelId(existing) ?? activeModelId;
    return {
      existing,
      modelId,
      projectId: existing.projectId ?? null,
      provider: providerOf(modelId),
    };
  }

  return {
    existing: null,
    modelId: activeModelId,
    projectId: activeProjectId,
    provider: providerOf(activeModelId),
  };
}

export function findSendTargetProject(
  projects: readonly Project[],
  target: SendTarget,
): Project | null {
  return projects.find((project) => project.id === target.projectId) ?? null;
}
