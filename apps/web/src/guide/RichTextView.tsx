import type { RichText } from "@astrolabe/contracts/build";
import type { GuideView } from "@astrolabe/contracts/guide";

const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const ONE_DIGIT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const TWO_DIGITS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Digits follow the size of the value: 1,150 and 61.4 and 0.35, not 1,149.87. */
function formatNumber(value: number): string {
  const size = Math.abs(value);
  return (size >= 100 ? WHOLE : size >= 10 ? ONE_DIGIT : TWO_DIGITS).format(value);
}

/** Key of an entity in `GuideView.names`. */
export const nameKey = (ref: { kind: string; id: string }): string => `${ref.kind}:${ref.id}`;

/** Name of an entity, or undefined when the server could not resolve it. */
export function nameOf(view: GuideView, ref: { kind: string; id: string }): string | undefined {
  return view.names[nameKey(ref)];
}

/**
 * Guide prose: text as written, entities by their catalog name and numbers from the stored
 * calculation they reference. What cannot be resolved is shown as such, never as a made-up value.
 */
export function RichTextView({ text, view }: { text: RichText; view: GuideView }) {
  return (
    <>
      {text.map((segment, i) => {
        if (segment.type === "text") return <span key={i}>{segment.text}</span>;
        if (segment.type === "entity") {
          const name = nameOf(view, segment.ref);
          return name === undefined ? (
            <span key={i} className="guide-unresolved" title="Not in the catalog of this release">
              {segment.ref.id}
            </span>
          ) : (
            <strong key={i}>{name}</strong>
          );
        }
        if (segment.type === "source") {
          const at = view.guide.research.findIndex((f) => f.id === segment.id);
          const finding = view.guide.research[at];
          return finding === undefined ? (
            <span
              key={i}
              className="guide-unresolved"
              title="This source is not listed in the guide"
            >
              [{segment.id}]
            </span>
          ) : (
            <sup key={i} className="guide-cite">
              <a
                href={finding.source.url}
                target="_blank"
                rel="noreferrer"
                title={finding.source.title}
              >
                [{at + 1}]
              </a>
            </sup>
          );
        }
        const result = view.results[segment.ref.calcId];
        const value = result?.stats[segment.ref.stat];
        if (result === undefined || value === undefined) {
          return (
            <span
              key={i}
              className="guide-unresolved"
              title="The stored calculation is not available"
            >
              {segment.ref.stat}
            </span>
          );
        }
        return (
          <span
            key={i}
            className="ef-numeric"
            title={`Path of Building ${result.pobVersion}, profile ${result.calcProfile}`}
          >
            {formatNumber(value)}
          </span>
        );
      })}
    </>
  );
}
