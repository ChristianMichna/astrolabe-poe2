import { useCallback, useState } from "react";
import { Badge, Button, Callout, GuideNotes, Panel, Tabs } from "@astrolabe/ui";
import type { ProgressionStage } from "@astrolabe/contracts/build";
import { stageSectionKey, type GuideListView, type GuideView } from "@astrolabe/contracts/guide";
import { CraftingSection } from "./GuideCrafting";
import { useLoaded } from "../api/use-loaded";
import { GearSection } from "./GuideGear";
import { GearMatrix } from "./GearMatrix";
import { StageBar } from "./StageBar";
import { GuideNav, type NavSection } from "./GuideNav";
import { PowerCurve } from "./PowerCurve";
import { TreeSection } from "./GuideTree";
import { StageNumbers } from "./StageNumbers";
import {
  AtlasSection,
  Bullets,
  EntityName,
  FaqSection,
  SourcesSection,
  PlaystyleSection,
  Reasons,
  VariantsSection,
} from "./GuideText";
import { gemChanges } from "../guide/gem-changes";
import { loadGuideList, loadGuideView } from "../api/guides";
import { RichTextView, nameOf } from "../guide/RichTextView";
import { BuildFileExportButton } from "./BuildFileExport";
import { GuideFileExportButton, GuideImportButton } from "./GuideFile";
import { CommentsBanner, GuideCommentsProvider, SectionComments } from "./SectionComments";
import { RevisionDiffPanel } from "./RevisionDiffPanel";
import { PageHeader } from "../shell/PageHeader";
import { useGuideId } from "../shell/route";

export function GuidePage() {
  const guideId = useGuideId();
  return guideId === undefined ? <GuideList /> : <GuideDetail guideId={guideId} />;
}

function GuideList() {
  // An import adds a guide, so the list is asked again under a new key.
  const [imports, setImports] = useState(0);
  const list = useLoaded<GuideListView>(loadGuideList, `list-${imports}`);
  return (
    <div className="page">
      <PageHeader
        kicker="Guides"
        title="Saved guides"
        subtitle="Guides Claude finished for you on this computer."
      />
      <GuideImportButton onImported={() => setImports((n) => n + 1)} />
      {list.status === "loading" ? <p>Loading guides …</p> : null}
      {list.status === "error" ? (
        <Callout tone="danger" title="Guides could not be loaded" live>
          {list.message}
        </Callout>
      ) : null}
      {list.status === "ready" && list.value.guides.length === 0 ? (
        <Callout tone="info" title="No guide yet">
          When Claude finishes a guide in a run, it shows up here. A guide file someone gave you can
          be imported with the button above.
        </Callout>
      ) : null}
      {list.status === "ready" ? (
        <ul className="guide-list">
          {list.value.guides.map((item) => (
            <li key={item.guideId}>
              {"error" in item ? (
                <Callout tone="danger" title={`Guide ${item.guideId.slice(0, 8)}`}>
                  {item.error}
                </Callout>
              ) : (
                <a
                  className="guide-list__link"
                  href={`#/guide/${encodeURIComponent(item.guideId)}`}
                >
                  <strong>{item.ascendancyName ?? item.ascendancyId}</strong>{" "}
                  {item.mainSkillName ?? item.mainSkillId}{" "}
                  {item.current ? null : <Badge tone="warning">Older game data</Badge>}{" "}
                  {item.origin === "imported" ? <Badge tone="neutral">Imported file</Badge> : null}
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function GuideDetail({ guideId }: { guideId: string }) {
  // A new revision (comments applied) reads the guide again.
  const [revisionReads, setRevisionReads] = useState(0);
  const loaded = useLoaded<GuideView>(
    (signal) => loadGuideView(guideId, signal),
    `${guideId}-${String(revisionReads)}`,
  );
  const reread = useCallback(() => setRevisionReads((n) => n + 1), []);
  if (loaded.status === "loading") {
    return (
      <div className="page">
        <p>Loading the guide …</p>
      </div>
    );
  }
  if (loaded.status === "error") {
    return (
      <div className="page">
        <Callout tone="danger" title="The guide could not be loaded" live>
          {loaded.message}{" "}
          <Button size="sm" onClick={() => (window.location.hash = "#/guide")}>
            Back to the list
          </Button>
        </Callout>
      </div>
    );
  }
  return (
    <GuideCommentsProvider guideId={guideId} onApplied={reread}>
      <GuideBody view={loaded.value} guideId={guideId} />
    </GuideCommentsProvider>
  );
}

function GuideBody({ view, guideId }: { view: GuideView; guideId: string }) {
  const { guide } = view;
  const { summary, mechanics } = guide;
  const ascendancy = nameOf(view, { kind: "ascendancy", id: summary.ascendancyId });
  const skill = nameOf(view, { kind: "gem", id: summary.mainSkillId });
  const sortedStages = [...guide.progression.stages].sort((a, b) => a.order - b.order);
  const [stageKey, setStageKey] = useState(guide.progression.stages[0]?.key ?? "");
  const nav: NavSection[] = [
    { id: "guide-summary", label: "Overview" },
    { id: "guide-mechanics", label: "How it works" },
    { id: "guide-stages", label: "Leveling to endgame" },
    { id: "guide-gear", label: "Gear" },
    ...(guide.crafting.length > 0 ? [{ id: "guide-crafting", label: "Crafting" }] : []),
    { id: "guide-tree", label: "Passive tree" },
    { id: "guide-playstyle", label: "Playstyle" },
    { id: "guide-atlas", label: "Endgame" },
    ...(guide.variants.length > 0 ? [{ id: "guide-variants", label: "Variants" }] : []),
    ...(guide.faq.length > 0 ? [{ id: "guide-faq", label: "Troubleshooting" }] : []),
    ...(guide.research.length > 0 ? [{ id: "guide-sources", label: "Sources" }] : []),
  ];
  return (
    <div className="page page--guide guide-page">
      <GuideNav sections={nav} />
      <div className="guide-main">
        <StageBar stages={sortedStages} value={stageKey} onChange={setStageKey} />
        <PageHeader
          kicker={`Guide · ${guide.metadata.dataReleaseId} · PoB ${guide.metadata.pobVersion}`}
          title={`${ascendancy ?? summary.ascendancyId}: ${skill ?? summary.mainSkillId}`}
          actions={
            <>
              <BuildFileExportButton guideId={guideId} />
              <GuideFileExportButton guideId={guideId} />
            </>
          }
        />
        <CommentsBanner />
        <RevisionDiffPanel guideId={guideId} view={view} />
        {view.current ? null : (
          <Callout tone="warning" title="Older game data">
            This guide was built with {guide.metadata.dataReleaseId}; the app now runs with{" "}
            {view.catalogReleaseId}. Names are not shown until the guide is revalidated, and its
            numbers keep the release they were calculated with.
          </Callout>
        )}
        {view.unresolved.length > 0 ? (
          <Callout tone="warning" title="Some names and numbers are missing">
            The game data this app runs with does not know these entries, so they are shown as ids:{" "}
            {view.unresolved.join(", ")}
          </Callout>
        ) : null}
        <section id="guide-summary" className="guide-section" tabIndex={-1}>
          <Panel title="Summary" kicker="At a glance">
            {summary.introduction.length > 0 ? (
              <GuideNotes>
                {summary.introduction.map((p, i) => (
                  <p key={i}>
                    <RichTextView text={p} view={view} />
                  </p>
                ))}
              </GuideNotes>
            ) : null}
            <GuideNotes>
              <p>
                <RichTextView text={summary.playstyle} view={view} />
              </p>
              <p>
                <RichTextView text={summary.scalingAxes} view={view} />
              </p>
            </GuideNotes>
            <div className="guide-columns">
              <div>
                <h3>Strengths</h3>
                <ul>
                  {summary.strengths.map((t, i) => (
                    <li key={i}>
                      <RichTextView text={t} view={view} />
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Weaknesses</h3>
                <ul>
                  {summary.weaknesses.map((t, i) => (
                    <li key={i}>
                      <RichTextView text={t} view={view} />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {summary.closing === undefined ? null : (
              <p>
                <strong>In short: </strong>
                <RichTextView text={summary.closing} view={view} />
              </p>
            )}
          </Panel>
          <PowerCurve view={view} />
          <SectionComments sectionKey="S9.summary" label="Overview" />
        </section>
        <section id="guide-mechanics" className="guide-section guide-prose" tabIndex={-1}>
          <Panel title="How it works" kicker="Mechanics" variant="recessed">
            <GuideNotes>
              <p>
                <RichTextView text={mechanics.explanation} view={view} />
              </p>
            </GuideNotes>
            <ul>
              {mechanics.decisions.map((d, i) => (
                <li key={i}>
                  {d.subject === undefined ? null : (
                    <strong>{nameOf(view, d.subject) ?? d.subject.id}: </strong>
                  )}
                  <RichTextView text={d.reason} view={view} />
                </li>
              ))}
            </ul>
            <Reasons
              title="How the parts work together"
              items={mechanics.interactions}
              view={view}
            />
            <Reasons title="Skill setups" items={mechanics.gemSetups} view={view} />
            <SectionComments sectionKey="S5.gems" label="Skill setup" />
            {mechanics.defences.length > 0 ? (
              <>
                <h3>Defences</h3>
                <ul>
                  {mechanics.defences.map((d, i) => (
                    <li key={i}>
                      <RichTextView text={d.explanation} view={view} />
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {mechanics.resources === undefined ? null : (
              <>
                <h3>Resources</h3>
                <p>
                  <RichTextView text={mechanics.resources} view={view} />
                </p>
              </>
            )}
          </Panel>
          <SectionComments sectionKey="S9.mechanics" label="How it works" />
        </section>
        <section id="guide-stages" className="guide-section" tabIndex={-1}>
          <Tabs
            label="Guide stages"
            variant="dial"
            value={stageKey}
            onChange={setStageKey}
            items={sortedStages.map((stage, i) => ({
              id: stage.key,
              label: stage.label,
              hint: `Level ${stage.levelRange[0]}–${stage.levelRange[1]}`,
              content: <StageView stage={stage} previous={sortedStages[i - 1]} view={view} />,
            }))}
          />
          <SectionComments sectionKey="S6.notes" label="Stage notes" />
        </section>
        <section id="guide-gear" className="guide-section" tabIndex={-1}>
          <GearMatrix view={view} />
          <GearSection view={view} />
        </section>
        <section id="guide-crafting" className="guide-section" tabIndex={-1}>
          <CraftingSection view={view} />
        </section>
        <section id="guide-tree" className="guide-section" tabIndex={-1}>
          <TreeSection
            view={view}
            stageIndex={Math.max(
              0,
              sortedStages.findIndex((s) => s.key === stageKey),
            )}
            onStageChange={(i) => {
              const key = sortedStages[i]?.key;
              if (key !== undefined) setStageKey(key);
            }}
          />
        </section>
        <section
          id="guide-playstyle"
          className="guide-section guide-section--flow guide-prose"
          tabIndex={-1}
        >
          <PlaystyleSection view={view} />
          <SectionComments sectionKey="S9.playstyle" label="Playstyle" />
        </section>
        <section
          id="guide-atlas"
          className="guide-section guide-section--flow guide-prose"
          tabIndex={-1}
        >
          <AtlasSection view={view} />
          <SectionComments sectionKey="S9.atlas" label="Endgame" />
        </section>
        <section
          id="guide-variants"
          className="guide-section guide-section--flow guide-prose"
          tabIndex={-1}
        >
          <VariantsSection view={view} />
          <SectionComments sectionKey="S9.variants" label="Variants" />
        </section>
        <section
          id="guide-faq"
          className="guide-section guide-section--flow guide-prose"
          tabIndex={-1}
        >
          <FaqSection view={view} />
          <SectionComments sectionKey="S9.faq" label="Troubleshooting" />
        </section>
        {guide.research.length > 0 ? (
          <section
            id="guide-sources"
            className="guide-section guide-section--flow guide-prose"
            tabIndex={-1}
          >
            <SourcesSection view={view} />
          </section>
        ) : null}
      </div>
    </div>
  );
}

function GemChangeList({
  previous,
  stage,
  view,
}: {
  previous: ProgressionStage | undefined;
  stage: ProgressionStage;
  view: GuideView;
}) {
  const changes = gemChanges(previous, stage);
  if (previous === undefined || changes.length === 0) return null;
  const gem = (id: string) => <EntityName view={view} entity={{ kind: "gem", id }} />;
  const gems = (ids: readonly string[]) =>
    ids.map((id, i) => (
      <span key={`${id}-${i}`}>
        {i > 0 ? ", " : ""}
        {gem(id)}
      </span>
    ));
  return (
    <>
      <h3>Changes since {previous.label}</h3>
      <ul>
        {changes.map((c, i) => (
          <li key={i}>
            {c.kind === "new" ? (
              <>
                New skill {gem(c.gemId)}
                {c.added.length > 0 ? <> with {gems(c.added)}</> : null}
              </>
            ) : null}
            {c.kind === "removed" ? (
              <>
                Drop {gem(c.gemId)}
                {c.dropped.length > 0 ? <> (with {gems(c.dropped)})</> : null}
              </>
            ) : null}
            {c.kind === "level" ? (
              <>
                {gem(c.gemId)}: level {c.from} → {c.to}
              </>
            ) : null}
            {c.kind === "swap" && c.fromGemId !== undefined ? (
              <>
                Swap {gem(c.fromGemId)} for {gem(c.gemId)}
                {c.added.length > 0 ? <>; add {gems(c.added)}</> : null}
                {c.dropped.length > 0 ? <>; drop {gems(c.dropped)}</> : null}
              </>
            ) : null}
            {c.kind === "supports" ? (
              <>
                {gem(c.gemId)}
                {c.added.length > 0 ? <>: add {gems(c.added)}</> : null}
                {c.dropped.length > 0 ? <>; drop {gems(c.dropped)}</> : null}
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function StageView({
  stage,
  previous,
  view,
}: {
  stage: ProgressionStage;
  previous: ProgressionStage | undefined;
  view: GuideView;
}) {
  const { state } = stage;
  return (
    <div className="stage">
      <Panel
        title={stage.label}
        kicker={`${stage.act === undefined ? "" : `Act ${stage.act} · `}Level ${stage.levelRange[0]}–${stage.levelRange[1]}`}
      >
        {stage.guide === undefined ? null : (
          <GuideNotes>
            <p>
              <RichTextView text={stage.guide.intro} view={view} />
            </p>
          </GuideNotes>
        )}
        <h3>What to do</h3>
        <ul>
          {stage.tasks.map((t, i) => (
            <li key={i}>
              <RichTextView text={t} view={view} />
            </li>
          ))}
        </ul>
        {stage.dangers.length > 0 ? (
          <>
            <h3>Dangers</h3>
            <ul>
              {stage.dangers.map((t, i) => (
                <li key={i}>
                  <RichTextView text={t} view={view} />
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Panel>
      <StageNumbers stage={stage} view={view} />
      <Panel title="Skills" kicker="Gems of this stage">
        <ul>
          {state.skills.map((skill) => (
            <li key={skill.key}>
              <strong>
                {nameOf(view, { kind: "gem", id: skill.gem.gemId }) ?? skill.gem.gemId}
              </strong>{" "}
              (level {skill.gem.level})
              {skill.supports.length > 0
                ? `: ${skill.supports
                    .map((s) => nameOf(view, { kind: "gem", id: s.gemId }) ?? s.gemId)
                    .join(", ")}`
                : null}
            </li>
          ))}
        </ul>
        <GemChangeList previous={previous} stage={stage} view={view} />
        {stage.guide === undefined || stage.guide.gemChanges.length === 0 ? null : (
          <>
            <h3>Why these skill changes</h3>
            <ul>
              {stage.guide.gemChanges.map((c, i) => (
                <li key={i}>
                  <EntityName view={view} entity={c.gem} />
                  {c.replaces === undefined ? null : (
                    <>
                      {" "}
                      (replaces <EntityName view={view} entity={c.replaces} />)
                    </>
                  )}
                  : <RichTextView text={c.reason} view={view} />
                </li>
              ))}
            </ul>
          </>
        )}
        <p>
          {state.tree.allocated.length} passive points allocated
          {state.tree.ascendancy.length > 0
            ? `, ${state.tree.ascendancy.length} ascendancy points`
            : ""}
          .
        </p>
      </Panel>
      {stage.guide === undefined ? null : (
        <Panel title="Passive tree" kicker="Why these nodes">
          <Reasons title="Choices" items={stage.guide.treeNotes} view={view} />
          <Bullets title="Gear at this point" items={stage.guide.gearNotes} view={view} />
          <Bullets title="Before you move on" items={stage.guide.checklist} view={view} />
          {stage.guide.nextStep === undefined ? null : (
            <p>
              <strong>Next: </strong>
              <RichTextView text={stage.guide.nextStep} view={view} />
            </p>
          )}
        </Panel>
      )}
      {stage.rationale.length > 0 ? (
        <Panel title="Why" kicker="Decisions" variant="recessed">
          <ul>
            {stage.rationale.map((r, i) => (
              <li key={i}>
                {r.subject === undefined ? null : (
                  <strong>{nameOf(view, r.subject) ?? r.subject.id}: </strong>
                )}
                <RichTextView text={r.reason} view={view} />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <SectionComments sectionKey={stageSectionKey(stage.key)} label={stage.label} />
    </div>
  );
}
