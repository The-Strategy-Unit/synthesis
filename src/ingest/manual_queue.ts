import { normaliseYouTubeVideoInput } from "./youtube_url.ts";

export const MANUAL_QUEUE_REVIEW_MODE = "manual" as const;

export interface ValidatedManualQueue {
  urls: string[];
  reviewMode: typeof MANUAL_QUEUE_REVIEW_MODE;
}

export class ManualQueueInputError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function validateManualQueueRequest(
  value: unknown,
  maxItems: number,
): ValidatedManualQueue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManualQueueInputError("Source queue request must be an object");
  }
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new RangeError("Source queue limit must be positive");
  }

  const request = value as Record<string, unknown>;
  if (request.reviewMode !== MANUAL_QUEUE_REVIEW_MODE) {
    throw new ManualQueueInputError(
      "Source queue reviewMode must be 'manual'",
    );
  }
  if (
    !Array.isArray(request.urls) || request.urls.length < 1 ||
    request.urls.length > maxItems
  ) {
    throw new ManualQueueInputError(
      `Source queue must contain 1-${maxItems} video URLs`,
    );
  }

  const urls = request.urls.map((value, index) => {
    if (typeof value !== "string" || !value.trim() || value.length > 2048) {
      throw new ManualQueueInputError(
        `Source queue urls[${index}] must be a valid YouTube video URL or ID`,
      );
    }
    try {
      return normaliseYouTubeVideoInput(value.trim());
    } catch {
      throw new ManualQueueInputError(
        `Source queue urls[${index}] must be a valid YouTube video URL or ID`,
      );
    }
  });
  if (new Set(urls).size !== urls.length) {
    throw new ManualQueueInputError("Source queue video URLs must be unique");
  }
  return { urls, reviewMode: MANUAL_QUEUE_REVIEW_MODE };
}
