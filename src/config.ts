import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONFIG_FILENAME = '.repo-memory.json';

export interface ToolGroupConfig {
  summaries?: boolean;
  tasks?: boolean;
  telemetry?: boolean;
}

export interface RepoMemoryConfig {
  ignore?: string[];
  maxFiles?: number;
  gc?: {
    cacheMaxAgeDays?: number;
    taskMaxAgeDays?: number;
    telemetryMaxAgeDays?: number;
  };
  tools?: ToolGroupConfig;
}

const configCache = new Map<string, RepoMemoryConfig>();

function warn(message: string): void {
  process.stderr.write(`Warning: ${CONFIG_FILENAME}: ${message}\n`);
}

export function loadConfig(projectRoot: string): RepoMemoryConfig {
  const cached = configCache.get(projectRoot);
  if (cached) return cached;

  const configPath = join(projectRoot, CONFIG_FILENAME);
  let config: RepoMemoryConfig = {};

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      config = validateConfig(JSON.parse(raw));
    } catch (err) {
      // Only unparseable JSON reaches here — validateConfig itself never throws,
      // it skips invalid keys. A broken file falls back to built-in defaults.
      warn(`failed to parse: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  configCache.set(projectRoot, config);
  return config;
}

// Validate per key: an invalid key is skipped with a warning and the valid keys
// are still applied, rather than discarding the whole config on one bad value.
// (A non-object root, or a non-object gc/tools, drops just that scope.)
function validateConfig(raw: unknown): RepoMemoryConfig {
  const config: RepoMemoryConfig = {};

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warn('must be a JSON object; using defaults');
    return config;
  }
  const obj = raw as Record<string, unknown>;

  if ('ignore' in obj) {
    if (Array.isArray(obj.ignore) && obj.ignore.every((v) => typeof v === 'string')) {
      config.ignore = obj.ignore as string[];
    } else {
      warn('"ignore" must be an array of strings; ignoring it');
    }
  }

  if ('maxFiles' in obj) {
    if (typeof obj.maxFiles === 'number' && obj.maxFiles >= 1) {
      config.maxFiles = obj.maxFiles;
    } else {
      warn('"maxFiles" must be a positive number; ignoring it');
    }
  }

  if ('gc' in obj) {
    if (typeof obj.gc === 'object' && obj.gc !== null && !Array.isArray(obj.gc)) {
      const gc = obj.gc as Record<string, unknown>;
      const out: NonNullable<RepoMemoryConfig['gc']> = {};
      for (const key of ['cacheMaxAgeDays', 'taskMaxAgeDays', 'telemetryMaxAgeDays'] as const) {
        if (key in gc) {
          const value = gc[key];
          if (typeof value === 'number' && value >= 1) {
            out[key] = value;
          } else {
            warn(`"gc.${key}" must be a positive number; ignoring it`);
          }
        }
      }
      if (Object.keys(out).length > 0) config.gc = out;
    } else {
      warn('"gc" must be an object; ignoring it');
    }
  }

  if ('tools' in obj) {
    if (typeof obj.tools === 'object' && obj.tools !== null && !Array.isArray(obj.tools)) {
      const tools = obj.tools as Record<string, unknown>;
      const out: ToolGroupConfig = {};
      for (const key of ['summaries', 'tasks', 'telemetry'] as const) {
        if (key in tools) {
          const value = tools[key];
          if (typeof value === 'boolean') {
            out[key] = value;
          } else {
            warn(`"tools.${key}" must be a boolean; ignoring it`);
          }
        }
      }
      if (Object.keys(out).length > 0) config.tools = out;
    } else {
      warn('"tools" must be an object; ignoring it');
    }
  }

  return config;
}

export function clearConfigCache(): void {
  configCache.clear();
}
