import type { ProgressionStage } from "@astrolabe/contracts/build";

/*
 * The stage picker of the guide page: always in reach while reading, so the reader says where they
 * are in the game and every part that depends on the stage (the stage guide, the passive tree)
 * shows that stage. It only sets the choice; the sections own what they show for it.
 */

export function StageBar({
  stages,
  value,
  onChange,
}: {
  stages: readonly ProgressionStage[];
  value: string;
  onChange: (key: string) => void;
}) {
  if (stages.length < 2) return null;
  return (
    <nav className="stage-bar" aria-label="Stage of the game">
      <span className="stage-bar__label">I am at</span>
      <ol className="stage-bar__list">
        {stages.map((stage) => (
          <li key={stage.key}>
            <button
              type="button"
              className="stage-bar__stage"
              aria-pressed={stage.key === value}
              onClick={() => onChange(stage.key)}
            >
              <span className="stage-bar__name">{stage.label}</span>
              <span className="stage-bar__levels">
                Lv {stage.levelRange[0]}–{stage.levelRange[1]}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
