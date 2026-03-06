import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { hashFile, hashContents } from '../../src/cache/hash.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('hashFile', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `hash-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns the same hash for the same file', async () => {
    const filePath = join(tempDir, 'stable.txt');
    await writeFile(filePath, 'hello world');

    const hash1 = await hashFile(filePath);
    const hash2 = await hashFile(filePath);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns different hashes for different contents', async () => {
    const fileA = join(tempDir, 'a.txt');
    const fileB = join(tempDir, 'b.txt');
    await writeFile(fileA, 'content A');
    await writeFile(fileB, 'content B');

    const hashA = await hashFile(fileA);
    const hashB = await hashFile(fileB);

    expect(hashA).not.toBe(hashB);
  });

  it('returns null for a missing file', async () => {
    const result = await hashFile(join(tempDir, 'nonexistent.txt'));
    expect(result).toBeNull();
  });

  it('returns a hash for an empty file', async () => {
    const filePath = join(tempDir, 'empty.txt');
    await writeFile(filePath, '');

    const result = await hashFile(filePath);

    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns a hash for binary content', async () => {
    const filePath = join(tempDir, 'binary.bin');
    await writeFile(filePath, Buffer.from([0x00, 0xff, 0x80, 0x7f]));

    const result = await hashFile(filePath);

    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('hashContents', () => {
  it('hashes a string', () => {
    const result = hashContents('hello');
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashes a Buffer', () => {
    const result = hashContents(Buffer.from('hello'));
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces the same hash for string and Buffer with same content', () => {
    const fromString = hashContents('hello');
    const fromBuffer = hashContents(Buffer.from('hello'));
    expect(fromString).toBe(fromBuffer);
  });

  it('produces different hashes for different inputs', () => {
    const a = hashContents('alpha');
    const b = hashContents('beta');
    expect(a).not.toBe(b);
  });
});
