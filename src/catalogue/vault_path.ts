import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";

import type { DatabaseSync } from "node:sqlite";

interface StoredPathRow {
  id: number;
  file_path: string;
}

function portableSegments(path: string): string[] {
  if (!path || path.length > 4_096 || /\p{Cc}/u.test(path)) {
    throw new Error("Catalogue file path is invalid");
  }
  const normalised = path.replaceAll("\\", "/");
  if (
    normalised.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalised)
  ) {
    throw new Error("Catalogue file path must be vault-relative");
  }
  const segments = normalised.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Catalogue file path must stay inside the vault");
  }
  return segments;
}

function legacyVaultPaths(
  path: string,
  directory: "notes" | "sources",
): string[] {
  const normalised = path.replaceAll("\\", "/");
  const marker = `/${directory}/`;
  const candidates: string[] = [];
  for (
    let index = normalised.indexOf(marker);
    index >= 0;
    index = normalised.indexOf(marker, index + marker.length)
  ) {
    candidates.push(normalised.slice(index + 1));
  }
  return candidates;
}

/** Encodes portable catalogue paths while exposing absolute paths to callers. */
export class VaultPathResolver {
  readonly vaultDirectory: string;

  constructor(databasePath: string) {
    this.vaultDirectory = resolve(dirname(databasePath));
  }

  store(filePath: string): string {
    if (isAbsolute(filePath)) {
      const candidate = resolve(filePath);
      const fromVault = relative(this.vaultDirectory, candidate);
      if (
        fromVault &&
        !isAbsolute(fromVault) &&
        fromVault !== ".." &&
        !fromVault.startsWith(`..${sep}`)
      ) {
        return portableSegments(fromVault).join("/");
      }
    }

    return portableSegments(filePath).join("/");
  }

  normaliseStoredPath(
    storedPath: string,
    directory: "notes" | "sources",
  ): string {
    if (
      !storedPath || storedPath.length > 4_096 || /\p{Cc}/u.test(storedPath)
    ) {
      throw new Error("Catalogue file path is invalid");
    }
    try {
      return this.store(storedPath);
    } catch (error) {
      const candidates = legacyVaultPaths(storedPath, directory).map((path) =>
        portableSegments(path).join("/")
      );
      if (candidates.length === 1) return candidates[0];
      const existing = candidates.filter((path) =>
        existsSync(this.resolve(path))
      );
      if (existing.length === 1) return existing[0];
      if (candidates.length > 1) {
        throw new Error("Legacy catalogue file path is ambiguous");
      }
      throw error;
    }
  }

  resolve(storedPath: string): string {
    return resolve(this.vaultDirectory, ...portableSegments(storedPath));
  }
}

/** Normalise legacy absolute paths without changing the rebuildable schema. */
export function normaliseCataloguePaths(
  db: DatabaseSync,
  paths: VaultPathResolver,
): void {
  const tables = ["notes", "sources"] as const;
  const changes = tables.flatMap((table) =>
    (db.prepare(`SELECT id, file_path FROM ${table}`)
      .all() as unknown as StoredPathRow[]).flatMap((row) => {
        const directory = table === "notes" ? "notes" : "sources";
        const storedPath = paths.normaliseStoredPath(row.file_path, directory);
        return storedPath === row.file_path
          ? []
          : [{ table, id: row.id, storedPath }];
      })
  );
  if (changes.length === 0) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const change of changes) {
      db.prepare(`UPDATE ${change.table} SET file_path = ? WHERE id = ?`).run(
        change.storedPath,
        change.id,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the validation or uniqueness error that caused the rollback.
    }
    throw error;
  }
}
