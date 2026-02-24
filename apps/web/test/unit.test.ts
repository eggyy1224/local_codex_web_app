import { describe, expect, it } from 'vitest';
import { defaultProject, groupAndSortProjects } from '../app/lib/projects.js';
import { formatEffortLabel, statusClass, statusLabel, truncate } from '../app/lib/status.js';

describe('web unit', () => {
  it('sorts and picks default project', () => {
    const items = [
      { id: '2', name: 'Beta' },
      { id: '1', name: 'Alpha' }
    ];
    expect(groupAndSortProjects(items).map((item) => item.name)).toEqual(['Alpha', 'Beta']);
    expect(defaultProject(items)?.name).toBe('Alpha');
  });


  it('returns null when all projects archived', () => {
    expect(defaultProject([{ id: '1', name: 'A', archived: true }])).toBeNull();
  });

  it('formats status helper labels', () => {
    expect(statusLabel('ok')).toBe('Healthy');
    expect(statusLabel('other')).toBe('Error');
    expect(statusClass('degraded')).toBe('text-yellow-500');
    expect(statusClass('other')).toBe('text-red-500');
    expect(formatEffortLabel('low')).toBe('LOW');
    expect(formatEffortLabel()).toBe('DEFAULT');
    expect(truncate('1234567890123', 5)).toBe('12345...');
    expect(truncate('short', 10)).toBe('short');
  });
});
