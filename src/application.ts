import {
  config,
  dbPath,
  notesDir,
  providerSettingsPath,
  sourcesDir,
} from "./config.ts";
import { DB } from "./db.ts";
import {
  DenoProfileFileStore,
  ProviderProfileStore,
} from "./provider_profile_store.ts";
import {
  embeddingIdentity,
  resolveActiveProviders,
} from "./provider_runtime.ts";
import { createHandler } from "./routes.ts";
import { KeyringSecretStore } from "./secret_store.ts";
import { ensureWikiSchema } from "./wiki_schema.ts";
import { ensureVaultManifest } from "./vault_manifest.ts";

export async function startApplication(
  signal?: AbortSignal,
): Promise<Deno.HttpServer> {
  const vaultDirectory = config.vaultDir;

  await Deno.mkdir(vaultDirectory, { recursive: true });
  await Deno.mkdir(notesDir(), { recursive: true });
  await Deno.mkdir(sourcesDir(), { recursive: true });
  await ensureVaultManifest();
  await ensureWikiSchema();

  const db = new DB(dbPath());
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

  return Deno.serve(
    { hostname: config.host, port: config.port, signal },
    createHandler(db, resolveProviders, {
      profiles: profileStore,
      secrets: KeyringSecretStore.create,
    }),
  );
}
