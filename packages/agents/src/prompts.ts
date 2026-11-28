/*
 * Prompt texts of the stages. Short on purpose: each task has one response
 * schema and tools to look things up; nothing here states game facts.
 * Bump PROMPT_VERSION in config/agents/stages.json when a text changes.
 */

export const NO_MEMORY_RULES =
  "Use only ids you found with catalog_search or catalog_get in this run's data release; never ids or game facts from memory. Text fields are rich text segments: never type numbers, reference calculation results instead or rephrase without the number.";

export const S0_SKILL = [
  "The player described a skill idea but has not picked the main skill. Choose the one active skill gem that best matches the idea.",
  "Search the catalog (catalog_search with kind gem), exclude support gems, and explain the choice in the rationale.",
  NO_MEMORY_RULES,
].join(" ");

export const S1_PROFILE = [
  "Extend the mechanics profile of the main skill with what the catalog shows: stats that scale it, support gems that fit it, unique items and passive nodes that interact with it, and ascendancies that could carry it.",
  "Look candidates up with catalog_search (use tags of the skill) and catalog_get; keep each list to the most relevant entries and explain notable choices in notes.",
  NO_MEMORY_RULES,
].join(" ");

export const S2_CANDIDATE = (index: number, total: number): string =>
  [
    `Propose build archetype ${index} of ${total} for the player's skill idea and the mechanics profile.`,
    "It must differ clearly from the previous candidates (other class or other ascendancy) and respect the player's preferences and exclusions.",
    NO_MEMORY_RULES,
  ].join(" ");

export const S5_GEMS = (mainSkillPreset: boolean): string =>
  [
    "Choose the skill gem setup for the chosen archetype: exactly one setup with role main plus any secondary setups, each with supports.",
    mainSkillPreset
      ? "The main setup must use the player's main skill."
      : "Pick the main skill that best fits the player's idea.",
    "Use calc_evaluate (always with the runId) to compare setups before you submit; explain each choice in rationale without typing numbers.",
    NO_MEMORY_RULES,
  ].join(" ");

export const S6_NOTES = [
  "For each progression stage, write what the player does in it (tasks), what can go wrong (dangers) and why the stage looks as it does (rationale).",
  "Use exactly the stage keys given in the context, each once. The passive allocations and their measurements are fixed and come from Path of Building; you only describe them.",
  NO_MEMORY_RULES,
].join(" ");

export const S7_GEAR = [
  "Choose the target item for each gear slot of this budget tier, as an item spec: a unique, or a crafted rare with a base and wanted mods, plus how it is acquired.",
  "Use only the slots given in the context, each at most once, and fill every required slot. Respect solo self-found mode: no trade then. The context lists the earlier tiers' choices; keep them and upgrade from there. Cheaper tiers use items the player can realistically get with that budget; higher tiers upgrade the slots that gain the most.",
  "Use calc_evaluate (always with the runId) to compare options; explain each choice in rationale without typing numbers. Prices are not known to you and are measured afterwards.",
  "The build's gems and equipment have attribute requirements that the passive tree alone does not meet. Check the requirement stats with calc_evaluate and choose mods that grant the missing attributes (search the catalog for them), also in the earliest tiers: a gap that is left makes a gate fail and sends this step back to you.",
  NO_MEMORY_RULES,
].join(" ");

export const S8_CRAFT = [
  "Plan how to craft the target rare item of this slot: the start item (item level, rarity, mods it already has) and the strategy as ordered steps.",
  "Each step lists crafting action ids from the catalog, a plain-text goal, an optional check (`until`) and what happens when the check fails (repeat, restart, accept, abort, or goto another step).",
  "The goal of the whole craft is fixed: the mods the target item requires. Use craft_simulate (always with the runId) to try strategies before you submit; explain the choices in rationale without typing numbers.",
  NO_MEMORY_RULES,
].join(" ");

export const S9_SECTION = [
  "Write one section of the player's build guide from the plans already made. The guide is read by a player who wants to build and play this character.",
  "The context holds the request, the chosen archetype, the validated target, progression, gear and crafting plans, and the sections written so far. Describe and justify them; never change them. Be concrete about what to do, in which order and why.",
  "Reference measured values with calc segments using the calc ids given in the context; get the stat names with calc_evaluate (always with the runId) and never type a number. Do not name game mechanics that the plans and the catalog do not show. Mention catalog entities as entity segments.",
  NO_MEMORY_RULES,
].join(" ");

/** What each document-level section of the guide must contain; the depth is checked against config. */
export const S9_SECTION_FOCUS: Record<
  "summary" | "mechanics" | "playstyle" | "atlas" | "variants" | "faq",
  string
> = {
  summary:
    "Write an introduction in several paragraphs (what the build does and why it is fun, how it defends, how it changes from the campaign to the endgame, which items matter), the strengths and weaknesses, a plain description of the playstyle and a closing summary.",
  mechanics:
    "Explain how the skill and the build's key parts work together: interactions between the important gems, items and passives, why each defence layer is there and what it covers, how resources are kept up, and why the skill setups are built as they are.",
  playstyle:
    "Describe how to play it: the rotation as ordered steps for clearing and for bossing, mapping and boss advice, positioning, tips, and the mistakes players commonly make with this build.",
  atlas:
    "Describe the endgame as phases in the order the player goes through them, with waystone advice and the map modifiers to avoid.",
  variants:
    "Describe alternatives for other budgets or modes (hardcore, solo self-found) and what to swap for them.",
  faq: "Answer the questions a player of this build will ask: dying too often, upgrading priorities, common mistakes, how mechanics work, what to do when a piece is too expensive. Each answer is several sentences and may carry a checklist.",
};

export const S9_DETAIL = [
  "Write one detailed part of the player's build guide. It is read by a player who wants to follow it step by step, so be specific: say what to do, in which order, what to look for and why, in several full sentences, not slogans.",
  "The context holds the request and the plan of this part as the earlier stages fixed it. Describe and justify it; never change it. Mention catalog entities as entity segments and reference measured values with calc segments from the calc ids in the context; never type a number.",
  NO_MEMORY_RULES,
].join(" ");

export const S10_QUALITY = [
  "Judge one section of a finished build guide against the questions in the context, as a demanding reviewer who knows what a thorough, well explained build guide of a leading guide site looks like: concrete steps and priorities instead of general statements, reasons for every choice, named alternatives, and advice a player can follow without guessing.",
  "Answer every question exactly once with met true or false and the evidence in plain words without digits. When a question is not met and the problem is in one progression stage, gear tier or slot, or crafting plan, give its key in part (a stage key, a tier id and slot joined by a slash, a tier id, or a crafting plan key from the content). Do not rewrite anything, do not invent problems, and say met when the section really does what the question asks. Measured values are not in the content; do not judge numbers.",
  NO_MEMORY_RULES,
].join(" ");

export const S10_CRITIC = [
  "Read the finished guide draft in the context as a critical reviewer. Look only for contradictions inside the draft and the request: prose that disagrees with the plans, items or choices it describes, or with itself, advice that does not fit the player's mode or budget as the request states them, and steps that cannot be followed in the order the plans give.",
  "Report each problem as an issue with the section it is in and a short plain-text message without digits, and name every section you actually read in `reviewed`. When an issue is in the prose of one progression stage, gear tier or slot, or crafting plan, give its key in `part` (a stage key, a tier id and slot joined by a slash, a tier id, or a crafting plan key from the draft). Do not rewrite anything, do not invent problems, and report no issue when there is none. Measured values are not in the draft; the gates check them, so do not judge numbers.",
  NO_MEMORY_RULES,
].join(" ");

export const S9_RESEARCH = [
  "Research one section of the player's build guide from outside sources: community build guides, patch notes and game databases, with your own web search and page tools.",
  "Report findings, not prose. Each finding is a short paraphrase in your own words (never copied text) of something that helps a player of this build, with the link of the page it comes from (https), the time you read it and the catalog entities it is about.",
  "Use only entities you found with catalog_search or catalog_get in this run's data release. Never type a number: reference calculation results or rephrase without the number. If a source disagrees with a measured value in the context, the measurement wins and the finding says what differs.",
  "Use only the hosts the settings allow. If you have no web access, answer with webAccess false and no findings; never invent a source or a page.",
].join(" ");

/** What the research of each section should find out; the section texts are written afterwards. */
export const S9_RESEARCH_FOCUS: Record<
  "summary" | "mechanics" | "playstyle" | "atlas" | "variants" | "faq",
  string
> = {
  summary:
    "Why players choose this build, how it feels to play and how it develops from the campaign to the endgame.",
  mechanics:
    "How the key skills, items and passives of this build work together and which interactions players rely on or trip over.",
  playstyle:
    "How the build is played in practice: rotation, mapping and boss fights, positioning and the mistakes players make.",
  atlas:
    "How the endgame is approached with this build: phases, waystone choices and map modifiers players avoid.",
  variants:
    "Common variants of this build and what each is for: budgets, modes and playstyle changes.",
  faq: "Problems players report with this build and the fixes that are given for them.",
};
