export function statusLabel(status: string): string {
  if (status === 'ok') return 'Healthy';
  if (status === 'degraded') return 'Degraded';
  return 'Error';
}

export function statusClass(status: string): string {
  if (status === 'ok') return 'text-green-500';
  if (status === 'degraded') return 'text-yellow-500';
  return 'text-red-500';
}

export function formatEffortLabel(effort?: string): string {
  return effort ? effort.toUpperCase() : 'DEFAULT';
}

export function truncate(value: string, max = 12): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
