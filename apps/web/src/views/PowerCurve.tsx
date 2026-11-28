import type { ProgressionStage } from "@astrolabe/contracts/build";
import type { GuideView } from "@astrolabe/contracts/guide";
import { Panel, ProvenanceBadge } from "@astrolabe/ui";
import { GUIDE_STATS } from "../guide/guide-stats";

/*
 * How the build grows: one small chart per emphasised engine number, a point per progression stage
 * at its level. Values are read from the stored Path of Building results, the same as the stage
 * numbers. A stage without a result for the stat has no point (a gap), never a zero.
 */

interface Point {
  readonly level: number;
  readonly label: string;
  readonly value: number | undefined;
}

interface Series {
  readonly profile: string;
  readonly pobVersion: string;
  readonly points: Point[];
}

/** One calc profile per chart, so every point of a curve has the source the badge names. */
function seriesOf(
  stat: string,
  stages: readonly ProgressionStage[],
  view: GuideView,
): Series | undefined {
  for (const profile of GUIDE_STATS.calcProfiles) {
    let pobVersion: string | undefined;
    const points = stages.map((stage): Point => {
      const outcome = stage.calcs[profile];
      const result = outcome?.status === "ok" ? view.results[outcome.calcId] : undefined;
      const value = result?.stats[stat];
      if (value !== undefined && pobVersion === undefined) pobVersion = result?.pobVersion;
      return { level: stage.levelRange[1], label: stage.label, value };
    });
    if (pobVersion !== undefined) return { profile, pobVersion, points };
  }
  return undefined;
}

const W = 320;
const H = 120;
const PAD = { l: 8, r: 8, t: 10, b: 18 };

function Chart({ title, series }: { title: string; series: Series }) {
  const { points } = series;
  const known = points.filter((p): p is Point & { value: number } => p.value !== undefined);
  if (known.length === 0) return null;
  const maxV = Math.max(...known.map((p) => p.value));
  const lo = Math.min(...points.map((p) => p.level));
  const hi = Math.max(...points.map((p) => p.level));
  const x = (level: number): number =>
    PAD.l + (hi === lo ? 0.5 : (level - lo) / (hi - lo)) * (W - PAD.l - PAD.r);
  const y = (v: number): number => H - PAD.b - (maxV <= 0 ? 0 : v / maxV) * (H - PAD.t - PAD.b);
  // A gap in the data breaks the line instead of bridging it.
  const runs: (Point & { value: number })[][] = [];
  for (const p of points) {
    if (p.value === undefined) runs.push([]);
    else (runs[runs.length - 1] ?? runs[runs.push([]) - 1])?.push({ ...p, value: p.value });
  }
  // The headline is the value of the last stage; without one there is no headline, never an older value.
  const lastPoint = points[points.length - 1];
  const last = lastPoint?.value === undefined ? undefined : lastPoint;
  const fmt = new Intl.NumberFormat("en-US");
  const summary = points
    .map(
      (p) => `${p.label}: ${p.value === undefined ? "no result" : fmt.format(Math.round(p.value))}`,
    )
    .join("; ");
  return (
    <figure className="power-curve__chart">
      <figcaption>
        <span>{title}</span>
        {last?.value === undefined ? null : (
          <strong title={last.label}>
            {new Intl.NumberFormat("en-US", { notation: "compact" }).format(last.value)}
          </strong>
        )}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} by stage. ${summary}`}>
        <line
          className="power-curve__axis"
          x1={PAD.l}
          x2={W - PAD.r}
          y1={H - PAD.b}
          y2={H - PAD.b}
        />
        {runs
          .filter((r) => r.length > 1)
          .map((r, i) => (
            <polyline
              key={i}
              className="power-curve__line"
              points={r.map((p) => `${x(p.level)},${y(p.value)}`).join(" ")}
            />
          ))}
        {known.map((p) => (
          <g key={`${p.level}-${p.label}`}>
            <circle className="power-curve__dot" cx={x(p.level)} cy={y(p.value)} r={3}>
              <title>{`${p.label}: ${new Intl.NumberFormat("en-US").format(Math.round(p.value))}`}</title>
            </circle>
          </g>
        ))}
        <text className="power-curve__tick" x={PAD.l} y={H - 4}>
          {`Lv ${String(lo)}`}
        </text>
        <text className="power-curve__tick" x={W - PAD.r} y={H - 4} textAnchor="end">
          {`Lv ${String(hi)}`}
        </text>
      </svg>
      <ProvenanceBadge
        provenance={{ kind: "pob", pobVersion: series.pobVersion, calcProfile: series.profile }}
      />
    </figure>
  );
}

export function PowerCurve({ view }: { view: GuideView }) {
  const stages = [...view.guide.progression.stages].sort((a, b) => a.order - b.order);
  const charts = GUIDE_STATS.stats
    .filter((s) => s.emphasis === true)
    .flatMap((s) => {
      const series = seriesOf(s.stat, stages, view);
      return series === undefined ? [] : [{ s, series }];
    });
  if (charts.length === 0) return null;
  return (
    <Panel title="Power curve" kicker="How the build grows">
      <div className="power-curve">
        {charts.map(({ s, series }) => (
          <Chart key={s.stat} title={s.label} series={series} />
        ))}
      </div>
    </Panel>
  );
}
