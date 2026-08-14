import { useEffect, useMemo, useRef, useState } from "react";
import type { GitStatus } from "../git";
import {
  formatAheadBehind,
  formatGitBranchLabel,
  suggestCommitMessage,
} from "../git";

type Props = {
  status: GitStatus | null;
  loading?: boolean;
  busy?: boolean;
  onCommit: (message: string) => boolean | Promise<boolean>;
  onPush: () => void | Promise<void>;
  onOpenPr?: () => void | Promise<void>;
  prUrl?: string | null;
  onRefresh?: () => void | Promise<void>;
};

/**
 * Compact git strip for Review (working-tree scope).
 * Flat toolbar + commit composer only when dirty — no floating card.
 */
export function ReviewGitPage({
  status,
  loading = false,
  busy = false,
  onCommit,
  onPush,
  onOpenPr,
  prUrl = null,
  onRefresh,
}: Props) {
  const [message, setMessage] = useState("");
  const [touched, setTouched] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const branch = formatGitBranchLabel(status);
  const aheadBehind = formatAheadBehind(status);
  const hasChanges = Boolean(status?.isRepo && status.hasWorkingTreeChanges);
  const canPush = Boolean(
    status?.isRepo &&
      status.branch &&
      !status.detached &&
      status.hasPrimaryRemote &&
      status.behindCount === 0 &&
      status.aheadCount > 0,
  );
  const canOpenPr = Boolean(
    status?.isRepo &&
      status.branch &&
      !status.detached &&
      !status.isDefaultBranch &&
      status.hasPrimaryRemote &&
      status.hasUpstream &&
      status.aheadCount === 0,
  );

  const fileCount = status?.workingTree.files.length ?? 0;
  const additions = status?.workingTree.insertions ?? 0;
  const deletions = status?.workingTree.deletions ?? 0;

  const suggested = useMemo(() => suggestCommitMessage(status), [status]);

  useEffect(() => {
    if (touched) return;
    setMessage(suggested);
  }, [suggested, touched]);

  const title = useMemo(() => {
    if (loading) return "Checking git status…";
    if (!status?.isRepo) {
      return status?.error ? status.error : "Not a git repository";
    }
    const parts = [branch ?? "git"];
    if (aheadBehind) parts.push(aheadBehind);
    if (hasChanges) {
      parts.push(
        `${fileCount} file${fileCount === 1 ? "" : "s"} · +${additions} −${deletions}`,
      );
    }
    return parts.join(" · ");
  }, [
    loading,
    status,
    branch,
    aheadBehind,
    hasChanges,
    fileCount,
    additions,
    deletions,
  ]);

  if (!status?.isRepo && !loading) {
    return (
      <section className="review-git" aria-label="Git">
        <div className="review-git__empty">
          <strong>Not a git repository</strong>
          <span>{status?.error || "Open a project folder that has a .git root."}</span>
        </div>
      </section>
    );
  }

  const submit = () => {
    if (!message.trim() || busy || !hasChanges) return;
    void Promise.resolve(onCommit(message.trim())).then((committed) => {
      if (committed) {
        setMessage("");
        setTouched(false);
      }
    });
  };

  const remoteHint = status?.upstream
    ? status.upstream
    : status?.hasPrimaryRemote
      ? "no upstream"
      : status?.isRepo
        ? "no remote"
        : null;

  return (
    <section className="review-git" aria-label="Git">
      <header className="review-git__bar" title={title}>
        <div className="review-git__branch">
          <GitBranchIcon />
          <span className="review-git__branch-name">
            {loading ? "…" : branch ?? "git"}
          </span>
          {aheadBehind ? (
            <span className="review-git__ab" aria-hidden>
              {aheadBehind}
            </span>
          ) : null}
        </div>

        <div className="review-git__bar-end">
          {hasChanges ? (
            <span className="review-git__stats">
              {fileCount} file{fileCount === 1 ? "" : "s"}{" "}
              <b>+{additions}</b> <em>−{deletions}</em>
            </span>
          ) : (
            <span className="review-git__stats review-git__stats--muted">
              {loading ? "Refreshing…" : "Clean"}
            </span>
          )}
          {remoteHint ? (
            <span className="review-git__remote" title={status?.upstream ?? remoteHint}>
              {remoteHint}
            </span>
          ) : null}
          {onRefresh ? (
            <button
              type="button"
              className="review-git__icon-btn"
              disabled={busy || loading}
              title="Refresh status"
              aria-label="Refresh git status"
              onClick={() => void onRefresh()}
            >
              <RefreshIcon />
            </button>
          ) : null}
        </div>
      </header>

      {hasChanges ? (
        <div className="review-git__composer">
          <textarea
            id="review-git-message"
            ref={textareaRef}
            className="review-git__input"
            rows={2}
            value={message}
            placeholder={suggested || "Commit message"}
            disabled={busy || loading}
            aria-label="Commit message"
            onChange={(e) => {
              setTouched(true);
              setMessage(e.target.value);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="review-git__actions">
            <span className="review-git__kbd">Ctrl+Enter</span>
            <div className="review-git__btns">
              {onOpenPr ? (
                <button
                  type="button"
                  className="review-git__ghost"
                  disabled={busy || loading || !canOpenPr}
                  title={
                    prUrl
                      ? prUrl
                      : canOpenPr
                        ? "Open or create a pull request"
                        : status?.isDefaultBranch
                          ? "Switch to a non-default branch first"
                          : status && status.aheadCount > 0
                            ? "Push all commits before opening a PR"
                            : "Push a non-default branch first"
                  }
                  onClick={() => void onOpenPr()}
                >
                  {prUrl ? "PR ready" : "Open PR"}
                </button>
              ) : null}
              <button
                type="button"
                className="review-git__ghost"
                disabled={busy || !canPush}
                title={
                  canPush
                    ? status?.hasUpstream
                      ? "Push to upstream"
                      : "Push and set upstream"
                    : "Nothing to push"
                }
                onClick={() => void onPush()}
              >
                {status?.hasUpstream ? "Push" : "Push upstream"}
                {status && status.aheadCount > 0 ? ` · ${status.aheadCount}` : ""}
              </button>
              <button
                type="button"
                className="review-git__primary"
                disabled={busy || loading || !message.trim()}
                onClick={submit}
              >
                {busy ? "Working…" : "Commit"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="review-git__actions review-git__actions--clean">
          <div className="review-git__btns">
            {onOpenPr ? (
              <button
                type="button"
                className="review-git__ghost"
                disabled={busy || loading || !canOpenPr}
                title={
                  prUrl
                    ? prUrl
                    : canOpenPr
                      ? "Open or create a pull request"
                      : status?.isDefaultBranch
                        ? "Switch to a non-default branch first"
                        : status && status.aheadCount > 0
                          ? "Push all commits before opening a PR"
                          : "Push a non-default branch first"
                }
                onClick={() => void onOpenPr()}
              >
                {prUrl ? "PR ready" : "Open PR"}
              </button>
            ) : null}
            <button
              type="button"
              className={`review-git__ghost${canPush ? " review-git__ghost--emphasis" : ""}`}
              disabled={busy || !canPush}
              title={
                canPush
                  ? status?.hasUpstream
                    ? "Push to upstream"
                    : "Push and set upstream"
                  : "Nothing to push"
              }
              onClick={() => void onPush()}
            >
              {status?.hasUpstream ? "Push" : "Push upstream"}
              {status && status.aheadCount > 0 ? ` · ${status.aheadCount}` : ""}
            </button>
          </div>
        </div>
      )}

      {prUrl ? (
        <p className="review-git__pr-url" title={prUrl}>
          <span>Pull request</span>
          <code>{prUrl}</code>
        </p>
      ) : null}
    </section>
  );
}

function GitBranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="6" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="18" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="6" cy="18" r="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M6 8.2v7.6M6 12h8.5a3.5 3.5 0 0 0 3.5-3.5V8.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 12a8 8 0 1 1-2.3-5.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M20 5v5h-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
