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

test("mobile smoke: chat-first thread flow + sheet controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");

  await page.addInitScript(() => {
    const applyPortalStyle = () => {
      const existing = document.getElementById("lcwa-e2e-nextjs-portal-style");
      if (existing) {
        return;
      }
      const style = document.createElement("style");
      style.id = "lcwa-e2e-nextjs-portal-style";
      style.textContent = "nextjs-portal { pointer-events: none !important; }";
      document.head.append(style);
    };
    if (document.head) {
      applyPortalStyle();
    } else {
      document.addEventListener("DOMContentLoaded", applyPortalStyle, { once: true });
    }
  });

  await page.goto("/");
  await expect(page.getByText("Gateway connected")).toBeVisible();

  await page.getByRole("button", { name: "New thread" }).first().click();
  await expect(page).toHaveURL(/\/threads\//);
  const topbar = page.getByTestId("mobile-chat-topbar");
  await expect(topbar).toBeVisible();
  await expect(topbar).toHaveCSS("position", "fixed");
  await page.evaluate(() => {
    const timeline = document.querySelector(".cdx-mobile-message-stream");
    if (timeline instanceof HTMLElement) {
      timeline.scrollTop = timeline.scrollHeight;
    }
  });
  await expect(topbar).toBeVisible();
  await expect
    .poll(() =>
      topbar.evaluate((node) => Math.round(node.getBoundingClientRect().top)),
    )
    .toBeLessThanOrEqual(0);
  await expect(page.getByText("THREADS")).toHaveCount(0);
  await expect(page.locator(".cdx-mobile-thread-main")).toHaveCSS("overflow-y", "hidden");
  await expect(page.locator(".cdx-mobile-message-stream")).toHaveCSS("overflow-y", "auto");

  await page.getByTestId("mobile-topbar-control-toggle").evaluate((node: HTMLElement) => {
    node.click();
  });
  await expect(page.getByTestId("mobile-control-sheet")).toBeVisible();
  await page.getByTestId("mobile-control-sheet-close").evaluate((node: HTMLElement) => {
    node.click();
  });
  await expect(page.getByTestId("mobile-control-sheet")).toHaveCount(0);

  await page.getByLabel("Open threads").evaluate((node: HTMLElement) => {
    node.click();
  });
  await expect(page.getByTestId("mobile-thread-switcher-overlay")).toBeVisible();
  await page.getByTestId("mobile-thread-switcher-close").click();
  await expect(page.getByTestId("mobile-thread-switcher-overlay")).toHaveCount(0);

  await page.goto("/");
  await page.getByRole("button", { name: "New thread" }).first().click();
  await expect(page).toHaveURL(/\/threads\//);

  await page.getByLabel("Open threads").click();
  const items = page.getByTestId("mobile-thread-switcher-item");
  await expect
    .poll(() => items.count(), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(2);
  const switchTarget = page.locator(".cdx-mobile-thread-switcher-item:not(.is-active)").first();
  await expect(switchTarget).toBeVisible();
  const beforeSwitchUrl = page.url();
  await switchTarget.click();
  await expect
    .poll(() => page.url(), {
      timeout: 10_000,
    })
    .not.toBe(beforeSwitchUrl);

  await page.getByTestId("turn-input").fill("mobile flow");
  await page.getByTestId("turn-submit").click();

  await page.getByTestId("mobile-topbar-control-toggle").click();
  await expect(page.getByTestId("mobile-control-sheet")).toBeVisible();
  await page.getByTestId("mobile-control-tab-approvals").click();
  await page.getByTestId("approval-allow").first().click();
  await page.getByTestId("mobile-control-tab-controls").click();

  await page.getByTestId("control-stop").click();

  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    )
    .toBeLessThanOrEqual(0);
});

test("events UI: connection status and cursor updates", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");

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
