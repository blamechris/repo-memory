import { resolve, normalize, relative, sep } from 'node:path';

/**
 * Validates that a file path is safe and resolves within the project root.
 * Throws an error if the path attempts traversal outside the project.
 *
 * @param projectRoot - The absolute path to the project root directory.
 * @param filePath - The file path to validate (relative or absolute).
 * @returns The validated relative path (relative to projectRoot).
 */
export function validatePath(projectRoot: string, filePath: string): string {
  if (filePath.includes('\0')) {
    throw new Error(`Invalid path: null byte detected in "${filePath}"`);
  }

  const normalizedRoot = normalize(resolve(projectRoot));
  const resolvedPath = normalize(resolve(projectRoot, filePath));

  if (
    resolvedPath !== normalizedRoot &&
    !resolvedPath.startsWith(normalizedRoot + sep)
  ) {
    throw new Error(
      `Path traversal detected: ${filePath} resolves outside project root`,
    );
  }

  return relative(normalizedRoot, resolvedPath);
}
