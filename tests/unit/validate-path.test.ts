import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { validatePath } from '../../src/utils/validate-path.js';

describe('validatePath', () => {
  const projectRoot = '/home/user/project';

  it('passes a normal relative path', () => {
    expect(validatePath(projectRoot, 'src/index.ts')).toBe('src/index.ts');
  });

  it('normalizes a path with ../ that stays within project', () => {
    expect(validatePath(projectRoot, 'src/../src/index.ts')).toBe(
      'src/index.ts',
    );
  });

  it('throws for path traversal outside project root', () => {
    expect(() => validatePath(projectRoot, '../../etc/passwd')).toThrow(
      'Path traversal detected',
    );
  });

  it('throws for absolute path outside project root', () => {
    expect(() => validatePath(projectRoot, '/etc/passwd')).toThrow(
      'Path traversal detected',
    );
  });

  it('passes for absolute path inside project root and returns relative', () => {
    const absPath = join(projectRoot, 'src/index.ts');
    expect(validatePath(projectRoot, absPath)).toBe('src/index.ts');
  });

  it('throws for null bytes in path', () => {
    expect(() => validatePath(projectRoot, 'src/\0evil.ts')).toThrow(
      'null byte',
    );
  });

  it('returns empty string for empty path', () => {
    // resolve(projectRoot, '') === projectRoot, so relative is ''
    expect(validatePath(projectRoot, '')).toBe('');
  });

  it('throws for path with .. escaping', () => {
    expect(() => validatePath(projectRoot, 'src/../../outside')).toThrow(
      'Path traversal detected',
    );
  });

  it('handles path that resolves to project root itself', () => {
    expect(validatePath(projectRoot, '.')).toBe('');
  });

  it('handles deeply nested relative path', () => {
    expect(validatePath(projectRoot, 'a/b/c/d/e.ts')).toBe('a/b/c/d/e.ts');
  });
});
