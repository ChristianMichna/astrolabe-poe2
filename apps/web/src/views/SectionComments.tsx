import {
  createContext,
  useRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Badge, Button, Callout } from "@astrolabe/ui";
import {
  GUIDE_COMMENT_MAX_LENGTH,
  type GuideComment,
  type GuideCommentsView,
  type GuideSectionKey,
} from "@astrolabe/contracts/guide";
import { loadGuideComments, postGuideComment } from "../api/guide-comments";
import { getDesktopBridge, type OpenClaudeResult } from "../desktop/bridge";

/** How often the comment states are read again while Claude still has comments to work off. */
const POLL_MS = 4000;

type State =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly view: GuideCommentsView };

interface CommentsApi {
  readonly state: State;
  send(section: GuideSectionKey, text: string): Promise<void>;
}

const CommentsContext = createContext<CommentsApi | undefined>(undefined);

const isOpen = (c: GuideComment): boolean => c.status === "queued" || c.status === "working";

/** Loads the comments of a guide once and keeps them current while Claude works on them. */
export function GuideCommentsProvider({
  guideId,
  onApplied,
  children,
}: {
  guideId: string;
  /** Called when the last open comment is applied: the guide is a new revision and is read again. */
  onApplied?: () => void;
  children: ReactNode;
}) {
  const [state, setState] = useState<State>({ status: "loading" });

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const view = await loadGuideComments(guideId, signal);
        if (!signal?.aborted) setState({ status: "ready", view });
      } catch (error) {
        if (signal?.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "The comments could not be loaded.",
        });
      }
    },
    [guideId],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadGuideComments(guideId, controller.signal).then(
      (view) => {
        if (!controller.signal.aborted) setState({ status: "ready", view });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "The comments could not be loaded.",
        });
      },
    );
    return () => controller.abort();
  }, [guideId]);

  const open = state.status === "ready" && state.view.comments.some(isOpen);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) onApplied?.();
    wasOpen.current = open;
  }, [open, onApplied]);
  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    const timer = setInterval(() => void refresh(controller.signal), POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [open, refresh]);

  const api = useMemo<CommentsApi>(
    () => ({
      state,
      send: async (section, text) => {
        const view = await postGuideComment(guideId, section, text);
        setState({ status: "ready", view });
      },
    }),
    [guideId, state],
  );
  return <CommentsContext.Provider value={api}>{children}</CommentsContext.Provider>;
}

const STATUS_TEXT: Record<GuideComment["status"], string> = {
  queued: "Waiting for Claude",
  working: "Claude is rewriting",
  applied: "Applied",
  failed: "Stopped",
};
const STATUS_TONE = {
  queued: "warning",
  working: "info",
  applied: "success",
  failed: "danger",
} as const;

/** Banner above the guide: tells the player when comments wait and how to hand them to Claude. */
export function CommentsBanner() {
  const api = useContext(CommentsContext);
  const bridge = getDesktopBridge();
  const [opened, setOpened] = useState<OpenClaudeResult | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (api === undefined) return null;
  if (api.state.status === "error") {
    return (
      <Callout tone="warning" title="Comments are not available" live>
        {api.state.message}
      </Callout>
    );
  }
  if (api.state.status !== "ready") return null;
  const { view } = api.state;
  const waiting = view.comments.filter(isOpen).length;
  if (waiting === 0) return null;
  return (
    <Callout tone="info" title="Claude has work from your comments" live>
      {waiting === 1 ? "One comment is" : `${String(waiting)} comments are`} waiting. Claude
      rewrites each commented section, Astrolabe checks it again with Path of Building and the guide
      becomes a new revision. Until then the guide stays as it is.{" "}
      {bridge !== undefined && view.runId !== undefined ? (
        <Button
          size="sm"
          variant="primary"
          busy={busy}
          onClick={() => {
            const runId = view.runId;
            if (runId === undefined) return;
            setBusy(true);
            setFailure(undefined);
            bridge.openClaude(runId).then(
              (result) => {
                setOpened(result);
                setBusy(false);
              },
              (error: unknown) => {
                setFailure(error instanceof Error ? error.message : "Claude could not be opened.");
                setBusy(false);
              },
            );
          }}
        >
          Continue with Claude
        </Button>
      ) : null}
      {opened !== undefined ? (
        <p>
          {opened.claudeDesktopOpened
            ? "Paste the start sentence from your clipboard into a new Claude chat."
            : `${opened.notOpenedReason ?? "Open Claude yourself."} The start sentence is on your clipboard.`}{" "}
          Session code <code>{opened.sessionCode}</code>.
        </p>
      ) : null}
      {failure !== undefined ? <p>{failure}</p> : null}
    </Callout>
  );
}

/**
 * Comment control of one guide section: shows the comments made on it with their state and a form
 * for a new one. Renders nothing when the guide cannot be commented on (imported file).
 */
export function SectionComments({
  sectionKey,
  label,
}: {
  sectionKey: GuideSectionKey;
  label: string;
}) {
  const api = useContext(CommentsContext);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  if (api === undefined || api.state.status !== "ready") return null;
  const { view } = api.state;
  if (!view.sections.some((s) => s.key === sectionKey)) return null;
  const mine = view.comments.filter((c) => c.section === sectionKey);
  const submit = (): void => {
    setBusy(true);
    setFailure(undefined);
    api.send(sectionKey, text.trim()).then(
      () => {
        setText("");
        setEditing(false);
        setBusy(false);
      },
      (error: unknown) => {
        setFailure(error instanceof Error ? error.message : "The comment could not be sent.");
        setBusy(false);
      },
    );
  };
  return (
    <div className="section-comments">
      {mine.length > 0 ? (
        <ul className="section-comments__list">
          {mine.map((c) => (
            <li key={c.commentId}>
              <Badge tone={STATUS_TONE[c.status]}>{STATUS_TEXT[c.status]}</Badge> {c.text}
            </li>
          ))}
        </ul>
      ) : null}
      {editing ? (
        <form
          className="section-comments__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() !== "") submit();
          }}
        >
          <label>
            What should change in “{label}”?
            <textarea
              value={text}
              rows={4}
              maxLength={GUIDE_COMMENT_MAX_LENGTH}
              onChange={(e) => setText(e.target.value)}
              placeholder="Be specific: what is missing, too generic or wrong, and what you want instead."
            />
          </label>
          {failure !== undefined ? <p role="alert">{failure}</p> : null}
          <div className="section-comments__actions">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              busy={busy}
              disabled={text.trim() === ""}
            >
              Send to Claude
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Comment on {label}
        </Button>
      )}
    </div>
  );
}
