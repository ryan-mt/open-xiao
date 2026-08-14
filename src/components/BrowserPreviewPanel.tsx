import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  browserPreviewBounds,
  captureBrowserPreview,
  clampBrowserPreviewPanelWidth,
  closeBrowserPreview,
  createBrowserPreviewLifecycleQueue,
  createBrowserPreviewPollGate,
  discoverLocalServers,
  getBrowserPreviewState,
  isCurrentBrowserPreviewRequest,
  isCurrentBrowserPreviewAction,
  isCurrentBrowserPreviewSession,
  navigateBrowserPreview,
  normalizeBrowserPreviewUrl,
  onBrowserPreviewBoundsReady,
  onBrowserPreviewBlocked,
  onBrowserPreviewState,
  openBrowserPreview,
  openBrowserPreviewExternal,
  runBrowserPreviewAction,
  setBrowserPreviewBounds,
  setBrowserPreviewVisible,
  syncBrowserPreviewState,
  type BrowserPreviewSnapshot,
  type DiscoveredLocalServer,
} from "../browserPreview";
import { isTauri } from "../lib/isTauri";
import { safeErrorMessage } from "../lib/userFacingError";
import { usePresence } from "../usePresence";
import { KEYBINDING_COMMAND_EVENT } from "../keybindings";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  RightPanelPageSwitcher,
  type RightPanelPage,
} from "./RightPanelControls";

type Props = {
  open: boolean;
  workspacePath: string | null;
  suppressed?: boolean;
  onClose: () => void;
  onPageChange: (page: RightPanelPage) => void;
  reviewStats?: {
    fileCount: number;
    additions: number;
    deletions: number;
  } | null;
};

const DEFAULT_URL = "https://www.google.com/";
const WIDTH_MIN = 360;
const WIDTH_DEFAULT = 540;
const WIDTH_KEY = "browser-preview-panel-width";

function loadBrowserPanelWidth(): number {
  try {
    const width = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(width) && width >= WIDTH_MIN) {
      return clampBrowserPreviewPanelWidth(width, window.innerWidth);
    }
  } catch {
    /* ignore */
  }
  return WIDTH_DEFAULT;
}

function useLoadingProgress(loading: boolean): number {
  const [progress, setProgress] = useState(0);
  const progressRef = useRef(0);
  progressRef.current = progress;

  useEffect(() => {
    if (!loading) {
      if (progressRef.current === 0) return;
      setProgress(100);
      const timer = window.setTimeout(() => setProgress(0), 220);
      return () => window.clearTimeout(timer);
    }

    setProgress((value) => (value > 0 && value < 95 ? value : 4));
    const interval = window.setInterval(() => {
      const current = progressRef.current;
      if (current >= 90) return;
      setProgress(Math.min(90, current + Math.max(0.5, (90 - current) * 0.08)));
    }, 120);
    return () => window.clearInterval(interval);
  }, [loading]);

  return progress;
}

function previewHost(url: string | null): string {
  if (!url) return "Browser";
  try {
    return new URL(url).host;
  } catch {
    return "Browser";
  }
}

export function BrowserPreviewPanel({
  open,
  workspacePath,
  suppressed = false,
  onClose,
  onPageChange,
  reviewStats = null,
}: Props) {
  const presence = usePresence(open, 220);
  const slotRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const snapshotRef = useRef<BrowserPreviewSnapshot | null>(null);
  const workspaceRef = useRef(workspacePath);
  const requestEpochRef = useRef(0);
  const discoveryEpochRef = useRef(0);
  const captureEpochRef = useRef(0);
  const lifecycleQueueRef = useRef<ReturnType<
    typeof createBrowserPreviewLifecycleQueue
  > | null>(null);
  if (!lifecycleQueueRef.current) {
    lifecycleQueueRef.current = createBrowserPreviewLifecycleQueue();
  }
  const lifecycleQueue = lifecycleQueueRef.current;
  const pollGateRef = useRef<ReturnType<
    typeof createBrowserPreviewPollGate
  > | null>(null);
  if (!pollGateRef.current) pollGateRef.current = createBrowserPreviewPollGate();
  const pollGate = pollGateRef.current;
  const defaultOpenAttemptedRef = useRef(false);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    pendingWidth: number;
  } | null>(null);
  const [draftUrl, setDraftUrl] = useState(DEFAULT_URL);
  const [inputFocused, setInputFocused] = useState(false);
  const [snapshot, setSnapshot] = useState<BrowserPreviewSnapshot | null>(null);
  const [stateReady, setStateReady] = useState(false);
  const [servers, setServers] = useState<DiscoveredLocalServer[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [opening, setOpening] = useState(false);
  const [switcherMenuOpen, setSwitcherMenuOpen] = useState(false);
  const [documentOverlayOpen, setDocumentOverlayOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stoppedUrl, setStoppedUrl] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(loadBrowserPanelWidth);
  const [resizing, setResizing] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [capturePreview, setCapturePreview] =
    useState<ExpandedImagePreview | null>(null);
  const widthRef = useRef(panelWidth);
  snapshotRef.current = snapshot;
  workspaceRef.current = workspacePath;
  widthRef.current = panelWidth;
  const nativeSuppressed =
    suppressed || switcherMenuOpen || documentOverlayOpen;
  const activeSessionId = snapshot?.sessionId;
  const loadProgress = useLoadingProgress(Boolean(snapshot?.loading));

  const queueVisibility = useCallback(
    (targetWorkspace: string, sessionId: number, visible: boolean) =>
      lifecycleQueue.run(() =>
          setBrowserPreviewVisible(targetWorkspace, sessionId, visible),
      ),
    [lifecycleQueue],
  );

  const waitForVisibilityQueue = useCallback(
    () => lifecycleQueue.drain(),
    [lifecycleQueue],
  );

  const syncBounds = useCallback(() => {
    if (
      !workspacePath ||
      activeSessionId == null ||
      !slotRef.current ||
      nativeSuppressed ||
      !open
    )
      return;
    const bounds = browserPreviewBounds(slotRef.current);
    if (!bounds) return;
    void setBrowserPreviewBounds(workspacePath, activeSessionId, bounds).catch(
      () => undefined,
    );
  }, [activeSessionId, nativeSuppressed, open, workspacePath]);

  const refreshServers = useCallback(async () => {
    if (!workspacePath || !isTauri()) return;
    const targetWorkspace = workspacePath;
    const requestEpoch = ++discoveryEpochRef.current;
    setDiscovering(true);
    try {
      const discovered = await discoverLocalServers(targetWorkspace);
      if (
        isCurrentBrowserPreviewRequest(
          requestEpoch,
          discoveryEpochRef.current,
          targetWorkspace,
          workspaceRef.current,
        )
      ) {
        setServers(discovered);
      }
    } catch (cause) {
      if (
        isCurrentBrowserPreviewRequest(
          requestEpoch,
          discoveryEpochRef.current,
          targetWorkspace,
          workspaceRef.current,
        )
      ) {
        setServers([]);
        setError(
          safeErrorMessage(
            cause,
            "Could not discover local development servers.",
          ),
        );
      }
    } finally {
      if (requestEpoch === discoveryEpochRef.current) setDiscovering(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    let disposed = false;
    let unlistenState: (() => void) | undefined;
    let unlistenBlocked: (() => void) | undefined;
    void onBrowserPreviewState((next) => {
      if (
        !disposed &&
        next.workspacePath === workspacePath &&
        isCurrentBrowserPreviewSession(snapshotRef.current, next)
      ) {
        setSnapshot(next);
        if (document.activeElement !== addressInputRef.current) {
          setDraftUrl(next.url);
        }
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenState = unlisten;
    });
    void onBrowserPreviewBlocked((blocked) => {
      const current = snapshotRef.current;
      if (!disposed && isCurrentBrowserPreviewSession(current, blocked)) {
        setError("Only HTTP and HTTPS pages can open in Browser.");
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenBlocked = unlisten;
    });
    return () => {
      disposed = true;
      unlistenState?.();
      unlistenBlocked?.();
    };
  }, [workspacePath]);

  useEffect(() => {
    requestEpochRef.current += 1;
    discoveryEpochRef.current += 1;
    captureEpochRef.current += 1;
    const previous = snapshotRef.current;
    if (previous && previous.workspacePath !== workspacePath && isTauri()) {
      void queueVisibility(
        previous.workspacePath,
        previous.sessionId,
        false,
      ).catch(() => undefined);
    }
    setSnapshot(null);
    setOpening(false);
    setDiscovering(false);
    setCapturing(false);
    setServers([]);
    setError(null);
    setStoppedUrl(null);
    setStateReady(false);
    defaultOpenAttemptedRef.current = false;
    if (!workspacePath || !isTauri()) {
      setStateReady(true);
      return;
    }
    let disposed = false;
    void getBrowserPreviewState(workspacePath)
      .then((next) => {
        if (disposed || !next) return;
        setSnapshot(next);
        setDraftUrl(next.url);
      })
      .catch((cause) => {
        if (!disposed) {
          setError(
            safeErrorMessage(cause, "Could not restore browser preview."),
          );
        }
      })
      .finally(() => {
        if (!disposed) setStateReady(true);
      });
    return () => {
      disposed = true;
    };
  }, [queueVisibility, workspacePath]);

  useEffect(() => {
    if (!open) {
      setDocumentOverlayOpen(false);
      return;
    }
    const update = () => {
      setDocumentOverlayOpen(
        document.querySelector('[aria-modal="true"]') != null,
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "aria-modal"],
    });
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open || snapshot || !workspacePath) return;
    void refreshServers();
    const timer = window.setInterval(() => void refreshServers(), 3000);
    return () => window.clearInterval(timer);
  }, [open, refreshServers, snapshot, workspacePath]);

  useEffect(() => {
    if (!workspacePath || !snapshot || !isTauri()) return;
    const visible = open && !nativeSuppressed;
    if (!visible) {
      void queueVisibility(
        workspacePath,
        snapshot.sessionId,
        false,
      ).catch(() => undefined);
      return;
    }
    // Native child webviews are not clipped by the CSS width transition.
    const timer = window.setTimeout(() => {
      syncBounds();
      void queueVisibility(
        workspacePath,
        snapshot.sessionId,
        true,
      ).catch(() => undefined);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [
    activeSessionId,
    nativeSuppressed,
    open,
    queueVisibility,
    syncBounds,
    workspacePath,
  ]);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot || !snapshot || !open || nativeSuppressed) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncBounds);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(slot);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [nativeSuppressed, open, snapshot, syncBounds]);

  useEffect(() => {
    if (!workspacePath || !snapshot || !open || nativeSuppressed || !isTauri())
      return;
    const sessionId = snapshot.sessionId;
    let disposed = false;
    const sync = () => {
      void pollGate.run(async () => {
        const requestEpoch = requestEpochRef.current;
        try {
          const next = await syncBrowserPreviewState(workspacePath, sessionId);
          if (
            !disposed &&
            isCurrentBrowserPreviewAction(
              requestEpoch,
              requestEpochRef.current,
              snapshotRef.current,
              workspacePath,
              sessionId,
            ) &&
            isCurrentBrowserPreviewSession(snapshotRef.current, next)
          ) {
            setSnapshot(next);
            if (document.activeElement !== addressInputRef.current) {
              setDraftUrl(next.url);
            }
          }
        } catch (cause) {
          if (
            disposed ||
            !isCurrentBrowserPreviewAction(
              requestEpoch,
              requestEpochRef.current,
              snapshotRef.current,
              workspacePath,
              sessionId,
            )
          )
            return;
          const stopped = snapshotRef.current;
          requestEpochRef.current += 1;
          snapshotRef.current = null;
          setSnapshot(null);
          setStoppedUrl(stopped?.url ?? null);
          setError(safeErrorMessage(cause, "Browser preview stopped."));
          void queueVisibility(workspacePath, sessionId, false).catch(
            () => undefined,
          );
        }
      });
    };
    const timer = window.setInterval(sync, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [
    nativeSuppressed,
    open,
    pollGate,
    queueVisibility,
    snapshot?.sessionId,
    workspacePath,
  ]);

  const navigate = async (
    rawUrl: string,
    readyBounds?: ReturnType<typeof browserPreviewBounds>,
  ) => {
    if (opening) return;
    if (!workspacePath) {
      setError("Open a project before starting browser preview.");
      return;
    }
    if (!isTauri()) {
      setError("Browser preview is available in the desktop app.");
      return;
    }
    let url: string;
    try {
      url = normalizeBrowserPreviewUrl(rawUrl);
    } catch (cause) {
      setError(safeErrorMessage(cause, "Enter a valid URL."));
      return;
    }
    setError(null);
    setStoppedUrl(null);
    setDraftUrl(url);
    const requestEpoch = ++requestEpochRef.current;
    const targetWorkspace = workspacePath;
    setOpening(true);
    try {
      await waitForVisibilityQueue();
      if (
        !isCurrentBrowserPreviewRequest(
          requestEpoch,
          requestEpochRef.current,
          targetWorkspace,
          workspaceRef.current,
        )
      )
        return;
      const current = snapshotRef.current;
      if (current && current.workspacePath === targetWorkspace) {
        await navigateBrowserPreview(targetWorkspace, current.sessionId, url);
      } else {
        const element = slotRef.current;
        const bounds =
          readyBounds ?? (element ? browserPreviewBounds(element) : null);
        if (!bounds) throw new Error("Browser preview surface is not ready.");
        const next = await openBrowserPreview(targetWorkspace, url, bounds);
        if (
          !isCurrentBrowserPreviewRequest(
            requestEpoch,
            requestEpochRef.current,
            targetWorkspace,
            workspaceRef.current,
          )
        ) {
          await closeBrowserPreview(targetWorkspace, next.sessionId).catch(
            () => undefined,
          );
          return;
        }
        setSnapshot(next);
      }
    } catch (cause) {
      if (
        isCurrentBrowserPreviewRequest(
          requestEpoch,
          requestEpochRef.current,
          targetWorkspace,
          workspaceRef.current,
        )
      ) {
        setError(safeErrorMessage(cause, "Could not open browser preview."));
      }
    } finally {
      if (requestEpochRef.current === requestEpoch) setOpening(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void navigate(draftUrl);
  };

  const runAction = async (action: "back" | "forward" | "reload") => {
    if (!workspacePath || !snapshot) return;
    const requestEpoch = requestEpochRef.current;
    const targetWorkspace = workspacePath;
    const targetSession = snapshot.sessionId;
    setError(null);
    try {
      await runBrowserPreviewAction(targetWorkspace, targetSession, action);
    } catch (cause) {
      if (
        isCurrentBrowserPreviewAction(
          requestEpoch,
          requestEpochRef.current,
          snapshotRef.current,
          targetWorkspace,
          targetSession,
        )
      ) {
        setError(safeErrorMessage(cause, "Could not control browser preview."));
      }
    }
  };

  useEffect(() => {
    if (!open) return;
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<{ command?: string }>).detail
        ?.command;
      if (command === "preview.focusUrl") {
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
      } else if (command === "preview.refresh") {
        void runAction("reload");
      }
    };

    window.addEventListener(KEYBINDING_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(KEYBINDING_COMMAND_EVENT, onCommand);
  }, [open, snapshot?.sessionId, workspacePath]);

  const closeTab = async () => {
    const requestEpoch = ++requestEpochRef.current;
    const current = snapshotRef.current;
    if (current && isTauri()) {
      try {
        await waitForVisibilityQueue();
        await closeBrowserPreview(current.workspacePath, current.sessionId);
      } catch (cause) {
        if (
          isCurrentBrowserPreviewAction(
            requestEpoch,
            requestEpochRef.current,
            snapshotRef.current,
            current.workspacePath,
            current.sessionId,
          )
        ) {
          setError(safeErrorMessage(cause, "Could not close browser preview."));
        }
        return;
      }
    }
    if (
      current &&
      !isCurrentBrowserPreviewAction(
        requestEpoch,
        requestEpochRef.current,
        snapshotRef.current,
        current.workspacePath,
        current.sessionId,
      )
    )
      return;
    defaultOpenAttemptedRef.current = false;
    setSnapshot(null);
    setDraftUrl(DEFAULT_URL);
    setError(null);
    setStoppedUrl(null);
    onClose();
  };

  const captureSnapshot = async () => {
    if (!workspacePath || !snapshot || capturing) return;
    const captureEpoch = ++captureEpochRef.current;
    const targetSnapshot = snapshot;
    setCapturing(true);
    setError(null);
    try {
      const captured = await captureBrowserPreview(
        workspacePath,
        targetSnapshot.sessionId,
      );
      if (
        captureEpoch !== captureEpochRef.current ||
        !isCurrentBrowserPreviewSession(snapshotRef.current, targetSnapshot)
      )
        return;
      setCapturePreview({
        images: [{ src: captured.dataUrl, name: captured.label }],
        index: 0,
      });
    } catch (cause) {
      if (
        captureEpoch === captureEpochRef.current &&
        isCurrentBrowserPreviewSession(snapshotRef.current, targetSnapshot)
      ) {
        setError(
          safeErrorMessage(cause, "Could not capture browser preview snapshot."),
        );
      }
    } finally {
      if (captureEpoch === captureEpochRef.current) setCapturing(false);
    }
  };

  const finishResize = (event?: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (resize && event?.currentTarget.hasPointerCapture(resize.pointerId)) {
      event.currentTarget.releasePointerCapture(resize.pointerId);
    }
    const finalWidth = resize?.pendingWidth ?? widthRef.current;
    resizeRef.current = null;
    setPanelWidth(finalWidth);
    setResizing(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try {
      localStorage.setItem(WIDTH_KEY, String(finalWidth));
    } catch {
      /* ignore */
    }
  };

  const cancelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(resize.pointerId)) {
      event.currentTarget.releasePointerCapture(resize.pointerId);
    }
    setPanelWidth(resize.startWidth);
    resizeRef.current = null;
    setResizing(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    const renderedWidth = panelRef.current?.getBoundingClientRect().width;
    const startWidth =
      renderedWidth && renderedWidth > 0 ? renderedWidth : panelWidth;
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      pendingWidth: startWidth,
    };
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const containerWidth =
      panelRef.current?.parentElement?.clientWidth ?? window.innerWidth;
    const next = resize.startWidth + resize.startX - event.clientX;
    const clamped = clampBrowserPreviewPanelWidth(next, containerWidth);
    resize.pendingWidth = clamped;
    setPanelWidth(clamped);
  };

  useEffect(
    () => () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    [],
  );

  useEffect(() => {
    if (!open || !stateReady || !workspacePath || snapshot || opening) return;
    if (defaultOpenAttemptedRef.current) return;
    const element = slotRef.current;
    if (!element) return;
    return onBrowserPreviewBoundsReady(element, (bounds) => {
      defaultOpenAttemptedRef.current = true;
      void navigate(DEFAULT_URL, bounds);
    });
  }, [open, opening, presence.visible, snapshot, stateReady, workspacePath]);

  if (!presence.present) return null;
  const closing = !open && presence.present;
  const activeUrl = snapshot?.url ?? null;

  return (
    <aside
      ref={panelRef}
      className={`browser-preview-panel right-panel-shell${open ? " is-open" : ""}${closing ? " is-closing" : ""}${resizing ? " is-resizing" : ""}`}
      aria-label="Browser preview"
      aria-hidden={!open}
      data-state={open ? "open" : closing ? "closed" : "opening"}
      style={
        { "--browser-preview-panel-width": `${panelWidth}px` } as CSSProperties
      }
    >
      <div
        className="browser-preview-panel__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize browser panel"
        title="Drag to resize"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={finishResize}
        onPointerCancel={cancelResize}
      />
      <div className="right-panel-shell__inner">
        <header className="browser-preview-panel__header right-panel-anim-head">
          <RightPanelPageSwitcher
            page="browser"
            onPageChange={onPageChange}
            reviewStats={reviewStats}
            previewUrl={activeUrl}
            filesAvailable={workspacePath !== null}
            onClosePage={() => void closeTab()}
            onMenuOpenChange={setSwitcherMenuOpen}
            beforeMenuOpen={async () => {
              const current = snapshotRef.current;
              if (!current || !isTauri()) return;
              try {
                await queueVisibility(
                  current.workspacePath,
                  current.sessionId,
                  false,
                );
              } catch (cause) {
                setError(
                  safeErrorMessage(cause, "Could not open the page menu."),
                );
                throw cause;
              }
            }}
          />
        </header>

        <div className="browser-preview-panel__chrome">
          <div
            className="browser-preview-panel__nav"
            role="group"
            aria-label="Browser navigation"
          >
            <button
              type="button"
              disabled={!snapshot?.canGoBack}
              aria-label="Go back"
              title="Back"
              onClick={() => void runAction("back")}
            >
              <BackIcon />
            </button>
            <button
              type="button"
              disabled={!snapshot?.canGoForward}
              aria-label="Go forward"
              title="Forward"
              onClick={() => void runAction("forward")}
            >
              <ForwardIcon />
            </button>
            <button
              type="button"
              disabled={!snapshot}
              aria-label="Reload preview"
              title="Reload"
              onClick={() => void runAction("reload")}
            >
              <ReloadIcon spinning={Boolean(snapshot?.loading)} />
            </button>
          </div>
          <form className="browser-preview-panel__address" onSubmit={onSubmit}>
            <input
              ref={addressInputRef}
              value={
                inputFocused
                  ? draftUrl
                  : activeUrl
                    ? previewHost(activeUrl)
                    : ""
              }
              aria-label="Preview URL"
              placeholder="Search or enter URL"
              spellCheck={false}
              autoCapitalize="none"
              onFocus={() => {
                setDraftUrl(activeUrl ?? "");
                setInputFocused(true);
                queueMicrotask(() => addressInputRef.current?.select());
              }}
              onBlur={() => setInputFocused(false)}
              onChange={(event) => setDraftUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setDraftUrl(activeUrl ?? DEFAULT_URL);
                  event.currentTarget.blur();
                }
              }}
            />
            {!inputFocused && activeUrl ? (
              <button
                type="button"
                className="browser-preview-panel__external"
                disabled={!workspacePath || opening}
                aria-label="Open in system browser"
                title="Open in system browser"
                onClick={() => {
                  if (!workspacePath || !snapshot) return;
                  void openBrowserPreviewExternal(
                    workspacePath,
                    snapshot.sessionId,
                    activeUrl,
                  ).catch((cause) => {
                    setError(
                      safeErrorMessage(
                        cause,
                        "Could not open the system browser.",
                      ),
                    );
                  });
                }}
              >
                <ExternalIcon />
              </button>
            ) : null}
          </form>
          <button
            type="button"
            className="browser-preview-panel__capture"
            disabled={!snapshot || capturing}
            aria-label="Capture preview snapshot"
            title="Capture snapshot"
            onClick={() => void captureSnapshot()}
          >
            <CameraIcon active={capturing} />
          </button>
          {loadProgress > 0 ? (
            <span
              className="browser-preview-panel__progress"
              style={{ width: `${loadProgress}%` }}
            />
          ) : null}
        </div>

        {error ? (
          <div
            className={`browser-preview-panel__error${stoppedUrl ? " is-recoverable" : ""}`}
            role="alert"
          >
            <span>{error}</span>
            {stoppedUrl ? (
              <button
                type="button"
                className="browser-preview-panel__error-action"
                disabled={opening}
                onClick={() => void navigate(stoppedUrl)}
              >
                {opening ? "Opening..." : "Open again"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label="Dismiss error"
              >
                <CloseIcon />
              </button>
            )}
          </div>
        ) : null}

        {snapshot ? (
          <div
            ref={slotRef}
            className="browser-preview-panel__surface"
            aria-label={`Preview ${previewHost(snapshot.url)}`}
          />
        ) : (
          <div
            ref={slotRef}
            className="browser-preview-panel__empty right-panel-anim-body"
          >
            {servers.length > 0 ? (
              <div className="browser-preview-panel__server-list-wrap">
                <div className="browser-preview-panel__servers-title">
                  <RadioTowerIcon />
                  <h2>Local servers</h2>
                </div>
                <div className="browser-preview-panel__servers">
                  {servers.map((server) => (
                    <button
                      type="button"
                      className="browser-preview-panel__server"
                      key={server.port}
                      disabled={opening}
                      onClick={() => void navigate(server.url)}
                    >
                      <BrowserMockup />
                      <span className="browser-preview-panel__server-copy">
                        <strong>Listening</strong>
                        <small>localhost:{server.port}</small>
                      </span>
                      <span
                        className="browser-preview-panel__server-status"
                        aria-label="Listening"
                      >
                        <span />
                      </span>
                    </button>
                  ))}
                </div>
                <p>Select a listening port to open it in this browser tab.</p>
              </div>
            ) : (
              <div className="browser-preview-panel__empty-content">
                <div className="browser-preview-panel__empty-mark" aria-hidden>
                  <span />
                  <span />
                  <span>
                    <GlobeIcon />
                  </span>
                </div>
                <h2>No preview yet</h2>
                <p>
                  {workspacePath
                    ? discovering
                      ? "Checking local development ports..."
                      : "Type a URL above, or run a dev script. Listening localhost ports will show up here automatically."
                    : "Open a project, then type any HTTP or HTTPS URL above."}
                </p>
              </div>
            )}
          </div>
        )}
        {capturePreview ? (
          <ExpandedImageDialog
            preview={capturePreview}
            onClose={() => setCapturePreview(null)}
          />
        ) : null}
      </div>
    </aside>
  );
}

function CameraIcon({ active }: { active: boolean }) {
  return (
    <svg
      className={active ? "is-pulsing" : undefined}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path d="M4 8h3l1.5-2h7L17 8h3v11H4V8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m15 6-6 6 6 6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ForwardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m9 6 6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ReloadIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={spinning ? "is-spinning" : undefined}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M19 8a7.5 7.5 0 1 0 .4 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M19 4v4h-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 5h5v5M19 5l-8 8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 7l10 10M17 7 7 17"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BrowserMockup() {
  return (
    <span className="browser-preview-panel__browser-mockup" aria-hidden>
      <span className="browser-preview-panel__browser-dots">
        <i />
        <i />
        <i />
      </span>
      <span className="browser-preview-panel__browser-lines">
        <i />
        <i />
      </span>
    </span>
  );
}

function GlobeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M3 12h18M12 3c2.2 2.4 3.3 5.4 3.3 9S14.2 18.6 12 21c-2.2-2.4-3.3-5.4-3.3-9S9.8 5.4 12 3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RadioTowerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4.9 19.1a10 10 0 0 1 0-14.2M8.5 15.5a5 5 0 0 1 0-7M19.1 4.9a10 10 0 0 1 0 14.2M15.5 8.5a5 5 0 0 1 0 7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}
