/*
 * Line-art silhouettes for the gear slots, drawn for this app. They stand in for the item image
 * until the item's own art is available; no game graphics (Grinding Gear Games owns those, and
 * this project does not copy them). Colour comes from `currentColor`, the fill from the rarity.
 */

const PATHS: Readonly<Record<string, readonly string[]>> = {
  weapon: [
    "M37 7 L41 11 L21 31 L17 27 Z",
    "M10 26 L22 38",
    "M18 30 L9 39",
    "M7 41 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0",
  ],
  shield: [
    "M24 6 L38 11 V24 C38 33 31 39 24 43 C17 39 10 33 10 24 V11 Z",
    "M24 12 V37",
    "M14 21 H34",
  ],
  helmet: [
    "M9 33 V23 C9 14 15 7 24 7 C33 7 39 14 39 23 V33 H33 V28 H15 V33 Z",
    "M15 28 V22 H33 V28",
    "M24 7 V22",
  ],
  amulet: [
    "M9 7 C9 25 39 25 39 7",
    "M24 24 L31 33 L24 44 L17 33 Z",
    "M24 29 L27 33 L24 38 L21 33 Z",
  ],
  body: [
    "M16 7 L7 14 L10 23 L15 21 V41 H33 V21 L38 23 L41 14 L32 7 C30 12 18 12 16 7 Z",
    "M24 12 V41",
    "M15 30 H33",
  ],
  ring: ["M14 29 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0", "M24 9 L29 15 L24 21 L19 15 Z"],
  gloves: [
    "M14 41 V27 L11 17 H15 V9 H19 V7 H23 V9 H27 V12 H31 L34 25 V41 Z",
    "M15 33 H33",
    "M19 9 V19",
    "M23 9 V19",
  ],
  belt: ["M5 19 H43 V30 H5 Z", "M18 15 H30 V34 H18 Z", "M22 21 H26 V28 H22 Z"],
  boots: ["M16 7 H28 V25 L41 30 V41 H13 V31 Z", "M16 14 H28", "M13 36 H41"],
  charm: ["M24 3 V9", "M24 11 L36 18 V32 L24 39 L12 32 V18 Z", "M24 18 L29 25 L24 32 L19 25 Z"],
  flask: [
    "M20 5 H28 V14 L37 36 C38 40 36 43 32 43 H16 C12 43 10 40 11 36 L20 14 Z",
    "M18 5 H30",
    "M14 31 H34",
  ],
  generic: ["M24 6 L40 24 L24 42 L8 24 Z", "M24 15 L32 24 L24 33 L16 24 Z"],
};

/** The icon ids the layout config may name. */
export const SLOT_ICON_IDS: readonly string[] = Object.keys(PATHS);

export function SlotIcon({ icon, className }: { icon: string; className?: string }) {
  const paths = PATHS[icon] ?? PATHS["generic"] ?? [];
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
      fillOpacity="0.14"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
