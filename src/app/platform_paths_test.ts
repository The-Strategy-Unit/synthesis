import assert from "node:assert/strict";

import {
  defaultAppDataDirectory,
  defaultVaultDirectory,
  platformHomeDirectory,
} from "./platform_paths.ts";

Deno.test("Windows defaults use native profile paths instead of MSYS HOME", () => {
  const environment = {
    APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
    HOME: "/c/Users/Ada",
    USERPROFILE: "C:\\Users\\Ada",
  };

  assert.equal(
    platformHomeDirectory("windows", environment),
    "C:\\Users\\Ada",
  );
  assert.equal(
    defaultVaultDirectory("windows", environment),
    "C:\\Users\\Ada\\Synthesis",
  );
  assert.equal(
    defaultAppDataDirectory("windows", environment),
    "C:\\Users\\Ada\\AppData\\Roaming\\Synthesis",
  );
});

Deno.test("Windows defaults support standard home fallbacks", () => {
  assert.equal(
    defaultVaultDirectory("windows", {
      HOME: "/c/Users/Wrong",
      HOMEDRIVE: "D:",
      HOMEPATH: "\\Profiles\\Grace",
    }),
    "D:\\Profiles\\Grace\\Synthesis",
  );
  assert.equal(
    defaultVaultDirectory("windows", { HOME: "E:\\Users\\Lin" }),
    "E:\\Users\\Lin\\Synthesis",
  );
  assert.equal(
    defaultVaultDirectory("windows", { HOME: "/c/Users/NotNative" }),
    "Synthesis",
  );
});

Deno.test("POSIX defaults use HOME and platform configuration conventions", () => {
  const linuxEnvironment = {
    HOME: "/home/ada",
    USERPROFILE: "C:\\Users\\Wrong",
    XDG_CONFIG_HOME: "/home/ada/.local/config",
  };
  assert.equal(
    defaultVaultDirectory("linux", linuxEnvironment),
    "/home/ada/Synthesis",
  );
  assert.equal(
    defaultAppDataDirectory("linux", linuxEnvironment),
    "/home/ada/.local/config/synthesis",
  );
  assert.equal(
    defaultAppDataDirectory("darwin", { HOME: "/Users/Ada" }),
    "/Users/Ada/Library/Application Support/Synthesis",
  );
});
