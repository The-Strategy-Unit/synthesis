import { config } from "../app/config.ts";
import {
  validateVaultManifest,
  type VaultManifest,
} from "./vault_manifest_format.ts";

export {
  validateVaultManifest,
  type VaultManifest,
} from "./vault_manifest_format.ts";

export function vaultManifestPath(): string {
  return `${config.vaultDir}/vault.json`;
}

export async function loadVaultManifest(): Promise<VaultManifest> {
  const info = await Deno.lstat(vaultManifestPath());
  if (info.isSymlink || !info.isFile) {
    throw new Error("Vault manifest must be an ordinary file");
  }
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
    return await loadVaultManifest();
  }
}
