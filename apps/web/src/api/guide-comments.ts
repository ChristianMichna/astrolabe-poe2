import { z } from "zod";
import {
  GuideCommentsView,
  type GuideCommentRequest,
  type GuideSectionKey,
} from "@astrolabe/contracts/guide";
import { ApiError } from "./client";

/*
 * Section comments of a guide (server: GET/POST /api/guides/:id/comments). Answers are checked
 * against `GuideCommentsView`; a failure is shown, never read as "no comments".
 */

const ErrorBody = z.object({ error: z.object({ message: z.string() }) });

async function call(url: string, init: RequestInit): Promise<GuideCommentsView> {
  const response = await fetch(url, init);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = ErrorBody.safeParse(body);
    throw new ApiError(
      parsed.success ? parsed.data.error.message : `The server answered HTTP ${response.status}.`,
      response.status,
    );
  }
  const answer = GuideCommentsView.safeParse(body);
  if (!answer.success) {
    throw new ApiError("The server sent an answer this app version does not understand.", 502, {
      cause: answer.error,
    });
  }
  return answer.data;
}

const url = (guideId: string): string => `/api/guides/${encodeURIComponent(guideId)}/comments`;

export const loadGuideComments = (
  guideId: string,
  signal?: AbortSignal,
): Promise<GuideCommentsView> => call(url(guideId), signal ? { signal } : {});

export function postGuideComment(
  guideId: string,
  section: GuideSectionKey,
  text: string,
): Promise<GuideCommentsView> {
  const body: GuideCommentRequest = { section, text };
  return call(url(guideId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
