// Ingest: fetch YouTube transcript via yt-dlp auto-captions

import { config } from "../app/config.ts";
import {
  normaliseYouTubePlaylistInput,
  normaliseYouTubeVideoInput,
} from "./youtube_url.ts";

export {
  normaliseYouTubePlaylistInput,
  normaliseYouTubeVideoInput,
  validateYouTubeUrl,
} from "./youtube_url.ts";

export type SourceType = "youtube" | "text" | "markdown" | "pdf";

export interface OriginalSourceFile {
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface IngestResult {
  transcript: string;
  sourceUrl: string;
  title: string;
  sourceType: SourceType;
  originalFile?: OriginalSourceFile;
  pageCount?: number;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

async function runYtDlp(
  args: string[],
  signal?: AbortSignal,
): Promise<Deno.CommandOutput> {
  if (signal?.aborted) throw abortError();
  const child = new Deno.Command(config.ingest.ytDlpPath, {
    args: ["--no-config", ...args],
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const abort = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited before cancellation reached it.
    }
  };
  signal?.addEventListener("abort", abort, { once: true });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited between the timeout and kill call.
      }
      reject(new Error("YouTube request timed out"));
    }, config.security.ytDlpTimeoutMs);
  });

  try {
    const output = await Promise.race([child.output(), timeout]);
    if (signal?.aborted) throw abortError();
    return output;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function ingestYouTube(
  url: string,
  signal?: AbortSignal,
): Promise<IngestResult> {
  const validatedUrl = normaliseYouTubeVideoInput(url);
  const tmpDir = await Deno.makeTempDir();

  try {
    const title = await fetchVideoTitle(validatedUrl, signal);

    const { success, code } = await runYtDlp([
      "--write-auto-sub",
      "--write-sub",
      "--skip-download",
      "--sub-format",
      "vtt",
      "--sub-lang",
      config.ingest.ytDlpLang,
      "-o",
      `${tmpDir}/%(id)s`,
      validatedUrl,
    ], signal);
    if (!success) {
      console.error(`yt-dlp subtitle request failed with exit code ${code}`);
      throw new Error("Unable to download YouTube subtitles");
    }

    const files: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) {
      if (entry.name.endsWith(".vtt")) {
        files.push(`${tmpDir}/${entry.name}`);
      }
    }
    if (files.length === 0) {
      throw new Error(
        "No subtitle file found. The video may not have English auto-captions.",
      );
    }

    const stat = await Deno.stat(files[0]);
    if (stat.size > config.security.maxSubtitleBytes) {
      throw new Error(
        "YouTube subtitle file exceeds the configured size limit",
      );
    }

    const vttContent = await Deno.readTextFile(files[0]);
    const transcript = parseVtt(vttContent);
    if (transcript.length > config.security.maxTranscriptChars) {
      throw new Error("YouTube transcript exceeds the configured size limit");
    }

    return {
      transcript,
      sourceUrl: validatedUrl,
      title,
      sourceType: "youtube",
    };
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore */ }
  }
}

export function ingestText(title: string, text: string): IngestResult {
  return { transcript: text, sourceUrl: "", title, sourceType: "text" };
}

async function fetchVideoTitle(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const validatedUrl = normaliseYouTubeVideoInput(url);
  const { success, code, stdout } = await runYtDlp([
    "--get-title",
    validatedUrl,
  ], signal);
  if (!success) {
    console.error(`yt-dlp title request failed with exit code ${code}`);
    throw new Error("Unable to fetch the YouTube video title");
  }
  return new TextDecoder().decode(stdout).trim();
}

export function parseVtt(vtt: string): string {
  const lines = vtt.split("\n");
  const textLines: string[] = [];
  let prevClean = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("WEBVTT")) continue;
    if (trimmed.startsWith("Kind:")) continue;
    if (trimmed.startsWith("Language:")) continue;
    if (/^\d{2}:\d{2}/.test(trimmed)) continue;
    if (trimmed.includes("-->")) continue;
    if (/^align:/.test(trimmed)) continue;
    if (/^position:/.test(trimmed)) continue;

    const clean = trimmed.replace(/<[^>]+>/g, "");

    // Only skip if identical to the immediately preceding line
    // (YouTube auto-captions duplicate consecutive cues)
    if (clean && clean !== prevClean) {
      textLines.push(clean);
      prevClean = clean;
    }
  }

  return textLines.join(" ");
}

export async function getPlaylistVideos(
  playlistUrl: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const validatedUrl = normaliseYouTubePlaylistInput(playlistUrl);
  const { success, code, stdout } = await runYtDlp([
    "--flat-playlist",
    "--playlist-end",
    String(config.ingest.maxPlaylistItems + 1),
    "--print",
    "webpage_url",
    validatedUrl,
  ], signal);
  if (!success) {
    console.error(`yt-dlp playlist request failed with exit code ${code}`);
    throw new Error("Unable to fetch the YouTube playlist");
  }

  const urls = [
    ...new Set(
      new TextDecoder().decode(stdout).trim().split("\n").filter(Boolean).map(
        normaliseYouTubeVideoInput,
      ),
    ),
  ];
  if (urls.length === 0) {
    throw new Error("The YouTube playlist contains no accessible videos");
  }
  if (urls.length > config.ingest.maxPlaylistItems) {
    throw new Error("YouTube playlist exceeds the configured item limit");
  }
  return urls;
}
