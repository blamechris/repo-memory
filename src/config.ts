import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONFIG_FILENAME = '.repo-memory.json';

export interface RepoMemoryConfig {
  ignore?: string[];
  maxFiles?: number;
  gc?: {
    cacheMaxAgeDays?: number;
    taskMaxAgeDays?: number;
    telemetryMaxAgeDays?: number;
  };
}

const configCache = new Map<string, RepoMemoryConfig>();

export function loadConfig(projectRoot: string): RepoMemoryConfig {
  const cached = configCache.get(projectRoot);
  if (cached) return cached;

  const configPath = join(projectRoot, CONFIG_FILENAME);
  let config: RepoMemoryConfig = {};

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      config = validateConfig(parsed);
    } catch (err) {
      process.stderr.write(
        `Warning: failed to load ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  configCache.set(projectRoot, config);
  return config;
}

function validateConfig(raw: unknown): RepoMemoryConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Config must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;
  const config: RepoMemoryConfig = {};

  if ('ignore' in obj) {
    if (!Array.isArray(obj.ignore) || !obj.ignore.every((v) => typeof v === 'string')) {
      throw new Error('"ignore" must be an array of strings');
    }
    config.ignore = obj.ignore;
  }

  if ('maxFiles' in obj) {
    if (typeof obj.maxFiles !== 'number' || obj.maxFiles < 1) {
      throw new Error('"maxFiles" must be a positive number');
    }
    config.maxFiles = obj.maxFiles;
  }

  if ('gc' in obj) {
    if (typeof obj.gc !== 'object' || obj.gc === null || Array.isArray(obj.gc)) {
      throw new Error('"gc" must be an object');
    }
    const gc = obj.gc as Record<string, unknown>;
    config.gc = {};

    for (const key of ['cacheMaxAgeDays', 'taskMaxAgeDays', 'telemetryMaxAgeDays'] as const) {
      if (key in gc) {
        if (typeof gc[key] !== 'number' || gc[key] < 1) {
          throw new Error(`"gc.${key}" must be a positive number`);
        }
        config.gc[key] = gc[key];
      }
    }
  }

  return config;
}

export function clearConfigCache(): void {
  configCache.clear();
}
