#!/usr/bin/env deno run --allow-all
/**
 * Cross-platform migration script wrapper
 * Handles path resolution for different operating systems
 */

import { config } from "../src/app/config.ts";

const defaultOldDb = "./output/synthesis.db";
const defaultNewDb = `${config.vaultDir}/synthesis.db`;

const oldDbArg = Deno.args[0];
const newDbArg = Deno.args[1];

const oldDb = oldDbArg ?? defaultOldDb;
const newDb = newDbArg ?? defaultNewDb;

const cmd = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "--allow-all",
    "src/vault/migrate.ts",
    oldDb,
    newDb,
  ],
  cwd: Deno.cwd(),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const status = await cmd.spawn().status;
Deno.exit(status.code);
