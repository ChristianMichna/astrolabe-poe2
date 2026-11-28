import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CommentsBanner, GuideCommentsProvider, SectionComments } from "./SectionComments";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const empty = {
  guideId: "g1",
  runId: RUN_ID,
  sections: [{ key: "S9.mechanics", label: "How it works" }],
  comments: [],
};

function stubServer(initial: unknown) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { section: string; text: string };
        posts.push(body);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...empty,
              comments: [
                {
                  commentId: "c1",
                  section: body.section,
                  text: body.text,
                  createdAt: "2026-11-27T10:00:00.000Z",
                  status: "queued",
                },
              ],
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(initial), { status: 200 }));
    }),
  );
  return posts;
}

function page() {
  return render(
    <GuideCommentsProvider guideId="g1">
      <CommentsBanner />
      <SectionComments sectionKey="S9.mechanics" label="How it works" />
    </GuideCommentsProvider>,
  );
}

describe("section comments", () => {
  it("sends a comment for the section and shows it as waiting for Claude", async () => {
    const posts = stubServer(empty);
    page();
    fireEvent.click(await screen.findByRole("button", { name: /Comment on How it works/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Explain the cost curve." } });
    fireEvent.click(screen.getByRole("button", { name: /Send to Claude/ }));
    await waitFor(() => expect(screen.getByText("Waiting for Claude")).toBeTruthy());
    expect(posts).toEqual([{ section: "S9.mechanics", text: "Explain the cost curve." }]);
    expect(screen.getByText("Claude has work from your comments")).toBeTruthy();
  });

  it("offers no comment button for a guide without a run", async () => {
    stubServer({
      guideId: "g1",
      reason: "This guide came from a file.",
      sections: [],
      comments: [],
    });
    page();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Comment on/ })).toBeNull();
  });

  it("shows a failed load instead of hiding it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "No run." } }), { status: 404 }),
        ),
      ),
    );
    page();
    expect(await screen.findByText("No run.")).toBeTruthy();
  });
});
