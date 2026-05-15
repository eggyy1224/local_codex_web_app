import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const DEFAULT_CONFIG_RESPONSE = {
  config: { serviceTier: "fast", model: null, reasoningEffort: null },
  filePath: null,
  version: null,
};

export const server = setupServer(
  http.get("http://127.0.0.1:8795/api/config", () => HttpResponse.json(DEFAULT_CONFIG_RESPONSE)),
);
