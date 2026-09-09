import { posix, win32 } from "node:path";

export interface PlatformEnvironment {
  APPDATA?: string;
  HOME?: string;
  HOMEDRIVE?: string;
  HOMEPATH?: string;
  USERPROFILE?: string;
  XDG_CONFIG_HOME?: string;
}

function environmentPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function nativeWindowsHome(
  environment: PlatformEnvironment,
): string | undefined {
  const userProfile = environmentPath(environment.USERPROFILE);
  if (userProfile) return userProfile;

  const homeDrive = environmentPath(environment.HOMEDRIVE);
  const homePath = environmentPath(environment.HOMEPATH);
  if (homeDrive && homePath) {
    return win32.join(`${homeDrive}\\`, homePath.replace(/^[\\/]+/, ""));
  }

  const home = environmentPath(environment.HOME);
  return home && (/^[a-z]:[\\/]/i.test(home) || /^\\\\/.test(home))
    ? home
    : undefined;
}

export function platformHomeDirectory(
  os: typeof Deno.build.os,
  environment: PlatformEnvironment,
): string {
  if (os === "windows") return nativeWindowsHome(environment) ?? ".";
  return environmentPath(environment.HOME) ?? ".";
}

export function defaultVaultDirectory(
  os: typeof Deno.build.os,
  environment: PlatformEnvironment,
): string {
  const paths = os === "windows" ? win32 : posix;
  return paths.join(platformHomeDirectory(os, environment), "Synthesis");
}

export function defaultAppDataDirectory(
  os: typeof Deno.build.os,
  environment: PlatformEnvironment,
): string {
  const home = platformHomeDirectory(os, environment);
  if (os === "windows") {
    return win32.join(
      environmentPath(environment.APPDATA) ?? home,
      "Synthesis",
    );
  }
  if (os === "darwin") {
    return posix.join(home, "Library", "Application Support", "Synthesis");
  }
  return posix.join(
    environmentPath(environment.XDG_CONFIG_HOME) ?? posix.join(home, ".config"),
    "synthesis",
  );
}
