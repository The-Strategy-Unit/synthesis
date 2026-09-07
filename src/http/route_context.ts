import type { DB } from "../catalogue/db.ts";
import type { OutputTokenUsageReader } from "../provider/output_token_usage.ts";
import type {
  IngestDependencies,
  IngestGate,
  ProviderResolver,
  ProviderSettingsDependencies,
} from "./support.ts";

export interface ApiRouteContext {
  db: DB;
  identity: string;
  ingestDependencies: IngestDependencies;
  ingestGate: IngestGate;
  method: string;
  path: string;
  providerSettings?: ProviderSettingsDependencies;
  providerUsage: OutputTokenUsageReader;
  req: Request;
  requestId: string;
  resolveProviders: ProviderResolver;
  url: URL;
}

export type ApiRoute = (
  context: ApiRouteContext,
) => Promise<Response | undefined>;
