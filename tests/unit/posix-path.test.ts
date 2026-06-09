import { describe, it, expect } from 'vitest';
import { toPosix } from '../../src/utils/posix-path.js';

describe('toPosix', () => {
  it('converts backslash separators to forward slashes', () => {
    expect(toPosix('src\\cache\\store.ts')).toBe('src/cache/store.ts');
  });

  it('leaves posix paths unchanged', () => {
    expect(toPosix('src/cache/store.ts')).toBe('src/cache/store.ts');
  });

  it('handles mixed separators', () => {
    expect(toPosix('src\\cache/store.ts')).toBe('src/cache/store.ts');
  });

  it('handles an empty string', () => {
    expect(toPosix('')).toBe('');
  });
});
