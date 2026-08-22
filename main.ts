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
import {
  embeddingIdentity,
  resolveActiveProviders,
} from "./src/provider_runtime.ts";
import { createHandler } from "./src/routes.ts";
import { KeyringSecretStore } from "./src/secret_store.ts";
import { ensureWikiSchema } from "./src/wiki_schema.ts";
import { ensureVaultManifest } from "./src/vault_manifest.ts";

const vault_dir = config.vaultDir;
const db_path = dbPath();

await Deno.mkdir(vault_dir, { recursive: true });
await Deno.mkdir(notesDir(), { recursive: true });
await Deno.mkdir(sourcesDir(), { recursive: true });
await ensureVaultManifest();
await ensureWikiSchema();

const db = new DB(db_path);
const profileStore = new ProviderProfileStore(
  providerSettingsPath(),
  new DenoProfileFileStore(),
);
const resolveProviders = () =>
  resolveActiveProviders(profileStore, KeyringSecretStore.create);

try {
  const providers = await resolveProviders();
  db.activateSemanticIndex(embeddingIdentity(providers.embedding));
} catch {
  // Provider-free reading remains available. Existing identified semantic
  // state is retained and will be revalidated when a provider is configured.
}

Deno.serve(
  { hostname: config.host, port: config.port },
  createHandler(db, resolveProviders, {
    profiles: profileStore,
    secrets: KeyringSecretStore.create,
  }),
);
