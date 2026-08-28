import { config } from "../app/config.ts";

export interface VaultManifest {
  formatVersion: 1;
  vaultId: string;
  createdAt: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function vaultManifestPath(): string {
  return `${config.vaultDir}/vault.json`;
}

export function validateVaultManifest(value: unknown): VaultManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Vault manifest must be a JSON object");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.formatVersion !== 1) {
    throw new Error("Vault manifest formatVersion must be 1");
  }
  if (
    typeof manifest.vaultId !== "string" ||
    !UUID_PATTERN.test(manifest.vaultId)
  ) {
    throw new Error("Vault manifest vaultId must be a UUID");
  }
  if (
    typeof manifest.createdAt !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(manifest.createdAt) ||
    Number.isNaN(Date.parse(manifest.createdAt))
  ) {
    throw new Error("Vault manifest createdAt must be an ISO UTC timestamp");
  }
  return {
    formatVersion: 1,
    vaultId: manifest.vaultId,
    createdAt: manifest.createdAt,
  };
}

async function readVaultManifest(): Promise<VaultManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(vaultManifestPath()));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Vault manifest contains invalid JSON");
    }
    throw error;
  }
  return validateVaultManifest(value);
}

/** Create one stable local vault identity, or validate and return the existing one. */
export async function ensureVaultManifest(): Promise<VaultManifest> {
  await Deno.mkdir(config.vaultDir, { recursive: true });
  const manifest: VaultManifest = {
    formatVersion: 1,
    vaultId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  try {
    await Deno.writeTextFile(
      vaultManifestPath(),
      JSON.stringify(manifest, null, 2) + "\n",
      { createNew: true },
    );
    return manifest;
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    return await readVaultManifest();
  }
}
