import { useMemo } from "react";
import { Callout, Panel } from "@astrolabe/ui";
import type { GuideView } from "@astrolabe/contracts/guide";
import { loadGuideRevision } from "../api/guides";
import { useLoaded } from "../api/use-loaded";
import { diffRevisions } from "../guide/revision-diff";
import { useCommentRevisions } from "./SectionComments";

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const show = (n: number | undefined): string =>
  n === undefined ? "not measured" : NUMBER.format(n);

/** Before/after of the last revision: what a comment changed, from the stored Path of Building results. */
export function RevisionDiffPanel({ guideId, view }: { guideId: string; view: GuideView }) {
  const info = useCommentRevisions();
  if (info === undefined || info.revisions < 1 || info.open) return null;
  return <Loaded guideId={guideId} revision={info.revisions - 1} view={view} />;
}

function Loaded({
  guideId,
  revision,
  view,
}: {
  guideId: string;
  revision: number;
  view: GuideView;
}) {
  const before = useLoaded(
    (signal) => loadGuideRevision(guideId, revision, signal),
    `${guideId}#${String(revision)}`,
  );
  const diff = useMemo(
    () => (before.status === "ready" ? diffRevisions(before.value, view) : undefined),
    [before, view],
  );
  if (before.status === "loading") return null;
  if (before.status === "error") {
    return (
      <Callout tone="warning" title="The last revision could not be compared" live>
        {before.message}
      </Callout>
    );
  }
  if (diff === undefined || diff.empty) return null;
  return (
    <Panel title="What changed" kicker={`Revision ${String(revision + 1)}`} variant="recessed">
      {diff.stats.length > 0 ? (
        <table className="revision-diff__stats">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Stat</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {diff.stats.map((c) => (
              <tr key={`${c.stage}:${c.stat}`}>
                <td>{c.stage}</td>
                <td>{c.label}</td>
                <td>{show(c.before)}</td>
                <td>{show(c.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <ul className="revision-diff__list">
        {diff.skills.map((c) => (
          <li key={`skill:${c.stage}`}>
            {c.stage}: skills
            {c.added.length > 0 ? ` added ${c.added.join(", ")}` : ""}
            {c.removed.length > 0 ? ` removed ${c.removed.join(", ")}` : ""}
          </li>
        ))}
        {diff.gear.map((c) => (
          <li key={`gear:${c.tier}:${c.slot}`}>
            {c.tier} {c.slot}: {c.before ?? "empty"} → {c.after ?? "empty"}
          </li>
        ))}
        {diff.craftingAdded.map((k) => (
          <li key={`ca:${k}`}>Crafting plan added: {k}</li>
        ))}
        {diff.craftingRemoved.map((k) => (
          <li key={`cr:${k}`}>Crafting plan removed: {k}</li>
        ))}
        {diff.stagesAdded.map((k) => (
          <li key={`sa:${k}`}>Stage added: {k}</li>
        ))}
        {diff.stagesRemoved.map((k) => (
          <li key={`sr:${k}`}>Stage removed: {k}</li>
        ))}
      </ul>
    </Panel>
  );
}
