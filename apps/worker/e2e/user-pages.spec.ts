import { expect, test } from "@playwright/test";
import { TOKEN } from "./global-setup";

test("user pages can be created, rendered, and opened with a pre-auth link", async ({
  page,
  request,
}) => {
  const pageResponse = await request.post("/api/v1/ui/pages", {
    headers: { Authorization: `Bearer ${TOKEN}` },
    data: {
      title: "Daily Review",
      slug: "daily-review",
      status: "published",
      template: "<section><h1>{{page.title}}</h1>{{^items}}No items yet.{{/items}}</section>",
      queries: { items: { kind: "thoughts", limit: 5 } },
    },
  });
  expect(pageResponse.status()).toBe(201);
  const pageJson = (await pageResponse.json()) as { id: string };

  await page.goto("/");
  await page.getByLabel("Bearer token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Welcome, Playwright E2E")).toBeVisible();

  await page.goto("/playwright-e2e/daily-review");
  await expect(page.getByRole("heading", { name: "Daily Review" })).toBeVisible();
  await expect(page.getByText("No items yet.")).toBeVisible();

  const linkResponse = await request.post(`/api/v1/ui/pages/${pageJson.id}/access-links`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    data: { ttl_seconds: 3600, max_uses: 1, label: "e2e" },
  });
  expect(linkResponse.status()).toBe(201);
  const linkJson = (await linkResponse.json()) as { url: string };

  const guest = await page.context().browser()?.newContext();
  if (!guest) throw new Error("browser context unavailable");
  const guestPage = await guest.newPage();
  await guestPage.goto(linkJson.url);
  await expect(guestPage).toHaveURL(/\/playwright-e2e\/daily-review$/);
  await expect(guestPage.getByRole("heading", { name: "Daily Review" })).toBeVisible();

  const appResponse = await guestPage.goto("/app");
  expect(appResponse?.url()).toMatch(/\/$/);
  await guest.close();
});
