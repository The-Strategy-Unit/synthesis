import { config, dbPath, notesDir, sourcesDir } from "./src/config.ts";
import { DB } from "./src/db.ts";
import { createHandler } from "./src/routes.ts";

const vault_dir = config.vaultDir;
const db_path = dbPath();

try {
  await Deno.stat(vault_dir);
} catch {
  console.error(`Vault directory not found: ${vault_dir}`);
  console.error(`Run \`mkdir -p ${vault_dir}/notes\` first.`);
  Deno.exit(1);
}
await Deno.mkdir(notesDir(), { recursive: true });
await Deno.mkdir(sourcesDir(), { recursive: true });

const db = new DB(db_path);

Deno.serve(
  { hostname: config.host, port: config.port },
  createHandler(db),
);
