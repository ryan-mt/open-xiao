import { useMemo, useState } from "react";
import {
  ArrowLeft,
  CalendarClock,
  ExternalLink,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import type {
  AutomationSchedule,
  AutomationTask,
  AutomationUpsertInput,
} from "../../automations";
import type {
  AccessMode,
  AgentMode,
  Model,
  PermissionMode,
} from "../../models";
import { modelCatalogsForModels } from "../../models";
import type { Project } from "../../types";
import { requestConfirmDialog } from "../../confirmDialog";
import { Select } from "../Select";

type ScheduleMode = "fixed_time" | "interval";

type Draft = {
  id?: string;
  title: string;
  prompt: string;
  enabled: boolean;
  scheduleMode: ScheduleMode;
  everyMinutes: string;
  timeOfDay: string;
  weekdays: Set<number>;
  projectId: string;
  modelId: string;
  accessMode: AccessMode;
  permissionMode: PermissionMode;
  agentMode: AgentMode;
};

const WEEKDAYS = [
  { id: 1, label: "Mo" },
  { id: 2, label: "Tu" },
  { id: 3, label: "We" },
  { id: 4, label: "Th" },
  { id: 5, label: "Fr" },
  { id: 6, label: "Sa" },
  { id: 0, label: "Su" },
] as const;

const ACCESS_OPTIONS = [
  { id: "workspace" as const, label: "Workspace only" },
  { id: "full" as const, label: "Full machine" },
];

const PERMISSION_OPTIONS = [
  { id: "ask" as const, label: "Ask first" },
  { id: "auto" as const, label: "Run automatically" },
];

const AGENT_OPTIONS = [
  { id: "build" as const, label: "Build" },
  { id: "plan" as const, label: "Plan only" },
];

function blankDraft(projects: Project[], models: Model[]): Draft {
  return {
    title: "",
    prompt: "",
    enabled: true,
    scheduleMode: "fixed_time",
    everyMinutes: "30",
    timeOfDay: "09:00",
    weekdays: new Set([1, 2, 3, 4, 5]),
    projectId: projects[0]?.id ?? "",
    modelId: models[0]?.id ?? "",
    accessMode: "workspace",
    permissionMode: "ask",
    agentMode: "build",
  };
}

function taskDraft(task: AutomationTask): Draft {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode: task.schedule.type,
    everyMinutes:
      task.schedule.type === "interval"
        ? String(task.schedule.everyMinutes)
        : "30",
    timeOfDay:
      task.schedule.type === "fixed_time" ? task.schedule.timeOfDay : "09:00",
    weekdays:
      task.schedule.type === "fixed_time"
        ? new Set(task.schedule.weekdays)
        : new Set([1, 2, 3, 4, 5]),
    projectId: task.projectId,
    modelId: task.modelId,
    accessMode: task.accessMode,
    permissionMode: task.permissionMode,
    agentMode: task.agentMode,
  };
}

function scheduleForDraft(draft: Draft): AutomationSchedule {
  return draft.scheduleMode === "interval"
    ? {
        type: "interval",
        everyMinutes: Math.max(
          1,
          Math.floor(Number.parseInt(draft.everyMinutes, 10) || 1),
        ),
      }
    : {
        type: "fixed_time",
        timeOfDay: draft.timeOfDay,
        weekdays: [...draft.weekdays].sort((left, right) => left - right),
      };
}

export function automationScheduleLabel(schedule: AutomationSchedule): string {
  if (schedule.type === "interval") {
    return `Every ${schedule.everyMinutes} ${schedule.everyMinutes === 1 ? "minute" : "minutes"}`;
  }
  const weekdays = schedule.weekdays;
  const dayLabel =
    weekdays.length === 0 || weekdays.length === 7
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : WEEKDAYS.filter((day) => weekdays.includes(day.id))
            .map((day) => day.label)
            .join(", ");
  return `${dayLabel} at ${schedule.timeOfDay}`;
}

export function automationRelativeTime(value: number | null, now = Date.now()): string {
  if (value == null) return "Not scheduled";
  const minutes = Math.ceil((value - now) / 60_000);
  if (minutes <= 0) return "due now";
  if (minutes === 1) return "in a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export type AutomationsPageProps = {
  tasks: AutomationTask[];
  projects: Project[];
  models: Model[];
  onSave: (input: AutomationUpsertInput) => Promise<void>;
  onSetEnabled: (id: string, enabled: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRunNow: (id: string) => Promise<void>;
  onOpenThread: (id: string) => void;
};

export function AutomationsPage({
  tasks,
  projects,
  models,
  onSave,
  onSetEnabled,
  onDelete,
  onRunNow,
  onOpenThread,
}: AutomationsPageProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const modelCatalogs = useMemo(() => modelCatalogsForModels(models), [models]);
  const selectedModelCatalog =
    modelCatalogs.find((catalog) =>
      catalog.models.some((model) => model.id === draft?.modelId),
    ) ?? modelCatalogs[0];
  const providerOptions = modelCatalogs.map((catalog) => ({
    id: catalog.id,
    label:
      catalog.provider === "opencode"
        ? `${catalog.title} via OpenCode`
        : catalog.title,
  }));
  const modelOptions = (selectedModelCatalog?.models ?? []).map((model) => ({
    id: model.id,
    label: model.label,
  }));
  const projectOptions = projects.map((project) => ({
    id: project.id,
    label: project.name,
  }));
  const canCreate = projects.length > 0 && models.length > 0;

  const runMutation = async (id: string, mutation: () => Promise<void>) => {
    if (busyId) return;
    setError(null);
    setBusyId(id);
    try {
      await mutation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  if (draft) {
    const valid =
      draft.title.trim().length > 0 &&
      draft.prompt.trim().length > 0 &&
      draft.projectId.length > 0 &&
      draft.modelId.length > 0 &&
      (draft.scheduleMode === "interval" || /^\d{2}:\d{2}$/.test(draft.timeOfDay));
    return (
      <>
        <div className="settings-v2__header automation-header">
          <button
            type="button"
            className="automation-back"
            onClick={() => setDraft(null)}
            aria-label="Back to automations"
          >
            <ArrowLeft size={15} />
          </button>
          <div>
            <h2 className="settings-v2__title">
              {draft.id ? "Edit automation" : "New automation"}
            </h2>
            <p className="automation-header__subtitle">
              Runs on this computer while Open Xiao is running.
            </p>
          </div>
        </div>
        <div className="settings-v2__body automation-editor">
          {error ? <div className="automation-error-banner">{error}</div> : null}
          <div className="automation-field">
            <label htmlFor="automation-title">Name</label>
            <input
              id="automation-title"
              autoFocus
              value={draft.title}
              placeholder="Morning dependency review"
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </div>
          <div className="automation-field">
            <div className="automation-field__label-row">
              <label htmlFor="automation-prompt">Prompt</label>
              <span>Sent exactly as written</span>
            </div>
            <textarea
              id="automation-prompt"
              rows={6}
              value={draft.prompt}
              placeholder="Review dependency updates, run focused tests, and summarize anything that needs attention."
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </div>
          <div className="automation-form-grid automation-form-grid--four">
            <div className="automation-field">
              <label>Project</label>
              <Select
                value={draft.projectId}
                options={projectOptions}
                onChange={(projectId) => setDraft({ ...draft, projectId })}
                aria-label="Automation project"
                className="automation-select"
              />
            </div>
            <div className="automation-field">
              <label>Provider</label>
              <Select
                value={selectedModelCatalog?.id ?? ""}
                options={providerOptions}
                onChange={(catalogId) => {
                  const modelId = modelCatalogs.find(
                    (catalog) => catalog.id === catalogId,
                  )?.models[0]?.id;
                  if (modelId) setDraft({ ...draft, modelId });
                }}
                aria-label="Automation provider"
                className="automation-select"
              />
            </div>
            <div className="automation-field">
              <label>Model</label>
              <Select
                value={draft.modelId}
                options={modelOptions}
                onChange={(modelId) => setDraft({ ...draft, modelId })}
                aria-label="Automation model"
                className="automation-select"
              />
            </div>
            <div className="automation-field">
              <label>Approval</label>
              <Select
                value={draft.permissionMode}
                options={PERMISSION_OPTIONS}
                onChange={(permissionMode) => setDraft({ ...draft, permissionMode })}
                aria-label="Automation approval mode"
                className="automation-select"
              />
            </div>
          </div>
          <div className="automation-form-grid automation-form-grid--three">
            <div className="automation-field">
              <label>Agent mode</label>
              <Select
                value={draft.agentMode}
                options={AGENT_OPTIONS}
                onChange={(agentMode) => setDraft({ ...draft, agentMode })}
                aria-label="Automation agent mode"
                className="automation-select"
              />
            </div>
            <div className="automation-field">
              <label>File access</label>
              <Select
                value={draft.accessMode}
                options={ACCESS_OPTIONS}
                onChange={(accessMode) => setDraft({ ...draft, accessMode })}
                aria-label="Automation file access"
                className="automation-select"
              />
            </div>
            <div className="automation-field">
              <label>Schedule</label>
              <Select
                value={draft.scheduleMode}
                options={[
                  { id: "fixed_time", label: "At a fixed time" },
                  { id: "interval", label: "On an interval" },
                ]}
                onChange={(scheduleMode) => setDraft({ ...draft, scheduleMode })}
                aria-label="Automation schedule type"
                className="automation-select"
              />
            </div>
          </div>
          {draft.scheduleMode === "interval" ? (
            <div className="automation-field automation-field--narrow">
              <div className="automation-field__label-row">
                <label htmlFor="automation-interval">Repeat every</label>
                <span>Minutes</span>
              </div>
              <input
                id="automation-interval"
                type="number"
                min={1}
                value={draft.everyMinutes}
                onChange={(event) =>
                  setDraft({ ...draft, everyMinutes: event.target.value })
                }
              />
            </div>
          ) : (
            <div className="automation-schedule-row">
              <div className="automation-field automation-field--time">
                <div className="automation-field__label-row">
                  <label htmlFor="automation-time">Time</label>
                  <span>Computer local time</span>
                </div>
                <input
                  id="automation-time"
                  type="time"
                  value={draft.timeOfDay}
                  onChange={(event) =>
                    setDraft({ ...draft, timeOfDay: event.target.value })
                  }
                />
              </div>
              <div className="automation-field automation-field--days">
                <label>Run on</label>
                <div className="automation-weekdays">
                  {WEEKDAYS.map((day) => {
                    const selected = draft.weekdays.has(day.id);
                    return (
                      <button
                        key={day.id}
                        type="button"
                        className={selected ? "is-selected" : ""}
                        aria-pressed={selected}
                        onClick={() => {
                          const weekdays = new Set(draft.weekdays);
                          if (selected) weekdays.delete(day.id);
                          else weekdays.add(day.id);
                          setDraft({ ...draft, weekdays });
                        }}
                      >
                        {day.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          <div className="automation-enabled-row">
            <div>
              <strong>Enabled</strong>
              <span>Pause this automation without deleting its setup.</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={draft.enabled}
              className={`settings-v2__switch${draft.enabled ? " is-on" : ""}`}
              onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
            >
              <span className="settings-v2__switch-thumb" />
            </button>
          </div>
          <div className="automation-editor__actions">
            <button
              type="button"
              className="settings-v2__btn"
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="settings-v2__btn settings-v2__btn--primary"
              disabled={!valid || busyId === (draft.id ?? "new")}
              onClick={() =>
                void runMutation(draft.id ?? "new", async () => {
                  await onSave({
                    ...(draft.id ? { id: draft.id } : {}),
                    title: draft.title,
                    prompt: draft.prompt,
                    enabled: draft.enabled,
                    schedule: scheduleForDraft(draft),
                    projectId: draft.projectId,
                    modelId: draft.modelId,
                    accessMode: draft.accessMode,
                    permissionMode: draft.permissionMode,
                    agentMode: draft.agentMode,
                  });
                  setDraft(null);
                })
              }
            >
              {busyId ? "Saving..." : draft.id ? "Save changes" : "Create automation"}
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="settings-v2__header automation-header">
        <div>
          <h2 className="settings-v2__title">Automations</h2>
          <p className="automation-header__subtitle">
            Scheduled prompts, each in a fresh chat.
          </p>
        </div>
        <button
          type="button"
          className="settings-v2__btn settings-v2__btn--primary automation-new"
          disabled={!canCreate}
          onClick={() => setDraft(blankDraft(projects, models))}
        >
          <Plus size={14} />
          New
        </button>
      </div>
      <div className="settings-v2__body automation-page">
        {error ? <div className="automation-error-banner">{error}</div> : null}
        {tasks.length === 0 ? (
          <div className="automation-empty">
            <div className="automation-empty__mark">
              <CalendarClock size={22} strokeWidth={1.5} />
            </div>
            <h3>No automations yet</h3>
            <p>
              {canCreate
                ? "Schedule reviews, maintenance, or recurring research without keeping a prompt in your head."
                : "Add a project and sign in to a model provider before creating an automation."}
            </p>
            <button
              type="button"
              className="settings-v2__btn"
              disabled={!canCreate}
              onClick={() => setDraft(blankDraft(projects, models))}
            >
              Create your first automation
            </button>
          </div>
        ) : (
          <div className="automation-list">
            {tasks.map((task) => {
              const project = projectById.get(task.projectId);
              const running = task.lastRunStatus === "running";
              return (
                <article key={task.id} className="automation-row">
                  <div className="automation-row__status" data-status={task.lastRunStatus} />
                  <div className="automation-row__copy">
                    <div className="automation-row__title-line">
                      <h3>{task.title}</h3>
                      <span className={`automation-status is-${task.lastRunStatus}`}>
                        {task.lastRunStatus === "never"
                          ? "Not run"
                          : task.lastRunStatus === "running"
                            ? "Running"
                            : task.lastRunStatus === "succeeded"
                              ? "Completed"
                              : "Failed"}
                      </span>
                      {!task.enabled ? <span className="automation-status">Paused</span> : null}
                    </div>
                    <p className="automation-row__prompt">{task.prompt}</p>
                    <div className="automation-row__meta">
                      <span>{project?.name ?? "Missing project"}</span>
                      <span>{automationScheduleLabel(task.schedule)}</span>
                      {task.enabled ? (
                        <span>Next {automationRelativeTime(task.nextRunAt)}</span>
                      ) : null}
                      {task.runCount > 0 ? (
                        <span>{task.runCount} {task.runCount === 1 ? "run" : "runs"}</span>
                      ) : null}
                    </div>
                    {task.lastError ? (
                      <p className="automation-row__error">{task.lastError}</p>
                    ) : null}
                  </div>
                  <div className="automation-row__actions">
                    {task.lastThreadId ? (
                      <button
                        type="button"
                        onClick={() => onOpenThread(task.lastThreadId!)}
                        aria-label={`Open latest run of ${task.title}`}
                        title="Open latest run"
                      >
                        <ExternalLink size={15} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={busyId !== null || running}
                      onClick={() => void runMutation(task.id, () => onRunNow(task.id))}
                      aria-label={`Run ${task.title} now`}
                      title="Run now"
                    >
                      <Play size={15} />
                    </button>
                    <button
                      type="button"
                      disabled={busyId !== null || running}
                      onClick={() => setDraft(taskDraft(task))}
                      aria-label={`Edit ${task.title}`}
                      title="Edit"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      disabled={busyId !== null || running}
                      onClick={() =>
                        void (async () => {
                          const confirmed = await requestConfirmDialog(
                            `Delete “${task.title}”?`,
                            { variant: "destructive" },
                          );
                          if (!confirmed) return;
                          await runMutation(task.id, () => onDelete(task.id));
                        })()
                      }
                      aria-label={`Delete ${task.title}`}
                      title="Delete"
                    >
                      <Trash2 size={15} />
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={task.enabled}
                      aria-label={task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`}
                      className={`settings-v2__switch${task.enabled ? " is-on" : ""}`}
                      disabled={busyId !== null || running}
                      onClick={() =>
                        void runMutation(task.id, () =>
                          onSetEnabled(task.id, !task.enabled),
                        )
                      }
                    >
                      <span className="settings-v2__switch-thumb" />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
