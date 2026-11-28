import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Badge } from "../components/Badge";
import { ProvenanceBadge } from "../components/Provenance";
import type { ProvenanceView } from "../components/provenance-model";
import type { TreeCamera, TreeHighlight } from "./renderer";
import type { TreeCanvasHandle } from "./TreeCanvas";
import type { TreeIconSheet } from "./renderer";
import { TreeCanvas } from "./TreeCanvas";
import type { PassiveTreeView, TreeNodeShape, TreeNodeView } from "./tree-model";
import type { TimelineState, TreeTimeline } from "./tree-timeline";
import { stateAt } from "./tree-timeline";
import { TreeTimelineRule } from "./TreeTimelineRule";
import "./tree.css";

export interface PassiveTreeProps {
  /** Main tree (without ascendancy nodes). */
  readonly view: PassiveTreeView;
  /** The build's ascendancy, drawn in its own inset. */
  readonly ascendancy?: { readonly name: string; readonly view: PassiveTreeView };
  readonly timeline: TreeTimeline;
  /** Stage shown first (index); its last point is selected. */
  readonly initialStage?: number;
  /** Selected stage (index) when the page owns the stage choice; the tree follows it. */
  readonly stageIndex?: number;
  /** Called when the reader moves the tree into another stage. */
  readonly onStageChange?: (index: number) => void;
  /** Node pictures (see `TreeIconSheet`); the plain shapes show without them. */
  readonly iconSheet?: TreeIconSheet;
  /** Where the tree data comes from (data release). */
  readonly provenance: ProvenanceView;
  /** Where the allocation comes from, e.g. a sample fixture or a guide revision. */
  readonly allocationSource: string;
}

const SHAPE_LABEL: Readonly<Record<TreeNodeShape, string>> = {
  small: "Passive",
  attribute: "Attribute",
  notable: "Notable",
  keystone: "Keystone",
  jewelSocket: "Jewel socket",
  classStart: "Class start",
  ascendancyStart: "Ascendancy start",
  decoration: "Decoration",
};

/** Zoom (screen px per tree unit) from which names of allocated notables appear. */
const LABEL_SCALE = 0.1;
/** Approximate label box in px, for skipping overlapping labels. */
const LABEL_BOX = { w: 150, h: 18 };
const PLAY_INTERVAL_MS = 110;
/** Framing when a passive is picked from the list (tree units). */
const FOCUS_FRAME = { padding: 0.2, span: 2600, insetSpan: 900 };
const SEARCH_MIN_CHARS = 2;

const pad2 = (n: number) => String(n).padStart(2, "0");

function highlightOf(state: TimelineState, matches: ReadonlySet<string>): TreeHighlight {
  return {
    allocated: state.allocated,
    added: new Set(state.added.keys()),
    refunded: state.refunded,
    matches,
  };
}

function searchNodes(view: PassiveTreeView, query: string): Set<string> {
  const q = query.trim().toLowerCase();
  if (q.length < SEARCH_MIN_CHARS) return new Set();
  const hits = new Set<string>();
  for (const n of view.nodes.values()) {
    if (n.shape === "decoration") continue;
    if (n.name.toLowerCase().includes(q) || n.stats.some((s) => s.toLowerCase().includes(q)))
      hits.add(n.id);
  }
  return hits;
}

interface Hover {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly pinned: boolean;
  readonly inset: boolean;
}

/**
 * Interactive passive tree with level timeline: the cursor plays the
 * allocation point by point; points of the current stage glow, respecs are
 * struck through in amber. A text list of the stage's points is the
 * accessible alternative to the canvas.
 */
export function PassiveTree({
  view,
  ascendancy,
  timeline,
  initialStage = 0,
  stageIndex,
  onStageChange,
  provenance,
  allocationSource,
  iconSheet,
}: PassiveTreeProps) {
  const canvasRef = useRef<TreeCanvasHandle>(null);
  const insetRef = useRef<TreeCanvasHandle>(null);
  const searchId = useId();
  const [cursor, setCursor] = useState(
    () => timeline.stages[Math.min(initialStage, timeline.stages.length - 1)]?.to ?? 0,
  );
  const [playing, setPlaying] = useState<{ end: number } | null>(null);
  const [stageHint, setStageHint] = useState<number | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<Hover | null>(null);
  const [camera, setCamera] = useState<TreeCamera | null>(null);
  const [expanded, setExpanded] = useState(false);

  const state = useMemo(() => stateAt(timeline, cursor, stageHint), [timeline, cursor, stageHint]);
  const stage = timeline.stages[state.stage];
  const matches = useMemo(() => searchNodes(view, query), [view, query]);
  const highlight = useMemo(() => highlightOf(state, matches), [state, matches]);
  const insetMatches = useMemo(
    () => (ascendancy ? searchNodes(ascendancy.view, query) : new Set<string>()),
    [ascendancy, query],
  );
  const insetHighlight = useMemo(() => highlightOf(state, insetMatches), [state, insetMatches]);

  // The page owns the stage choice: the tree moves to the end of the chosen stage (state set while
  // rendering, the pattern React gives for state that follows a prop).
  const [followed, setFollowed] = useState<number | undefined>(undefined);
  if (stageIndex !== undefined && stageIndex !== followed) {
    setFollowed(stageIndex);
    const target = timeline.stages[stageIndex];
    if (target !== undefined && stageIndex !== state.stage) {
      setPlaying(null);
      setStageHint(stageIndex);
      setCursor(target.to);
    }
  }
  const reported = useRef(state.stage);
  useEffect(() => {
    if (reported.current === state.stage) return;
    reported.current = state.stage;
    onStageChange?.(state.stage);
  }, [state.stage, onStageChange]);

  // Full screen: the tree fills the window; Escape leaves it and the page stops scrolling meanwhile.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setExpanded(false);
    };
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = before;
    };
  }, [expanded]);

  // playback runs to the end of the stage it was started in
  useEffect(() => {
    if (!playing || cursor >= playing.end) return;
    const t = setTimeout(() => {
      const next = cursor + 1;
      setCursor(next);
      if (next >= playing.end) setPlaying(null);
    }, PLAY_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [playing, cursor]);

  const play = (on: boolean) => {
    const s = timeline.stages[state.stage];
    if (!on || !s || s.to === s.from) {
      setPlaying(null);
      return;
    }
    const start = cursor >= s.to || cursor < s.from ? s.from : cursor;
    setCursor(start);
    setStageHint(state.stage);
    setPlaying({ end: s.to });
  };

  const cameraFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(cameraFrame.current), []);
  const onCamera = useCallback((c: TreeCamera) => {
    cancelAnimationFrame(cameraFrame.current);
    cameraFrame.current = requestAnimationFrame(() => setCamera(c));
    setHover((h) => (h?.pinned ? null : h));
  }, []);

  const nodeOf = (id: string): TreeNodeView | undefined =>
    view.nodes.get(id) ?? ascendancy?.view.nodes.get(id);

  const stageNodes = useMemo(
    () =>
      [...state.added.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([id, point]) => ({ id, point, node: nodeOf(id) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeOf reads stable props
    [state, view, ascendancy],
  );
  const refunded = [...state.refunded].map((id) => ({ id, node: nodeOf(id) }));
  const missing = [
    ...stageNodes.filter((n) => !n.node).map((n) => n.id),
    ...refunded.filter((n) => !n.node).map((n) => n.id),
  ];
  const allocatedMain = [...state.allocated].filter((id) => view.nodes.has(id));

  const focusNode = (id: string) => {
    const inset = !view.nodes.has(id);
    const ref = inset ? insetRef : canvasRef;
    ref.current?.fit([id], FOCUS_FRAME.padding, inset ? FOCUS_FRAME.insetSpan : FOCUS_FRAME.span);
    const pos = ref.current?.project(id);
    if (pos) setHover({ id, ...pos, pinned: true, inset });
  };

  const labels =
    camera && camera.scale >= LABEL_SCALE
      ? [...state.allocated]
          .map((id) => view.nodes.get(id))
          .filter(
            (n): n is TreeNodeView => !!n && (n.shape === "notable" || n.shape === "keystone"),
          )
          .map((n) => ({
            n,
            x: n.x * camera.scale + camera.x,
            y: n.y * camera.scale + camera.y,
            fresh: state.added.has(n.id),
          }))
          .sort((a, b) => Number(b.fresh) - Number(a.fresh) || a.y - b.y)
          .filter((l, i, all) =>
            all
              .slice(0, i)
              .every((o) => Math.abs(o.x - l.x) > LABEL_BOX.w || Math.abs(o.y - l.y) > LABEL_BOX.h),
          )
      : [];
  const points =
    camera && camera.scale >= LABEL_SCALE * 1.6
      ? [...state.added.entries()]
          .map(([id, point]) => ({ id, point, n: view.nodes.get(id) }))
          .filter((p): p is { id: string; point: number; n: TreeNodeView } => !!p.n)
          .map((p) => ({
            ...p,
            x: p.n.x * camera.scale + camera.x,
            y: p.n.y * camera.scale + camera.y,
          }))
      : [];

  const hovered = hover ? nodeOf(hover.id) : undefined;
  const issues = [...view.issues, ...(ascendancy?.view.issues ?? []), ...timeline.issues];

  return (
    <div className={expanded ? "ef-tree ef-tree--expanded" : "ef-tree"}>
      <div className="ef-tree__stage">
        <TreeCanvas
          ref={canvasRef}
          view={view}
          iconSheet={iconSheet}
          highlight={highlight}
          focus={hover && !hover.inset ? hover.id : undefined}
          initialFit={allocatedMain}
          label={`Passive tree, ${stage ? stage.label : ""}`}
          onCamera={onCamera}
          onHover={(hit) =>
            setHover((h) => (hit ? { ...hit, pinned: false, inset: false } : h?.pinned ? h : null))
          }
          onSelect={(id) => {
            if (!id) return setHover(null);
            const pos = canvasRef.current?.project(id);
            if (pos) setHover({ id, ...pos, pinned: true, inset: false });
          }}
          className="ef-tree__main"
        >
          <div className="ef-tree__labels" aria-hidden="true">
            {labels.map(({ n, x, y, fresh }) => (
              <span
                key={n.id}
                className={`ef-tree__label ef-tree__label--${n.shape}`}
                data-fresh={fresh ? "true" : undefined}
                style={{ transform: `translate(${String(x)}px, ${String(y)}px)` }}
              >
                {n.name}
              </span>
            ))}
            {points.map((p) => (
              <span
                key={p.id}
                className="ef-tree__point"
                style={{ transform: `translate(${String(p.x)}px, ${String(p.y)}px)` }}
              >
                {pad2(p.point)}
              </span>
            ))}
          </div>

          <div className="ef-tree__hud ef-tree__hud--tl">
            <p className="ef-tree__kicker">
              Stage {pad2(state.stage + 1)} / {pad2(timeline.stages.length)}
            </p>
            <p className="ef-tree__title">{stage?.label ?? "No stage"}</p>
            {stage ? (
              <p className="ef-tree__levels">
                Level {stage.levelRange[0]}–{stage.levelRange[1]}
              </p>
            ) : null}
            <dl className="ef-tree__counts">
              <div>
                <dt>Allocated</dt>
                <dd>{state.allocated.size}</dd>
              </div>
              <div data-tone="new">
                <dt>New</dt>
                <dd>+{state.added.size}</dd>
              </div>
              <div data-tone="respec">
                <dt>Respec</dt>
                <dd>{state.refunded.size}</dd>
              </div>
            </dl>
          </div>

          <div className="ef-tree__hud ef-tree__hud--tr">
            <label className="ef-tree__search" htmlFor={searchId}>
              <span className="ef-visually-hidden">Search passives</span>
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5 L14 14" />
              </svg>
              <input
                id={searchId}
                type="search"
                placeholder="Search passives"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
              {query.trim().length >= SEARCH_MIN_CHARS ? (
                <output className="ef-tree__search-count">
                  {matches.size + insetMatches.size} found
                </output>
              ) : null}
            </label>
            <div className="ef-tree__zoom" role="group" aria-label="Zoom">
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                aria-pressed={expanded}
                aria-label="Full screen"
                title={expanded ? "Leave full screen (Esc)" : "Full screen"}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  {expanded ? (
                    <path d="M6 1v5H1M10 1v5h5M10 15v-5h5M6 15v-5H1" />
                  ) : (
                    <path d="M1 6V1h5M10 1h5v5M15 10v5h-5M6 15H1v-5" />
                  )}
                </svg>
              </button>
              <button
                type="button"
                onClick={() => canvasRef.current?.zoomBy(1.4)}
                aria-label="Zoom in"
              >
                +
              </button>
              <button
                type="button"
                onClick={() => canvasRef.current?.zoomBy(1 / 1.4)}
                aria-label="Zoom out"
              >
                −
              </button>
              <button
                type="button"
                onClick={() => canvasRef.current?.fit(allocatedMain, 0.14, 5200)}
                aria-label="Frame the build"
                title="Frame the build"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M1 5V1h4M11 1h4v4M15 11v4h-4M5 15H1v-4" />
                  <circle cx="8" cy="8" r="2" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => canvasRef.current?.fit()}
                aria-label="Show the whole tree"
                title="Show the whole tree"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <circle cx="8" cy="8" r="6.5" />
                  <circle cx="8" cy="8" r="3" />
                </svg>
              </button>
            </div>
          </div>

          <div className="ef-tree__hud ef-tree__hud--bl">
            <ul className="ef-tree__legend" aria-label="Legend">
              <li data-key="allocated">Allocated</li>
              <li data-key="new">New this stage</li>
              <li data-key="respec">Respec</li>
              {matches.size + insetMatches.size > 0 ? <li data-key="search">Search hit</li> : null}
            </ul>
          </div>

          <div className="ef-tree__hud ef-tree__hud--br">
            <ProvenanceBadge provenance={provenance} />
            <span className="ef-tree__source">{allocationSource}</span>
          </div>

          {hover && hovered && !hover.inset ? (
            <NodeCard node={hovered} state={state} x={hover.x} y={hover.y} pinned={hover.pinned} />
          ) : null}
        </TreeCanvas>

        <TreeTimelineRule
          timeline={timeline}
          cursor={cursor}
          stage={state.stage}
          onCursor={(c) => {
            setPlaying(null);
            setStageHint(undefined);
            setCursor(c);
          }}
          playing={playing !== null}
          onPlay={play}
        />
      </div>

      <aside className="ef-tree__side" aria-label="Stage details">
        {ascendancy ? (
          <section className="ef-tree__inset" aria-label={`Ascendancy ${ascendancy.name}`}>
            <p className="ef-tree__side-kicker">Ascendancy</p>
            <h2 className="ef-tree__side-title">{ascendancy.name}</h2>
            <TreeCanvas
              ref={insetRef}
              view={ascendancy.view}
              iconSheet={iconSheet}
              highlight={insetHighlight}
              focus={hover?.inset ? hover.id : undefined}
              bezel={false}
              label={`Ascendancy ${ascendancy.name}`}
              onHover={(hit) =>
                setHover((h) =>
                  hit ? { ...hit, pinned: false, inset: true } : h?.pinned ? h : null,
                )
              }
              onSelect={(id) => {
                if (!id) return setHover(null);
                const pos = insetRef.current?.project(id);
                if (pos) setHover({ id, ...pos, pinned: true, inset: true });
              }}
              className="ef-tree__inset-canvas"
            >
              {hover && hovered && hover.inset ? (
                <NodeCard
                  node={hovered}
                  state={state}
                  x={hover.x}
                  y={hover.y}
                  pinned={hover.pinned}
                />
              ) : null}
            </TreeCanvas>
          </section>
        ) : null}

        <section className="ef-tree__order" aria-labelledby={`${searchId}-order`}>
          <p className="ef-tree__side-kicker">Allocation order</p>
          <h2 id={`${searchId}-order`} className="ef-tree__side-title">
            {stage?.label ?? "No stage"}
          </h2>
          {stageNodes.length === 0 && refunded.length === 0 ? (
            <p className="ef-tree__empty">No passive changes up to this point of the stage.</p>
          ) : null}
          <div className="ef-tree__scroll">
            <ol className="ef-tree__list">
              {stageNodes.map(({ id, point, node }) =>
                node ? (
                  <li key={id} data-shape={node.shape}>
                    <button type="button" onClick={() => focusNode(id)}>
                      <span className="ef-tree__list-no">{pad2(point)}</span>
                      <span className="ef-tree__list-name">{node.name}</span>
                      <span className="ef-tree__list-kind">{SHAPE_LABEL[node.shape]}</span>
                    </button>
                  </li>
                ) : null,
              )}
            </ol>
            {refunded.length > 0 ? (
              <>
                <p className="ef-tree__side-kicker ef-tree__side-kicker--respec">Respec</p>
                <ul className="ef-tree__list ef-tree__list--respec">
                  {refunded.map(({ id, node }) =>
                    node ? (
                      <li key={id} data-shape={node.shape}>
                        <button type="button" onClick={() => focusNode(id)}>
                          <span className="ef-tree__list-no" aria-hidden="true">
                            ×
                          </span>
                          <span className="ef-tree__list-name">{node.name}</span>
                          <span className="ef-tree__list-kind">{SHAPE_LABEL[node.shape]}</span>
                        </button>
                      </li>
                    ) : null,
                  )}
                </ul>
              </>
            ) : null}
            {missing.length > 0 || issues.length > 0 ? (
              <div className="ef-tree__issues" role="alert">
                <Badge tone="danger">Data problem</Badge>
                <ul>
                  {missing.map((id) => (
                    <li key={id}>Passive {id} is not in this data release.</li>
                  ))}
                  {issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </section>
      </aside>
    </div>
  );
}

function NodeCard({
  node,
  state,
  x,
  y,
  pinned,
}: {
  node: TreeNodeView;
  state: TimelineState;
  x: number;
  y: number;
  pinned: boolean;
}) {
  const point = state.added.get(node.id);
  const status =
    point !== undefined
      ? `New · point ${pad2(point)}`
      : state.refunded.has(node.id)
        ? "Respec"
        : state.allocated.has(node.id)
          ? "Allocated"
          : "Not allocated";
  const tone =
    point !== undefined
      ? "new"
      : state.refunded.has(node.id)
        ? "respec"
        : state.allocated.has(node.id)
          ? "allocated"
          : "none";
  return (
    <div
      className={`ef-tree-card ef-tree-card--${node.shape}`}
      data-tone={tone}
      data-pinned={pinned ? "true" : undefined}
      role="tooltip"
      style={{ transform: `translate(${String(x)}px, ${String(y)}px)` }}
    >
      <p className="ef-tree-card__kicker">
        <span>{SHAPE_LABEL[node.shape]}</span>
        <span className="ef-tree-card__status">{status}</span>
      </p>
      <p className="ef-tree-card__name">{node.name}</p>
      {node.stats.length > 0 ? (
        <ul className="ef-tree-card__stats">
          {node.stats.map((s, i) => (
            <li key={`${String(i)}:${s}`}>{s}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
