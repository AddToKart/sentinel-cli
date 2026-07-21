import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  ToolDefinition, resolvePath, isSafeRegex, compileSafeRegex,
  escapeRegex, isRgAvailable, grepResultCompact
} from './security.js';

// ─── Grep Search ──────────────────────────────────────────────────────────────
export const grepTool: ToolDefinition = {
  name: 'grep_search',
  displayName: 'Searching',
  description: 'Search for string or regex patterns in files. Faster than reading many files manually.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'String or regex pattern to search for' },
      path: { type: 'string', description: 'File or directory path to search (default: current directory)' },
      is_regex: { type: 'boolean', description: 'Set to true if pattern is a regex (default: false)' },
      case_sensitive: { type: 'boolean', description: 'Case-sensitive search (default: false)' },
      include: { type: 'string', description: 'File pattern filter (e.g. "*.ts", "*.json")' },
    },
    required: ['pattern'],
  },
  getLabel: ({ pattern, path: p }) => `"${pattern}" in ${p || '.'}`,
  async execute({ pattern, path: searchPath = '.', is_regex = false, case_sensitive = false, include }) {
    try {
      const rootPath = resolvePath(searchPath);
      if (!fs.existsSync(rootPath)) return `Path not found: ${searchPath}`;

      if (is_regex && !isSafeRegex(pattern)) {
        return '⚠ Blocked: Pattern is too complex or vulnerable to ReDoS. Use simple regex or literal string search.';
      }

      if (isRgAvailable()) {
        try {
          const flags: string[] = ['-n', '--max-count=20', '--max-columns=200'];
          if (!case_sensitive) flags.push('-i');
          if (!is_regex) flags.push('-F');
          if (include) flags.push(`-g "${include}"`);
          flags.push('--glob "!node_modules/**"', '--glob "!.git/**"', '--glob "!dist/**"');
          const cmd = `rg ${flags.join(' ')} ${JSON.stringify(pattern)} ${JSON.stringify(rootPath)}`;
          const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 512 });
          const relOutput = output.replace(new RegExp(escapeRegex(process.cwd() + path.sep), 'g'), '');
          return grepResultCompact('rg', pattern, relOutput.trim() || 'No matches found.');
        } catch (err: any) {
          if (err.status === 1) return grepResultCompact('rg', pattern, 'No matches found.');
        }
      }

      const { regex, error } = compileSafeRegex(is_regex ? pattern : escapeRegex(pattern), case_sensitive ? 'g' : 'gi');
      if (error || !regex) return `Error: ${error || 'Invalid pattern'}`;

      const results: string[] = [];
      const MAX_RESULTS = 50;
      const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'coverage', '.cache', '.tmp-dist']);

      let includeRegex: RegExp | null = null;
      if (include) {
        const globPattern = include.replace(/\./g, '\\.').replace(/\*/g, '.*');
        includeRegex = new RegExp(`^${globPattern}$`, 'i');
      }

      const searchRegex = regex;
      function searchFile(filePath: string) {
        if (results.length >= MAX_RESULTS || !searchRegex) return;
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > 1024 * 512) return;
          const content = fs.readFileSync(filePath, 'utf-8');
          const lines = content.split('\n');
          const relPath = path.relative(process.cwd(), filePath);

          for (let i = 0; i < lines.length; i++) {
            if (results.length >= MAX_RESULTS) break;
            const line = lines[i]!;
            searchRegex.lastIndex = 0;
            if (searchRegex.test(line)) {
              results.push(`${relPath}:${i + 1}:${line.trim().slice(0, 150)}`);
            }
          }
        } catch { /* skip unreadable */ }
      }

      function walk(dir: string) {
        if (results.length >= MAX_RESULTS) return;
        let files: fs.Dirent[];
        try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const file of files) {
          if (results.length >= MAX_RESULTS) break;
          if (IGNORE.has(file.name)) continue;
          const full = path.join(dir, file.name);
          if (file.isDirectory()) {
            walk(full);
          } else if (file.isFile()) {
            if (includeRegex && !includeRegex.test(file.name)) continue;
            searchFile(full);
          }
        }
      }

      const stat = fs.statSync(rootPath);
      if (stat.isFile()) searchFile(rootPath);
      else walk(rootPath);

      if (results.length === 0) return grepResultCompact('JS', pattern, 'No matches found.');
      const capNotice = results.length >= MAX_RESULTS ? ` (capped at ${MAX_RESULTS} results)` : '';
      return grepResultCompact('JS', pattern, `${results.join('\n')}${capNotice}`);
    } catch (err: any) {
      return `Error in grep: ${err.message}`;
    }
  },
};

// ─── Glob File Finder ─────────────────────────────────────────────────────────
export const globTool: ToolDefinition = {
  name: 'find_files',
  displayName: 'Finding Files',
  description: 'Find files matching a glob pattern (e.g. "*.ts", "src/**/*.js", "**/test*").',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match file names/paths (e.g. "*.ts", "**/*.test.js")' },
      path: { type: 'string', description: 'Starting directory (default: current directory)' },
    },
    required: ['pattern'],
  },
  getLabel: ({ pattern, path: p }) => `"${pattern}" in ${p || '.'}`,
  async execute({ pattern, path: searchPath = '.' }) {
    try {
      const rootPath = resolvePath(searchPath);
      if (!fs.existsSync(rootPath)) return `Path not found: ${searchPath}`;

      const MAX_RESULTS = 100;
      const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'coverage', '.cache', '.tmp-dist']);
      const matches: string[] = [];

      const globRegex = new RegExp(
        '^' + pattern
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '.*')
          .replace(/(?<!\.)\*/g, '[^/\\\\]*')
          .replace(/\?/g, '.') + '$',
        'i'
      );

      function walk(dir: string) {
        if (matches.length >= MAX_RESULTS) return;
        let files: fs.Dirent[];
        try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const file of files) {
          if (matches.length >= MAX_RESULTS) break;
          if (IGNORE.has(file.name)) continue;
          const full = path.join(dir, file.name);
          const rel = path.relative(process.cwd(), full);

          if (file.isDirectory()) {
            if (globRegex.test(rel) || globRegex.test(file.name)) matches.push(`📁 ${rel}/`);
            walk(full);
          } else if (file.isFile()) {
            if (globRegex.test(rel) || globRegex.test(file.name)) matches.push(`  ${rel}`);
          }
        }
      }

      walk(rootPath);
      if (matches.length === 0) return `find_files: no files matching "${pattern}" in ${searchPath}.`;
      const capNotice = matches.length >= MAX_RESULTS ? ` (capped at ${MAX_RESULTS})` : '';
      return `find_files: "${pattern}" (${matches.length} matches${capNotice}):\n${matches.join('\n')}`;
    } catch (err: any) {
      return `Error in find_files: ${err.message}`;
    }
  },
};

// ─── Search Symbols (Fast AST/Pattern Indexer) ──────────────────────────────
export const searchSymbolTool: ToolDefinition = {
  name: 'search_symbol',
  displayName: 'Indexing Symbols',
  description: 'Fast symbol search to locate function, class, interface, type, struct, and enum definitions across codebases (.ts, .tsx, .js, .jsx, .py, .rs, .go, .java) without loading full files into context.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Symbol name or pattern to search for (e.g. "executeTurn", "User", "calculateRoute")' },
      path: { type: 'string', description: 'File or directory to search (default: cwd)' },
      symbol_type: { type: 'string', description: 'Filter by symbol type: function | class | interface | type | struct | enum | any (default: any)' },
      include: { type: 'string', description: 'Glob pattern filter (e.g. "*.ts")' },
      max_results: { type: 'number', description: 'Max symbol results to return (default: 50)' },
    },
    required: ['query'],
  },
  getLabel: ({ query, path: p }) => `"${query}" in ${p || '.'}`,
  async execute({ query, path: searchPath = '.', symbol_type = 'any', include, max_results = 50 }: {
    query: string; path?: string; symbol_type?: string; include?: string; max_results?: number;
  }) {
    const root = resolvePath(searchPath);
    if (!fs.existsSync(root)) return `Error: path not found: ${searchPath}`;

    const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'coverage', '.cache', '.tmp-dist']);
    const VALID_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java']);

    let includeRegex: RegExp | null = null;
    if (include) {
      const globPattern = include.replace(/\./g, '\\.').replace(/\*/g, '.*');
      includeRegex = new RegExp(`^${globPattern}$`, 'i');
    }

    const filesToScan: string[] = [];
    const maxFiles = 3000;

    function walk(target: string) {
      if (filesToScan.length >= maxFiles) return;
      let stat: fs.Stats;
      try { stat = fs.statSync(target); } catch { return; }
      if (stat.isFile()) {
        const ext = path.extname(target).toLowerCase();
        if (VALID_EXTS.has(ext)) {
          const filename = path.basename(target);
          if (!includeRegex || includeRegex.test(filename)) {
            filesToScan.push(target);
          }
        }
        return;
      }
      if (stat.isDirectory()) {
        const base = path.basename(target);
        if (IGNORE_DIRS.has(base)) return;
        let entries: string[] = [];
        try { entries = fs.readdirSync(target); } catch { return; }
        for (const entry of entries) {
          if (IGNORE_DIRS.has(entry)) continue;
          walk(path.join(target, entry));
          if (filesToScan.length >= maxFiles) break;
        }
      }
    }

    walk(root);

    const loweredQuery = query.toLowerCase();
    const desiredType = (symbol_type || 'any').toLowerCase();

    interface SymbolMatch {
      file: string;
      lineNum: number;
      type: string;
      name: string;
      snippet: string;
    }

    const matches: SymbolMatch[] = [];
    const max = Number(max_results) || 50;

    const PATTERNS: Array<{ type: string; ext: string[]; regex: RegExp }> = [
      { type: 'function', ext: ['.ts', '.tsx', '.js', '.jsx'], regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/ },
      { type: 'function', ext: ['.ts', '.tsx', '.js', '.jsx'], regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/ },
      { type: 'class', ext: ['.ts', '.tsx', '.js', '.jsx'], regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/ },
      { type: 'interface', ext: ['.ts', '.tsx'], regex: /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/ },
      { type: 'type', ext: ['.ts', '.tsx'], regex: /^\s*(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/ },
      { type: 'enum', ext: ['.ts', '.tsx'], regex: /^\s*(?:export\s+)?enum\s+([A-Za-z0-9_$]+)/ },
      { type: 'function', ext: ['.py'], regex: /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/ },
      { type: 'class', ext: ['.py'], regex: /^\s*class\s+([A-Za-z0-9_]+)\b/ },
      { type: 'function', ext: ['.rs'], regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\b/ },
      { type: 'struct', ext: ['.rs'], regex: /^\s*(?:pub\s+)?struct\s+([A-Za-z0-9_]+)\b/ },
      { type: 'enum', ext: ['.rs'], regex: /^\s*(?:pub\s+)?enum\s+([A-Za-z0-9_]+)\b/ },
      { type: 'trait', ext: ['.rs'], regex: /^\s*(?:pub\s+)?trait\s+([A-Za-z0-9_]+)\b/ },
      { type: 'function', ext: ['.go'], regex: /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z0-9_]+)\b/ },
      { type: 'struct', ext: ['.go'], regex: /^\s*type\s+([A-Za-z0-9_]+)\s+struct\b/ },
      { type: 'interface', ext: ['.go'], regex: /^\s*type\s+([A-Za-z0-9_]+)\s+interface\b/ },
      { type: 'class', ext: ['.java'], regex: /^\s*(?:public|protected|private)?\s*(?:abstract|final)?\s*class\s+([A-Za-z0-9_]+)/ },
      { type: 'interface', ext: ['.java'], regex: /^\s*(?:public|protected|private)?\s*interface\s+([A-Za-z0-9_]+)/ },
      { type: 'enum', ext: ['.java'], regex: /^\s*(?:public|protected|private)?\s*enum\s+([A-Za-z0-9_]+)/ },
    ];

    for (const filePath of filesToScan) {
      if (matches.length >= max) break;
      const ext = path.extname(filePath).toLowerCase();
      let content = '';
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      const lines = content.split('\n');
      const relPath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');

      const applicablePatterns = PATTERNS.filter(p => p.ext.includes(ext));

      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= max) break;
        const line = lines[i] ?? '';
        for (const p of applicablePatterns) {
          if (desiredType !== 'any' && p.type !== desiredType) continue;
          const match = line.match(p.regex);
          if (match && match[1]) {
            const symName = match[1];
            if (symName.toLowerCase().includes(loweredQuery) || line.toLowerCase().includes(loweredQuery)) {
              matches.push({
                file: relPath,
                lineNum: i + 1,
                type: p.type,
                name: symName,
                snippet: line.trim().slice(0, 100),
              });
              break;
            }
          }
        }
      }
    }

    if (matches.length === 0) {
      return `search_symbol: no symbols matching "${query}" found.`;
    }

    const outputLines = [
      `search_symbol: found ${matches.length} symbol(s) matching "${query}":`,
      ...matches.map(m => `  • [${m.type}] ${m.name} -> ${m.file}:${m.lineNum} \`${m.snippet}\``)
    ];

    return outputLines.join('\n');
  },
};
