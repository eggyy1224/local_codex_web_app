import cors from "@fastify/cors";
import Fastify from "fastify";
import type { HealthResponse } from "@lcwa/shared-types";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
});

app.get("/health", async (): Promise<HealthResponse> => {
  return {
    status: "ok",
    appServerConnected: false,
    timestamp: new Date().toISOString(),
  };
});

await app.listen({ host, port });
