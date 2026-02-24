import type { ModelOption, PermissionMode, TurnStartParams } from './types.js';

export function statusFromRaw(status: string): 'ok' | 'degraded' | 'error' {
  if (status === 'connected') return 'ok';
  if (status === 'degraded') return 'degraded';
  return 'error';
}

export function permissionModeToTurnStartParams(mode: PermissionMode): TurnStartParams {
  if (mode === 'full-access') {
    return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }

  return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
}

export function toModelOption(model: ModelOption): ModelOption {
  const normalized = {
    ...model,
    reasoningEffort: model.reasoningEffort?.toLowerCase()
  };

  if (!model.supportedReasoningEfforts) return normalized;

  return {
    ...normalized,
    supportedReasoningEfforts: [...new Set(model.supportedReasoningEfforts.map((item) => item.toLowerCase()))]
  };
}
