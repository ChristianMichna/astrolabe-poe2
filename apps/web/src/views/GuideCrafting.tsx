import type { CraftOnFail, CraftStep, CraftingPlan } from "@astrolabe/contracts/build";
import type { GuideView } from "@astrolabe/contracts/guide";
import { Callout, Panel, StatGrid, StatValue } from "@astrolabe/ui";
import type { ValueState } from "@astrolabe/ui";
import { measuredState } from "../guide/measured";
import { priceLabel, priceState } from "../guide/price";
import { RichTextView, nameOf } from "../guide/RichTextView";
import { Bullets } from "./GuideText";

/*
 * The crafting plans of a guide as a flow: the base item, then every step with its goal, chance,
 * expected attempts and cost, and what happens when a step fails. Chances, attempts and prices
 * keep their source; a value the engine does not have is shown as uncalibrated, never as 0.
 */

function failText(onFail: CraftOnFail, view: GuideView): React.ReactNode {
  switch (onFail.action) {
    case "repeat":
      return "On failure: repeat the step";
    case "restart":
      return "On failure: start again from the base item";
    case "accept":
      return "On failure: keep the item as it is";
    case "goto":
      return `On failure: go to step ${onFail.order + 1}`;
    case "abort":
      return (
        <>
          On failure: stop. <RichTextView text={onFail.reason} view={view} />
        </>
      );
  }
}

/*
 * A number the engine or the market does not have is not repeated on every card: the cell is left
 * out and the plan states once, below its title, which numbers are missing and why. Nothing is
 * estimated in its place.
 */
type CellProps = { label: string; format: "decimal1"; state: ValueState; emphasis?: boolean };

function Cell(props: CellProps) {
  if (props.state.status === "uncalibrated") return null;
  return <StatValue {...props} />;
}

function missingReasons(plan: CraftingPlan): string[] {
  const states: ValueState[] = [
    priceState(plan.start.cost),
    priceState(plan.expectedTotal),
    ...plan.steps.flatMap((s) => [
      measuredState(s.successChance, 100),
      measuredState(s.expectedAttempts),
      priceState(s.expectedCost),
    ]),
  ];
  return [...new Set(states.flatMap((st) => (st.status === "uncalibrated" ? [st.reason] : [])))];
}

function StepNode({ step, view }: { step: CraftStep; view: GuideView }) {
  const actions = step.actionIds.map((id) => nameOf(view, { kind: "craftingAction", id }) ?? id);
  return (
    <li className="craft-step">
      <div className="craft-step__card">
        <p className="craft-step__order">Step {step.order + 1}</p>
        <h3>{actions.join(" + ")}</h3>
        <p>
          <RichTextView text={step.goal} view={view} />
        </p>
        <StatGrid>
          <Cell
            label="Chance (%)"
            format="decimal1"
            state={measuredState(step.successChance, 100)}
          />
          <Cell
            label="Expected attempts"
            format="decimal1"
            state={measuredState(step.expectedAttempts)}
          />
          <Cell
            label={priceLabel(step.expectedCost, view)}
            format="decimal1"
            state={priceState(step.expectedCost)}
          />
        </StatGrid>
        <p className="craft-step__fail">{failText(step.onFail, view)}</p>
      </div>
    </li>
  );
}

function Plan({ plan, view }: { plan: CraftingPlan; view: GuideView }) {
  const base = nameOf(view, { kind: "baseItem", id: plan.start.baseItemId });
  return (
    <Panel
      title={plan.slot}
      kicker={plan.tier === undefined ? "Crafting plan" : `Crafting plan · ${plan.tier}`}
    >
      {missingReasons(plan).length === 0 ? null : (
        <Callout tone="info" title="Some numbers are not available">
          <p>These are left out rather than estimated:</p>
          <ul>
            {missingReasons(plan).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Callout>
      )}
      {plan.guide === undefined ? null : (
        <>
          <p>
            <RichTextView text={plan.guide.overview} view={view} />
          </p>
          <Bullets title="Tips" items={plan.guide.tips} view={view} />
          <Bullets title="Pitfalls" items={plan.guide.pitfalls} view={view} />
        </>
      )}
      <ol className="craft-flow">
        <li className="craft-step craft-step--start">
          <div className="craft-step__card">
            <p className="craft-step__order">Start</p>
            <h3>{base ?? plan.start.baseItemId}</h3>
            <p>Item level {plan.start.itemLevel}</p>
            <StatGrid>
              <Cell
                label={priceLabel(plan.start.cost, view)}
                format="decimal1"
                state={priceState(plan.start.cost)}
              />
            </StatGrid>
          </div>
        </li>
        {[...plan.steps]
          .sort((a, b) => a.order - b.order)
          .map((step) => (
            <StepNode key={`${step.order}-${step.actionIds.join("+")}`} step={step} view={view} />
          ))}
      </ol>
      <StatGrid>
        <Cell
          label={`Expected total · ${priceLabel(plan.expectedTotal, view)}`}
          emphasis
          format="decimal1"
          state={priceState(plan.expectedTotal)}
        />
      </StatGrid>
      {plan.fallback === undefined ? null : (
        <p>
          <strong>If it does not work out: </strong>
          <RichTextView text={plan.fallback} view={view} />
        </p>
      )}
    </Panel>
  );
}

export function CraftingSection({ view }: { view: GuideView }) {
  if (view.guide.crafting.length === 0) return null;
  return (
    <>
      {view.guide.crafting.map((plan) => (
        <Plan key={plan.key} plan={plan} view={view} />
      ))}
    </>
  );
}
