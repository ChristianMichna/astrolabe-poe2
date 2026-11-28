import { useState } from "react";
import { GearPaperDoll } from "./GearPaperDoll";
import { rarityOf, toItemView } from "../guide/gear-item";
import { ItemTooltip, Panel, Tabs } from "@astrolabe/ui";
import { Bullets, EntityName } from "./GuideText";
import { RichTextView } from "../guide/RichTextView";
import type { GuideGearEntry, GuideItemCard, GuideView } from "@astrolabe/contracts/guide";

/*
 * The gear plan of a guide: one tab per budget tier, one card per slot. Names and modifier texts
 * come from the server's catalog (`GuideView.gear`); an item the catalog does not know is shown
 * as unavailable, never as its id dressed up as a name.
 */

function RarityNote({ card }: { card: GuideItemCard }) {
  if (rarityOf(card) !== null) return null;
  return (
    <p role="status">
      The game data this app runs with does not know the rarity
      {card.rarityId === undefined ? "" : ` (${card.rarityId})`}; the card is shown plain.
    </p>
  );
}

function Slot({ entry, view }: { entry: GuideGearEntry; view: GuideView }) {
  const plan = view.guide.gear.tiers
    .find((t) => t.budgetTier === entry.budgetTier)
    ?.slots.find((s) => s.slot === entry.slot);
  const dataRelease = view.catalogReleaseId;
  return (
    <section className="gear-slot" aria-label={entry.slot}>
      <h3>{entry.slot}</h3>
      {entry.target === null ? (
        <p role="status">This item is not in the game data this app runs with.</p>
      ) : (
        <>
          <ItemTooltip
            item={toItemView(entry.target, `${entry.slot}-target`, dataRelease, plan?.acquisition)}
          />
          <RarityNote card={entry.target} />
        </>
      )}
      {plan?.guide === undefined ? null : (
        <div className="gear-slot__notes">
          <p>
            <RichTextView text={plan.guide.why} view={view} />
          </p>
          {plan.guide.statPriorities.length > 0 ? (
            <>
              <h4>What to look for, in order</h4>
              <ol>
                {plan.guide.statPriorities.map((s, i) => (
                  <li key={i}>
                    <EntityName view={view} entity={{ kind: "mod", id: s.modId }} />:{" "}
                    <RichTextView text={s.reason} view={view} />
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          <p>
            <strong>Where to get it: </strong>
            <RichTextView text={plan.guide.whereToGet} view={view} />
          </p>
          <Bullets title="Alternatives" items={plan.guide.alternativesNotes} view={view} />
          {plan.guide.upgradeAdvice === undefined ? null : (
            <p>
              <strong>Upgrading: </strong>
              <RichTextView text={plan.guide.upgradeAdvice} view={view} />
            </p>
          )}
        </div>
      )}
      {entry.minimum === undefined || entry.minimum === null ? null : (
        <details>
          <summary>Minimum to get started</summary>
          <ItemTooltip item={toItemView(entry.minimum, `${entry.slot}-minimum`, dataRelease)} />
          <RarityNote card={entry.minimum} />
        </details>
      )}
      {entry.alternatives.length > 0 ? (
        <details>
          <summary>{entry.alternatives.length} alternative(s)</summary>
          {entry.alternatives.map((alt, i) =>
            alt === null ? (
              <p key={i} role="status">
                This item is not in the game data this app runs with.
              </p>
            ) : (
              <div key={i}>
                <ItemTooltip item={toItemView(alt, `${entry.slot}-alt-${i}`, dataRelease)} />
                <RarityNote card={alt} />
              </div>
            ),
          )}
        </details>
      ) : null}
    </section>
  );
}

export function GearSection({ view }: { view: GuideView }) {
  const tiers = [...new Set(view.gear.map((g) => g.budgetTier))];
  const [tier, setTier] = useState(tiers[0] ?? "");
  if (tiers.length === 0) return null;
  if (!view.current) {
    return (
      <Panel title="Gear" kicker="By budget">
        <p role="status">
          Item names and modifier texts come from the current game data. Revalidate this guide to
          see its gear.
        </p>
      </Panel>
    );
  }
  return (
    <Panel title="Gear" kicker="By budget">
      <Tabs
        label="Budget tier"
        value={tier}
        onChange={setTier}
        items={tiers.map((id) => ({
          id,
          label: id,
          content: (
            <>
              {view.guide.gear.tiers.find((t) => t.budgetTier === id)?.description ===
              undefined ? null : (
                <p>
                  <RichTextView
                    text={view.guide.gear.tiers.find((t) => t.budgetTier === id)?.description ?? []}
                    view={view}
                  />
                </p>
              )}
              <TierGear entries={view.gear.filter((g) => g.budgetTier === id)} view={view} />
            </>
          ),
        }))}
      />
    </Panel>
  );
}

function TierGear({ entries, view }: { entries: readonly GuideGearEntry[]; view: GuideView }) {
  const [picked, setPicked] = useState<string | null>(null);
  const current = entries.find((e) => e.slot === picked) ?? entries[0];
  return (
    <>
      <GearPaperDoll
        entries={entries}
        view={view}
        selected={current?.slot ?? null}
        onSelect={setPicked}
      />
      {current === undefined ? null : <Slot key={current.slot} entry={current} view={view} />}
    </>
  );
}
