import { normalizeYouTubeVideoInput } from "./youtube_url.ts";

export const TRUSTED_BATCH_REVIEW_MODE = "automatic" as const;

export interface TrustedBatchRequest {
  urls: string[];
  reviewMode: typeof TRUSTED_BATCH_REVIEW_MODE;
  confirm: string;
}

export interface ValidatedTrustedBatch {
  urls: string[];
  reviewMode: typeof TRUSTED_BATCH_REVIEW_MODE;
}

export class TrustedBatchInputError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_TRUSTED_BATCH" | "CONFIRMATION_REQUIRED" =
      "INVALID_TRUSTED_BATCH",
  ) {
    super(message);
  }
}

export function trustedBatchConfirmation(sourceCount: number): string {
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 1) {
    throw new RangeError("Trusted batch source count must be positive");
  }
  return `AUTO APPLY ${sourceCount} TRUSTED SOURCES`;
}

export function validateTrustedBatchRequest(
  value: unknown,
  maxItems: number,
): ValidatedTrustedBatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrustedBatchInputError("Trusted batch request must be an object");
  }
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new RangeError("Trusted batch limit must be positive");
  }

  const request = value as Record<string, unknown>;
  if (request.reviewMode !== TRUSTED_BATCH_REVIEW_MODE) {
    throw new TrustedBatchInputError(
      "Trusted batch reviewMode must be 'automatic'",
    );
  }
  if (
    !Array.isArray(request.urls) || request.urls.length < 1 ||
    request.urls.length > maxItems
  ) {
    throw new TrustedBatchInputError(
      `Trusted batch must contain 1-${maxItems} video URLs`,
    );
  }

  const urls = request.urls.map((value, index) => {
    if (typeof value !== "string" || !value.trim() || value.length > 2048) {
      throw new TrustedBatchInputError(
        `Trusted batch urls[${index}] must be a valid YouTube video URL or ID`,
      );
    }
    try {
      return normalizeYouTubeVideoInput(value.trim());
    } catch {
      throw new TrustedBatchInputError(
        `Trusted batch urls[${index}] must be a valid YouTube video URL or ID`,
      );
    }
  });
  if (new Set(urls).size !== urls.length) {
    throw new TrustedBatchInputError(
      "Trusted batch video URLs must be unique",
    );
  }

  const expected = trustedBatchConfirmation(urls.length);
  if (request.confirm !== expected) {
    throw new TrustedBatchInputError(
      `Set 'confirm' to '${expected}' to automatically apply this trusted batch`,
      "CONFIRMATION_REQUIRED",
    );
  }
  return { urls, reviewMode: TRUSTED_BATCH_REVIEW_MODE };
}
