import { expect, test } from "@playwright/test";

const gatewayPort = process.env.PLAYWRIGHT_GATEWAY_PORT ?? "8877";
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((url) => {
    window.localStorage.setItem("lcwa.gatewayUrl.v1", url);
  }, gatewayUrl);
});

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
  await expect(page.getByRole("heading", { name: "Let's build" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const homeMain = document.querySelector(".cdx-main--home");
        const sidebar = document.querySelector(".cdx-workspace--home .cdx-sidebar");
        if (!(homeMain instanceof HTMLElement) || !(sidebar instanceof HTMLElement)) {
          return false;
        }
        return homeMain.getBoundingClientRect().top < sidebar.getBoundingClientRect().top;
      }),
    )
    .toBe(true);

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

  // View-mode menu lives on the topbar; tapping it should surface Normal /
  // Thinking / Verbose without affecting the rest of the chrome.
  await page.getByTestId("mobile-topbar-views-toggle").click();
  await expect(page.getByTestId("mobile-topbar-views-menu")).toBeVisible();
  await page.getByTestId("mobile-topbar-views-verbose").click();
  await expect(page.getByTestId("mobile-topbar-views-menu")).toHaveCount(0);
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-view-mode", "verbose");
  // Reset to Normal so the rest of the smoke flow runs in the default mode.
  await page.getByTestId("mobile-topbar-views-toggle").click();
  await page.getByTestId("mobile-topbar-views-normal").click();

  // Canvas is a mobile-only embedded browser sheet. It should open from the
  // top bar, accept an app-relative URL, snap full, then close without
  // disturbing the chat chrome or leaving a bottom trigger over the composer.
  await expect(page.getByTestId("mobile-topbar-canvas-toggle")).toBeVisible();
  await expect(page.getByTestId("mobile-canvas-trigger")).toHaveCount(0);
  await page.getByTestId("mobile-topbar-canvas-toggle").click();
  await expect(page.getByTestId("mobile-canvas-sheet")).toBeVisible();
  await expect(page.getByTestId("mobile-canvas-sheet")).toHaveAttribute("data-snap", "full");
  await page.getByTestId("mobile-canvas-url-input").fill("/?canvas-preview=1");
  await page.getByTestId("mobile-canvas-open-url").click();
  await expect(page.getByTestId("mobile-canvas-frame")).toHaveAttribute(
    "src",
    "/?canvas-preview=1",
  );
  const canvasFrameMetrics = await page
    .getByTestId("mobile-canvas-frame")
    .evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        bottomGap: window.innerHeight - rect.bottom,
        height: rect.height,
        viewportHeight: window.innerHeight,
      };
    });
  expect(canvasFrameMetrics.bottomGap).toBeLessThanOrEqual(2);
  expect(canvasFrameMetrics.height).toBeGreaterThan(canvasFrameMetrics.viewportHeight * 0.55);
  await page.getByTestId("mobile-canvas-snap-toggle").click();
  await expect(page.getByTestId("mobile-canvas-sheet")).toHaveAttribute("data-snap", "peek");
  await page.getByTestId("mobile-canvas-close").click();
  await expect(page.getByTestId("mobile-canvas-sheet")).toHaveCount(0);

  // Composer "+" opens a lightweight menu; Controls inside it routes to the
  // sheet (the prior auto-open behavior now lives behind the Controls item).
  await page.getByTestId("mobile-composer-control-toggle").click();
  await expect(page.getByTestId("mobile-composer-plus-menu")).toBeVisible();
  await page.getByTestId("mobile-composer-plus-controls").click();
  await expect(page.getByTestId("mobile-control-sheet")).toBeVisible();
  await page.getByTestId("mobile-control-sheet-close").click();
  await expect(page.getByTestId("mobile-control-sheet")).toHaveCount(0);

  // Real .click() fires the full pointerdown → pointerup → click sequence,
  // which exercises the sheet header's pointer-capture guard. A synthetic
  // .evaluate(node => node.click()) would skip pointerdown entirely and miss
  // a regression of the bug fixed in 24617e4 (header capturing the pointer
  // and eating the Close button's click).
  await page.getByTestId("mobile-topbar-control-toggle").click();
  await expect(page.getByTestId("mobile-control-sheet")).toBeVisible();
  await page.getByTestId("mobile-control-sheet-close").click();
  await expect(page.getByTestId("mobile-control-sheet")).toHaveCount(0);

  await page.getByLabel("Open threads").evaluate((node: HTMLElement) => {
    node.click();
  });
  const drawer = page.getByTestId("mobile-thread-switcher-overlay");
  await expect(drawer).toBeVisible();
  // The drawer is now a left side panel, not a full-screen overlay.
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const dialog = document.querySelector(
          ".cdx-mobile-thread-switcher-dialog",
        ) as HTMLElement | null;
        if (!dialog) return Number.POSITIVE_INFINITY;
        return dialog.getBoundingClientRect().width;
      });
    })
    .toBeLessThanOrEqual(360);
  // Search input + New session entry must be present.
  await expect(page.getByTestId("mobile-thread-switcher-search")).toBeVisible();
  await expect(page.getByTestId("mobile-thread-switcher-new")).toBeVisible();
  // Status filter tabs are present and default to All.
  await expect(page.getByTestId("mobile-thread-switcher-filter-all")).toHaveAttribute(
    "aria-selected",
    "true",
  );
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
  await page.getByTestId("mobile-control-tab-pending").click();
  await page.getByTestId("approval-allow").first().click();
  await page.getByTestId("mobile-control-tab-advanced").click();

  await page.getByTestId("control-stop").click();

  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    )
    .toBeLessThanOrEqual(0);
});

test("desktop plan flow: answer questions then implement proposed plan", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");

  await page.goto("/");
  await expect(page.getByText("Gateway connected")).toBeVisible();

  await page.getByRole("button", { name: "New thread" }).first().click();
  await expect(page).toHaveURL(/\/threads\//);

  await page.getByTestId("turn-input").fill("plan flow desktop");
  await page.getByTestId("turn-submit").click();

  await expect(page.getByTestId("approval-drawer")).toBeVisible();
  await page.getByLabel("Staging - safe environment").check();
  await page.getByPlaceholder("Other").fill("canary rollout");
  await page.getByTestId("interaction-submit").click();

  await expect
    .poll(async () => {
      const status = await page.locator(".cdx-status-row").innerText();
      return status.includes("Pending questions: 0");
    })
    .toBe(true);

  await expect(page.getByText("Plan ready")).toBeVisible();
  await page.getByRole("button", { name: "Implement this plan" }).first().click();

  const dialog = page.getByTestId("implement-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("implement-draft-input").fill("Implement now from e2e");
  await dialog.getByRole("button", { name: "Implement this plan" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByTestId("timeline")).toContainText("Echo: Implement now from e2e");
});

test("mobile plan flow: answer questions tab then implement from sheet", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");

  await page.goto("/");
  await expect(page.getByText("Gateway connected")).toBeVisible();

  await page.getByRole("button", { name: "New thread" }).first().click();
  await expect(page).toHaveURL(/\/threads\//);

  await page.getByTestId("turn-input").fill("plan flow mobile");
  await page.getByTestId("turn-submit").click();

  await page.getByTestId("mobile-topbar-control-toggle").click();
  const sheet = page.getByTestId("mobile-control-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("mobile-control-tab-pending").click();
  await sheet.getByLabel("Staging - safe environment").check();
  await sheet.getByTestId("interaction-submit").click();
  // Real click exercises pointerdown→pointerup on the sheet header (regression
  // guard for the pointer-capture fix in 24617e4).
  await sheet.getByTestId("mobile-control-sheet-close").click();
  await expect(sheet).toHaveCount(0);

  await expect(page.getByRole("button", { name: "Implement this plan" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Implement this plan" }).first().click();

  const implementSheet = page.getByTestId("mobile-implement-sheet");
  await expect(implementSheet).toBeVisible();
  await implementSheet.getByTestId("implement-draft-input").fill("Mobile implement now");
  await implementSheet.getByRole("button", { name: "Implement this plan" }).click();
  await expect(implementSheet).toHaveCount(0);

  await expect(page.getByTestId("timeline")).toContainText("Echo: Mobile implement now");
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
