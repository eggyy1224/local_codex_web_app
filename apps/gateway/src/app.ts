import Fastify from 'fastify';
import type { GatewayAppServerPort } from './types.js';
import { statusFromRaw } from './helpers.js';

export function createGatewayApp(deps: { appServer: GatewayAppServerPort }) {
  const app = Fastify();

  app.get('/health', async () => {
    if (deps.appServer.isConnected()) {
      return { status: 'ok' };
    }

    return {
      status: statusFromRaw('degraded'),
      message: deps.appServer.errorMessage() ?? 'app-server unavailable'
    };
  });

  return app;
}
