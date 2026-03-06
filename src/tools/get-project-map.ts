import { buildProjectMap, type ProjectMap } from '../indexer/project-map.js';

export async function getProjectMap(
  projectRoot: string,
  depth?: number,
): Promise<ProjectMap> {
  return buildProjectMap(projectRoot, depth !== undefined ? { depth } : undefined);
}
