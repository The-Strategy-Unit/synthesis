// Ingest: fetch YouTube transcript via yt-dlp auto-captions

export interface IngestResult {
  transcript: string;
  sourceUrl: string;
  title: string;
}

export async function ingestYouTube(url: string): Promise<IngestResult> {
  const tmpDir = await Deno.makeTempDir();

  try {
    const title = await fetchVideoTitle(url);

    const cmd = new Deno.Command("yt-dlp", {
      args: [
        "--write-auto-sub",
        "--write-sub",
        "--skip-download",
        "--sub-format",
        "vtt",
        "--sub-lang",
        "en",
        "-o",
        `${tmpDir}/%(id)s`,
        url,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { success, stderr } = await cmd.output();
    if (!success) {
      throw new Error(`yt-dlp failed: ${new TextDecoder().decode(stderr)}`);
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

    const vttContent = await Deno.readTextFile(files[0]);
    const transcript = parseVtt(vttContent);

    return { transcript, sourceUrl: url, title };
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore */ }
  }
}

export function ingestText(title: string, text: string): IngestResult {
  return { transcript: text, sourceUrl: "", title };
}

async function fetchVideoTitle(url: string): Promise<string> {
  const cmd = new Deno.Command("yt-dlp", {
    args: ["--get-title", url],
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stdout, stderr } = await cmd.output();
  if (!success) {
    throw new Error(
      `yt-dlp failed to fetch title: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout).trim();
}

function parseVtt(vtt: string): string {
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
): Promise<string[]> {
  const cmd = new Deno.Command("yt-dlp", {
    args: ["--flat-playlist", "--print", "url", playlistUrl],
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stdout, stderr } = await cmd.output();
  if (!success) {
    throw new Error(
      `yt-dlp playlist fetch failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout).trim().split("\n").filter(Boolean);
}
