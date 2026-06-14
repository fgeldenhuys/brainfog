import process from "node:process";
import { expect, test } from "@playwright/test";

test("token-entry flow: rejects invalid tokens, accepts a valid one, and remembers the session", async ({
  page,
}) => {
  const token = process.env.E2E_TOKEN;
  const userName = process.env.E2E_USER_NAME;
  const nonAdminToken = process.env.E2E_NON_ADMIN_TOKEN;
  if (!token || !userName) {
    throw new Error("E2E_TOKEN/E2E_USER_NAME not set — did globalSetup run?");
  }
  if (!nonAdminToken) {
    throw new Error("E2E_NON_ADMIN_TOKEN not set — did globalSetup run?");
  }

  await page.context().clearCookies();
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

  await page.getByRole("link", { name: "Browser" }).click();
  await expect(page.getByRole("heading", { name: "Data Browser" })).toBeVisible();
  await page.getByRole("link", { name: "Documents" }).click();
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();

  await page.getByRole("link", { name: "New Document" }).click();
  await page.getByLabel("Title").fill(`E2E Markdown ${Date.now()}`);
  await page.getByLabel("Type").selectOption("text/markdown");
  await page
    .getByLabel("Content")
    .fill("# E2E Rendered Markdown\n\n<script>alert('x')</script>\n\n[bad](javascript:alert('x'))");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("link", { name: "Open Reader" }).click();
  await expect(page.getByRole("heading", { name: "E2E Rendered Markdown" })).toBeVisible();
  await expect(page.locator("script", { hasText: "alert('x')" })).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);

  await page.getByRole("link", { name: "Metrics" }).click();
  await expect(page.getByRole("heading", { name: "Metrics Dashboard" })).toBeVisible();
  await expect(page.getByText("Recallable rows")).toBeVisible();

  await page.getByRole("link", { name: "Users" }).click();
  await expect(page.getByRole("heading", { name: "User Management" })).toBeVisible();

  await page.context().clearCookies();
  await page.goto("/");
  await page.getByLabel("Bearer token").fill(nonAdminToken);
  await page.getByRole("button", { name: "Sign in" }).click();
  const usersResponse = await page.goto("/app/users");
  expect(usersResponse?.status()).toBe(403);
  await expect(page.getByRole("heading", { name: "Forbidden" })).toBeVisible();
});
