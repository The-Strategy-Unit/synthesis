import {
  config,
  dbPath,
  notesDir,
  providerSettingsPath,
  sourcesDir,
} from "./src/config.ts";
import { DB } from "./src/db.ts";
import {
  DenoProfileFileStore,
  ProviderProfileStore,
} from "./src/provider_profile_store.ts";
import { resolveActiveProviders } from "./src/provider_runtime.ts";
import { createHandler } from "./src/routes.ts";
import { KeyringSecretStore } from "./src/secret_store.ts";

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
const profileStore = new ProviderProfileStore(
  providerSettingsPath(),
  new DenoProfileFileStore(),
);
const resolveProviders = () =>
  resolveActiveProviders(profileStore, KeyringSecretStore.create);

Deno.serve(
  { hostname: config.host, port: config.port },
  createHandler(db, resolveProviders),
);
