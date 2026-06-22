import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { GarminSpikeContainer } from "./garmin-spike-container";
import type { BrainfogMCP } from "./mcp";

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  DOCUMENTS: R2Bucket;
  D1_BACKUPS: R2Bucket;
  D1_BACKUP_WORKFLOW: Workflow;
  MCP_OBJECT: DurableObjectNamespace<BrainfogMCP>;
  GARMIN_SPIKE_CONTAINER?: DurableObjectNamespace<GarminSpikeContainer>;
  OAUTH_KV: KVNamespace;
  // Injected by OAuthProvider for requests it routes to defaultHandler/apiHandler;
  // not present when calling memory.ts service functions directly (e.g. in tests).
  OAUTH_PROVIDER?: OAuthHelpers;
  BRAINFOG_TOKEN_HASH_SECRET: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  D1_DATABASE_ID: string;
  D1_REST_API_TOKEN: string;
  BRAINFOG_CONNECTOR_ENCRYPTION_KEY?: string;
  TEST_MIGRATIONS?: D1Migration[];
}
