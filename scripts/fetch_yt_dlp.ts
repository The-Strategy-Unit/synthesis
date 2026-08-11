#!/usr/bin/env deno run --allow-read --allow-write --allow-run --allow-env --allow-net

/**
 * Fetch yt-dlp binary for the current platform
 * Run: deno run --allow-all scripts/fetch_yt_dlp.ts
 */

import { fileURLToPath } from "node:url";

const OS = Deno.build.os;
const ARCH = Deno.build.arch;

const BUNDLE_DIR = fileURLToPath(new URL("../bundle", import.meta.url));

async function download(url: string, outputPath: string): Promise<void> {
  console.log(`Downloading from ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`,
    );
  }
  const buffer = await response.arrayBuffer();
  await Deno.writeFile(outputPath, new Uint8Array(buffer));

  // Make executable on Unix
  if (OS !== "windows") {
    const perm = await Deno.permissions.query({
      name: "write",
      path: outputPath,
    });
    if (perm.state === "granted") {
      await Deno.chmod(outputPath, 0o755);
    }
  }
}

async function main() {
  await Deno.mkdir(BUNDLE_DIR, { recursive: true });

  const ytDlpPath = OS === "windows"
    ? `${BUNDLE_DIR}/yt-dlp.exe`
    : `${BUNDLE_DIR}/yt-dlp`;

  console.log(`Download yt-dlp for ${OS} (${ARCH})...`);

  let url: string;

  switch (OS) {
    case "linux":
      if (ARCH === "x86_64") {
        url =
          "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
      } else if (ARCH === "aarch64") {
        url =
          "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64";
      } else {
        throw new Error(`Unsupported Linux architecture: ${ARCH}`);
      }
      await download(url, ytDlpPath);
      console.log(`Saved to ${ytDlpPath}`);
      break;

    case "darwin":
      // macOS universal binary
      url =
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
      await download(url, ytDlpPath);
      console.log(`Saved to ${ytDlpPath}`);
      break;

    case "windows":
      url =
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
      await download(url, ytDlpPath);
      console.log(`Saved to ${ytDlpPath}`);
      break;

    default:
      throw new Error(`Unsupported platform: ${OS}`);
  }

  console.log("Done! yt-dlp is ready in the bundle/ directory.");
}

await main();
