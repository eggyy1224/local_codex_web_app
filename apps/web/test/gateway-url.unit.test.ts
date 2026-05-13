import { describe, expect, it } from "vitest";
import { resolveGatewayUrlForPage } from "../app/lib/gateway-url";

describe("gateway URL resolution", () => {
  it("keeps Playwright's local runtime override on localhost pages", () => {
    expect(
      resolveGatewayUrlForPage(
        "http://127.0.0.1:8795",
        "http://127.0.0.1:3000/",
        "http://127.0.0.1:8877",
      ),
    ).toBe("http://127.0.0.1:8877");
  });

  it("derives the gateway URL from a remote mobile page host", () => {
    expect(
      resolveGatewayUrlForPage(
        "http://127.0.0.1:8795",
        "http://100.67.60.60:3000/",
        null,
      ),
    ).toBe("http://100.67.60.60:8795");
  });

  it("derives the configured gateway port from a remote mobile page host", () => {
    expect(
      resolveGatewayUrlForPage(
        "http://127.0.0.1:8877",
        "http://100.67.60.60:3000/",
        null,
      ),
    ).toBe("http://100.67.60.60:8877");
  });

  it("ignores stale localhost overrides on remote mobile pages", () => {
    expect(
      resolveGatewayUrlForPage(
        "http://100.67.60.60:8795",
        "http://100.67.60.60:3000/",
        "http://127.0.0.1:8877",
      ),
    ).toBe("http://100.67.60.60:8795");
  });

  it("keeps remote overrides that match the configured gateway port", () => {
    expect(
      resolveGatewayUrlForPage(
        "http://100.67.60.60:8877",
        "http://100.67.60.60:3000/",
        "http://100.67.60.60:8877",
      ),
    ).toBe("http://100.67.60.60:8877");
  });

  it("ignores stale wrong-port overrides on remote mobile pages", () => {
    expect(
      resolveGatewayUrlForPage(
        "http://100.67.60.60:8795",
        "http://100.67.60.60:3000/",
        "http://100.67.60.60:8877",
      ),
    ).toBe("http://100.67.60.60:8795");
  });

  it("treats bracketed IPv6 loopback pages as local", () => {
    expect(
      resolveGatewayUrlForPage(
        "http://127.0.0.1:8795",
        "http://[::1]:3000/",
        "http://127.0.0.1:8877",
      ),
    ).toBe("http://127.0.0.1:8877");
  });
});
