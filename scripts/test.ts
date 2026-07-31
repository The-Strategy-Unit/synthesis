#!/usr/bin/env deno run --allow-all
/**
 * Cross-platform test runner
 * Resolves correct paths for the current OS before running tests
 */

import { config } from "../src/config.ts";

const vaultDir = config.vaultDir;

const cmd = new Deno.Command(Deno.execPath(), {
  args: [
    "test",
    "--allow-net",
    `--allow-read=web,${vaultDir}`,
    `--allow-write=${vaultDir}`,
    "--allow-run=yt-dlp",
    "--allow-env",
    "--allow-scripts",
  ],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const status = await cmd.spawn().status;
Deno.exit(status.code);
