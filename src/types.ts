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
  confidence: 'high' | 'medium' | 'low';
}

export interface ImportRef {
  source: string;
  target: string;
  specifiers: string[];
  type: 'static' | 'dynamic' | 're-export';
  /**
   * True when the target does not resolve to a file inside the project
   * (bare module specifiers, builtins, unresolvable relative paths).
   * External refs are excluded from the dependency graph.
   */
  external?: boolean;
}
