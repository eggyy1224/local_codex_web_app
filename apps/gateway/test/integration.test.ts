import { describe, expect, it } from 'vitest';
import { createGatewayApp } from '../src/app.js';

describe('gateway integration', () => {
  it('returns healthy status when connected', async () => {
    const app = createGatewayApp({
      appServer: {
        request: async () => ({}),
        notify: async () => {},
        respond: async () => {},
        on: () => {},
        isConnected: () => true,
        errorMessage: () => null,
        start: async () => {}
      }
    });

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns degraded status when disconnected', async () => {
    const app = createGatewayApp({
      appServer: {
        request: async () => ({}),
        notify: async () => {},
        respond: async () => {},
        on: () => {},
        isConnected: () => false,
        errorMessage: () => 'down',
        start: async () => {}
      }
    });

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'degraded', message: 'down' });
  });
});
