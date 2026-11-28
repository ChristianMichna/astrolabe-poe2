import type { GuideView } from "@astrolabe/contracts/guide";
import { Badge, Panel } from "@astrolabe/ui";

/*
 * The whole gear plan on one screen: a row per slot, a column per budget tier, each cell saying how
 * the slot is obtained. It shows where the budget goes and which slots are the core ones before the
 * reader opens the item cards.
 */

const PRIORITY_TONE = { core: "accent", important: "info", nice: "neutral" } as const;

export function GearMatrix({ view }: { view: GuideView }) {
  const tiers = view.guide.gear.tiers;
  const slots = [...new Set(tiers.flatMap((t) => t.slots.map((s) => s.slot)))];
  if (slots.length === 0) return null;
  return (
    <Panel title="Gear at a glance" kicker="Slot by budget tier">
      <div className="gear-matrix" role="table" aria-label="Gear plan overview">
        <div role="row" className="gear-matrix__row gear-matrix__row--head">
          <span role="columnheader">Slot</span>
          {tiers.map((t) => (
            <span role="columnheader" key={t.budgetTier}>
              {t.budgetTier}
            </span>
          ))}
        </div>
        {slots.map((slot) => (
          <div role="row" className="gear-matrix__row" key={slot}>
            <span role="rowheader">{slot}</span>
            {tiers.map((t) => {
              const s = t.slots.find((x) => x.slot === slot);
              return (
                <span role="cell" key={t.budgetTier}>
                  {s === undefined ? (
                    <span className="gear-matrix__none" aria-label="Not used in this tier">
                      –
                    </span>
                  ) : (
                    <>
                      <Badge tone={PRIORITY_TONE[s.priority]}>{s.priority}</Badge>{" "}
                      <span className="gear-matrix__how">{s.acquisition}</span>
                    </>
                  )}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </Panel>
  );
}
