import { useState } from "react";
import type { CSSProperties } from "react";
import { ItemTooltip } from "@astrolabe/ui";
import type { GuideGearEntry, GuideView } from "@astrolabe/contracts/guide";
import { GEAR_LAYOUT } from "../guide/gear-layout";
import { rarityOf, toItemView } from "../guide/gear-item";
import { SlotIcon } from "./SlotIcon";

/*
 * The gear as it sits on a character: one framed cell per slot in the arrangement of
 * config/web/gear-layout.json. Hovering or focusing a cell shows the full item card; selecting it
 * opens the slot's notes below. Slots the layout does not know (charms, flasks) go to a strip
 * underneath. The frames and slot icons are our own; no game graphics. The hover card never takes
 * the pointer (CSS), so moving on to the next slot works at once.
 */

interface Props {
  readonly entries: readonly GuideGearEntry[];
  readonly view: GuideView;
  readonly selected: string | null;
  readonly onSelect: (slot: string) => void;
}

function cellStyle(slot: string): CSSProperties | undefined {
  const area = GEAR_LAYOUT.slots[slot];
  if (area === undefined) return undefined;
  return {
    gridColumn: `${area.col} / span ${area.colSpan}`,
    gridRow: `${area.row} / span ${area.rowSpan}`,
  };
}

function Cell({
  entry,
  view,
  selected,
  onSelect,
}: {
  entry: GuideGearEntry;
  view: GuideView;
  selected: boolean;
  onSelect: (slot: string) => void;
}) {
  const area = GEAR_LAYOUT.slots[entry.slot];
  const rarity = entry.target === null ? "empty" : (rarityOf(entry.target) ?? "normal");
  const icon = GEAR_LAYOUT.icons[entry.slot] ?? "generic";
  const [dismissed, setDismissed] = useState(false);
  const [artBroken, setArtBroken] = useState(false);
  const art = entry.target?.icon;
  const tipId = `gear-tip-${entry.budgetTier}-${entry.slot.replace(/\s+/g, "-")}`;
  const vertical = area === undefined || area.row > 3 ? "up" : "down";
  const side =
    area === undefined ? "center" : area.col > GEAR_LAYOUT.columns / 2 ? "left" : "right";
  const plan = view.guide.gear.tiers
    .find((t) => t.budgetTier === entry.budgetTier)
    ?.slots.find((s) => s.slot === entry.slot);
  return (
    <div
      className="gear-cell"
      style={cellStyle(entry.slot)}
      data-rarity={rarity}
      data-size={
        area === undefined || (area.colSpan === 1 && area.rowSpan === 1) ? "small" : "large"
      }
      {...(dismissed ? { "data-dismissed": "" } : {})}
      onMouseLeave={() => setDismissed(false)}
      onBlur={() => setDismissed(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setDismissed(true);
      }}
    >
      <button
        type="button"
        className="gear-cell__frame"
        aria-pressed={selected}
        {...(entry.target === null ? {} : { "aria-describedby": tipId })}
        onClick={() => onSelect(entry.slot)}
      >
        {art !== undefined && !artBroken ? (
          <img
            className="gear-cell__art"
            src={`/api/release-assets/${art}`}
            alt=""
            loading="lazy"
            onError={() => setArtBroken(true)}
          />
        ) : (
          <SlotIcon icon={icon} className="gear-cell__icon" />
        )}
        <span className="gear-cell__slot">{entry.slot}</span>
        {entry.target === null ? (
          <span className="gear-cell__name">Not in game data</span>
        ) : (
          <>
            <span className="gear-cell__name">{entry.target.name ?? entry.target.baseName}</span>
            {entry.target.name === undefined ? null : (
              <span className="gear-cell__base">{entry.target.baseName}</span>
            )}
          </>
        )}
      </button>
      {entry.target !== null ? (
        <div
          id={tipId}
          className={`gear-cell__hover gear-cell__hover--${side} gear-cell__hover--${vertical}`}
          role="tooltip"
        >
          <ItemTooltip
            item={toItemView(
              entry.target,
              `${entry.budgetTier}-${entry.slot}-hover`,
              view.catalogReleaseId,
              plan?.acquisition,
            )}
          />
        </div>
      ) : null}
    </div>
  );
}

export function GearPaperDoll({ entries, view, selected, onSelect }: Props) {
  const placed = entries.filter((e) => GEAR_LAYOUT.slots[e.slot] !== undefined);
  const others = entries.filter((e) => GEAR_LAYOUT.slots[e.slot] === undefined);
  const rows = Math.max(
    1,
    ...placed.map(
      (e) => (GEAR_LAYOUT.slots[e.slot]?.row ?? 1) + (GEAR_LAYOUT.slots[e.slot]?.rowSpan ?? 1) - 1,
    ),
  );
  return (
    <div className="gear-doll">
      <div
        className="gear-doll__body"
        style={
          {
            "--gear-cols": GEAR_LAYOUT.columns,
            gridTemplateColumns: `repeat(${GEAR_LAYOUT.columns}, var(--gear-cell))`,
            gridTemplateRows: `repeat(${rows}, var(--gear-cell))`,
          } as CSSProperties
        }
      >
        {placed.map((e) => (
          <Cell
            key={e.slot}
            entry={e}
            view={view}
            selected={selected === e.slot}
            onSelect={onSelect}
          />
        ))}
      </div>
      {others.length > 0 ? (
        <div className="gear-doll__extras">
          {others.map((e) => (
            <Cell
              key={e.slot}
              entry={e}
              view={view}
              selected={selected === e.slot}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
      {entries.some((e) => e.target?.icon !== undefined) ? (
        <p className="gear-doll__credit">Item images: Graphics © Grinding Gear Games</p>
      ) : null}
    </div>
  );
}
