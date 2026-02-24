import { describe, expect, it } from 'vitest';
import { permissionModeToTurnStartParams, statusFromRaw, toModelOption } from '../src/helpers.js';

describe('helpers', () => {
  it('maps status with fallback', () => {
    expect(statusFromRaw('connected')).toBe('ok');
    expect(statusFromRaw('degraded')).toBe('degraded');
    expect(statusFromRaw('unknown')).toBe('error');
  });

  it('maps permission mode', () => {
    expect(permissionModeToTurnStartParams('local')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    });
    expect(permissionModeToTurnStartParams('full-access')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access'
    });
    expect(permissionModeToTurnStartParams(undefined)).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    });
  });

  it('normalizes model option', () => {
    expect(
      toModelOption({
        id: 'gpt',
        reasoningEffort: 'HIGH',
        supportedReasoningEfforts: ['HIGH', 'medium', 'MEDIUM'],
        extra: 1
      })
    ).toEqual({
      id: 'gpt',
      reasoningEffort: 'high',
      supportedReasoningEfforts: ['high', 'medium'],
      extra: 1
    });
  });
});
