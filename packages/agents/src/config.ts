import { z } from "zod";
import { GuideSpec, specRubricGaps } from "./guide-spec.js";
import { ResearchConfig } from "./research-config.js";
import { QualityRubric } from "./quality/rubric.js";
import { BudgetTierId } from "@astrolabe/contracts/build";
import { CalcProfileId } from "@astrolabe/contracts/common";

/** Settings of the pipeline stages; lives versioned in config/agents/stages.json. */
export const StageConfig = z
  .object({
    version: z.string().min(1),
    /** Version of the prompt texts these stages use; reported in the guide metadata. */
    promptVersion: z.string().min(1),
    /**
     * Gem kinds (ids from the data release) that are support gems. Release
     * data, so it lives here and not in code; a patch that renames it only
     * changes this file.
     */
    supportGemKinds: z.array(z.string().min(1)).min(1),
    /**
     * Builds whose main skill is a gem of one of `skillKinds` (the gem `kind` of the data release; the tag `minion` is on skills that deal their own damage too) take
     * their damage from PoB's minion outputs: the stat names in `statMap` are replaced for the
     * tree and gear objectives and the damage gate. PoB's own DPS stays 0 for such a skill, and a
     * stat PoB does not calculate is never replaced by an estimate. Absent: no replacement.
     */
    minion: z
      .object({
        skillKinds: z.array(z.string().min(1)).min(1),
        statMap: z.record(z.string().min(1), z.string().min(1)),
      })
      .optional(),
    s1: z.object({
      /** Upper bound per list a profile may contain (keeps tasks small). */
      maxListItems: z.int().positive(),
    }),
    s3: z.object({
      /** Character level of the skeleton build (a design parameter of the quick evaluation). */
      level: z.int().positive(),
      /** Passive points of the skeleton's tree: a deliberately small design budget of the quick evaluation, not the game's rule (S5 reads that from the release). */
      passivePoints: z.int().positive(),
      /** Level of the main and support gems in the skeleton. */
      gemLevel: z.int().positive(),
      /** Support gems taken from the profile's candidates, in the profile's order. */
      supportCount: z.int().nonnegative(),
      /** Calc profiles every skeleton is measured with. */
      calcProfiles: z.array(CalcProfileId).min(1),
      /** Tree objective: PoB output names with weights and minimum values. */
      objective: z.object({
        weights: z.record(z.string().min(1), z.number()),
        floors: z.record(z.string().min(1), z.number()).default({}),
      }),
      /**
       * Attack skills deal no damage without a weapon, so the tree searches would be blind for
       * damage. When set, the skeleton wears the weapon (of a class the slot accepts, the lowest
       * requirement) that PoB measures best for the main skill; the gear stages replace it.
       */
      placeholderWeapon: z
        .object({
          /** Slot id of the release (`DataRelease.itemSlots`) that takes the weapon. */
          slot: z.string().min(1),
          /** Rarity id of the release the placeholder has (no modifiers). */
          rarity: z.string().min(1),
        })
        .optional(),
    }),
    /**
     * S5 target build. Optional on purpose: calc profiles and the tree objective
     * are a product decision that is not made yet. Level and passive points come
     * from the data release, never from here. Without this block the run stops
     * at S5 with an explicit error.
     */
    s5: z
      .object({
        calcProfiles: z.array(CalcProfileId).min(1),
        objective: z.object({
          weights: z.record(z.string().min(1), z.number()),
          floors: z.record(z.string().min(1), z.number()).default({}),
          /** Metric held to another measured metric, e.g. Int against ReqInt (no numbers typed here). */
          floorsFromMetrics: z.record(z.string().min(1), z.string().min(1)).default({}),
        }),
        /**
         * What the ascendancy search does with nodes whose mods Path of Building does not
         * calculate: `avoid` searches again without them (the numbers would ignore their effect),
         * `accept` keeps them (G2 then needs `s10.acceptedUnsupportedModPatterns` for them).
         */
        unsupportedMods: z.enum(["avoid", "accept"]).default("avoid"),
        unsupportedMaxRounds: z.number().int().positive().default(4),
      })
      .optional(),
    /**
     * S6 progression: calc profiles and tree objective. The stage table is
     * derived from the data release (acts, level bands, passive points); an
     * explicit `stages` list overrides that. Without this block the run stops at
     * S6 with an explicit error.
     */
    s6: z
      .object({
        stages: z
          .array(
            z.object({
              key: z.string().regex(/^[a-z][a-z0-9-]*$/),
              label: z.string().min(1).max(120),
              kind: z.enum(["campaign", "endgame"]),
              act: z.int().positive().optional(),
              levelRange: z.tuple([z.int().positive(), z.int().positive()]),
              /** Main-tree points available at the end of this stage. */
              passivePoints: z.int().nonnegative(),
            }),
          )
          .min(1)
          .superRefine((stages, ctx) => {
            const keys = new Set<string>();
            stages.forEach((st, i) => {
              if (keys.has(st.key)) {
                ctx.addIssue({
                  code: "custom",
                  message: `duplicate stage key ${st.key}`,
                  path: [i, "key"],
                });
              }
              keys.add(st.key);
              if (st.levelRange[0] > st.levelRange[1]) {
                ctx.addIssue({
                  code: "custom",
                  message: "levelRange must be ascending",
                  path: [i, "levelRange"],
                });
              }
              const prev = stages[i - 1];
              if (prev !== undefined && st.passivePoints < prev.passivePoints) {
                ctx.addIssue({
                  code: "custom",
                  message: "passivePoints must not decrease",
                  path: [i, "passivePoints"],
                });
              }
              if (prev !== undefined && st.levelRange[0] <= prev.levelRange[1]) {
                ctx.addIssue({
                  code: "custom",
                  message: "level bands must not overlap",
                  path: [i, "levelRange"],
                });
              }
            });
          })
          .optional(),
        calcProfiles: z.array(CalcProfileId).min(1),
        objective: z.object({
          weights: z.record(z.string().min(1), z.number()),
          floors: z.record(z.string().min(1), z.number()).default({}),
          /** Metric held to another measured metric, e.g. Int against ReqInt (no numbers typed here). */
          floorsFromMetrics: z.record(z.string().min(1), z.string().min(1)).default({}),
        }),
      })
      .optional(),
    /**
     * S7 gear. Optional on purpose, like s5 and s6: the item slots come from the
     * release (PoB slot ids and the classes each accepts), the budget tiers are
     * an editable default that the product owner adjusts. Without this block the run stops at S7 with an
     * explicit error.
     */
    s7: z
      .object({
        /**
         * Overrides the slots of the release (`DataRelease.itemSlots`, ids exactly
         * as PoB names them). Without it the release's slots are used.
         */
        slots: z.array(z.string().min(1)).min(1).optional(),
        /** Slots every tier must fill; absent means the release's slots that are neither optional nor dependent. */
        requiredSlots: z.array(z.string().min(1)).optional(),
        /** Budget tiers in ascending order; the request names tiers by id. */
        tiers: z
          .array(z.object({ id: BudgetTierId, label: z.string().min(1).max(120) }))
          .min(1)
          .refine((t) => new Set(t.map((x) => x.id)).size === t.length, {
            message: "duplicate tier id",
          }),
        calcProfiles: z.array(CalcProfileId).min(1),
        /** Weights of the PoB outputs that rank gear upgrades (gain per cost). */
        objective: z.object({
          /** PoB outputs that rank upgrades; at least one, finite. */
          weights: z
            .record(z.string().min(1), z.number().finite())
            .refine((w) => Object.keys(w).length > 0, { message: "needs at least one weight" }),
          /** The calc profile the ranking is measured with; one of `calcProfiles`. */
          calcProfile: CalcProfileId,
        }),
      })
      .refine((c) => c.calcProfiles.includes(c.objective.calcProfile), {
        message: "objective.calcProfile must be one of calcProfiles",
        path: ["objective", "calcProfile"],
      })
      .optional(),
    /**
     * S10 gates that need PoB outputs and thresholds. Stat names are PoB's own output names.
     * Thresholds are calibrated per patch by the product owner; a gate whose thresholds are
     * absent is reported as not checked, never as passed.
     */
    s10: z
      .object({
        /** The calc profile of a stage that the gates read. */
        calcProfile: CalcProfileId,
        /** Fewest progression stages and gear tiers a guide may have (G7). */
        minProgressionStages: z.int().positive(),
        minGearTiers: z.int().positive(),
        /** Profiles every progression stage must have a calculation for (G2). */
        requiredCalcProfiles: z.array(CalcProfileId),
        /** Patterns (regular expressions) of unsupported-mod texts as PoB reports them that the product owner accepts; they stay visible as warnings in the report, every other one fails G2. */
        acceptedUnsupportedModPatterns: z.array(
          z.string().refine(
            (p) => {
              try {
                new RegExp(p);
                return true;
              } catch {
                return false;
              }
            },
            { message: "not a valid regular expression" },
          ),
        ),
        /** How often gate findings may send the same stage back before the run fails. */
        maxReturnsPerStage: z.int().min(1).max(10),
        stats: z.object({
          /** Unreserved spirit; below zero the build reserves more than it has (G3). */
          spiritFree: z.string().min(1),
          /** Resistance still missing to the cap per element (PoB's "Missing…Resist", never negative); above zero the cap is not reached (G4). */
          resistMissing: z.array(z.string().min(1)).min(1),
          /** Attribute totals and the highest requirement of any item or gem (PoB's Str/ReqStr…); a total below its requirement fails G3. */
          attributes: z
            .array(z.object({ have: z.string().min(1), need: z.string().min(1) }))
            .min(1),
          ehp: z.string().min(1),
          dps: z.string().min(1),
        }),
        /** Progression stage kinds ("campaign" or "endgame") whose resistances must be at cap. */
        resistanceCapStageKinds: z.array(z.enum(["campaign", "endgame"])).min(1),
        /** False while the thresholds are measured starting values, not set by the product owner; the report then carries a warning. */
        thresholdsCalibrated: z.boolean().default(false),
        /** Minimum EHP and DPS from a character level on; for each of the two minimums the entry with the highest fromLevel at or below a stage's level that sets it applies. */
        thresholds: z
          .array(
            z.object({
              fromLevel: z.int().positive(),
              minEhp: z.number().positive().optional(),
              minDps: z.number().positive().optional(),
            }),
          )
          .refine((t) => new Set(t.map((x) => x.fromLevel)).size === t.length, {
            message: "duplicate fromLevel",
          }),
        /**
         * Thresholds derived from the guide's own measurements instead of fixed numbers (product
         * owner decision 26.11.2026: automatic): a stage must keep at least this share of the
         * previous stage's EHP and damage, and the first stage must have any. Patch-agnostic: no
         * value depends on the game version. Replaces `thresholds`, which must then be empty.
         */
        derived: z.object({ minRatioToBest: z.number().positive().max(1) }).optional(),
      })
      .refine((c) => c.derived === undefined || c.thresholds.length === 0, {
        message: "derived thresholds replace the fixed ones: `thresholds` must be empty",
      })
      .optional(),
    /**
     * S11 publishing: weights of the guide parts for the completeness score
     * (share of the weighted parts that are not empty). Without this block the run stops
     * after validation with an explicit error.
     */
    s11: z
      .object({
        scoringConfigVersion: z.string().min(1),
        weights: z
          .object({
            summary: z.number().nonnegative(),
            mechanics: z.number().nonnegative(),
            progression: z.number().nonnegative(),
            gear: z.number().nonnegative(),
            crafting: z.number().nonnegative(),
            playstyle: z.number().nonnegative(),
            atlas: z.number().nonnegative(),
            variants: z.number().nonnegative(),
            faq: z.number().nonnegative(),
          })
          .refine((w) => Object.values(w).some((x) => x > 0), { message: "all weights are zero" }),
      })
      .optional(),
    /**
     * S9 depth of the guide: the detail pass (one task per stage, tier, slot and crafting plan) and
     * the least amount of prose the sections must hold. Without this block the guide has only the
     * short sections. Counts are the product owner's quality bar, not game facts.
     */
    s9: z
      .object({
        /** File with the quality rubric, next to this config; the loader reads it into `rubric`. */
        rubricFile: z.string().min(1).optional(),
        rubric: QualityRubric.optional(),
        /** File with the guide specification, next to this config; the loader reads it into `guideSpec`. */
        guideSpecFile: z.string().min(1).optional(),
        guideSpec: GuideSpec.optional(),
        /** File with the research settings, next to this config; the loader reads it into `research`. */
        researchFile: z.string().min(1).optional(),
        research: ResearchConfig.optional(),
        depth: z.object({
          introductionParagraphs: z.int().nonnegative(),
          interactions: z.int().nonnegative(),
          defences: z.int().nonnegative(),
          gemSetups: z.int().nonnegative(),
          rotationSteps: z.int().nonnegative(),
          tips: z.int().nonnegative(),
          commonMistakes: z.int().nonnegative(),
          atlasPhases: z.int().nonnegative(),
          waystoneTips: z.int().nonnegative(),
          variants: z.int().nonnegative(),
          faq: z.int().nonnegative(),
          minTreeNotesPerStage: z.int().nonnegative(),
          minStatPrioritiesPerSlot: z.int().nonnegative(),
        }),
      })
      .refine(
        (s9) => {
          if (s9.rubric === undefined || s9.guideSpec === undefined) return true;
          const gaps = specRubricGaps(s9.guideSpec, s9.rubric);
          return gaps.unknown.length === 0 && gaps.unreferenced.length === 0;
        },
        {
          message:
            "the guide specification and the quality rubric disagree: every rubric rule must be explained by a spec item and every spec item may name only existing rules",
          path: ["guideSpec"],
        },
      )
      .refine((s9) => s9.rubric !== undefined || s9.rubricFile !== undefined, {
        message: "s9 needs the quality rubric (rubricFile): the quality gate must not be off",
        path: ["rubricFile"],
      })
      .optional(),
    s2: z.object({
      /** Number of archetype candidates (the plan asks for 3–6). */
      candidateCount: z.int().min(1).max(6),
      maxKeyEntities: z.int().positive(),
    }),
  })
  .refine(
    (c) =>
      c.s10 === undefined || c.s7 === undefined || c.s10.calcProfile === c.s7.objective.calcProfile,
    {
      message:
        "s10.calcProfile must equal s7.objective.calcProfile: the gates read the gear measurement S7 made",
      path: ["s10", "calcProfile"],
    },
  )
  .refine(
    (c) =>
      c.s10 === undefined ||
      c.s6 === undefined ||
      c.s10.requiredCalcProfiles.every((p) => c.s6?.calcProfiles.includes(p) === true),
    {
      message: "s10.requiredCalcProfiles must be profiles S6 calculates (s6.calcProfiles)",
      path: ["s10", "requiredCalcProfiles"],
    },
  );
export type StageConfig = z.infer<typeof StageConfig>;
