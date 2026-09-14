import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export class VaultAlreadyOpenError extends Error {
  constructor() {
    super("This vault is already open in another Synthesis process");
    this.name = "VaultAlreadyOpenError";
  }
}

export interface VaultProcessLock {
  release(): void;
}

/**
 * Hold a separate SQLite exclusive transaction for the process lifetime.
 * SQLite delegates ownership to OS file locks, including crash cleanup.
 */
export function acquireVaultProcessLock(
  vaultDirectory: string,
): VaultProcessLock {
  const lockPath = join(vaultDirectory, ".synthesis-lock.db");
  try {
    const info = Deno.lstatSync(lockPath);
    if (info.isSymlink || !info.isFile || info.size > 1024 * 1024) {
      throw new Error("Vault process lock must be a small ordinary file");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const database = new DatabaseSync(lockPath);
  let held = false;
  try {
    database.exec("PRAGMA busy_timeout = 0");
    database.exec(
      "CREATE TABLE IF NOT EXISTS vault_owner (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))",
    );
    database.exec("BEGIN EXCLUSIVE");
    database.prepare(
      "INSERT OR IGNORE INTO vault_owner (singleton) VALUES (1)",
    ).run();
    held = true;
  } catch (error) {
    database.close();
    if (
      error instanceof Error &&
      /(?:locked|busy)/i.test(error.message)
    ) {
      throw new VaultAlreadyOpenError();
    }
    throw error;
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        if (held) database.exec("ROLLBACK");
      } finally {
        held = false;
        database.close();
      }
    },
  };
}
