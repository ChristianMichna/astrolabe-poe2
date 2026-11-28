import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GuideView } from "@astrolabe/contracts/guide";
import { RichTextView } from "../guide/RichTextView";
import { SourcesSection } from "./GuideText";

afterEach(cleanup);

const finding = {
  id: "boss-order",
  section: "playstyle",
  topic: "Boss phases",
  claim: [{ type: "text", text: "Fixture claim in the researcher's words." }],
  source: {
    url: "https://maxroll.gg/guide",
    title: "Fixture guide page",
    retrievedAt: "2026-11-28T00:00:00Z",
  },
  entities: [],
};
const viewWith = (research: unknown[]) =>
  ({ guide: { research }, names: {}, results: {} }) as never as GuideView;

describe("sources of a guide", () => {
  it("lists each source with its link, host and claim", () => {
    render(<SourcesSection view={viewWith([finding])} />);
    const link = screen.getByRole("link", { name: "Fixture guide page" });
    expect(link.getAttribute("href")).toBe("https://maxroll.gg/guide");
    expect(screen.getByText("(maxroll.gg)")).toBeTruthy();
    expect(screen.getByText("Fixture claim in the researcher's words.")).toBeTruthy();
  });

  it("still renders when a link cannot be parsed, and shows the raw link instead of a host", () => {
    const odd = { ...finding, source: { ...finding.source, url: "https://a.1" } };
    render(<SourcesSection view={viewWith([odd])} />);
    expect(screen.getByText("(https://a.1)")).toBeTruthy();
  });

  it("shows nothing when the guide was written without research", () => {
    const { container } = render(<SourcesSection view={viewWith([])} />);
    expect(container.textContent).toBe("");
  });

  it("numbers a citation by the order of the sources and marks an unknown one", () => {
    render(
      <RichTextView
        view={viewWith([finding])}
        text={[
          { type: "source", id: "boss-order" },
          { type: "source", id: "made-up" },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "[1]" }).getAttribute("href")).toBe(
      "https://maxroll.gg/guide",
    );
    expect(screen.getByText("[made-up]").className).toContain("guide-unresolved");
  });
});
