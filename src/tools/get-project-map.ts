import { buildProjectMap, type ProjectMap } from '../indexer/project-map.js';

/**
 * Default directory depth for the project map. An undepthed map of a large
 * repo costs thousands of tokens; depth 2 keeps the first orientation call
 * cheap while still showing the second-level structure. Pass an explicit
 * `depth` for more (buildProjectMap itself stays unlimited-by-default for
 * programmatic reuse).
 */
const DEFAULT_DEPTH = 2;

export async function getProjectMap(
  projectRoot: string,
  depth?: number,
): Promise<ProjectMap> {
  return buildProjectMap(projectRoot, { depth: depth ?? DEFAULT_DEPTH });
}
