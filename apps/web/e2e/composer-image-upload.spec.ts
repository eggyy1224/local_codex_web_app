import { expect, test } from "@playwright/test";

const gatewayPort = process.env.PLAYWRIGHT_GATEWAY_PORT ?? "8877";
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

const samplePngBytes = Buffer.from(
  // Minimal valid 1x1 PNG (67 bytes).
  "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478" +
    "9C62000100000500010D0A2DB40000000049454E44AE426082",
  "hex",
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript((url) => {
    window.localStorage.setItem("lcwa.gatewayUrl.v1", url);
  }, gatewayUrl);
});

test("mobile composer: pick an image, see thumbnail, send a turn with localImage", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");

  await page.addInitScript(() => {
    const applyPortalStyle = () => {
      const existing = document.getElementById("lcwa-e2e-nextjs-portal-style");
      if (existing) return;
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
  await expect(page.getByTestId("turn-input")).toBeVisible();

  // Initially the send button is disabled (empty composer, no attachments).
  const sendButton = page.getByTestId("turn-submit");
  await expect(sendButton).toBeDisabled();

  // Open the + menu and verify "Add image" is the first item.
  await page.getByTestId("mobile-composer-control-toggle").click();
  const plusMenu = page.getByTestId("mobile-composer-plus-menu");
  await expect(plusMenu).toBeVisible();
  await expect(page.getByTestId("mobile-composer-plus-image")).toBeVisible();

  // setInputFiles drives the hidden <input type="file"> directly — clicking
  // the menu item would open the native chooser which Playwright cannot
  // interact with.
  await page
    .getByTestId("mobile-composer-file-input")
    .setInputFiles({
      name: "screenshot.png",
      mimeType: "image/png",
      buffer: samplePngBytes,
    });

  // Strip should appear with one thumb. Wait for status=ready (upload finished).
  const thumb = page.getByTestId("composer-attachment-thumb");
  await expect(thumb).toBeVisible();
  await expect
    .poll(() => thumb.getAttribute("data-attachment-status"), {
      timeout: 5_000,
    })
    .toBe("ready");

  // Send enables once the upload is ready, even with empty text.
  await expect(sendButton).not.toBeDisabled();

  // Spy on the turn POST so we can verify the input payload includes
  // a localImage entry pointing at an absolute path under the gateway's
  // upload root.
  const turnRequestPromise = page.waitForRequest(
    (req) =>
      req.method() === "POST" && /\/api\/threads\/[^/]+\/turns$/.test(req.url()),
  );

  await sendButton.click();

  const turnRequest = await turnRequestPromise;
  const body = JSON.parse(turnRequest.postData() ?? "{}") as {
    input: Array<{ type: string; path?: string; text?: string }>;
  };
  const localImageItem = body.input.find((item) => item.type === "localImage");
  expect(localImageItem).toBeTruthy();
  expect(localImageItem!.path).toMatch(/^\//);

  // Strip should clear after a successful send.
  await expect(page.getByTestId("composer-attachment-strip")).toHaveCount(0);

  // Sanity guard for the iOS keyboard-inset regression class
  // ([[feedback_ios_keyboard_gap]]): the composer dock must remain on-screen
  // — its bottom edge should sit at or below the viewport height, not float
  // off into the keyboard gap.
  const composerBottom = await page
    .getByTestId("mobile-composer-dock")
    .evaluate((node) => Math.round(node.getBoundingClientRect().bottom));
  const viewportHeight = page.viewportSize()?.height ?? 0;
  expect(composerBottom).toBeGreaterThan(0);
  expect(composerBottom).toBeLessThanOrEqual(viewportHeight);
});
