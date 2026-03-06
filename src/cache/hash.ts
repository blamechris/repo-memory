import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Compute a SHA-256 hex digest of a file at the given absolute path.
 * Returns `null` if the file does not exist or cannot be read.
 */
export async function hashFile(absolutePath: string): Promise<string | null> {
  try {
    const contents = await readFile(absolutePath);
    return hashContents(contents);
  } catch {
    return null;
  }
}

/**
 * Compute a SHA-256 hex digest of the given string or Buffer.
 */
export function hashContents(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}
