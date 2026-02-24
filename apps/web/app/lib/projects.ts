export interface ProjectItem {
  id: string;
  name: string;
  archived?: boolean;
}

export function groupAndSortProjects(projects: ProjectItem[]): ProjectItem[] {
  return [...projects].sort((a, b) => a.name.localeCompare(b.name));
}

export function defaultProject(projects: ProjectItem[]): ProjectItem | null {
  return groupAndSortProjects(projects).find((p) => !p.archived) ?? null;
}
