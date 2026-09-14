import {
  config,
  dbPath,
  notesDir,
  providerSettingsPath,
  providerUsagePath,
  sourcesDir,
  validateRuntimeConfiguration,
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
import {
  DenoOutputTokenUsageFileStore,
  OutputTokenUsageStore,
} from "../provider/output_token_usage.ts";
import { setChatCompletionUsageRecorder } from "../provider/llm.ts";
import { createHandler } from "../http/routes.ts";
import { KeyringSecretStore } from "../provider/secret_store.ts";
import { ensureWikiSchema } from "../wiki/wiki_schema.ts";
import { ensureVaultManifest } from "../vault/vault_manifest.ts";
import { errMsg } from "../shared/utils.ts";
import { acquireVaultProcessLock } from "../vault/vault_lock.ts";
import {
  completeVaultOperation,
  type PreparedVaultOperation,
  recoverPendingVaultOperations,
} from "../vault/vault_operation.ts";
import { rebuildVaultCatalogue } from "../vault/vault_rebuild.ts";

export function closeCatalogueOnServerFinish(
  server: Pick<Deno.HttpServer, "finished">,
  db: Pick<DB, "close">,
  cleanup: () => void = () => undefined,
): Promise<void> {
  const close = () => {
    try {
      db.close();
    } catch (error) {
      console.error(`Catalogue shutdown failed: ${errMsg(error)}`);
    }
    try {
      cleanup();
    } catch (error) {
      console.error(`Application shutdown cleanup failed: ${errMsg(error)}`);
    }
  };
  return server.finished.then(close, close);
}

export interface ApplicationSession {
  close(): Promise<void>;
  finished: Promise<void>;
  server: Deno.HttpServer;
}

export interface ApplicationOptions {
  onVaultSwitch?: () => void | Promise<void>;
}

async function ensureOrdinaryDirectory(
  path: string,
  label: string,
): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
  const info = await Deno.lstat(path);
  if (info.isSymlink || !info.isDirectory) {
    throw new Error(`${label} must be an ordinary directory`);
  }
}

export async function startApplication(
  signal?: AbortSignal,
  options: ApplicationOptions = {},
): Promise<ApplicationSession> {
  validateRuntimeConfiguration();
  const vaultDirectory = config.vaultDir;

  await ensureOrdinaryDirectory(vaultDirectory, "Vault storage");
  const vaultLock = acquireVaultProcessLock(vaultDirectory);
  let recoveredOperations: PreparedVaultOperation[];
  try {
    await ensureOrdinaryDirectory(notesDir(), "Vault notes");
    await ensureOrdinaryDirectory(sourcesDir(), "Vault sources");
    await ensureOrdinaryDirectory(`${vaultDirectory}/history`, "Vault history");
    await ensureVaultManifest();
    await ensureWikiSchema();
    recoveredOperations = await recoverPendingVaultOperations(vaultDirectory);
  } catch (error) {
    try {
      vaultLock.release();
    } catch (cleanupError) {
      console.error(`Vault lock cleanup failed: ${errMsg(cleanupError)}`);
    }
    throw error;
  }
  let db: DB;
  let openedDb: DB | undefined;
  try {
    openedDb = new DB(dbPath());
    db = openedDb;
    if (recoveredOperations.length > 0) {
      await rebuildVaultCatalogue(db);
      for (const operation of recoveredOperations) {
        await completeVaultOperation(operation);
      }
    }
  } catch (error) {
    try {
      openedDb?.close();
    } catch (cleanupError) {
      console.error(`Catalogue cleanup failed: ${errMsg(cleanupError)}`);
    }
    try {
      vaultLock.release();
    } catch (cleanupError) {
      console.error(`Vault lock cleanup failed: ${errMsg(cleanupError)}`);
    }
    throw error;
  }
  const profileStore = new ProviderProfileStore(
    providerSettingsPath(),
    new DenoProfileFileStore(),
  );
  const usageStore = new OutputTokenUsageStore(
    providerUsagePath(),
    new DenoOutputTokenUsageFileStore(),
  );
  const stopUsageAccounting = setChatCompletionUsageRecorder(
    ({ outputTokens, recordedAt }) =>
      usageStore.record(outputTokens, recordedAt).then(() => undefined),
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

  const serverController = new AbortController();
  const abortServer = () => serverController.abort();
  signal?.addEventListener("abort", abortServer, { once: true });
  if (signal?.aborted) abortServer();
  try {
    const server = Deno.serve(
      {
        hostname: config.host,
        port: config.port,
        signal: serverController.signal,
      },
      createHandler(
        db,
        resolveProviders,
        {
          profiles: profileStore,
          secrets: KeyringSecretStore.create,
        },
        undefined,
        usageStore,
        { onVaultSwitch: options.onVaultSwitch },
      ),
    );
    const finished = closeCatalogueOnServerFinish(server, db, () => {
      signal?.removeEventListener("abort", abortServer);
      try {
        stopUsageAccounting();
      } finally {
        vaultLock.release();
      }
    });
    let closePromise: Promise<void> | undefined;
    return {
      server,
      finished,
      close() {
        closePromise ??= (async () => {
          signal?.removeEventListener("abort", abortServer);
          if (serverController.signal.aborted) await server.finished;
          else await server.shutdown();
          await finished;
        })();
        return closePromise;
      },
    };
  } catch (error) {
    signal?.removeEventListener("abort", abortServer);
    try {
      stopUsageAccounting();
    } catch (cleanupError) {
      console.error(`Usage cleanup failed: ${errMsg(cleanupError)}`);
    }
    try {
      db.close();
    } catch (cleanupError) {
      console.error(`Catalogue cleanup failed: ${errMsg(cleanupError)}`);
    }
    try {
      vaultLock.release();
    } catch (cleanupError) {
      console.error(`Vault lock cleanup failed: ${errMsg(cleanupError)}`);
    }
    throw error;
  }
}
