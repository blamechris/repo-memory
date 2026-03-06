import { execFileSync } from 'child_process';

export interface DiffAnalysis {
  structural: boolean;
  affectedExports: string[];
  affectedImports: string[];
  lineCountChanged: boolean;
}

const EXPORT_PATTERN =
  /export\s+(?:default\s+)?(?:const|function|class|interface|type|enum)\b/;

const IMPORT_PATTERN = /import\s+.*?\s+from\s+['"]|import\s+['"]/;

const DECLARATION_PATTERN =
  /(?:function|class|interface|type|enum)\s+\w+/;

function extractAffectedExports(lines: string[]): string[] {
  const results: string[] = [];
  const re =
    /export\s+(?:default\s+)?(?:const|let|var|function\s*\*?|class|interface|type|enum|abstract\s+class)\s+(\w+)/;
  for (const line of lines) {
    const match = re.exec(line);
    if (match) {
      results.push(match[1]);
    }
  }
  return [...new Set(results)];
}

function extractAffectedImports(lines: string[]): string[] {
  const results: string[] = [];
  const fromRe = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/;
  const sideEffectRe = /import\s+['"]([^'"]+)['"]/;
  for (const line of lines) {
    const fromMatch = fromRe.exec(line);
    if (fromMatch) {
      results.push(fromMatch[1]);
      continue;
    }
    const sideMatch = sideEffectRe.exec(line);
    if (sideMatch) {
      results.push(sideMatch[1]);
    }
  }
  return [...new Set(results)];
}

export function analyzeDiff(
  filePath: string,
  projectRoot: string,
): DiffAnalysis {
  let diffOutput: string;
  try {
    diffOutput = execFileSync(
      'git',
      ['diff', 'HEAD', '--', filePath],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 10_000,
      },
    );
  } catch {
    return {
      structural: true,
      affectedExports: [],
      affectedImports: [],
      lineCountChanged: true,
    };
  }

  if (!diffOutput.trim()) {
    return {
      structural: true,
      affectedExports: [],
      affectedImports: [],
      lineCountChanged: true,
    };
  }

  const diffLines = diffOutput.split('\n');
  const changedLines: string[] = [];
  let addedLines = 0;
  let removedLines = 0;

  for (const line of diffLines) {
    if (line.startsWith('@@') || line.startsWith('diff ') ||
        line.startsWith('index ') || line.startsWith('---') ||
        line.startsWith('+++')) {
      continue;
    }
    if (line.startsWith('+')) {
      addedLines++;
      changedLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      removedLines++;
      changedLines.push(line.slice(1));
    }
  }

  const lineCountChanged = addedLines !== removedLines;

  let structural = false;
  for (const line of changedLines) {
    if (EXPORT_PATTERN.test(line) || IMPORT_PATTERN.test(line) ||
        DECLARATION_PATTERN.test(line)) {
      structural = true;
      break;
    }
  }

  const affectedExports = extractAffectedExports(changedLines);
  const affectedImports = extractAffectedImports(changedLines);

  return {
    structural,
    affectedExports,
    affectedImports,
    lineCountChanged,
  };
}
