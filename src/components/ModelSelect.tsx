import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, Star } from "lucide-react";
import {
  ACCESS_MODES,
  AGENT_MODES,
  PERMISSION_MODES,
  THINKING_LEVELS,
  availableModelCatalogs,
  getModel,
  type AccessMode,
  type AgentMode,
  type PermissionMode,
  type ProviderAvailability,
  type ModelProvider,
  type ThinkingLevel,
} from "../models";
import { scoreModelPickerSearch } from "../modelPickerSearch";
import { AntigravityLogo } from "./AntigravityLogo";
import { GrokLogo } from "./GrokLogo";
import { OpenAILogo } from "./OpenAILogo";
import { OpenCodeLogo } from "./OpenCodeLogo";
import {
  KEYBINDING_COMMAND_EVENT,
  resolveShortcutCommand,
  type KeybindingRule,
} from "../keybindings";

type MenuKind = "model" | "thinking" | "access" | "agent";

type Props = {
  modelId: string;
  thinking: ThinkingLevel;
  fastMode: boolean;
  accessMode: AccessMode;
  agentMode: AgentMode;
  permissionMode: PermissionMode;
  keybindings?: ReadonlyArray<KeybindingRule>;
  providerAvailability: ProviderAvailability;
  lockedProvider?: ModelProvider | null;
  disabled?: boolean;
  /** Hide labels when composer footer is narrow. */
  compact?: boolean;
  onModelChange: (id: string) => boolean | void;
  onThinkingChange: (level: ThinkingLevel) => void;
  onFastModeChange: (enabled: boolean) => void;
  onAccessModeChange: (mode: AccessMode) => void;
  onAgentModeChange: (mode: AgentMode) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
};

type MenuPos = { top: number; left: number };

const MODEL_FAVORITES_KEY = "open-xiao:model-favorites";

function loadModelFavorites(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(MODEL_FAVORITES_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function saveModelFavorites(ids: string[]): void {
  try {
    localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(ids));
  } catch {
    // Favorites still work for the current session when persistence is unavailable.
  }
}

function optionsForModelJump(menu: HTMLDivElement | null, index: number): HTMLElement | null {
  return (
    Array.from(
      menu?.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)') ?? [],
    )[index] ?? null
  );
}

function ProviderModelIcon({ provider, size = 16 }: { provider: ModelProvider; size?: number }) {
  if (provider === "openai") return <OpenAILogo size={size} />;
  if (provider === "antigravity") return <AntigravityLogo size={size} />;
  if (provider === "opencode") return <OpenCodeLogo size={size} />;
  if (provider === "grok") return <GrokLogo size={size} />;
  return (
    <span
      className="msel__provider-fallback"
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.55) }}
      aria-hidden
    >
      {provider.charAt(0).toUpperCase()}
    </span>
  );
}

export function ModelSelect({
  modelId,
  thinking,
  fastMode,
  accessMode,
  agentMode,
  permissionMode,
  keybindings = [],
  providerAvailability,
  lockedProvider = null,
  disabled,
  compact = false,
  onModelChange,
  onThinkingChange,
  onFastModeChange,
  onAccessModeChange,
  onAgentModeChange,
  onPermissionModeChange,
}: Props) {
  const [open, setOpen] = useState<MenuKind | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const thinkBtnRef = useRef<HTMLButtonElement>(null);
  const accessBtnRef = useRef<HTMLButtonElement>(null);
  const agentBtnRef = useRef<HTMLButtonElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const typeaheadRef = useRef({ value: "", at: 0 });
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [favoriteModelIds, setFavoriteModelIds] = useState(loadModelFavorites);
  const selectedModel = getModel(modelId);
  const model = providerAvailability[selectedModel.provider] !== false
    ? selectedModel
    : null;
  const fastModeAvailable =
    model?.provider === "openai" && model.fastMode === true;
  const effectiveFastMode = fastModeAvailable && fastMode;
  const fastModeHelp = fastModeAvailable
    ? "Availability and usage are controlled by your OpenAI plan"
    : model?.provider === "openai"
      ? `${model.label} does not support Fast mode. ${model.description}.`
      : "Select an OpenAI model that supports Fast mode";
  const modelCatalogs = useMemo(
    () => availableModelCatalogs(providerAvailability),
    [providerAvailability],
  );
  const catalogIdForModel = (candidateId: string) =>
    modelCatalogs.find((catalog) =>
      catalog.models.some((catalogModel) => catalogModel.id === candidateId),
    )?.id;
  const [selectedCatalog, setSelectedCatalog] = useState<string>(() =>
    favoriteModelIds.length > 0
      ? "favorites"
      : (catalogIdForModel(modelId) ?? modelCatalogs[0]?.id ?? "favorites"),
  );
  const favoriteModelSet = useMemo(
    () => new Set(favoriteModelIds),
    [favoriteModelIds],
  );
  const allModelItems = useMemo(
    () =>
      modelCatalogs.flatMap((catalog) =>
        catalog.models.map((catalogModel) => ({
          model: catalogModel,
          catalogId: catalog.id,
          catalogTitle: catalog.title,
        })),
      ),
    [modelCatalogs],
  );
  const visibleModelItems = useMemo(() => {
    if (modelSearch.trim()) {
      return allModelItems
        .filter(({ model: catalogModel }) =>
          lockedProvider == null || catalogModel.provider === lockedProvider,
        )
        .map((item) => ({
          ...item,
          score: scoreModelPickerSearch(
            {
              label: item.model.label,
              provider: item.model.provider,
              providerTitle: item.catalogTitle,
              subProvider: item.model.subProvider,
              isFavorite: favoriteModelSet.has(item.model.id),
            },
            modelSearch,
          ),
        }))
        .filter((item): item is typeof item & { score: number } => item.score !== null)
        .sort((left, right) =>
          left.score !== right.score
            ? left.score - right.score
            : left.model.label.localeCompare(right.model.label),
        );
    }

    return allModelItems
      .filter(({ model: catalogModel, catalogId }) => {
        if (lockedProvider != null && catalogModel.provider !== lockedProvider) return false;
        return selectedCatalog === "favorites"
          ? favoriteModelSet.has(catalogModel.id)
          : catalogId === selectedCatalog;
      })
      .sort((left, right) =>
        Number(favoriteModelSet.has(right.model.id)) -
        Number(favoriteModelSet.has(left.model.id)),
      );
  }, [allModelItems, favoriteModelSet, lockedProvider, modelSearch, selectedCatalog]);
  const thinkingEnabled = model?.thinking ?? false;
  const supportedThinking = model
    ? THINKING_LEVELS.filter((level) =>
        model.supportedThinking.includes(level.id),
      )
    : [];
  const thinkingOn = thinkingEnabled && thinking !== "off";
  const thinkingLabel = thinkingOn
    ? thinking.charAt(0).toUpperCase() + thinking.slice(1)
    : "Think";
  const accessFull = accessMode === "full";
  const accessLabel = accessFull ? "Full access" : "Workspace";
  const accessMeta = ACCESS_MODES.find((a) => a.id === accessMode);
  const agentPlan = agentMode === "plan";
  const agentLabel = agentPlan ? "Plan" : "Build";
  const agentMeta = AGENT_MODES.find((a) => a.id === agentMode);

  useEffect(() => {
    const selectedEntry = modelCatalogs.find(
      (catalog) => catalog.id === selectedCatalog,
    );
    if (
      lockedProvider != null &&
      selectedCatalog !== "favorites" &&
      selectedEntry?.provider !== lockedProvider
    ) {
      setSelectedCatalog(
        catalogIdForModel(modelId) ??
          modelCatalogs.find((catalog) => catalog.provider === lockedProvider)?.id ??
          "favorites",
      );
      return;
    }
    if (
      selectedCatalog !== "favorites" &&
      selectedEntry == null
    ) {
      setSelectedCatalog(
        catalogIdForModel(modelId) ?? modelCatalogs[0]?.id ?? "favorites",
      );
    }
  }, [lockedProvider, modelCatalogs, modelId, selectedCatalog]);

  const toggleFavorite = (favoriteId: string) => {
    setFavoriteModelIds((current) => {
      const next = current.includes(favoriteId)
        ? current.filter((id) => id !== favoriteId)
        : [...current, favoriteId];
      saveModelFavorites(next);
      return next;
    });
  };

  const triggerRef = (kind: MenuKind) => {
    if (kind === "model") return modelBtnRef;
    if (kind === "thinking") return thinkBtnRef;
    if (kind === "access") return accessBtnRef;
    return agentBtnRef;
  };

  const closeMenu = () => {
    const kind = open;
    setOpen(null);
    if (kind) {
      requestAnimationFrame(() => triggerRef(kind).current?.focus());
    }
  };

  const menuWidthGuess = (kind: MenuKind) => {
    if (kind === "model") return 360;
    if (kind === "access") return 248;
    if (kind === "agent") return 220;
    return 192;
  };

  const placeMenu = () => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const btn = triggerRef(open).current;
    const menu = menuRef.current;
    if (!btn) return;

    const rect = btn.getBoundingClientRect();
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const menuW = menu?.offsetWidth ?? menuWidthGuess(open);
    const menuH = menu?.offsetHeight ?? 220;

    let top = rect.top - menuH - gap;
    if (top < 8) {
      top = Math.min(rect.bottom + gap, vh - menuH - 8);
    }
    top = Math.max(8, top);

    let left = open === "model" ? rect.left : rect.right - menuW;
    left = Math.min(Math.max(8, left), vw - menuW - 8);

    setMenuPos({ top, left });
  };

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    placeMenu();
    const id = requestAnimationFrame(() => placeMenu());
    return () => cancelAnimationFrame(id);
  }, [open, modelId, thinking, fastMode, accessMode, agentMode, permissionMode, compact]);

  useEffect(() => {
    const selectJump = (index: number) => {
      const option = optionsForModelJump(menuRef.current, index);
      option?.click();
    };
    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ command?: string; index?: number }>).detail;
      if (detail?.command === "modelPicker.toggle") {
        setModelSearch("");
        setOpen((value) => (value === "model" ? null : "model"));
        return;
      }
      if (
        detail?.command?.startsWith("modelPicker.jump.") &&
        open === "model" &&
        detail.index != null
      ) {
        selectJump(detail.index);
      }
    };
    window.addEventListener(KEYBINDING_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(KEYBINDING_COMMAND_EVENT, onCommand);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const focusId = requestAnimationFrame(() => {
      if (open === "model") {
        modelSearchRef.current?.focus({ preventScroll: true });
        return;
      }
      const menu = menuRef.current;
      const selected = menu?.querySelector<HTMLElement>(
        '[role="option"][aria-selected="true"]',
      );
      const first = menu?.querySelector<HTMLElement>('[role="option"]');
      (selected ?? first)?.focus();
    });
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      const command = resolveShortcutCommand(e, keybindings, {
        terminalFocus: false,
        previewOpen: false,
        modelPickerOpen: open === "model",
      });
      if (command?.startsWith("modelPicker.jump.")) {
        const index = Number(command.slice("modelPicker.jump.".length)) - 1;
        const option = optionsForModelJump(menuRef.current, index);
        if (option) {
          e.preventDefault();
          e.stopImmediatePropagation();
          option.click();
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const kind = open;
        setOpen(null);
        triggerRef(kind).current?.focus();
        return;
      }
      const options = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)') ?? [],
      );
      if (options.length === 0) return;
      if (e.target === modelSearchRef.current) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          options[0]?.focus();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          options[options.length - 1]?.focus();
        } else if (e.key === "Enter") {
          e.preventDefault();
          options[0]?.click();
        }
        return;
      }
      const current = options.indexOf(document.activeElement as HTMLElement);
      let next = -1;
      if (e.key === "ArrowDown") next = (current + 1 + options.length) % options.length;
      else if (e.key === "ArrowUp")
        next = (current - 1 + options.length) % options.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = options.length - 1;
      if (next >= 0) {
        e.preventDefault();
        options[next].focus();
        return;
      }
      if (
        e.key.length === 1 &&
        e.key !== " " &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        const now = Date.now();
        const previous =
          now - typeaheadRef.current.at > 700
            ? ""
            : typeaheadRef.current.value;
        const value = `${previous}${e.key.toLowerCase()}`;
        typeaheadRef.current = { value, at: now };
        const match = options.find((option) =>
          (option.textContent ?? "").trim().toLowerCase().startsWith(value),
        );
        if (match) {
          e.preventDefault();
          match.focus();
        }
      }
    };
    const onReposition = () => placeMenu();
    document.addEventListener("mousedown", onDoc);
    // Capture so Escape closes the menu before App's window handler runs.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      cancelAnimationFrame(focusId);
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [keybindings, open]);

  useEffect(() => {
    if (model && !model.supportedThinking.includes(thinking)) {
      onThinkingChange(model.defaultThinking);
    }
  }, [model, thinking, onThinkingChange]);

  const menuClass =
    open === "thinking"
      ? "think"
      : open === "access"
        ? "access"
        : open === "agent"
          ? "agent"
          : "model";

  const menu =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            className={`msel__menu msel__menu--${menuClass} msel__menu--portal`}
            role={open === "model" ? "dialog" : "listbox"}
            aria-label={`${menuClass} options`}
            style={
              menuPos
                ? {
                    top: menuPos.top,
                    left: menuPos.left,
                    visibility: "visible",
                  }
                : { visibility: "hidden", top: 0, left: 0 }
            }
          >
            {open === "model" ? (
              <div className={`msel__model-picker${modelSearch.trim() ? " is-searching" : ""}`}>
                {!modelSearch.trim() ? (
                  <aside className="msel__provider-rail" aria-label="Model providers">
                    <button
                      type="button"
                      className={`msel__provider-tab${selectedCatalog === "favorites" ? " is-selected" : ""}`}
                      onClick={() => {
                        setSelectedCatalog("favorites");
                        modelSearchRef.current?.focus();
                      }}
                      aria-label="Favorites"
                      title="Favorites"
                    >
                      <Star size={19} fill="currentColor" />
                    </button>
                    <span className="msel__provider-divider" aria-hidden />
                    {modelCatalogs.map((catalog) => {
                      const providerLocked =
                        lockedProvider != null && catalog.provider !== lockedProvider;
                      return (
                        <button
                          key={catalog.id}
                          type="button"
                          className={`msel__provider-tab${selectedCatalog === catalog.id ? " is-selected" : ""}`}
                          onClick={() => {
                            setSelectedCatalog(catalog.id);
                            modelSearchRef.current?.focus();
                          }}
                          disabled={providerLocked}
                          aria-label={
                            providerLocked
                              ? `${catalog.title} is unavailable in this thread`
                              : catalog.title
                          }
                          title={
                            providerLocked
                              ? `Start a new thread to switch to ${catalog.title}`
                              : catalog.title
                          }
                        >
                          <ProviderModelIcon provider={catalog.provider} size={20} />
                        </button>
                      );
                    })}
                  </aside>
                ) : null}

                <div className="msel__model-main">
                  <div className="msel__model-search">
                    <Search size={16} aria-hidden />
                    <input
                      ref={modelSearchRef}
                      value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)}
                      placeholder="Search models..."
                      aria-label="Search models"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>

                  <div className="msel__model-results" role="listbox" aria-label="Models">
                    {visibleModelItems.map(({ model: itemModel, catalogTitle }) => {
                      const active = itemModel.id === modelId;
                      const providerLocked =
                        lockedProvider != null && itemModel.provider !== lockedProvider;
                      const favorite = favoriteModelSet.has(itemModel.id);
                      return (
                        <div
                          key={itemModel.id}
                          className={`msel__model-row${active ? " is-active" : ""}`}
                        >
                          <button
                            type="button"
                            role="option"
                            tabIndex={-1}
                            aria-selected={active}
                            className="msel__model-select"
                            disabled={providerLocked}
                            title={itemModel.description}
                            onClick={() => {
                              if (onModelChange(itemModel.id) !== false) closeMenu();
                            }}
                          >
                            <span className="msel__item-main">
                              <span className="msel__item-name">
                                {itemModel.label}
                                {itemModel.badge ? (
                                  <span className="msel__badge">{itemModel.badge}</span>
                                ) : null}
                              </span>
                              <span className="msel__model-provider">
                                <ProviderModelIcon provider={itemModel.provider} size={12} />
                                <span>
                                  {catalogTitle}
                                  {itemModel.subProvider ? ` · ${itemModel.subProvider}` : ""}
                                </span>
                              </span>
                            </span>
                            <span className="msel__item-meta">{itemModel.context}</span>
                          </button>
                          <button
                            type="button"
                            className={`msel__favorite${favorite ? " is-favorite" : ""}`}
                            onClick={() => toggleFavorite(itemModel.id)}
                            disabled={providerLocked}
                            aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
                            title={favorite ? "Remove from favorites" : "Add to favorites"}
                          >
                            <Star size={13} fill={favorite ? "currentColor" : "none"} />
                          </button>
                        </div>
                      );
                    })}
                    {visibleModelItems.length === 0 ? (
                      <div className="msel__model-empty">No models found</div>
                    ) : null}
                  </div>

                  {!modelSearch.trim() &&
                  modelCatalogs.find((catalog) => catalog.id === selectedCatalog)
                    ?.provider === "openai" ? (
                    <div className="msel__fast-row" title={fastModeHelp}>
                      <span className="msel__fast-copy">
                        <span className="msel__fast-title">
                          <ZapIcon filled={effectiveFastMode} />
                          Fast mode
                        </span>
                        <span className="msel__fast-desc">
                          Priority routing with higher Codex credit usage
                        </span>
                      </span>
                      <button
                        type="button"
                        role="switch"
                        className="msel__fast-switch"
                        aria-label="OpenAI Fast mode"
                        aria-checked={effectiveFastMode}
                        disabled={!fastModeAvailable}
                        onClick={() => onFastModeChange(!effectiveFastMode)}
                        title={fastModeHelp}
                      >
                        <span aria-hidden />
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {open === "thinking" ? (
              <>
                <div className="msel__menu-title">Reasoning</div>
                {supportedThinking.map((t) => {
                  const active = t.id === thinking;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={active}
                      className={`msel__item${active ? " is-active" : ""}`}
                      onClick={() => {
                        onThinkingChange(t.id);
                        closeMenu();
                      }}
                    >
                      <span className="msel__item-main">
                        <span className="msel__item-name">
                          {t.id !== "off" ? (
                            <ZapIcon filled={active} className="msel__item-zap" />
                          ) : null}
                          {t.label}
                          {t.id === "medium" ? (
                            <span className="msel__badge">Default</span>
                          ) : null}
                        </span>
                        <span className="msel__item-desc">{t.description}</span>
                      </span>
                      {active ? <CheckIcon /> : null}
                    </button>
                  );
                })}
              </>
            ) : null}

            {open === "access" ? (
              <>
                <div className="msel__menu-title">Access</div>
                {ACCESS_MODES.map((a) => {
                  const active = a.id === accessMode;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={active}
                      className={`msel__item${active ? " is-active" : ""}`}
                      onClick={() => {
                        onAccessModeChange(a.id);
                        closeMenu();
                      }}
                    >
                      <span className="msel__item-main">
                        <span className="msel__item-name">
                          {a.id === "full" ? (
                            <UnlockIcon className="msel__item-zap" />
                          ) : (
                            <LockIcon className="msel__item-zap" />
                          )}
                          {a.label}
                          {a.id === "full" ? (
                            <span className="msel__badge">Default</span>
                          ) : null}
                        </span>
                        <span className="msel__item-desc">{a.description}</span>
                      </span>
                      {active ? <CheckIcon /> : null}
                    </button>
                  );
                })}
                <div className="msel__menu-title">Approvals</div>
                {PERMISSION_MODES.filter(
                  (p) => model?.provider !== "antigravity" || p.id !== "ask",
                ).map((p) => {
                  const active = p.id === permissionMode;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={active}
                      className={`msel__item${active ? " is-active" : ""}`}
                      onClick={() => {
                        onPermissionModeChange(p.id);
                        closeMenu();
                      }}
                    >
                      <span className="msel__item-main">
                        <span className="msel__item-name">
                          {p.id === "ask" ? (
                            <ShieldIcon className="msel__item-zap" />
                          ) : (
                            <BoltIcon className="msel__item-zap" />
                          )}
                          {p.label}
                          {p.id === "auto" ? (
                            <span className="msel__badge">Default</span>
                          ) : null}
                        </span>
                        <span className="msel__item-desc">
                          {p.description}
                        </span>
                      </span>
                      {active ? <CheckIcon /> : null}
                    </button>
                  );
                })}
              </>
            ) : null}

            {open === "agent" ? (
              <>
                <div className="msel__menu-title">Agent mode</div>
                {AGENT_MODES.map((a) => {
                  const active = a.id === agentMode;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={active}
                      className={`msel__item${active ? " is-active" : ""}`}
                      onClick={() => {
                        onAgentModeChange(a.id);
                        closeMenu();
                      }}
                    >
                      <span className="msel__item-main">
                        <span className="msel__item-name">
                          {a.id === "plan" ? (
                            <PlanIcon className="msel__item-zap" />
                          ) : (
                            <BuildIcon className="msel__item-zap" />
                          )}
                          {a.label}
                          {a.id === "build" ? (
                            <span className="msel__badge">Default</span>
                          ) : null}
                        </span>
                        <span className="msel__item-desc">{a.description}</span>
                      </span>
                      {active ? <CheckIcon /> : null}
                    </button>
                  );
                })}
              </>
            ) : null}

          </div>,
          document.body,
        )
      : null;

  return (
    <div className={`msel${compact ? " is-compact" : ""}`} ref={rootRef}>
      <button
        ref={modelBtnRef}
        type="button"
        className={`msel__trigger${open === "model" ? " is-open" : ""}`}
        disabled={disabled || modelCatalogs.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open === "model"}
        aria-label={compact ? `Model: ${model?.label ?? "No model"}` : undefined}
        onClick={() => {
          setModelSearch("");
          setOpen((value) => (value === "model" ? null : "model"));
        }}
        title={model?.description ?? "Sign in to choose a model"}
      >
        {model ? (
          <span className="msel__ico" aria-hidden>
            <ProviderModelIcon provider={model.provider} size={16} />
          </span>
        ) : null}
        {!compact ? (
          <span className="msel__label">{model?.label ?? "No model"}</span>
        ) : null}
        <ChevronIcon />
      </button>

      {thinkingEnabled ? (
        <button
          ref={thinkBtnRef}
          type="button"
          className={`msel__think${open === "thinking" ? " is-open" : ""}${thinkingOn ? " is-on" : ""}`}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open === "thinking"}
          aria-label={compact ? `Reasoning: ${thinkingLabel}` : undefined}
          onClick={() =>
            setOpen((v) => (v === "thinking" ? null : "thinking"))
          }
          title="Reasoning effort"
        >
          <span className="msel__ico" aria-hidden>
            <ZapIcon filled={thinkingOn} />
          </span>
          {!compact ? (
            <span className="msel__label">{thinkingLabel}</span>
          ) : null}
          <ChevronIcon />
        </button>
      ) : null}

      <button
        ref={accessBtnRef}
        type="button"
        className={`msel__access${open === "access" ? " is-open" : ""}${accessFull ? " is-on" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open === "access"}
        aria-label={compact ? `Access: ${accessLabel}` : undefined}
        onClick={() => setOpen((v) => (v === "access" ? null : "access"))}
        title={accessMeta?.description ?? "Tool filesystem access"}
      >
        <span className="msel__ico" aria-hidden>
          {accessFull ? <UnlockIcon /> : <LockIcon />}
        </span>
        {!compact ? <span className="msel__label">{accessLabel}</span> : null}
        <ChevronIcon />
      </button>

      <button
        ref={agentBtnRef}
        type="button"
        className={`msel__agent${open === "agent" ? " is-open" : ""}${agentPlan ? " is-on" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open === "agent"}
        aria-label={compact ? `Agent: ${agentLabel}` : undefined}
        onClick={() => setOpen((v) => (v === "agent" ? null : "agent"))}
        title={agentMeta?.description ?? "Plan or Build agent mode"}
      >
        <span className="msel__ico" aria-hidden>
          {agentPlan ? <PlanIcon /> : <BuildIcon />}
        </span>
        {!compact ? <span className="msel__label">{agentLabel}</span> : null}
        <ChevronIcon />
      </button>

      {menu}
    </div>
  );
}

function ZapIcon({
  filled,
  className,
}: {
  filled?: boolean;
  className?: string;
}) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      aria-hidden
      className={className}
    >
      <path
        d="M13 2 4.5 13.5H11l-1 8.5L19.5 10.5H13L13 2Z"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <rect
        x="5"
        y="11"
        width="14"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.85"
      />
      <path
        d="M8 11V8a4 4 0 0 1 8 0v3"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
      />
    </svg>
  );
}

function UnlockIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <rect
        x="5"
        y="11"
        width="14"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.85"
      />
      <path
        d="M8 11V8a4 4 0 0 1 7.5-2"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlanIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M8 6h12M8 12h12M8 18h8"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
      />
      <circle cx="4.5" cy="6" r="1.2" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="4.5" cy="18" r="1.2" fill="currentColor" />
    </svg>
  );
}

function BuildIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.9-2.9 2-2.1Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BoltIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="msel__chev"
    >
      <path
        d="M6 9.5 12 15.5 18 9.5"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className="msel__check"
    >
      <path
        d="M3 7.2 5.8 10 11 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
