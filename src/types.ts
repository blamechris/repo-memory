export interface CacheEntry {
  path: string;
  hash: string;
  lastChecked: number;
  summary: FileSummary | null;
}

export interface FileSummary {
  purpose: string;
  exports: string[];
  imports: string[];
  lineCount: number;
  topLevelDeclarations: string[];
}

export interface ImportRef {
  source: string;
  target: string;
  specifiers: string[];
  type: 'static' | 'dynamic' | 're-export';
}
