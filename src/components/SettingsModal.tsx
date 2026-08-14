import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock } from "lucide-react";
import type { AuthStatus, OpenAIAuthStatus } from "../auth";
import {
  deleteAutomation,
  listAutomations,
  runAutomationNow,
  setAutomationEnabled,
  upsertAutomation,
  type AutomationTask,
} from "../automations";
import { APP_BASE_NAME, APP_ENVIRONMENT_LABEL } from "../branding";
import {
  ensureNotifyPermission,
  getNotifyPermission,
  notifyAgentDone,
  type NotifyPermissionState,
} from "../desktopNotify";
import { formatPlanLabel } from "../planLabel";
import type { Model } from "../models";
import { THEME_CATALOG, type ThemeMode } from "../theme";
import { timeGroupLabel, type Project, type Thread } from "../types";
import type { KeybindingRule } from "../keybindings";
import { Select } from "./Select";
import {
  APPEARANCE_THEME_PAGE_SIZE,
  AppearancePage,
} from "./settings/AppearancePage";
import { KeybindingsPage } from "./keybindings/KeybindingsPage";
import { AutomationsPage } from "./settings/AutomationsPage";
import {
  resolveEnvironmentIdentificationPillLabel,
  saveEnvironmentIdentificationMode,
  useEnvironmentIdentificationMode,
  type EnvironmentIdentificationMode,
} from "./SidebarStageBackdrop";

const APP_VERSION = "0.1.1";

const ENV_ID_OPTIONS: {
  id: EnvironmentIdentificationMode;
  label: string;
}[] = [
  { id: "artwork", label: "Artwork" },
  { id: "pill", label: "Version pill" },
  { id: "none", label: "None" },
];

export type SettingsModalProps = {
  open: boolean;
  blocked?: boolean;
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  collapseThinking: boolean;
  onCollapseThinkingChange: (value: boolean) => void;
  notifyOnAgentComplete: boolean;
  onNotifyOnAgentCompleteChange: (value: boolean) => void;
  notifyOnAgentError: boolean;
  onNotifyOnAgentErrorChange: (value: boolean) => void;
  keybindings: ReadonlyArray<KeybindingRule>;
  onKeybindingsChange: (value: KeybindingRule[]) => void;
  grokAuth: AuthStatus;
  grokAuthBusy?: boolean;
  onGrokLogin: () => void;
  onGrokLogout: () => void;
  openaiAuth: OpenAIAuthStatus;
  openaiAuthBusy?: boolean;
  onOpenAILogin: () => void;
  onOpenAILogout: () => void;
  threads?: Thread[];
  projects?: Project[];
  onUnarchiveThread?: (id: string) => void;
  onDeleteThread?: (id: string) => void;
  onOpenThread?: (id: string) => void;
  onArchiveAll?: () => void;
  archiveAllBusy?: boolean;
  onImportCodexChats?: () => void;
  importCodexChatsBusy?: boolean;
  importedCodexChatCount?: number;
  onUnimportCodexChats?: () => void;
  unimportCodexChatsBusy?: boolean;
  /** Thread ids currently streaming — excluded from Archive all. */
  workingThreadIds?: string[];
  automations?: AutomationTask[];
  automationModels?: Model[];
  onAutomationsChange?: (tasks: AutomationTask[]) => void;
  onClose: () => void;
};

type TabId =
  | "general"
  | "account"
  | "automations"
  | "archive"
  | "appearance"
  | "keybindings";

export function SettingsModal({
  open,
  blocked = false,
  theme,
  onThemeChange,
  collapseThinking,
  onCollapseThinkingChange,
  notifyOnAgentComplete,
  onNotifyOnAgentCompleteChange,
  notifyOnAgentError,
  onNotifyOnAgentErrorChange,
  keybindings,
  onKeybindingsChange,
  grokAuth,
  grokAuthBusy,
  onGrokLogin,
  onGrokLogout,
  openaiAuth,
  openaiAuthBusy,
  onOpenAILogin,
  onOpenAILogout,
  threads = [],
  projects = [],
  onUnarchiveThread,
  onDeleteThread,
  onOpenThread,
  onArchiveAll,
  archiveAllBusy = false,
  onImportCodexChats,
  importCodexChatsBusy = false,
  importedCodexChatCount = 0,
  onUnimportCodexChats,
  unimportCodexChatsBusy = false,
  workingThreadIds = [],
  automations = [],
  automationModels = [],
  onAutomationsChange,
  onClose,
}: SettingsModalProps) {
  const [tab, setTab] = useState<TabId>("general");
  const [themePage, setThemePage] = useState(0);
  const [archiveQuery, setArchiveQuery] = useState("");
  const [notifyPerm, setNotifyPerm] =
    useState<NotifyPermissionState>("default");
  const [testingNotification, setTestingNotification] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const envIdMode = useEnvironmentIdentificationMode();
  const showEnvironmentIdentification =
    resolveEnvironmentIdentificationPillLabel(APP_ENVIRONMENT_LABEL) !== null;

  const projectById = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const archivedThreads = useMemo(() => {
    const q = archiveQuery.trim().toLowerCase();
    return threads
      .filter((t) => t.archivedAt != null)
      .filter((t) => {
        if (!q) return true;
        const projectName = t.projectId
          ? (projectById.get(t.projectId)?.name ?? "")
          : "";
        return (
          t.title.toLowerCase().includes(q) ||
          projectName.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  }, [threads, archiveQuery, projectById]);

  const workingSet = useMemo(
    () => new Set(workingThreadIds),
    [workingThreadIds],
  );

  const liveChatCount = useMemo(
    () =>
      threads.filter((t) => {
        if (t.archivedAt != null) return false;
        // Keep chats that are still generating out of bulk archive.
        if (workingSet.has(t.id)) return false;
        return t.messages.length > 0 || t.title !== "New chat" || t.pinned;
      }).length,
    [threads, workingSet],
  );

  useEffect(() => {
    if (!open) return;
    setTab("general");
    setThemePage(0);
    setArchiveQuery("");
    void getNotifyPermission().then(setNotifyPerm);
  }, [open]);

  useEffect(() => {
    if (!open || blocked) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
    const focusInitial = window.requestAnimationFrame(() => {
      (focusable()[0] ?? dialog).focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocus = (e: FocusEvent) => {
      if (e.target instanceof Node && !dialog.contains(e.target)) {
        (focusable()[0] ?? dialog).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus, true);
    return () => {
      window.cancelAnimationFrame(focusInitial);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [blocked, open, onClose]);

  const toggleNotifyComplete = async () => {
    const next = !notifyOnAgentComplete;
    if (next) {
      await ensureNotifyPermission();
      setNotifyPerm(await getNotifyPermission());
    }
    onNotifyOnAgentCompleteChange(next);
  };

  const toggleNotifyError = async () => {
    const next = !notifyOnAgentError;
    if (next) {
      await ensureNotifyPermission();
      setNotifyPerm(await getNotifyPermission());
    }
    onNotifyOnAgentErrorChange(next);
  };

  const testNotification = async () => {
    if (testingNotification) return;
    setTestingNotification(true);
    try {
      await ensureNotifyPermission();
      setNotifyPerm(await getNotifyPermission());
      await notifyAgentDone({
        title: "Notifications ready",
        body: "Completion sound and desktop banner are working.",
        threadId: "notification-test",
        skipIfInView: false,
      });
    } finally {
      setTestingNotification(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="settings-backdrop"
      role="presentation"
      aria-hidden={blocked || undefined}
      inert={blocked}
      onMouseDown={(e) => {
        if (!blocked && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal={blocked ? undefined : "true"}
        aria-label="Settings"
        tabIndex={-1}
      >
        <div className="settings-dialog__actions">
          <button
            type="button"
            className="settings-dialog__icon-btn"
            onClick={onClose}
            aria-label="Close settings"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="settings-v2">
          <nav className="settings-v2__nav" aria-label="Settings sections">
            <div className="settings-v2__nav-body">
              <div className="settings-v2__nav-section">
                <div className="settings-v2__nav-label">General</div>
                <button
                  type="button"
                  className={`settings-v2__nav-item${tab === "general" ? " is-active" : ""}`}
                  onClick={() => setTab("general")}
                >
                  <SlidersIcon />
                  General
                </button>
                <button
                  type="button"
                  className={`settings-v2__nav-item${tab === "account" ? " is-active" : ""}`}
                  onClick={() => setTab("account")}
                >
                  <UserIcon />
                  Account
                </button>
              </div>

              <div className="settings-v2__nav-section">
                <div className="settings-v2__nav-label">Chats</div>
                <button
                  type="button"
                  className={`settings-v2__nav-item${tab === "automations" ? " is-active" : ""}`}
                  onClick={() => setTab("automations")}
                >
                  <CalendarClock size={14} />
                  Automations
                  {automations.length > 0 ? (
                    <span className="settings-v2__nav-count">
                      {automations.length}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className={`settings-v2__nav-item${tab === "archive" ? " is-active" : ""}`}
                  onClick={() => setTab("archive")}
                >
                  <ArchiveIcon />
                  Archive
                  {archivedThreads.length > 0 ? (
                    <span className="settings-v2__nav-count">
                      {archivedThreads.length}
                    </span>
                  ) : null}
                </button>
              </div>

              <div className="settings-v2__nav-section">
                <div className="settings-v2__nav-label">Desktop</div>
                <button
                  type="button"
                  className={`settings-v2__nav-item${tab === "appearance" ? " is-active" : ""}`}
                  onClick={() => {
                    setTab("appearance");
                    const selectedIndex = THEME_CATALOG.slice(3).findIndex(
                      (option) => option.id === theme,
                    );
                    setThemePage(
                      selectedIndex < 0
                        ? 0
                        : Math.floor(selectedIndex / APPEARANCE_THEME_PAGE_SIZE),
                    );
                  }}
                >
                  <ThemesIcon />
                  Appearance
                </button>
                <button
                  type="button"
                  className={`settings-v2__nav-item${tab === "keybindings" ? " is-active" : ""}`}
                  onClick={() => setTab("keybindings")}
                >
                  <KeyboardIcon />
                  Keybindings
                </button>
              </div>
            </div>
            <div className="settings-v2__nav-footer">
              <span>{APP_BASE_NAME}</span>
              <span>v{APP_VERSION}</span>
            </div>
          </nav>

          <div className="settings-v2__panel">
            {tab === "general" ? (
              <>
                <div className="settings-v2__header">
                  <h2 className="settings-v2__title">General</h2>
                </div>
                <div className="settings-v2__body">
                  <section className="settings-v2__section">
                    <h3 className="settings-v2__section-title">Chats</h3>
                    <div className="settings-v2__list">
                      <div className="settings-v2__row settings-v2__row--compact">
                        <div className="settings-v2__row-copy">
                          <div className="settings-v2__row-title">
                            Codex chats
                          </div>
                          <div className="settings-v2__row-desc">
                            Import local Codex history. Re-importing updates chats
                            without duplicates.
                          </div>
                        </div>
                        <div className="settings-v2__row-control settings-v2__row-control--actions">
                          <button
                            type="button"
                            className="settings-v2__btn"
                            disabled={
                              importCodexChatsBusy ||
                              unimportCodexChatsBusy ||
                              !onImportCodexChats
                            }
                            onClick={onImportCodexChats}
                          >
                            {importCodexChatsBusy ? "Importing..." : "Import"}
                          </button>
                          <button
                            type="button"
                            className="settings-v2__btn settings-v2__btn--ghost-danger"
                            disabled={
                              importedCodexChatCount === 0 ||
                              importCodexChatsBusy ||
                              unimportCodexChatsBusy ||
                              !onUnimportCodexChats
                            }
                            onClick={onUnimportCodexChats}
                          >
                            {unimportCodexChatsBusy
                              ? "Removing..."
                              : "Unimport"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="settings-v2__section">
                    <h3 className="settings-v2__section-title">Appearance</h3>
                    <div className="settings-v2__list">
                      {showEnvironmentIdentification ? (
                        <div className="settings-v2__row">
                          <div className="settings-v2__row-copy">
                            <div className="settings-v2__row-title">
                              Environment identification
                            </div>
                            <div className="settings-v2__row-desc">
                              Choose how Dev and Beta environments are
                              identified in the sidebar.
                            </div>
                          </div>
                          <div className="settings-v2__row-control">
                            <Select
                              className="settings-v2__select"
                              value={envIdMode}
                              options={ENV_ID_OPTIONS}
                              onChange={saveEnvironmentIdentificationMode}
                              aria-label="Environment identification"
                            />
                          </div>
                        </div>
                      ) : null}
                      <div className="settings-v2__row">
                        <div className="settings-v2__row-copy">
                          <div className="settings-v2__row-title">
                            Collapse thinking
                          </div>
                          <div className="settings-v2__row-desc">
                            Hide reasoning text by default and show only the
                            Thinking label. Click to expand.
                          </div>
                        </div>
                        <div className="settings-v2__row-control">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={collapseThinking}
                            aria-label="Collapse thinking"
                            className={`settings-v2__switch${collapseThinking ? " is-on" : ""}`}
                            onClick={() =>
                              onCollapseThinkingChange(!collapseThinking)
                            }
                          >
                            <span className="settings-v2__switch-thumb" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="settings-v2__section">
                    <h3 className="settings-v2__section-title">
                      Notifications
                    </h3>
                    <div className="settings-v2__list">
                      {notifyPerm === "unsupported" ? (
                        <div className="settings-v2__row">
                          <div className="settings-v2__row-copy">
                            <div className="settings-v2__row-title">
                              Not available
                            </div>
                            <div className="settings-v2__row-desc">
                              This environment does not support system
                              notifications.
                            </div>
                          </div>
                        </div>
                      ) : null}
                      {notifyPerm === "denied" ? (
                        <div className="settings-v2__row">
                          <div className="settings-v2__row-copy">
                            <div className="settings-v2__row-title">
                              Permission blocked
                            </div>
                            <div className="settings-v2__row-desc">
                              Notifications are blocked for this app. Allow them
                              in Windows Settings → System → Notifications.
                            </div>
                          </div>
                        </div>
                      ) : null}
                      <div className="settings-v2__row">
                        <div className="settings-v2__row-copy">
                          <div className="settings-v2__row-title">
                            Agent finished
                          </div>
                          <div className="settings-v2__row-desc">
                            Desktop banner in any window state, plus an audible
                            completion tone when a reply is ready.
                          </div>
                        </div>
                        <div className="settings-v2__row-control">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={notifyOnAgentComplete}
                            aria-label="Notify when agent finished"
                            className={`settings-v2__switch${notifyOnAgentComplete ? " is-on" : ""}`}
                            onClick={() => void toggleNotifyComplete()}
                          >
                            <span className="settings-v2__switch-thumb" />
                          </button>
                        </div>
                      </div>
                      <div className="settings-v2__row">
                        <div className="settings-v2__row-copy">
                          <div className="settings-v2__row-title">
                            Agent errors
                          </div>
                          <div className="settings-v2__row-desc">
                            Desktop banner when a turn fails and the app is in
                            any window state, plus an audible error tone.
                          </div>
                        </div>
                        <div className="settings-v2__row-control">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={notifyOnAgentError}
                            aria-label="Notify on agent errors"
                            className={`settings-v2__switch${notifyOnAgentError ? " is-on" : ""}`}
                            onClick={() => void toggleNotifyError()}
                          >
                            <span className="settings-v2__switch-thumb" />
                          </button>
                        </div>
                      </div>
                      <div className="settings-v2__row">
                        <div className="settings-v2__row-copy">
                          <div className="settings-v2__row-title">
                            Test notifications
                          </div>
                          <div className="settings-v2__row-desc">
                            Plays the app tone and sends a desktop banner now.
                          </div>
                        </div>
                        <div className="settings-v2__row-control">
                          <button
                            type="button"
                            className="settings-v2__btn"
                            disabled={testingNotification}
                            onClick={() => void testNotification()}
                          >
                            {testingNotification ? "Sending..." : "Send test"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              </>
            ) : tab === "account" ? (
              <>
                <div className="settings-v2__header">
                  <h2 className="settings-v2__title">Account</h2>
                </div>
                <div className="settings-v2__body">
                  <section className="settings-v2__section">
                    <div className="settings-v2__list">
                      <div className="settings-v2__row">
                        <div className="settings-v2__row-copy">
                          <div className="settings-v2__row-title">
                            Grok / xAI
                          </div>
                          <div className="settings-v2__row-desc">
                            {grokAuth.signedIn
                              ? [
                                  grokAuth.name || grokAuth.email || "Signed in",
                                  grokAuth.email &&
                                  grokAuth.email !== grokAuth.name
                                    ? grokAuth.email
                                    : null,
                                  formatPlanLabel(grokAuth.plan),
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : "Sign in with SuperGrok to chat with Grok models."}
                          </div>
                        </div>
                        <div className="settings-v2__row-control">
                          {grokAuth.signedIn ? (
                            <button
                              type="button"
                              className="settings-v2__btn"
                              disabled={grokAuthBusy}
                              onClick={onGrokLogout}
                            >
                              {grokAuthBusy ? "Signing out..." : "Sign out"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="settings-v2__btn settings-v2__btn--primary"
                              disabled={grokAuthBusy}
                              onClick={onGrokLogin}
                            >
                              {grokAuthBusy ? "Signing in..." : "Sign in"}
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="settings-v2__row">
                        <div className="settings-v2__row-copy">
                          <div className="settings-v2__row-title">
                            OpenAI
                          </div>
                          <div className="settings-v2__row-desc">
                            {openaiAuth.signedIn
                              ? [
                                  openaiAuth.email || "Signed in",
                                  formatPlanLabel(openaiAuth.plan),
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : "Sign in with OpenAI to use GPT models."}
                          </div>
                        </div>
                        <div className="settings-v2__row-control">
                          {openaiAuth.signedIn ? (
                            <button
                              type="button"
                              className="settings-v2__btn"
                              disabled={openaiAuthBusy}
                              onClick={onOpenAILogout}
                            >
                              {openaiAuthBusy ? "Signing out..." : "Sign out"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="settings-v2__btn settings-v2__btn--primary"
                              disabled={openaiAuthBusy}
                              onClick={onOpenAILogin}
                            >
                              {openaiAuthBusy ? "Signing in..." : "Sign in"}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              </>
            ) : tab === "automations" ? (
              <AutomationsPage
                tasks={automations}
                projects={projects}
                models={automationModels}
                onSave={async (input) => {
                  await upsertAutomation(input);
                  onAutomationsChange?.(await listAutomations());
                }}
                onSetEnabled={async (id, enabled) => {
                  await setAutomationEnabled(id, enabled);
                  onAutomationsChange?.(await listAutomations());
                }}
                onDelete={async (id) => {
                  await deleteAutomation(id);
                  onAutomationsChange?.(await listAutomations());
                }}
                onRunNow={async (id) => {
                  await runAutomationNow(id);
                  onAutomationsChange?.(await listAutomations());
                }}
                onOpenThread={(id) => onOpenThread?.(id)}
              />
            ) : tab === "appearance" ? (
              <AppearancePage
                onThemeChange={onThemeChange}
                onThemePageChange={setThemePage}
                theme={theme}
                themePage={themePage}
              />
            ) : tab === "archive" ? (
              <>
                <div className="settings-v2__header">
                  <h2 className="settings-v2__title">Archive</h2>
                </div>
                <div className="settings-v2__body settings-v2__body--archive">
                  <section className="settings-v2__section">
                    <h3 className="settings-v2__section-title">Bulk actions</h3>
                    <div className="settings-v2__list">
                      <div className="settings-v2__row">
                        <div className="settings-v2__row-copy">
                          <div className="settings-v2__row-title">
                            Archive all chats
                          </div>
                          <div className="settings-v2__row-desc">
                            Sweep idle open chats into the archive with a full-app
                            vortex. Chats that are still working stay open. You can
                            restore any chat later from this page.
                          </div>
                        </div>
                        <div className="settings-v2__row-control">
                          <button
                            type="button"
                            className="settings-v2__btn settings-v2__btn--danger"
                            disabled={
                              archiveAllBusy ||
                              liveChatCount === 0 ||
                              !onArchiveAll
                            }
                            onClick={() => onArchiveAll?.()}
                          >
                            {archiveAllBusy
                              ? "Archiving…"
                              : liveChatCount === 0
                                ? "Nothing to archive"
                                : `Archive all (${liveChatCount})`}
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="settings-v2__section">
                    <div className="settings-archive__head">
                      <h3 className="settings-v2__section-title">
                        Archived chats
                      </h3>
                      <span className="settings-archive__count">
                        {archivedThreads.length}
                      </span>
                    </div>

                    <div className="settings-archive__search">
                      <SearchIcon />
                      <input
                        type="search"
                        value={archiveQuery}
                        placeholder="Search archived chats…"
                        aria-label="Search archived chats"
                        onChange={(e) => setArchiveQuery(e.target.value)}
                      />
                    </div>

                    {archivedThreads.length === 0 ? (
                      <div className="settings-archive__empty">
                        <ArchiveIcon />
                        <p>
                          {archiveQuery.trim()
                            ? "No archived chats match this search."
                            : "No archived chats yet."}
                        </p>
                        <p className="settings-archive__empty-hint">
                          Archive from a chat menu, or use Archive all above.
                        </p>
                      </div>
                    ) : (
                      <ul className="settings-archive__list">
                        {archivedThreads.map((t) => {
                          const projectName = t.projectId
                            ? projectById.get(t.projectId)?.name
                            : null;
                          const when = t.archivedAt
                            ? timeGroupLabel(t.archivedAt)
                            : "";
                          const msgCount = t.messages.length;
                          return (
                            <li key={t.id} className="settings-archive__item">
                              <button
                                type="button"
                                className="settings-archive__main"
                                onClick={() => onOpenThread?.(t.id)}
                                title="Restore and open"
                              >
                                <span className="settings-archive__title">
                                  {t.title || "Untitled chat"}
                                </span>
                                <span className="settings-archive__meta">
                                  {projectName ? (
                                    <span>{projectName}</span>
                                  ) : (
                                    <span>Inbox</span>
                                  )}
                                  <span aria-hidden>·</span>
                                  <span>
                                    {msgCount} message
                                    {msgCount === 1 ? "" : "s"}
                                  </span>
                                  {when ? (
                                    <>
                                      <span aria-hidden>·</span>
                                      <span>Archived {when.toLowerCase()}</span>
                                    </>
                                  ) : null}
                                </span>
                              </button>
                              <div className="settings-archive__actions">
                                <button
                                  type="button"
                                  className="settings-v2__btn"
                                  onClick={() => onUnarchiveThread?.(t.id)}
                                >
                                  Restore
                                </button>
                                <button
                                  type="button"
                                  className="settings-v2__btn settings-v2__btn--ghost-danger"
                                  onClick={() => onDeleteThread?.(t.id)}
                                >
                                  Delete
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                </div>
              </>
            ) : (
              <KeybindingsPage
                keybindings={keybindings}
                onChange={onKeybindingsChange}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M4.5 20c1.6-3.2 4.3-5 7.5-5s5.9 1.8 7.5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ThemesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3.25a8.75 8.75 0 1 0 0 17.5h1.1c1.05 0 1.6-1.2.95-2.02-.7-.9-.08-2.23 1.06-2.23h1.14A4.5 4.5 0 0 0 20.75 12 8.75 8.75 0 0 0 12 3.25Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 10h.01M10 7h.01M14 7.5h.01"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="2"
        y="6"
        width="20"
        height="12"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3.5 7.5h17v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 4.5h19v3h-19v-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M10 12h4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="m16 16 3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
