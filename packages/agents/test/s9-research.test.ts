import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PipelineContext } from "../src/pipeline.js";
import type { StageConfig } from "../src/config.js";
import { ResearchConfig, hostAllowed } from "../src/research-config.js";
import {
  researchCheck,
  researchContext,
  researchKey,
  researchSections,
} from "../src/stages/s9-research.js";

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"));
const research = ResearchConfig.parse(readJson("config/agents/research.json"));

const finding = (id: string, url = "https://maxroll.gg/guide") => ({
  id,
  section: "playstyle" as const,
  topic: "Fixture topic",
  claim: [{ type: "text" as const, text: "Fixture claim in the researcher's own words." }],
  source: { url, title: "Fixture page", retrievedAt: "2026-11-28T00:00:00Z" },
  entities: [],
});

describe("research settings", () => {
  it("reads the shipped file, and its hosts are the ones the desktop shell may open", () => {
    const desktop = readJson("config/desktop/desktop.json") as {
      citations: { allowedHosts: string[] };
    };
    expect([...research.hostAllowlist].sort()).toEqual([...desktop.citations.allowedHosts].sort());
  });

  it("allows a listed host and its subdomains, https only and without a port", () => {
    expect(hostAllowed("https://maxroll.gg/poe2/x", research.hostAllowlist)).toBe(true);
    expect(hostAllowed("https://www.pathofexile.com/forum", research.hostAllowlist)).toBe(true);
    expect(hostAllowed("http://maxroll.gg/x", research.hostAllowlist)).toBe(false);
    expect(hostAllowed("https://maxroll.gg:8443/x", research.hostAllowlist)).toBe(false);
    expect(hostAllowed("https://maxroll.gg.evil.example/x", research.hostAllowlist)).toBe(false);
    expect(hostAllowed("https://evilmaxroll.gg/x", research.hostAllowlist)).toBe(false);
    expect(hostAllowed("https://user@maxroll.gg/x", research.hostAllowlist)).toBe(false);
  });

  it("plans research tasks only when it is switched on", () => {
    const on = { s9: { research } } as unknown as StageConfig;
    const off = { s9: { research: { ...research, enabled: false } } } as unknown as StageConfig;
    expect(researchSections(on)).toEqual(research.sections);
    expect(researchSections(off)).toEqual([]);
    expect(researchSections({} as StageConfig)).toEqual([]);
  });
});

describe("research check", () => {
  const check = researchCheck("playstyle", research, new Set(["taken-id"]));
  const many = (n: number) => Array.from({ length: n }, (_, i) => finding(`f-${String(i)}`));
  const codes = (a: { webAccess: boolean; findings: ReturnType<typeof many> }) =>
    check(a).map((f) => f.code);

  it("accepts findings within the count and the allowed hosts", () => {
    expect(codes({ webAccess: true, findings: many(research.findings.min) })).toEqual([]);
  });

  it("accepts an answer without web access only when it has no findings", () => {
    expect(codes({ webAccess: false, findings: [] })).toEqual([]);
    expect(codes({ webAccess: false, findings: many(2) })).toEqual(["research_without_web"]);
  });

  it("returns too few or too many findings, other hosts and reused ids", () => {
    expect(codes({ webAccess: true, findings: [] })).toContain("research_count");
    expect(codes({ webAccess: true, findings: many(research.findings.max + 1) })).toContain(
      "research_count",
    );
    expect(
      codes({
        webAccess: true,
        findings: [finding("aa"), finding("bb", "https://other.example/x")],
      }),
    ).toEqual(["research_host"]);
    expect(codes({ webAccess: true, findings: [finding("aa"), finding("aa")] })).toContain(
      "research_duplicate_id",
    );
    expect(codes({ webAccess: true, findings: [finding("taken-id"), finding("bb")] })).toContain(
      "research_duplicate_id",
    );
  });

  it("returns a topic with a digit", () => {
    expect(
      codes({
        webAccess: true,
        findings: [{ ...finding("aa"), topic: "Boss with 3 phases" }, finding("bb")],
      }),
    ).toEqual(["research_topic_number"]);
  });

  it("returns a finding that belongs to another section", () => {
    expect(
      codes({
        webAccess: true,
        findings: [{ ...finding("aa"), section: "atlas" as never }, finding("bb")],
      }),
    ).toContain("research_section");
  });
});

describe("research context of a writing task", () => {
  const ctxWith = (stored: unknown) =>
    ({
      result: (key: string) => (key === researchKey("playstyle") ? stored : undefined),
    }) as never as PipelineContext;

  it("is absent before the research is done, and shows id, topic, claim and source after", () => {
    expect(researchContext(ctxWith(undefined), "playstyle")).toBeUndefined();
    const out = researchContext(
      ctxWith({ webAccess: true, findings: [finding("aa")] }),
      "playstyle",
    ) as { available: boolean; findings: { id: string; source: object }[] };
    expect(out.available).toBe(true);
    expect(out.findings[0]?.id).toBe("aa");
    expect(out.findings[0]?.source).toEqual({
      title: "Fixture page",
      url: "https://maxroll.gg/guide",
    });
  });

  it("tells the writer that research was not available", () => {
    expect(researchContext(ctxWith({ webAccess: false, findings: [] }), "playstyle")).toEqual({
      available: false,
      findings: [],
    });
  });
});
