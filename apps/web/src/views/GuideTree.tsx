import { useMemo } from "react";
import { Callout, Panel, PassiveTree, buildTimeline, buildTreeView } from "@astrolabe/ui";
import type { GuideView, PassiveTreeData } from "@astrolabe/contracts/guide";
import type { TreeIconSheet } from "@astrolabe/ui";
import { loadPassiveTree, loadTreeIconSheet } from "../api/guides";
import { useLoaded } from "../api/use-loaded";
import { nameOf } from "../guide/RichTextView";

/*
 * The passive tree of a guide: its allocation, stage by stage, on the tree of the data release
 * the server runs with. A guide of another release is not drawn, because a node id can mean
 * something else there.
 */

const SKIPPED_SHOWN = 10;

interface StageProps {
  readonly stageIndex?: number | undefined;
  readonly onStageChange?: ((index: number) => void) | undefined;
}

interface LoadedTreeData {
  readonly data: PassiveTreeData;
  /** Absent when the pictures could not be loaded; `iconsProblem` says why. */
  readonly iconSheet?: TreeIconSheet;
  readonly iconsProblem?: string;
}

/** The tree comes first; its pictures are an extra whose failure is shown, not hidden. */
async function loadTreeWithIcons(signal: AbortSignal): Promise<LoadedTreeData> {
  const data = await loadPassiveTree(signal);
  try {
    return { data, iconSheet: await loadTreeIconSheet(signal) };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      data,
      iconsProblem: error instanceof Error ? error.message : "The icons could not be loaded.",
    };
  }
}

function TreeBody({
  view,
  data,
  iconSheet,
  iconsProblem,
  stageIndex,
  onStageChange,
}: { view: GuideView } & LoadedTreeData & StageProps) {
  const { guide } = view;
  const ascendancyId = guide.summary.ascendancyId;
  const prepared = useMemo(() => {
    const stages = [...guide.progression.stages].sort((a, b) => a.order - b.order);
    return {
      main: buildTreeView(data.passiveNodes, data.passiveGroups, {
        include: (n) => n.ascendancyId === undefined,
      }),
      ascendancy: buildTreeView(data.passiveNodes, data.passiveGroups, {
        include: (n) => n.ascendancyId === ascendancyId,
      }),
      timeline: buildTimeline(stages),
    };
  }, [data, guide, ascendancyId]);
  if (data.dataReleaseId !== view.catalogReleaseId) {
    return (
      <Callout tone="warning" title="The game data changed">
        The tree is from {data.dataReleaseId}, but this guide was read with {view.catalogReleaseId}.
        Reload the guide.
      </Callout>
    );
  }
  return (
    <>
      {data.skipped.length > 0 ? (
        <Callout tone="warning" title="Some tree entries could not be read">
          {data.skipped.slice(0, SKIPPED_SHOWN).join(", ")}
          {data.skipped.length > SKIPPED_SHOWN
            ? ` and ${data.skipped.length - SKIPPED_SHOWN} more`
            : ""}
        </Callout>
      ) : null}
      {iconsProblem !== undefined ? (
        <Callout tone="warning" title="Node pictures are not available">
          {iconsProblem} The tree is drawn with plain shapes.
        </Callout>
      ) : null}
      <PassiveTree
        view={prepared.main}
        {...(iconSheet === undefined ? {} : { iconSheet })}
        ascendancy={{
          name: nameOf(view, { kind: "ascendancy", id: ascendancyId }) ?? ascendancyId,
          view: prepared.ascendancy,
        }}
        timeline={prepared.timeline}
        {...(stageIndex === undefined ? {} : { stageIndex, initialStage: stageIndex })}
        {...(onStageChange === undefined ? {} : { onStageChange })}
        provenance={{ kind: "gamedata", dataRelease: data.dataReleaseId }}
        allocationSource={`Allocation: guide ${guide.metadata.guideId}`}
      />
    </>
  );
}

export function TreeSection({ view, stageIndex, onStageChange }: { view: GuideView } & StageProps) {
  if (!view.current) {
    return (
      <Panel title="Passive tree" kicker="By stage">
        <p role="status">
          The tree is drawn from the current game data. Revalidate this guide to see its passive
          tree.
        </p>
      </Panel>
    );
  }
  return <LoadedTree view={view} stageIndex={stageIndex} onStageChange={onStageChange} />;
}

function LoadedTree({ view, stageIndex, onStageChange }: { view: GuideView } & StageProps) {
  const loaded = useLoaded(loadTreeWithIcons, view.catalogReleaseId);
  return (
    <Panel title="Passive tree" kicker="By stage">
      {loaded.status === "loading" ? <p role="status">Loading tree data…</p> : null}
      {loaded.status === "error" ? (
        <Callout tone="danger" title="Tree data could not be loaded">
          {loaded.message}
        </Callout>
      ) : null}
      {loaded.status === "ready" ? (
        <TreeBody
          view={view}
          {...loaded.value}
          stageIndex={stageIndex}
          onStageChange={onStageChange}
        />
      ) : null}
    </Panel>
  );
}
