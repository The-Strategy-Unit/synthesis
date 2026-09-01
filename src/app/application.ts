import {
  config,
  dbPath,
  notesDir,
  providerSettingsPath,
  sourcesDir,
} from "./config.ts";
import { DB } from "../catalogue/db.ts";
import {
  DenoProfileFileStore,
  ProviderProfileStore,
} from "../provider/provider_profile_store.ts";
import {
  embeddingIdentity,
  resolveActiveProviders,
} from "../provider/provider_runtime.ts";
import { createHandler } from "../http/routes.ts";
import { KeyringSecretStore } from "../provider/secret_store.ts";
import { ensureWikiSchema } from "../wiki/wiki_schema.ts";
import { ensureVaultManifest } from "../vault/vault_manifest.ts";
import { errMsg } from "../shared/utils.ts";

export function closeCatalogueOnServerFinish(
  server: Pick<Deno.HttpServer, "finished">,
  db: Pick<DB, "close">,
): void {
  const close = () => {
    try {
      db.close();
    } catch (error) {
      console.error(`Catalogue shutdown failed: ${errMsg(error)}`);
    }
  };
  void server.finished.then(close, close);
}

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
    db.search.activateSemanticIndex(embeddingIdentity(providers.embedding));
  } catch {
    // Provider-free reading remains available. Existing identified semantic
    // state is retained and will be revalidated when a provider is configured.
  }

  try {
    const server = Deno.serve(
      { hostname: config.host, port: config.port, signal },
      createHandler(db, resolveProviders, {
        profiles: profileStore,
        secrets: KeyringSecretStore.create,
      }),
    );
    closeCatalogueOnServerFinish(server, db);
    return server;
  } catch (error) {
    db.close();
    throw error;
  }
}
