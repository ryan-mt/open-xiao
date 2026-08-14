export type ThinkingLevel =
  | "off"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

/** Tool filesystem scope, simplified to two runtime access modes. */
export type AccessMode = "workspace" | "full";

/** Whether risky tools run immediately or wait for user approval. */
export type PermissionMode = "auto" | "ask";

/** Plan = read-only research; Build = full coding tools. */
export type AgentMode = "plan" | "build";

export type ModelProvider = "grok" | "openai" | "antigravity" | "opencode";
export type ProviderAvailability = Record<ModelProvider, boolean>;

export type Model = {
  id: string;
  label: string;
  description: string;
  provider: ModelProvider;
  /** Upstream service when the runtime aggregates models from other providers. */
  subProvider?: string;
  /** supports reasoning / thinking controls */
  thinking: boolean;
  /** Supports OpenAI priority routing (Fast mode). */
  fastMode?: boolean;
  defaultThinking: ThinkingLevel;
  supportedThinking: ThinkingLevel[];
  context: string;
  badge?: string;
};

/** Backwards-compatible alias for existing model consumers. */
export type GrokModel = Model;

/** Latest chat models from xAI docs (2026) */
export const GROK_MODELS: Model[] = [
  {
    id: "grok-4.5",
    label: "Grok 4.5",
    description: "Most intelligent & fastest - default",
    provider: "grok",
    thinking: true,
    defaultThinking: "medium",
    supportedThinking: ["off", "low", "medium", "high"],
    context: "500k",
    badge: "New",
  },
  {
    id: "grok-4.3",
    label: "Grok 4.3",
    description: "Strong general model - 1M context",
    provider: "grok",
    thinking: true,
    defaultThinking: "medium",
    supportedThinking: ["off", "low", "medium", "high"],
    context: "1M",
  },
  {
    id: "grok-4.20-0309-reasoning",
    label: "Grok 4.20 Reasoning",
    description: "Deep reasoning - thinking on",
    provider: "grok",
    thinking: true,
    defaultThinking: "medium",
    supportedThinking: ["off", "low", "medium", "high"],
    context: "1M",
    badge: "Think",
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    label: "Grok 4.20 Fast",
    description: "Non-reasoning - lower latency",
    provider: "grok",
    thinking: false,
    defaultThinking: "off",
    supportedThinking: ["off"],
    context: "1M",
  },
  {
    id: "grok-4.20-multi-agent-0309",
    label: "Grok 4.20 Multi-agent",
    description: "Multi-agent orchestration",
    provider: "grok",
    thinking: true,
    defaultThinking: "medium",
    supportedThinking: ["off", "low", "medium", "high"],
    context: "1M",
  },
  {
    id: "grok-build-0.1",
    label: "Grok Build 0.1",
    description: "Coding / build workflows",
    provider: "grok",
    thinking: true,
    defaultThinking: "medium",
    supportedThinking: ["off", "low", "medium", "high"],
    context: "256k",
    badge: "Code",
  },
];

export const OPENAI_MODELS: Model[] = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    description: "OpenAI flagship reasoning model",
    provider: "openai",
    thinking: true,
    fastMode: true,
    defaultThinking: "low",
    supportedThinking: ["low", "medium", "high", "xhigh", "max", "ultra"],
    context: "272k",
    badge: "New",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    description: "Balanced intelligence and speed",
    provider: "openai",
    thinking: true,
    fastMode: true,
    defaultThinking: "medium",
    supportedThinking: ["low", "medium", "high", "xhigh", "max", "ultra"],
    context: "272k",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    description: "Fast, efficient everyday model",
    provider: "openai",
    thinking: true,
    fastMode: true,
    defaultThinking: "medium",
    supportedThinking: ["low", "medium", "high", "xhigh", "max"],
    context: "272k",
  },
];

export const OPENCODE_MODELS: Model[] = [];
export const ANTIGRAVITY_MODELS: Model[] = [];
export const ALL_MODELS: Model[] = [
  ...GROK_MODELS,
  ...OPENAI_MODELS,
  ...ANTIGRAVITY_MODELS,
  ...OPENCODE_MODELS,
];

function refreshAllModels(): void {
  ALL_MODELS.splice(
    0,
    ALL_MODELS.length,
    ...GROK_MODELS,
    ...OPENAI_MODELS,
    ...ANTIGRAVITY_MODELS,
    ...OPENCODE_MODELS,
  );
}

export function configureAntigravityModels(models: Model[]): void {
  ANTIGRAVITY_MODELS.splice(0, ANTIGRAVITY_MODELS.length, ...models);
  refreshAllModels();
}

export function configureOpenCodeModels(models: Model[]): void {
  OPENCODE_MODELS.splice(0, OPENCODE_MODELS.length, ...models);
  refreshAllModels();
}

/** Persisted dynamic model ids remain valid while their async catalog reloads. */
export function isKnownModelId(id: string): boolean {
  const modelId = id.trim();
  return (
    ALL_MODELS.some((model) => model.id === modelId) ||
    (modelId.startsWith("opencode::") && modelId.length > "opencode::".length) ||
    (modelId.startsWith("antigravity::") &&
      modelId.length > "antigravity::".length)
  );
}

export function availableModelCatalogs(
  availability: ProviderAvailability,
): Array<{
  provider: ModelProvider;
  title: string;
  models: Model[];
}> {
  const catalogs: Array<{
    provider: ModelProvider;
    title: string;
    models: Model[];
  }> = [
    {
      provider: "grok",
      title: "Grok",
      models: GROK_MODELS,
    },
    {
      provider: "openai",
      title: "OpenAI",
      models: OPENAI_MODELS,
    },
    {
      provider: "antigravity",
      title: "Antigravity",
      models: ANTIGRAVITY_MODELS,
    },
    {
      provider: "opencode",
      title: "OpenCode",
      models: OPENCODE_MODELS,
    },
  ];
  return catalogs.filter((catalog) => availability[catalog.provider]);
}

export function reconcileAvailableModelId(
  currentId: string,
  availability: ProviderAvailability,
): string | null {
  const current = ALL_MODELS.find((model) => model.id === currentId);
  if (current && availability[current.provider]) return current.id;
  if (isKnownModelId(currentId)) {
    const provider = providerOf(currentId);
    if (availability[provider]) return currentId;
  }
  return availableModelCatalogs(availability)[0]?.models[0]?.id ?? null;
}

export const THINKING_LEVELS: {
  id: ThinkingLevel;
  label: string;
  description: string;
}[] = [
  { id: "off", label: "Off", description: "No extended thinking" },
  { id: "low", label: "Low", description: "Light reasoning" },
  { id: "medium", label: "Medium", description: "Balanced" },
  { id: "high", label: "High", description: "Deep reasoning" },
  { id: "xhigh", label: "XHigh", description: "Extra deep reasoning" },
  { id: "max", label: "Max", description: "Maximum reasoning" },
  {
    id: "ultra",
    label: "Ultra",
    description: "Maximum reasoning with delegation",
  },
];

export const DEFAULT_MODEL_ID = "grok-4.5";
export const DEFAULT_THINKING: ThinkingLevel = "medium";
/** Default full so agents can read sibling repos (e.g. opencode) without crawl scripts. */
export const DEFAULT_ACCESS_MODE: AccessMode = "full";
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";
export const DEFAULT_AGENT_MODE: AgentMode = "build";

export const ACCESS_MODES: {
  id: AccessMode;
  label: string;
  description: string;
}[] = [
  {
    id: "workspace",
    label: "Workspace",
    description:
      "Path tools stay in the project; bash can still reach the machine",
  },
  {
    id: "full",
    label: "Full access",
    description: "Read/write absolute paths anywhere on this machine",
  },
];

export const PERMISSION_MODES: {
  id: PermissionMode;
  label: string;
  description: string;
}[] = [
  {
    id: "auto",
    label: "Auto",
    description: "Run tools immediately without pausing",
  },
  {
    id: "ask",
    label: "Ask",
    description: "Approve bash, file changes, and nested subagent tools before they run",
  },
];

export const AGENT_MODES: {
  id: AgentMode;
  label: string;
  description: string;
}[] = [
  {
    id: "plan",
    label: "Plan",
    description: "Read-only: research, outline, todos — no edits",
  },
  {
    id: "build",
    label: "Build",
    description: "Full coding tools: edit, bash, subagents",
  },
];

export function getModel(id: string): Model {
  const model = ALL_MODELS.find((candidate) => candidate.id === id);
  if (model) return model;
  const stored = storedModelDisplay(id);
  if (stored?.provider === "antigravity" || stored?.provider === "opencode") {
    return {
      id,
      label: stored.label,
      description: "Model metadata is loading from the provider",
      provider: stored.provider,
      thinking: false,
      defaultThinking: "off",
      supportedThinking: ["off"],
      context: "—",
    };
  }
  return GROK_MODELS[0];
}

/** Provider identity for a persisted thread model, including stale OpenCode catalogs. */
export function storedModelDisplay(
  id: string | null | undefined,
): Pick<Model, "label" | "provider"> | null {
  const modelId = id?.trim();
  if (!modelId) return null;
  const model = ALL_MODELS.find((candidate) => candidate.id === modelId);
  if (model) return { label: model.label, provider: model.provider };
  if (modelId.startsWith("opencode::")) {
    return {
      label: modelId.slice("opencode::".length),
      provider: "opencode",
    };
  }
  if (modelId.startsWith("antigravity::")) {
    return {
      label: modelId.slice("antigravity::".length),
      provider: "antigravity",
    };
  }
  if (modelId.startsWith("gpt-")) {
    return { label: modelId, provider: "openai" };
  }
  if (modelId.startsWith("grok-")) {
    return { label: modelId, provider: "grok" };
  }
  return null;
}

export function providerOf(id: string): ModelProvider {
  if (id.startsWith("opencode::")) return "opencode";
  if (id.startsWith("antigravity::")) return "antigravity";
  return getModel(id).provider;
}

export function supportsFastMode(id: string): boolean {
  return ALL_MODELS.find((model) => model.id === id)?.fastMode === true;
}

export function thinkingForModel(
  id: string,
  preferred: ThinkingLevel,
): ThinkingLevel {
  const model = getModel(id);
  return model.supportedThinking.includes(preferred)
    ? preferred
    : model.defaultThinking;
}
