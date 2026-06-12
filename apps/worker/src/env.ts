import type { BrainfogMCP } from "./mcp";

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  DOCUMENTS: R2Bucket;
  MCP_OBJECT: DurableObjectNamespace<BrainfogMCP>;
  BRAINFOG_TOKEN_HASH_SECRET: string;
}
