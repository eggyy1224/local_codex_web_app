import { createGatewayApp } from './app.js';
import type { GatewayAppServerPort } from './types.js';

const noopServer: GatewayAppServerPort = {
  request: async () => ({}),
  notify: async () => {},
  respond: async () => {},
  on: () => {},
  isConnected: () => false,
  errorMessage: () => 'not configured',
  start: async () => {}
};

const app = createGatewayApp({ appServer: noopServer });

const port = Number(process.env.PORT ?? '3000');
app.listen({ port, host: '0.0.0.0' });
