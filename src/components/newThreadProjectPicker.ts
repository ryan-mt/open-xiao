type SearchableProject = {
  name: string;
  path: string;
};

export function shouldOpenNewThreadProjectPicker(
  scopeKey: string,
  projectCount: number,
  shiftKey = false,
): boolean {
  return !shiftKey && scopeKey === "all" && projectCount > 1;
}

export function filterNewThreadProjects<T extends SearchableProject>(
  projects: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...projects];
  return projects.filter((project) =>
    `${project.name} ${project.path}`.toLowerCase().includes(needle),
  );
}
