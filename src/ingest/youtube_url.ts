const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID = /^[A-Za-z0-9_-]{2,100}$/;

export function validateYouTubeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid YouTube URL");
  }

  if (
    url.protocol !== "https:" ||
    !YOUTUBE_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("Only HTTPS YouTube URLs are supported");
  }

  return url.href;
}

export function normaliseYouTubeVideoInput(value: string): string {
  const input = value.trim();
  if (YOUTUBE_VIDEO_ID.test(input)) {
    return `https://www.youtube.com/watch?v=${input}`;
  }

  const url = new URL(validateYouTubeUrl(input));
  const pathParts = url.pathname.split("/").filter(Boolean);
  const videoId = url.hostname.toLowerCase() === "youtu.be"
    ? pathParts[0]
    : url.searchParams.get("v") ??
      (["shorts", "embed", "live"].includes(pathParts[0])
        ? pathParts[1]
        : undefined);
  if (!videoId || !YOUTUBE_VIDEO_ID.test(videoId)) {
    throw new Error("YouTube video URL must contain a valid video ID");
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function normaliseYouTubePlaylistInput(value: string): string {
  const input = value.trim();
  const playlistId = YOUTUBE_PLAYLIST_ID.test(input)
    ? input
    : new URL(validateYouTubeUrl(input)).searchParams.get("list")?.trim();
  if (!playlistId || !YOUTUBE_PLAYLIST_ID.test(playlistId)) {
    throw new Error("YouTube playlist URL must contain a valid playlist ID");
  }
  return `https://www.youtube.com/playlist?list=${playlistId}`;
}
