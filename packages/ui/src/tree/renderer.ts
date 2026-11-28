// WebGL renderer of the passive tree (PixiJS). Imperative on purpose: React
// owns the controls and overlays, this class owns the canvas, the camera and
// hit testing. Colours come from the --ef-tree-* design tokens; shapes are
// Astrolabe's own (no game art).
// The desktop app forbids 'unsafe-eval' in its CSP; this module replaces the
// shader code generation that needs it, so the policy stays strict.
import "pixi.js/unsafe-eval";
import { Application, Container, Graphics, Rectangle, Sprite, Texture, ImageSource } from "pixi.js";
import type { PassiveTreeView, TreeEdgeView, TreeNodeShape, TreeNodeView } from "./tree-model";

export interface TreeHighlight {
  readonly allocated: ReadonlySet<string>;
  /** Allocated in the current stage. */
  readonly added: ReadonlySet<string>;
  /** Refunded in the current stage. */
  readonly refunded: ReadonlySet<string>;
  /** Search hits. */
  readonly matches: ReadonlySet<string>;
}

export interface TreeCamera {
  /** Screen pixels per tree unit. */
  readonly scale: number;
  /** Screen position of tree point (0, 0). */
  readonly x: number;
  readonly y: number;
}

/**
 * Node pictures: one image with square cells in rows (the server's icon atlas). The window loads
 * it; the renderer only cuts cells. Nodes without an entry are drawn without a picture.
 */
export interface TreeIconSheet {
  readonly image: ImageBitmap | HTMLImageElement | HTMLCanvasElement;
  /** Edge length of one cell in pixels. */
  readonly cell: number;
  /** Cells per row. */
  readonly columns: number;
  /** Node id to cell index (row-major, from 0). */
  readonly icons: Readonly<Record<string, number>>;
}

export interface TreeRendererOptions {
  readonly view: PassiveTreeView;
  /** Pictures for notables, keystones, ascendancy and class starts; without them the plain shapes show. */
  readonly iconSheet?: TreeIconSheet;
  /** Draw the engraved bezel ring around the whole tree. */
  readonly bezel?: boolean;
  readonly onHover?: (hit: { id: string; x: number; y: number } | null) => void;
  readonly onSelect?: (id: string | null) => void;
  readonly onCamera?: (camera: TreeCamera) => void;
  /** The WebGL context was lost after start; the canvas no longer shows the tree. */
  readonly onError?: (error: Error) => void;
}

/** Radius in tree units and minimum radius in screen pixels per shape. */
const NODE_SIZE: Readonly<Record<TreeNodeShape, { r: number; minPx: number }>> = {
  small: { r: 19, minPx: 0.9 },
  attribute: { r: 21, minPx: 1 },
  notable: { r: 34, minPx: 1.9 },
  keystone: { r: 52, minPx: 3.4 },
  jewelSocket: { r: 34, minPx: 2 },
  classStart: { r: 118, minPx: 6 },
  ascendancyStart: { r: 40, minPx: 3 },
  decoration: { r: 64, minPx: 0 },
};

/** Shapes that carry a picture when the sheet has one. */
const ICON_SHAPES: ReadonlySet<TreeNodeShape> = new Set([
  "notable",
  "keystone",
  "jewelSocket",
  "ascendancyStart",
  "classStart",
]);
/** Picture size relative to the node radius, and its brightness while not allocated. */
const ICON_FIT = { diameter: 1.7, classStartDiameter: 1.2, idleAlpha: 0.62, idleTint: 0xa8a8a8 };

const ICON_MIN_PX: Readonly<Partial<Record<TreeNodeShape, number>>> = {
  notable: 4.5,
  keystone: 6,
  jewelSocket: 4,
  ascendancyStart: 5,
};

const EDGE_WIDTH = { allocated: 11, allocatedMinPx: 2.2, glow: 3.4 };
const ZOOM = { min: 0.012, max: 1.6, step: 1.25, wheel: 0.0016 };
const HIT_PX = 9;
const GRID = 400;

interface Palette {
  engraving: string;
  bezel: string;
  edge: string;
  node: string;
  notable: string;
  keystone: string;
  allocated: string;
  added: string;
  respec: string;
  search: string;
  hover: string;
}

function readPalette(host: HTMLElement): Palette {
  const css = getComputedStyle(host);
  const v = (name: string) => {
    const value = css.getPropertyValue(`--ef-tree-${name}`).trim();
    if (!value) throw new Error(`Design token --ef-tree-${name} is not defined`);
    return value;
  };
  return {
    engraving: v("engraving"),
    bezel: v("bezel"),
    edge: v("edge"),
    node: v("node"),
    notable: v("node-notable"),
    keystone: v("node-keystone"),
    allocated: v("allocated"),
    added: v("new"),
    respec: v("respec"),
    search: v("search"),
    hover: v("hover"),
  };
}

function polygon(cx: number, cy: number, r: number, points: number, inner: number, rot = 0) {
  const out: number[] = [];
  for (let i = 0; i < points * 2; i++) {
    const rr = i % 2 === 0 ? r : r * inner;
    const a = rot + (Math.PI * i) / points;
    out.push(cx + Math.sin(a) * rr, cy - Math.cos(a) * rr);
  }
  return out;
}

export class TreeRenderer {
  private readonly app: Application;
  private readonly world = new Container();
  private readonly engraving = new Graphics();
  private readonly baseEdges = new Graphics();
  private readonly activeEdges = new Graphics();
  private readonly nodes = new Graphics();
  private readonly iconLayer = new Container();
  private readonly icons = new Map<string, Sprite>();
  private readonly overlay = new Graphics();
  private readonly focusLayer = new Graphics();
  private focus: string | undefined;
  private hoverId: string | undefined;
  private readonly grid = new Map<string, TreeNodeView[]>();
  private readonly palette: Palette;
  private highlight: TreeHighlight = {
    allocated: new Set(),
    added: new Set(),
    refunded: new Set(),
    matches: new Set(),
  };
  private camera: TreeCamera = { scale: 0.03, x: 0, y: 0 };
  private redrawQueued = false;
  private renderQueued = false;
  private drawnScale = 0;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private destroyed = false;
  private readonly resizeObserver: ResizeObserver;

  private constructor(
    private readonly host: HTMLElement,
    private readonly options: TreeRendererOptions,
    app: Application,
  ) {
    this.app = app;
    this.palette = readPalette(host);
    this.world.addChild(
      this.engraving,
      this.baseEdges,
      this.activeEdges,
      this.nodes,
      this.iconLayer,
      this.overlay,
      this.focusLayer,
    );
    app.stage.addChild(this.world);
    this.buildIcons();
    for (const n of options.view.nodes.values()) {
      if (n.shape === "decoration") continue;
      const key = `${Math.floor(n.x / GRID)}:${Math.floor(n.y / GRID)}`;
      this.grid.set(key, [...(this.grid.get(key) ?? []), n]);
    }
    this.drawStatic();
    this.bindInput();
    // Pixi's resizeTo follows window resizes only; entering full screen (a CSS class) changes the host
    // size without one, which left the canvas at its old size while labels were placed for the new one.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.destroyed) return;
      const { clientWidth, clientHeight } = this.host;
      if (clientWidth > 0 && clientHeight > 0) this.app.renderer.resize(clientWidth, clientHeight);
      this.queueRedraw();
    });
    this.resizeObserver.observe(host);
  }

  static async create(host: HTMLElement, options: TreeRendererOptions): Promise<TreeRenderer> {
    const app = new Application();
    try {
      await app.init({
        resizeTo: host,
        antialias: true,
        backgroundAlpha: 0,
        preference: "webgl",
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
        // frames are drawn on demand (see invalidate): the tree is large and a
        // continuous ticker keeps software WebGL busy even while nothing moves
        autoStart: false,
        sharedTicker: false,
      });
      app.canvas.setAttribute("aria-hidden", "true");
      host.appendChild(app.canvas);
      return new TreeRenderer(host, options, app);
    } catch (cause) {
      // never leave a half-built canvas or WebGL context behind
      let cleanup = "";
      try {
        app.destroy({ removeView: true }, { children: true });
      } catch (destroyError) {
        cleanup = ` (cleanup failed too: ${destroyError instanceof Error ? destroyError.message : String(destroyError)})`;
      }
      throw new Error(`Tree renderer could not start${cleanup}`, { cause });
    }
  }

  /** One sprite per node that has a picture; cells are cut from one shared texture. */
  private buildIcons(): void {
    const sheet = this.options.iconSheet;
    if (sheet === undefined) return;
    const source = new ImageSource({
      resource: sheet.image,
      autoGenerateMipmaps: true,
      scaleMode: "linear",
    });
    const cells = new Map<number, Texture>();
    for (const n of this.options.view.nodes.values()) {
      const cell = sheet.icons[n.id];
      if (cell === undefined || !ICON_SHAPES.has(n.shape)) continue;
      let texture = cells.get(cell);
      if (texture === undefined) {
        texture = new Texture({
          source,
          frame: new Rectangle(
            (cell % sheet.columns) * sheet.cell,
            Math.floor(cell / sheet.columns) * sheet.cell,
            sheet.cell,
            sheet.cell,
          ),
        });
        cells.set(cell, texture);
      }
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      this.icons.set(n.id, sprite);
      this.iconLayer.addChild(sprite);
    }
  }

  private hasIcon(n: TreeNodeView): boolean {
    return this.icons.has(n.id);
  }

  /** Size follows the zoom (radius has a pixel minimum); brightness follows allocation. */
  private drawIcons(): void {
    const h = this.highlight;
    for (const [id, sprite] of this.icons) {
      const n = this.options.view.nodes.get(id);
      if (n === undefined) continue;
      const size =
        this.radius(n) *
        (n.shape === "classStart" ? ICON_FIT.classStartDiameter : ICON_FIT.diameter);
      sprite.position.set(n.x, n.y);
      sprite.width = size;
      sprite.height = size;
      const on = h.allocated.has(id) || h.added.has(id);
      sprite.alpha = on ? 1 : ICON_FIT.idleAlpha;
      sprite.tint = on ? 0xffffff : ICON_FIT.idleTint;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.app.destroy({ removeView: true }, { children: true });
  }

  getCamera(): TreeCamera {
    return this.camera;
  }

  setHighlight(highlight: TreeHighlight): void {
    this.highlight = highlight;
    this.drawActive();
  }

  /** Ring around the hovered or picked node; drawn on its own layer. */
  setFocus(id: string | undefined): void {
    if (id === this.focus) return;
    this.focus = id;
    this.drawFocus();
  }

  /** Fits the given nodes (or the whole tree) into the view. */
  fit(ids?: Iterable<string>, padding = 0.08, minSpan = 800): void {
    let { minX, minY, maxX, maxY } = this.options.view.bounds;
    if (ids) {
      const pts = [...ids]
        .map((id) => this.options.view.nodes.get(id))
        .filter((n): n is TreeNodeView => n !== undefined);
      if (pts.length > 0) {
        minX = Math.min(...pts.map((n) => n.x));
        maxX = Math.max(...pts.map((n) => n.x));
        minY = Math.min(...pts.map((n) => n.y));
        maxY = Math.max(...pts.map((n) => n.y));
      }
    }
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === 0 || h === 0) return;
    const spanX = Math.max(maxX - minX, minSpan);
    const spanY = Math.max(maxY - minY, minSpan);
    const scale = this.clampScale(
      Math.min((w * (1 - 2 * padding)) / spanX, (h * (1 - 2 * padding)) / spanY),
    );
    this.setCamera({
      scale,
      x: w / 2 - ((minX + maxX) / 2) * scale,
      y: h / 2 - ((minY + maxY) / 2) * scale,
    });
  }

  /** Zooms by a factor around a screen point (default: view centre). */
  zoomBy(factor: number, at?: { x: number; y: number }): void {
    const p = at ?? { x: this.host.clientWidth / 2, y: this.host.clientHeight / 2 };
    const scale = this.clampScale(this.camera.scale * factor);
    const k = scale / this.camera.scale;
    this.setCamera({
      scale,
      x: p.x - (p.x - this.camera.x) * k,
      y: p.y - (p.y - this.camera.y) * k,
    });
  }

  panBy(dx: number, dy: number): void {
    this.setCamera({ ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy });
  }

  /** Screen position of a node, for overlays. */
  project(id: string): { x: number; y: number } | undefined {
    const n = this.options.view.nodes.get(id);
    if (!n) return undefined;
    return {
      x: n.x * this.camera.scale + this.camera.x,
      y: n.y * this.camera.scale + this.camera.y,
    };
  }

  // ---------------------------------------------------------------- camera

  private clampScale(s: number): number {
    return Math.min(ZOOM.max, Math.max(ZOOM.min, s));
  }

  private setCamera(camera: TreeCamera): void {
    this.camera = camera;
    this.world.scale.set(camera.scale);
    this.world.position.set(camera.x, camera.y);
    this.queueRedraw();
    this.options.onCamera?.(camera);
  }

  /** Draws one frame on the next animation frame; many changes share it. */
  private invalidate(): void {
    if (this.renderQueued || this.destroyed) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.destroyed) this.app.render();
    });
  }

  /** Widths and minimum sizes depend on the zoom; redraw once per frame at most. */
  private queueRedraw(): void {
    this.invalidate();
    if (this.redrawQueued || this.destroyed) return;
    this.redrawQueued = true;
    requestAnimationFrame(() => {
      this.redrawQueued = false;
      if (this.destroyed) return;
      if (Math.abs(this.drawnScale - this.camera.scale) / this.camera.scale > 0.04) {
        this.drawStatic();
        this.drawActive();
        this.drawFocus();
      }
    });
  }

  // ---------------------------------------------------------------- input

  private toTree(clientX: number, clientY: number) {
    const rect = this.host.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return {
      sx,
      sy,
      x: (sx - this.camera.x) / this.camera.scale,
      y: (sy - this.camera.y) / this.camera.scale,
    };
  }

  private hitTest(x: number, y: number): TreeNodeView | undefined {
    const reach = HIT_PX / this.camera.scale;
    let best: TreeNodeView | undefined;
    let bestDist = Infinity;
    const gx = Math.floor(x / GRID);
    const gy = Math.floor(y / GRID);
    const cells = Math.ceil(reach / GRID) + 1;
    for (let i = gx - cells; i <= gx + cells; i++) {
      for (let j = gy - cells; j <= gy + cells; j++) {
        for (const n of this.grid.get(`${i}:${j}`) ?? []) {
          const d = Math.hypot(n.x - x, n.y - y);
          const r = Math.max(NODE_SIZE[n.shape].r, reach);
          if (d <= r && d < bestDist) {
            best = n;
            bestDist = d;
          }
        }
      }
    }
    return best;
  }

  private bindInput(): void {
    const el = this.app.canvas;
    el.style.touchAction = "none";
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const p = this.toTree(e.clientX, e.clientY);
        this.zoomBy(Math.exp(-e.deltaY * ZOOM.wheel), { x: p.sx, y: p.sy });
      },
      { passive: false },
    );
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, moved: false };
    });
    el.addEventListener("pointermove", (e) => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (this.drag.moved || Math.hypot(dx, dy) > 3) {
          this.drag = { x: e.clientX, y: e.clientY, moved: true };
          this.panBy(dx, dy);
          if (this.hoverId !== undefined) {
            this.hoverId = undefined;
            this.options.onHover?.(null);
          }
          return;
        }
      }
      const p = this.toTree(e.clientX, e.clientY);
      const hit = this.hitTest(p.x, p.y);
      el.style.cursor = hit ? "pointer" : this.drag ? "grabbing" : "grab";
      // report changes only: moving within one node must not re-render React
      if (hit?.id === this.hoverId) return;
      this.hoverId = hit?.id;
      const pos = hit ? this.project(hit.id) : undefined;
      this.options.onHover?.(hit && pos ? { id: hit.id, ...pos } : null);
    });
    el.addEventListener("pointerup", (e) => {
      const wasClick = this.drag && !this.drag.moved;
      this.drag = null;
      if (!wasClick) return;
      const p = this.toTree(e.clientX, e.clientY);
      this.options.onSelect?.(this.hitTest(p.x, p.y)?.id ?? null);
    });
    el.addEventListener("pointerleave", () => {
      if (this.drag) return;
      this.hoverId = undefined;
      this.options.onHover?.(null);
    });
    el.addEventListener("pointercancel", () => {
      this.drag = null;
      this.hoverId = undefined;
      this.options.onHover?.(null);
    });
    el.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.options.onError?.(new Error("The graphics context was lost (WebGL)"));
    });
  }

  // ---------------------------------------------------------------- drawing

  private px(n: number): number {
    return n / this.camera.scale;
  }

  private radius(n: TreeNodeView): number {
    const size = NODE_SIZE[n.shape];
    // Nodes with a picture stay big enough to be recognised when the tree is zoomed out.
    const minPx = this.hasIcon(n) ? Math.max(size.minPx, ICON_MIN_PX[n.shape] ?? 0) : size.minPx;
    return Math.max(size.r, this.px(minPx));
  }

  private path(g: Graphics, e: TreeEdgeView): void {
    const a = this.options.view.nodes.get(e.a);
    const b = this.options.view.nodes.get(e.b);
    if (!a || !b) return;
    g.moveTo(a.x, a.y);
    if (e.arc) g.arc(e.arc.cx, e.arc.cy, e.arc.r, e.arc.start, e.arc.end, e.arc.anticlockwise);
    else g.lineTo(b.x, b.y);
  }

  private drawStatic(): void {
    this.invalidate();
    const { view } = this.options;
    const c = this.palette;
    this.drawnScale = this.camera.scale;

    const eng = this.engraving.clear();
    // engraved orbit rings of each group: the instrument's graduations
    for (const g of view.groups) {
      for (const r of g.radii) if (r > 0) eng.circle(g.cx, g.cy, r);
    }
    eng.stroke({ width: 1, color: c.engraving, pixelLine: true });
    for (const n of view.nodes.values()) {
      if (n.shape !== "decoration") continue;
      // decoration nodes become an engraved rosette at their position
      const r = NODE_SIZE.decoration.r;
      eng.circle(n.x, n.y, r);
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI * i) / 3;
        eng.moveTo(n.x + Math.sin(a) * r * 0.35, n.y - Math.cos(a) * r * 0.35);
        eng.lineTo(n.x + Math.sin(a) * r, n.y - Math.cos(a) * r);
      }
    }
    eng.stroke({ width: 1, color: c.engraving, pixelLine: true, alpha: 1 });
    if (this.options.bezel !== false) this.drawBezel(eng);

    const edges = this.baseEdges.clear();
    for (const e of view.edges) if (!e.classStart) this.path(edges, e);
    edges.stroke({ width: Math.max(4, this.px(1)), color: c.edge, alpha: 0.95 });

    this.drawNodes();
  }

  private drawBezel(g: Graphics): void {
    const { minX, minY, maxX, maxY } = this.options.view.bounds;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const R = (Math.max(maxX - minX, maxY - minY) / 2) * 1.04;
    const c = this.palette;
    g.circle(cx, cy, R).circle(cx, cy, R * 1.035);
    g.stroke({ width: 1, color: c.bezel, pixelLine: true });
    for (let i = 0; i < 360; i += 2) {
      const a = (i * Math.PI) / 180;
      const len = i % 30 === 0 ? 0.035 : i % 10 === 0 ? 0.022 : 0.012;
      g.moveTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R);
      g.lineTo(cx + Math.sin(a) * R * (1 + len), cy - Math.cos(a) * R * (1 + len));
    }
    g.stroke({ width: 1, color: c.bezel, pixelLine: true });
    // crosshair through the centre, broken around the middle
    const gap = R * 0.08;
    g.moveTo(cx - R, cy)
      .lineTo(cx - gap, cy)
      .moveTo(cx + gap, cy)
      .lineTo(cx + R, cy);
    g.moveTo(cx, cy - R)
      .lineTo(cx, cy - gap)
      .moveTo(cx, cy + gap)
      .lineTo(cx, cy + R);
    g.stroke({ width: 1, color: c.engraving, pixelLine: true });
  }

  /** Unallocated look of every node; allocation is drawn on top in drawActive. */
  private drawNodes(): void {
    const g = this.nodes.clear();
    const c = this.palette;
    const byShape = (shape: TreeNodeShape) =>
      [...this.options.view.nodes.values()].filter((n) => n.shape === shape);

    for (const n of byShape("small")) g.circle(n.x, n.y, this.radius(n));
    g.fill({ color: c.node });
    for (const n of byShape("attribute")) {
      const r = this.radius(n);
      g.poly([n.x, n.y - r, n.x + r, n.y, n.x, n.y + r, n.x - r, n.y]);
    }
    g.fill({ color: c.node });

    const ring = Math.max(5, this.px(1));
    // A picture replaces the fill and the centre dot; the ring stays as the frame.
    const plain = (shape: TreeNodeShape) => byShape(shape).filter((n) => !this.hasIcon(n));
    for (const n of plain("notable")) g.circle(n.x, n.y, this.radius(n));
    g.fill({ color: c.notable, alpha: 0.25 });
    for (const n of byShape("notable")) g.circle(n.x, n.y, this.radius(n));
    g.stroke({ width: ring * 1.4, color: c.notable });
    for (const n of plain("notable")) g.circle(n.x, n.y, this.radius(n) * 0.42);
    g.fill({ color: c.notable });

    for (const n of byShape("jewelSocket")) {
      const r = this.radius(n);
      g.circle(n.x, n.y, r);
      g.moveTo(n.x - r * 1.3, n.y).lineTo(n.x + r * 1.3, n.y);
      g.moveTo(n.x, n.y - r * 1.3).lineTo(n.x, n.y + r * 1.3);
    }
    g.stroke({ width: ring * 1.2, color: c.notable });

    for (const n of plain("keystone")) {
      const r = this.radius(n);
      g.poly(polygon(n.x, n.y, r * 0.92, 8, 0.45));
    }
    g.fill({ color: c.keystone, alpha: 0.85 });
    for (const n of byShape("keystone")) g.circle(n.x, n.y, this.radius(n) * 1.15);
    g.stroke({ width: ring * 1.2, color: c.keystone });

    for (const n of byShape("ascendancyStart")) {
      const r = this.radius(n);
      g.circle(n.x, n.y, r);
      g.poly(polygon(n.x, n.y, r * 0.6, 2, 0.5));
    }
    g.stroke({ width: ring * 1.2, color: c.notable });

    for (const n of byShape("classStart")) {
      const r = this.radius(n);
      g.circle(n.x, n.y, r).circle(n.x, n.y, r * 0.78);
      for (let i = 0; i < 24; i++) {
        const a = (Math.PI * i) / 12;
        const len = i % 6 === 0 ? 0.62 : 0.7;
        g.moveTo(n.x + Math.sin(a) * r * len, n.y - Math.cos(a) * r * len);
        g.lineTo(n.x + Math.sin(a) * r * 0.78, n.y - Math.cos(a) * r * 0.78);
      }
    }
    g.stroke({ width: ring * 1.2, color: c.keystone, alpha: 0.9 });
    this.drawIcons();
  }

  /** Allocation, new points, respecs, search hits and focus. */
  private drawActive(): void {
    this.invalidate();
    const { view } = this.options;
    const h = this.highlight;
    const c = this.palette;
    const e = this.activeEdges.clear();
    const o = this.overlay.clear();

    const width = Math.max(EDGE_WIDTH.allocated, this.px(EDGE_WIDTH.allocatedMinPx));
    const kept: TreeEdgeView[] = [];
    const fresh: TreeEdgeView[] = [];
    const refunded: TreeEdgeView[] = [];
    for (const edge of view.edges) {
      const startA = view.nodes.get(edge.a)?.shape === "classStart";
      const startB = view.nodes.get(edge.b)?.shape === "classStart";
      const aOn = startA || h.allocated.has(edge.a);
      const bOn = startB || h.allocated.has(edge.b);
      if (edge.classStart && !(h.allocated.has(edge.a) || h.allocated.has(edge.b))) continue;
      if (aOn && bOn) {
        (h.added.has(edge.a) || h.added.has(edge.b) ? fresh : kept).push(edge);
      } else if (
        (h.refunded.has(edge.a) || h.refunded.has(edge.b)) &&
        (aOn || bOn || (h.refunded.has(edge.a) && h.refunded.has(edge.b)))
      ) {
        refunded.push(edge);
      }
    }
    for (const edge of fresh) this.path(e, edge);
    e.stroke({ width: width * EDGE_WIDTH.glow, color: c.added, alpha: 0.16 });
    for (const edge of kept) this.path(e, edge);
    e.stroke({ width, color: c.allocated, alpha: 0.9 });
    for (const edge of fresh) this.path(e, edge);
    e.stroke({ width, color: c.added });
    for (const edge of refunded) this.path(e, edge);
    e.stroke({ width: width * 0.7, color: c.respec, alpha: 0.75 });

    const nodes = (ids: Iterable<string>) =>
      [...ids].map((id) => view.nodes.get(id)).filter((n): n is TreeNodeView => !!n);
    const allocated = nodes(h.allocated);
    const added = nodes(h.added);
    const ring = Math.max(6, this.px(1.2));

    // glow under new points
    for (const n of added) o.circle(n.x, n.y, this.radius(n) * 2.2);
    o.fill({ color: c.added, alpha: 0.14 });
    for (const n of allocated) {
      if (h.added.has(n.id) || this.hasIcon(n)) continue;
      this.shapePath(o, n, 1);
    }
    o.fill({ color: c.allocated });
    for (const n of added) if (!this.hasIcon(n)) this.shapePath(o, n, 1);
    o.fill({ color: c.added });
    for (const n of allocated) {
      if (n.shape === "notable" || n.shape === "keystone" || n.shape === "jewelSocket")
        o.circle(n.x, n.y, this.radius(n) * 1.45);
    }
    o.stroke({ width: ring, color: c.allocated, alpha: 0.8 });
    // New points with a picture get a ring in the "new" colour instead of the filled shape.
    for (const n of added) if (this.hasIcon(n)) o.circle(n.x, n.y, this.radius(n) * 1.45);
    o.stroke({ width: ring * 1.2, color: c.added });
    this.drawIcons();

    // refunded: amber ring struck through
    for (const n of nodes(h.refunded)) {
      const r = this.radius(n) * 1.5;
      o.circle(n.x, n.y, r);
      o.moveTo(n.x - r * 0.7, n.y + r * 0.7).lineTo(n.x + r * 0.7, n.y - r * 0.7);
    }
    o.stroke({ width: ring * 1.2, color: c.respec });

    for (const n of nodes(h.matches)) o.circle(n.x, n.y, this.radius(n) + this.px(6));
    o.stroke({ width: Math.max(8, this.px(1.5)), color: c.search });
  }

  private drawFocus(): void {
    this.invalidate();
    const g = this.focusLayer.clear();
    const focus = this.focus ? this.options.view.nodes.get(this.focus) : undefined;
    if (!focus) return;
    g.circle(focus.x, focus.y, this.radius(focus) + this.px(5));
    g.stroke({ width: Math.max(6, this.px(1.5)), color: this.palette.hover });
  }

  private shapePath(g: Graphics, n: TreeNodeView, k: number): void {
    const r = this.radius(n) * k;
    switch (n.shape) {
      case "attribute":
        g.poly([n.x, n.y - r, n.x + r, n.y, n.x, n.y + r, n.x - r, n.y]);
        return;
      case "keystone":
        g.poly(polygon(n.x, n.y, r * 0.92, 8, 0.45));
        return;
      case "notable":
      case "jewelSocket":
        g.circle(n.x, n.y, r * 0.78);
        return;
      case "classStart":
      case "decoration":
        return;
      default:
        g.circle(n.x, n.y, r);
    }
  }
}
