import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { BrainfogMCP } from "./mcp";

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  DOCUMENTS: R2Bucket;
  MCP_OBJECT: DurableObjectNamespace<BrainfogMCP>;
  OAUTH_KV: KVNamespace;
  // Injected by OAuthProvider for requests it routes to defaultHandler/apiHandler;
  // not present when calling memory.ts service functions directly (e.g. in tests).
  OAUTH_PROVIDER?: OAuthHelpers;
  BRAINFOG_TOKEN_HASH_SECRET: string;
  TEST_MIGRATIONS?: D1Migration[];
}
