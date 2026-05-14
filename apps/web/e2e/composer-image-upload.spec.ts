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

test("desktop composer: pick + drag-drop, see thumbnails, send a turn with localImage", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");

  await page.goto("/");
  await expect(page.getByText("Gateway connected")).toBeVisible();

  await page.getByRole("button", { name: "New thread" }).first().click();
  await expect(page).toHaveURL(/\/threads\//);
  await expect(page.getByTestId("turn-input")).toBeVisible();

  const sendButton = page.getByTestId("turn-submit");
  await expect(sendButton).toBeDisabled();

  // Path 1: Add image button → hidden file input.
  await expect(page.getByTestId("desktop-composer-add-image")).toBeVisible();
  await page
    .getByTestId("desktop-composer-file-input")
    .setInputFiles({
      name: "picked.png",
      mimeType: "image/png",
      buffer: samplePngBytes,
    });

  const firstThumb = page.getByTestId("composer-attachment-thumb").first();
  await expect(firstThumb).toBeVisible();
  await expect
    .poll(() => firstThumb.getAttribute("data-attachment-status"), {
      timeout: 5_000,
    })
    .toBe("ready");

  // Path 2: simulate a drag-drop onto the composer card. Playwright can't
  // forge a real DataTransfer.files, so build one in-page and dispatch the
  // drop event so the React handler still sees `dataTransfer.files`.
  await page.evaluate(async ({ b64 }) => {
    const composer = document.querySelector('[data-testid="desktop-composer"]') as HTMLElement;
    if (!composer) throw new Error("composer not found");
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], "dropped.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    composer.dispatchEvent(
      new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }),
    );
    composer.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, dataTransfer: dt }),
    );
    composer.dispatchEvent(
      new DragEvent("drop", { bubbles: true, dataTransfer: dt }),
    );
  }, { b64: samplePngBytes.toString("base64") });

  // After drop there should be 2 thumbs and the new one should reach ready.
  await expect
    .poll(() => page.getByTestId("composer-attachment-thumb").count(), {
      timeout: 5_000,
    })
    .toBe(2);
  await expect
    .poll(
      () =>
        page
          .getByTestId("composer-attachment-thumb")
          .nth(1)
          .getAttribute("data-attachment-status"),
      { timeout: 5_000 },
    )
    .toBe("ready");

  await expect(sendButton).not.toBeDisabled();

  const turnRequestPromise = page.waitForRequest(
    (req) => req.method() === "POST" && /\/api\/threads\/[^/]+\/turns$/.test(req.url()),
  );
  await sendButton.click();
  const turnRequest = await turnRequestPromise;
  const body = JSON.parse(turnRequest.postData() ?? "{}") as {
    input: Array<{ type: string; path?: string; text?: string }>;
  };
  const localImageItems = body.input.filter((item) => item.type === "localImage");
  expect(localImageItems.length).toBe(2);
  expect(localImageItems.every((item) => item.path?.startsWith("/"))).toBe(true);

  await expect(page.getByTestId("composer-attachment-strip")).toHaveCount(0);
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
