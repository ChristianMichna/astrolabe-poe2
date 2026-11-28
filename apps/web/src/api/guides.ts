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

/** An earlier revision of a guide (`GuideCommentsView.revisions` counts them), for the comparison. */
export const loadGuideRevision = (
  guideId: string,
  revision: number,
  signal?: AbortSignal,
): Promise<GuideView> =>
  get(
    `/api/guides/${encodeURIComponent(guideId)}/view?revision=${String(revision)}`,
    GuideView,
    signal,
  );

export const loadPassiveTree = (signal?: AbortSignal): Promise<PassiveTreeData> =>
  get("/api/tree", PassiveTreeData, signal);

/**
 * The node pictures of the passive tree: the atlas index and its image, joined for the renderer.
 * The image goes through `fetch` like every other call, so the app protocol adds the access token.
 */
export async function loadTreeIconSheet(signal?: AbortSignal): Promise<TreeIconSheet> {
  const init = signal ? { signal } : {};
  const [atlas, response] = await Promise.all([
    get("/api/tree/icons.json", TreeIconAtlas, signal),
    fetch("/api/tree/icons.png", init),
  ]);
  if (!response.ok) {
    throw new ApiError(
      `The server answered HTTP ${response.status} for the icon image.`,
      response.status,
    );
  }
  const image = await createImageBitmap(await response.blob());
  // The caller owns the bitmap; one that is not handed over is closed here.
  if (signal?.aborted) {
    image.close();
    throw new DOMException("Aborted", "AbortError");
  }
  if (image.width !== atlas.width || image.height !== atlas.height) {
    image.close();
    throw new ApiError(
      `The icon image is ${image.width}x${image.height} but its index says ${atlas.width}x${atlas.height}.`,
      502,
    );
  }
  return { image, cell: atlas.cell, columns: atlas.columns, icons: atlas.icons };
}
