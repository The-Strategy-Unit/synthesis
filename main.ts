import { startApplication } from "./src/app/application.ts";
import {
  SUPERVISED_VAULT_SWITCH_ARGUMENT,
  VAULT_SWITCH_EXIT_CODE,
} from "./src/app/process_protocol.ts";

if (import.meta.main) {
  const supervised = Deno.args.length === 1 &&
    Deno.args[0] === SUPERVISED_VAULT_SWITCH_ARGUMENT;
  if (Deno.args.length > (supervised ? 1 : 0)) {
    throw new Error(
      `Usage: main.ts [${SUPERVISED_VAULT_SWITCH_ARGUMENT}]`,
    );
  }
  let requestSwitch!: () => void;
  const switchRequested = new Promise<void>((resolve) => {
    requestSwitch = resolve;
  });
  const session = await startApplication(undefined, {
    onVaultSwitch: supervised ? requestSwitch : undefined,
  });
  const outcome = await Promise.race([
    session.finished.then(() => "finished" as const),
    switchRequested.then(() => "switch" as const),
  ]);
  if (outcome === "switch") {
    await session.close();
    Deno.exit(VAULT_SWITCH_EXIT_CODE);
  }
}
