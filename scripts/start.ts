#!/usr/bin/env deno run --allow-all
/**
 * Cross-platform start script for Synthesis
 * Set SYNTHESIS_WATCH=true for development mode with auto-reload
 */

import { config } from "../src/config.ts";

const vaultDir = config.vaultDir;
const port = config.port;
const isDev = Deno.env.get("SYNTHESIS_WATCH") === "true";

const os = Deno.build.os;
let tempDir: string;

switch (os) {
  case "windows":
    tempDir = Deno.env.get("TEMP") ?? Deno.env.get("TMP") ?? "C:\\temp";
    break;
  case "darwin":
    tempDir = "/tmp";
    break;
  case "linux":
    tempDir = "/tmp";
    break;
  default:
    tempDir = "/tmp";
}

const args = ["run"];
if (isDev) args.push("--watch");
args.push(
  "--allow-net",
  "--allow-ffi",
  `--allow-read=web,${vaultDir},${tempDir}`,
  `--allow-write=${vaultDir},${tempDir}`,
  "--allow-run=yt-dlp",
  "--allow-env",
  "main.ts",
);

const cmd = new Deno.Command(Deno.execPath(), {
  args,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const process = cmd.spawn();

// Open browser (server typically starts within 1-2s)
const url = `http://localhost:${port}`;
const opener = os === "windows"
  ? ["cmd", "/c", "start", url]
  : os === "darwin"
  ? ["open", url]
  : ["xdg-open", url];

try {
  new Deno.Command(opener[0], { args: opener.slice(1), stdin: "null" }).spawn();
  console.log(`\nOpening browser: ${url}\n`);
} catch {
  console.log(`\nOpen browser to: ${url}\n`);
}

const status = await process.status;
Deno.exit(status.code);
