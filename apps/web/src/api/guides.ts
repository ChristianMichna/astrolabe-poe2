import { z } from "zod";
import {
  GuideListView,
  GuideView,
  PassiveTreeData,
  TreeIconAtlas,
} from "@astrolabe/contracts/guide";
import type { TreeIconSheet } from "@astrolabe/ui";
import { ApiError } from "./client";

/*
 * Saved guides from the local server: the list (GET /api/guides, `GuideListView`) and one guide
 * with the names and results behind it (GET /api/guides/:id/view, `GuideView`). Both answers are
 * checked against the contracts.
 */

const ErrorBody = z.object({ error: z.object({ message: z.string() }) });

async function get<T>(
  url: string,
  schema: z.ZodType<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  const response = await fetch(url, signal ? { signal } : {});
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = ErrorBody.safeParse(body);
    throw new ApiError(
      parsed.success ? parsed.data.error.message : `The server answered HTTP ${response.status}.`,
      response.status,
    );
  }
  const answer = schema.safeParse(body);
  if (!answer.success) {
    throw new ApiError("The server sent an answer this app version does not understand.", 502, {
      cause: answer.error,
    });
  }
  return answer.data;
}

export const loadGuideList = (signal?: AbortSignal): Promise<GuideListView> =>
  get("/api/guides", GuideListView, signal);

export const loadGuideView = (guideId: string, signal?: AbortSignal): Promise<GuideView> =>
  get(`/api/guides/${encodeURIComponent(guideId)}/view`, GuideView, signal);

export const loadPassiveTree = (signal?: AbortSignal): Promise<PassiveTreeData> =>
  get("/api/tree", PassiveTreeData, signal);

/**
 * The node pictures of the passive tree: the atlas index and its image, joined for the renderer.
 * The image goes through `fetch` like every other call, so the app protocol adds the access token.
 */
export async function loadTreeIconSheet(signal?: AbortSignal): Promise<TreeIconSheet> {
  const atlas = await get("/api/tree/icons.json", TreeIconAtlas, signal);
  const response = await fetch("/api/tree/icons.png", signal ? { signal } : {});
  if (!response.ok) {
    throw new ApiError(
      `The server answered HTTP ${response.status} for the icon image.`,
      response.status,
    );
  }
  const image = await createImageBitmap(await response.blob());
  return { image, cell: atlas.cell, columns: atlas.columns, icons: atlas.icons };
}
