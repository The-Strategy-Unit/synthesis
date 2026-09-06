const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID =
  /^(?:PL|UU|LL|FL|RD|UL|TL|PU|EC|OLAK5uy_)[A-Za-z0-9_-]{2,98}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const SOURCE_TYPES = new Set([
  "auto",
  "text",
  "video",
  "playlist",
  "queue",
  "trusted-batch",
]);

function httpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function detectedUrl(value) {
  if (VIDEO_ID.test(value)) {
    return new URL(`https://www.youtube.com/watch?v=${value}`);
  }
  if (PLAYLIST_ID.test(value)) {
    return new URL(`https://www.youtube.com/playlist?list=${value}`);
  }
  return httpUrl(value);
}

function isCanonicalYouTubePlaylist(url) {
  return YOUTUBE_HOSTS.has(url.hostname.toLowerCase()) &&
    url.pathname === "/playlist" && url.searchParams.has("list");
}

export function classifyIngestSource(value, sourceType) {
  const input = value.trim();
  if (!SOURCE_TYPES.has(sourceType)) {
    throw new Error("Invalid ingest source type");
  }
  if (sourceType !== "auto") return { kind: sourceType, value: input };

  const url = detectedUrl(input);
  if (url === null) return { kind: "text", value: input };
  return {
    kind: isCanonicalYouTubePlaylist(url) ? "playlist" : "video",
    value: url.href,
  };
}

function parseVideoLines(value, emptyMessage) {
  const urls = String(value).split(/\r?\n/u).map((line) => line.trim()).filter(
    Boolean,
  );
  if (urls.length === 0) {
    throw new Error(emptyMessage);
  }
  return urls;
}

export function parseManualVideoQueue(value) {
  return parseVideoLines(value, "Add at least one queued YouTube URL or ID");
}

export function parseTrustedVideoBatch(value) {
  return parseVideoLines(value, "Add at least one YouTube video URL or ID");
}

export function trustedBatchConfirmation(sourceCount) {
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 1) {
    throw new RangeError("Trusted batch source count must be positive");
  }
  return `AUTO APPLY ${sourceCount} TRUSTED SOURCES`;
}
