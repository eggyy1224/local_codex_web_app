import { expect, test } from "@playwright/test";

test("desktop smoke: home -> new thread -> send turn -> timeline render", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");

  await page.goto("/");
  await expect(page.getByText("Gateway connected")).toBeVisible();

  const composer = page.locator("textarea").first();
  await composer.fill("Build a smoke test flow");
  await composer.press("Enter");

  await expect(page).toHaveURL(/\/threads\//);
  await expect(page.getByTestId("turn-input")).toBeVisible();

  await page.getByTestId("turn-input").fill("second turn");
  await page.getByTestId("turn-submit").click();

  await expect(page.getByTestId("timeline")).toContainText("Codex");
});

test("mobile smoke: thread flow + approval drawer + control buttons", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");

  await page.goto("/");
  await expect(page.getByText("Gateway connected")).toBeVisible();

  await page.getByRole("button", { name: "New thread" }).first().click();
  await expect(page).toHaveURL(/\/threads\//);
  await expect(page.getByTestId("mobile-thread-context")).toBeVisible();
  await expect(page.getByText("THREADS")).toHaveCount(0);

  await page.getByTestId("mobile-thread-switcher-toggle").click();
  await expect(page.getByTestId("mobile-thread-switcher-overlay")).toBeVisible();
  await page.getByTestId("mobile-thread-switcher-close").click();
  await expect(page.getByTestId("mobile-thread-switcher-overlay")).toHaveCount(0);

  await page.getByRole("button", { name: "New thread" }).first().click();
  await expect(page).toHaveURL(/\/threads\//);

  await page.getByTestId("mobile-thread-switcher-toggle").click();
  const items = page.getByTestId("mobile-thread-switcher-item");
  await expect(items).toHaveCount(2);
  const beforeSwitchUrl = page.url();
  await items.nth(1).click();
  await expect
    .poll(() => page.url(), {
      timeout: 10_000,
    })
    .not.toBe(beforeSwitchUrl);

  await page.getByTestId("turn-input").fill("mobile flow");
  await page.getByTestId("turn-submit").click();

  await expect(page.getByTestId("approval-drawer")).toBeVisible();
  await page.getByTestId("approval-allow").click();
  await expect(page.getByText(/Pending approval: 0/)).toBeVisible();

  await expect(page.getByTestId("control-stop")).toBeVisible();
  await page.getByTestId("control-stop").click();
});

test("events UI: connection status and cursor updates", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Gateway connected")).toBeVisible();

  await page.getByRole("button", { name: "New thread" }).first().click();
  await expect(page).toHaveURL(/\/threads\//);

  const cursor = page.getByTestId("event-cursor");
  await expect(cursor).toHaveText("0");

  await page.getByTestId("turn-input").fill("cursor update");
  await page.getByTestId("turn-submit").click();

  await expect
    .poll(async () => Number(await cursor.textContent()), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  await expect(page.getByText(/Connected|Reconnecting|Lagging/)).toBeVisible();
});
