import process from "node:process";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: "http://localhost:8787",
  },
  webServer: {
    command: "pnpm dev",
    cwd: "..",
    url: "http://localhost:8787",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
