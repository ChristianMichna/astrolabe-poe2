import type { EntityRef } from "@astrolabe/contracts/common";
import type { GuideView } from "@astrolabe/contracts/guide";
import { Badge, Panel } from "@astrolabe/ui";
import { RichTextView, nameOf } from "../guide/RichTextView";

/*
 * The written parts of a guide after its numbers: how to play, the atlas strategy, variants and
 * the troubleshooting questions. Names come from the server's catalog; an entity it does not know
 * is shown as its id and marked as unresolved.
 */

const VARIANT_LABEL = {
  alternative: "Alternative",
  hardcore: "Hardcore",
  ssf: "Solo self-found",
} as const;

export function EntityName({ view, entity }: { view: GuideView; entity: EntityRef }) {
  const name = nameOf(view, entity);
  return name === undefined ? (
    <span className="guide-unresolved" title="Not in the catalog of this release">
      {entity.id}
    </span>
  ) : (
    <strong>{name}</strong>
  );
}

function Prose({
  title,
  view,
  text,
}: {
  title: string;
  view: GuideView;
  text: Parameters<typeof RichTextView>[0]["text"];
}) {
  return (
    <>
      <h3>{title}</h3>
      <p>
        <RichTextView text={text} view={view} />
      </p>
    </>
  );
}

type Text = Parameters<typeof RichTextView>[0]["text"];

/** A bulleted list of rich texts under an optional heading; nothing when the list is empty. */
export function Bullets({
  title,
  items,
  view,
}: {
  title?: string;
  items: readonly Text[];
  view: GuideView;
}) {
  if (items.length === 0) return null;
  return (
    <>
      {title === undefined ? null : <h3>{title}</h3>}
      <ul>
        {items.map((t, i) => (
          <li key={i}>
            <RichTextView text={t} view={view} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** Titled blocks of advice (rotation steps, endgame phases), numbered in reading order. */
export function Blocks({
  title,
  blocks,
  view,
}: {
  title: string;
  blocks: readonly { title: string; detail: Text }[];
  view: GuideView;
}) {
  if (blocks.length === 0) return null;
  return (
    <>
      <h3>{title}</h3>
      <ol className="guide-blocks">
        {blocks.map((b, i) => (
          <li key={i}>
            <strong>{b.title}</strong>
            <p>
              <RichTextView text={b.detail} view={view} />
            </p>
          </li>
        ))}
      </ol>
    </>
  );
}

/** Decisions with their reasons, each led by the entity it is about. */
export function Reasons({
  title,
  items,
  view,
}: {
  title: string;
  items: readonly { subject?: EntityRef | undefined; reason: Text }[];
  view: GuideView;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul>
        {items.map((d, i) => (
          <li key={i}>
            {d.subject === undefined ? null : (
              <>
                <EntityName view={view} entity={d.subject} />:{" "}
              </>
            )}
            <RichTextView text={d.reason} view={view} />
          </li>
        ))}
      </ul>
    </>
  );
}

export function PlaystyleSection({ view }: { view: GuideView }) {
  const { playstyle } = view.guide;
  return (
    <Panel title="Playstyle" kicker="How to play it">
      <Prose title="Rotation" view={view} text={playstyle.rotation} />
      <Blocks title="Step by step" blocks={playstyle.rotationSteps} view={view} />
      {playstyle.keybinds === undefined ? null : (
        <Prose title="Keybinds" view={view} text={playstyle.keybinds} />
      )}
      <Prose title="Mapping" view={view} text={playstyle.mapping} />
      <Prose title="Bossing" view={view} text={playstyle.bossing} />
      <Prose title="Positioning" view={view} text={playstyle.positioning} />
      <Bullets title="Tips" items={playstyle.tips} view={view} />
      <Bullets title="Common mistakes" items={playstyle.commonMistakes} view={view} />
      {playstyle.bossMechanics.length > 0 ? (
        <>
          <h3>Boss mechanics</h3>
          <ul>
            {playstyle.bossMechanics.map((m, i) => (
              <li key={i}>
                {m.subject === undefined ? null : (
                  <>
                    <EntityName view={view} entity={m.subject} />:{" "}
                  </>
                )}
                <RichTextView text={m.advice} view={view} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Panel>
  );
}

export function AtlasSection({ view }: { view: GuideView }) {
  const { atlas } = view.guide;
  return (
    <Panel title="Atlas" kicker="Endgame strategy">
      <p>
        <RichTextView text={atlas.strategy} view={view} />
      </p>
      <Blocks title="Endgame phases" blocks={atlas.phases} view={view} />
      <Bullets title="Waystone tips" items={atlas.waystoneTips} view={view} />
      {atlas.avoidMods.length > 0 ? (
        <>
          <h3>Map modifiers to avoid</h3>
          <ul>
            {atlas.avoidMods.map((m, i) => (
              <li key={`${m.modId}-${i}`}>
                <EntityName view={view} entity={{ kind: "mod", id: m.modId }} />:{" "}
                <RichTextView text={m.reason} view={view} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Panel>
  );
}

export function VariantsSection({ view }: { view: GuideView }) {
  const { variants } = view.guide;
  if (variants.length === 0) return null;
  return (
    <Panel title="Variants" kicker="Other ways to play it">
      <ul className="guide-variants">
        {variants.map((v, i) => (
          <li key={i}>
            <Badge>{VARIANT_LABEL[v.kind]}</Badge>{" "}
            {v.replaces === undefined ? null : (
              <>
                Replace <EntityName view={view} entity={v.replaces} />
                {v.with.length > 0 ? " with " : ""}
              </>
            )}
            {v.with.map((w, j) => (
              <span key={`${w.kind}:${w.id}:${j}`}>
                {j > 0 ? ", " : ""}
                <EntityName view={view} entity={w} />
              </span>
            ))}
            <p>
              <RichTextView text={v.explanation} view={view} />
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function FaqSection({ view }: { view: GuideView }) {
  const { faq } = view.guide;
  if (faq.length === 0) return null;
  return (
    <Panel title="Troubleshooting" kicker="Questions">
      {faq.map((entry, i) => (
        <details key={i} className="guide-faq">
          <summary>
            <RichTextView text={entry.question} view={view} />
          </summary>
          <p>
            <RichTextView text={entry.answer} view={view} />
          </p>
          {entry.checklist.length > 0 ? (
            <ul>
              {entry.checklist.map((c, j) => (
                <li key={j}>
                  <RichTextView text={c} view={view} />
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ))}
    </Panel>
  );
}

/** Host of a source link; undefined when the browser cannot parse it, so one odd link never breaks the page. */
function hostOfLink(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** The pages the research behind the guide came from; the numbers match the [n] in the text. */
export function SourcesSection({ view }: { view: GuideView }) {
  const { research } = view.guide;
  if (research.length === 0) return null;
  return (
    <Panel title="Sources" kicker="Research">
      <ol className="guide-sources">
        {research.map((f) => (
          <li key={f.id} id={`source-${f.id}`}>
            <a href={f.source.url} target="_blank" rel="noreferrer">
              {f.source.title}
            </a>{" "}
            <span className="guide-source-host">({hostOfLink(f.source.url) ?? f.source.url})</span>
            <p>
              <RichTextView text={f.claim} view={view} />
            </p>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
