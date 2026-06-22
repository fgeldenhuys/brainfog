import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**", "dist/**"],
  },
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("../../packages/db/migrations"),
          // Test-only encryption key for connector credential tests (32 random bytes, base64)
          BRAINFOG_CONNECTOR_ENCRYPTION_KEY: "YnJhaW5mb2d0ZXN0LTMyYnl0ZS1rZXktMTIzNDU2Nzg=",
        },
      },
    })),
  ],
});
