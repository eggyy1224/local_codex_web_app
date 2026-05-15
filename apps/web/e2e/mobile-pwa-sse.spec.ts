import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const gatewayPort = process.env.PLAYWRIGHT_GATEWAY_PORT ?? "8877";
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

declare global {
  interface Window {
    __lcwaCloseEventSourcesSilently?: () => void;
    __lcwaEventSourceUrls?: string[];
    __lcwaGatewaySeqs?: number[];
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((url) => {
    window.localStorage.setItem("lcwa.gatewayUrl.v1", url);
  }, gatewayUrl);
});

async function installTrackedEventSource(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    const instances: EventSource[] = [];
    window.__lcwaEventSourceUrls = [];
    window.__lcwaGatewaySeqs = [];

    class TrackedEventSource extends NativeEventSource {
      constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        super(url, eventSourceInitDict);
        window.__lcwaEventSourceUrls?.push(String(url));
        instances.push(this);
        super.addEventListener("gateway", (event) => {
          const data = JSON.parse((event as MessageEvent).data) as { seq?: unknown };
          if (typeof data.seq === "number") {
            window.__lcwaGatewaySeqs?.push(data.seq);
          }
        });
      }
    }

    Object.defineProperty(window, "EventSource", {
      configurable: true,
      writable: true,
      value: TrackedEventSource,
    });
    window.__lcwaCloseEventSourcesSilently = () => {
      for (const instance of instances) {
        instance.close();
      }
    };
  });
}

async function setPageVisibility(page: Page, visibilityState: "hidden" | "visible"): Promise<void> {
  await page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => state !== "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(state === "visible" ? "focus" : "blur"));
  }, visibilityState);
}

async function startHeldMobileTurn(page: Page, prompt: string): Promise<string> {
  await page.goto("/");
  await expect(page.getByText("Gateway connected")).toBeVisible();

  await page.getByRole("button", { name: "New thread" }).first().click();
  await expect(page).toHaveURL(/\/threads\//);
  const threadId = page.url().split("/threads/")[1]?.split(/[?#]/)[0];
  if (!threadId) {
    throw new Error(`thread id missing from ${page.url()}`);
  }

  await page.getByTestId("turn-input").fill(prompt);
  await page.getByTestId("turn-submit").click();
  await expect(page.getByTestId("mobile-running-indicator")).toHaveText(
    /Thinking in progress/,
  );

  return threadId;
}

async function readLastGatewaySeq(page: Page): Promise<number> {
  return page.evaluate(() => window.__lcwaGatewaySeqs?.at(-1) ?? 0);
}

async function waitForCursorGreaterThan(page: Page, seq: number): Promise<number> {
  await expect
    .poll(async () => readLastGatewaySeq(page), {
      timeout: 15_000,
    })
    .toBeGreaterThan(seq);
  return readLastGatewaySeq(page);
}

async function completeHeldTurn(request: APIRequestContext, threadId: string): Promise<void> {
  const res = await request.post(`${gatewayUrl}/__e2e/threads/${threadId}/complete-active-turn`);
  expect(res.ok()).toBe(true);
}

async function emitDelta(
  request: APIRequestContext,
  threadId: string,
  delta: string,
): Promise<void> {
  const res = await request.post(`${gatewayUrl}/__e2e/threads/${threadId}/emit-delta`, {
    data: { delta },
  });
  expect(res.ok()).toBe(true);
}

test.describe("mobile PWA-resilient SSE", () => {
  test("recovers a completed turn after hidden-page EventSource misses terminal events", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    await installTrackedEventSource(page);

    const prompt = "e2e hold pwa foreground recovery";
    const threadId = await startHeldMobileTurn(page, prompt);
    const lastLiveSeq = await waitForCursorGreaterThan(page, 0);

    await setPageVisibility(page, "hidden");
    await page.evaluate(() => window.__lcwaCloseEventSourcesSilently?.());
    await completeHeldTurn(request, threadId);
    await expect(page.getByTestId("timeline")).not.toContainText(`Echo: ${prompt}`);

    await setPageVisibility(page, "visible");

    await expect(page.getByTestId("timeline")).toContainText(`Echo: ${prompt}`);
    await expect(page.getByTestId("mobile-running-indicator")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          (seq) => window.__lcwaEventSourceUrls?.some((url) => url.includes(`since=${seq}`)),
          lastLiveSeq,
        ),
      )
      .toBe(true);
  });

  test("watchdog reconnects from last seq and replays events missed by a stale stream", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await installTrackedEventSource(page);

    const prompt = "e2e hold pwa stale watchdog";
    const threadId = await startHeldMobileTurn(page, prompt);
    const lastLiveSeq = await waitForCursorGreaterThan(page, 0);

    await page.evaluate(() => window.__lcwaCloseEventSourcesSilently?.());
    await completeHeldTurn(request, threadId);
    await page.clock.runFor(24_000);

    await expect
      .poll(() =>
        page.evaluate(
          (seq) => window.__lcwaEventSourceUrls?.some((url) => url.includes(`since=${seq}`)),
          lastLiveSeq,
        ),
      )
      .toBe(true);
    const recoveredSeq = await waitForCursorGreaterThan(page, lastLiveSeq);
    expect(recoveredSeq).toBeGreaterThan(lastLiveSeq);
    await expect(page.getByTestId("timeline")).toContainText(`Echo: ${prompt}`);
    await expect(page.getByTestId("mobile-running-indicator")).toHaveCount(0);
  });

  test("does not poll full timeline snapshots during healthy streaming", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await installTrackedEventSource(page);

    const timelineRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/threads/") && url.includes("/timeline?limit=")) {
        timelineRequests.push(url);
      }
    });

    const threadId = await startHeldMobileTurn(page, "e2e hold pwa healthy streaming");
    const baselineTimelineRequests = timelineRequests.length;
    let lastSeq = await waitForCursorGreaterThan(page, 0);

    for (let step = 0; step < 4; step += 1) {
      await page.clock.runFor(10_000);
      await emitDelta(request, threadId, `still streaming ${step}`);
      lastSeq = await waitForCursorGreaterThan(page, lastSeq);
    }

    expect(timelineRequests.slice(baselineTimelineRequests)).toEqual([]);
  });
});
