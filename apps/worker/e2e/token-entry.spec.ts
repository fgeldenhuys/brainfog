import process from "node:process";
import { expect, test } from "@playwright/test";

test("token-entry flow: rejects invalid tokens, accepts a valid one, and remembers the session", async ({
  page,
}) => {
  const token = process.env.E2E_TOKEN;
  const userName = process.env.E2E_USER_NAME;
  if (!token || !userName) {
    throw new Error("E2E_TOKEN/E2E_USER_NAME not set — did globalSetup run?");
  }

  await page.goto("/");
  await expect(page.getByLabel("Bearer token")).toBeVisible();

  await page.getByLabel("Bearer token").fill("not-a-real-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Invalid token.")).toBeVisible();

  await page.getByLabel("Bearer token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${userName}`)).toBeVisible();

  await page.reload();
  await expect(page.getByText(`Signed in as ${userName}`)).toBeVisible();
});
