import type { DB } from "../catalogue/db.ts";
import type {
  IngestDependencies,
  IngestGate,
  ProviderResolver,
  ProviderSettingsDependencies,
  SemanticSearchGate,
} from "./support.ts";

export interface ApiRouteContext {
  db: DB;
  identity: string;
  ingestDependencies: IngestDependencies;
  ingestGate: IngestGate;
  method: string;
  path: string;
  providerSettings?: ProviderSettingsDependencies;
  req: Request;
  requestId: string;
  resolveProviders: ProviderResolver;
  semanticSearchGate: SemanticSearchGate;
  url: URL;
}

export type ApiRoute = (
  context: ApiRouteContext,
) => Promise<Response | undefined>;
