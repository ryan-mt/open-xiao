import {
  approvalArgsPreview,
  type PendingApproval,
} from "../toolApproval";

type Props = {
  items: readonly PendingApproval[];
  busyId?: string | null;
  onApprove: (toolId: string) => void;
  onDeny: (toolId: string) => void;
  onApproveAll?: () => void;
  onDenyAll?: () => void;
};

export function ToolApprovalDock({
  items,
  busyId = null,
  onApprove,
  onDeny,
  onApproveAll,
  onDenyAll,
}: Props) {
  if (items.length === 0) return null;
  const multi = items.length > 1;

  return (
    <div className="tool-approval-dock" role="region" aria-label="Tool approvals">
      <div className="tool-approval-dock__head">
        <span className="tool-approval-dock__title">
          Approval needed
          {multi ? ` (${items.length})` : ""}
        </span>
        {multi && onApproveAll && onDenyAll ? (
          <span className="tool-approval-dock__bulk">
            <button
              type="button"
              className="tool-approval-dock__btn tool-approval-dock__btn--ghost"
              disabled={busyId != null}
              onClick={onDenyAll}
            >
              Deny all
            </button>
            <button
              type="button"
              className="tool-approval-dock__btn tool-approval-dock__btn--ok"
              disabled={busyId != null}
              onClick={onApproveAll}
            >
              Approve all
            </button>
          </span>
        ) : null}
      </div>
      <ul className="tool-approval-dock__list">
        {items.map((item) => {
          const preview = approvalArgsPreview(item.args);
          const busy = busyId === item.id;
          return (
            <li key={item.id} className="tool-approval-dock__item">
              <div className="tool-approval-dock__meta">
                <span className="tool-approval-dock__name">{item.name}</span>
                {item.reason ? (
                  <span className="tool-approval-dock__reason">{item.reason}</span>
                ) : null}
                {preview ? (
                  <span className="tool-approval-dock__preview" title={preview}>
                    {preview}
                  </span>
                ) : null}
              </div>
              <div className="tool-approval-dock__actions">
                <button
                  type="button"
                  className="tool-approval-dock__btn tool-approval-dock__btn--deny"
                  disabled={busyId != null}
                  aria-label={`Deny ${item.name}`}
                  onClick={() => onDeny(item.id)}
                >
                  {busy ? "…" : "Deny"}
                </button>
                <button
                  type="button"
                  className="tool-approval-dock__btn tool-approval-dock__btn--ok"
                  disabled={busyId != null}
                  aria-label={`Approve ${item.name}`}
                  onClick={() => onApprove(item.id)}
                >
                  {busy ? "…" : "Approve"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
