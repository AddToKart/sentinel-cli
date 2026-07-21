import fs from 'fs';
import path from 'path';
import {
  ToolDefinition, resolvePath, isPathTraversal, isDangerousExtension,
  isPathSensitive, promptSensitiveFileRead, detectOmission, formatBytes,
  normalizeNewlines, detectEol, withEol, getFileLabel
} from './security.js';
import { generateDiff } from './diff.js';

// ─── Read File ────────────────────────────────────────────────────────────────
export const readFileTool: ToolDefinition = {
  name: 'read_file',
  displayName: 'Reading',
  description: 'Read a file. Use offset/limit to read specific sections without loading entire large files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (relative to cwd or absolute)' },
      offset: { type: 'number', description: 'Start reading from this line number (1-indexed, default: 1)' },
      limit: { type: 'number', description: 'Maximum number of lines to read (default: all)' },
    },
    required: ['path'],
  },
  getLabel: ({ path: p, offset, limit }) =>
    `${p}${offset ? ` L${offset}` : ''}${limit ? `+${limit}` : ''}`,
  async execute({ path: filePath, offset, limit }) {
    try {
      const fullPath = resolvePath(filePath);

      const traverseCheck = isPathTraversal(filePath);
      if (traverseCheck.traversal) {
        return `⚠ Blocked by security policy: Path traversal detected (${traverseCheck.reason}) in "${filePath}".`;
      }

      const sensitiveCheck = isPathSensitive(fullPath);
      if (sensitiveCheck.sensitive) {
        const allow = await promptSensitiveFileRead(filePath, sensitiveCheck.reason!);
        if (!allow) return `Skipped: ${filePath} requires approval (${sensitiveCheck.reason}).`;
      }
      if (!fs.existsSync(fullPath)) return `File not found: ${filePath}`;
      const stat = fs.statSync(fullPath);
      if (stat.size > 1024 * 1024 * 2) return `File too large (${(stat.size / 1024).toFixed(0)} KB). Use offset/limit.`;
      const content = fs.readFileSync(fullPath, 'utf-8');
      const allLines = content.split('\n');
      const start = Math.max(0, (Number(offset) || 1) - 1);
      const end = limit ? Math.min(allLines.length, start + Number(limit)) : allLines.length;
      const sliced = allLines.slice(start, end);
      const numbered = sliced.map((line, idx) =>
        `${String(start + idx + 1).padStart(String(end).length, ' ')}|${line}`
      ).join('\n');
      const range = offset || limit
        ? ` (lines ${start + 1}-${end} of ${allLines.length})`
        : ` (${allLines.length} lines, ${formatBytes(stat.size)})`;
      return `read_file: ${filePath}${range}\n\`\`\`${path.extname(filePath).slice(1) || 'text'}\n${numbered}\n\`\`\``;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
};

// ─── Write File ───────────────────────────────────────────────────────────────
export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  displayName: 'Writing',
  description: 'Write or overwrite a file. Prefer edit_file for targeted changes to existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file path to write to' },
      content: { type: 'string', description: 'The full content to write' },
    },
    required: ['path', 'content'],
  },
  requiresConfirmation: true,
  getLabel: ({ path: p }) => p,
  getRiskSummary: ({ path: p, content }) => `Overwrite ${p} with ${content?.split('\n').length ?? 0} lines`,
  async execute({ path: filePath, content }) {
    try {
      const fullPath = resolvePath(filePath);

      const traverseCheck = isPathTraversal(filePath);
      if (traverseCheck.traversal) {
        return `⚠ Blocked by security policy: Path traversal detected (${traverseCheck.reason}) in "${filePath}".`;
      }

      if (isDangerousExtension(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        return `⚠ Blocked by security policy: Writing ${ext} files is not allowed (${filePath}). This extension is blocked for security.`;
      }

      const sensitiveCheck = isPathSensitive(fullPath);
      if (sensitiveCheck.sensitive) {
        return `⚠ Blocked by security policy: Cannot write to ${sensitiveCheck.reason} (${filePath}). This path is protected.`;
      }

      const omission = detectOmission(content);
      if (omission) {
        return `⚠ Blocked: Content contains an omission placeholder ("${omission}"). Provide the COMPLETE file content without shortcuts.`;
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      const existed = fs.existsSync(fullPath);
      const oldContent = existed ? fs.readFileSync(fullPath, 'utf-8') : '';
      if (existed && normalizeNewlines(oldContent) === normalizeNewlines(content)) {
        return `Skipped write_file: ${filePath} already matches the requested content.`;
      }
      const outputContent = existed ? withEol(content, detectEol(oldContent)) : content;
      fs.writeFileSync(fullPath, outputContent, 'utf-8');
      const diff = existed ? generateDiff(oldContent, outputContent, filePath) : '(new file)';
      return `${existed ? 'Updated' : 'Created'} ${filePath}\n${diff}`;
    } catch (err: any) {
      return `Error writing to file: ${err.message}`;
    }
  },
};

// ─── Edit File (Surgical) ─────────────────────────────────────────────────────
export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  displayName: 'Editing',
  description: 'Make targeted find-and-replace edits. For multiple edits to the same file, use `edits` array: `[{old_string, new_string}, ...]`. Each old_string must be unique in the file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit' },
      old_string: { type: 'string', description: 'The exact string to find and replace (for single edit)' },
      new_string: { type: 'string', description: 'The replacement string (for single edit)' },
      edits: { type: 'array', items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['old_string', 'new_string'] }, description: 'Array of {old_string, new_string} for multiple edits to the same file' },
    },
    required: ['path'],
  },
  requiresConfirmation: true,
  getLabel: ({ path: p, edits }) => `${p} (${edits?.length ?? 1} edit(s))`,
  getRiskSummary: ({ path: p, old_string, new_string, edits }) => {
    if (edits?.length) return `Edit ${p}: ${edits.length} replacements`;
    return `Edit ${p}: replace "${String(old_string).split('\n')[0]?.slice(0, 40) ?? ''}..."`;
  },
  async execute({ path: filePath, old_string, new_string, edits }: {
    path: string; old_string?: string; new_string?: string;
    edits?: Array<{ old_string: string; new_string: string }>;
  }) {
    try {
      const fullPath = resolvePath(filePath);

      const traverseCheck = isPathTraversal(filePath);
      if (traverseCheck.traversal) {
        return `⚠ Blocked by security policy: Path traversal detected (${traverseCheck.reason}) in "${filePath}".`;
      }

      const sensitiveCheck = isPathSensitive(fullPath);
      if (sensitiveCheck.sensitive) return `Blocked: cannot edit ${sensitiveCheck.reason} (${filePath}).`;
      if (!fs.existsSync(fullPath)) return `File not found: ${filePath}`;

      const original = fs.readFileSync(fullPath, 'utf-8');
      const fileEol = detectEol(original);

      const editList: Array<{ old_string: string; new_string: string }> = edits?.length
        ? edits
        : (old_string !== undefined && new_string !== undefined ? [{ old_string, new_string }] : []);
      if (editList.length === 0) return 'Error: provide either (old_string + new_string) or edits array.';

      const replacements: Array<{ old: string; nw: string }> = [];
      for (const edit of editList) {
        const omission = detectOmission(edit.new_string);
        if (omission) return `Blocked: new_string contains omission placeholder ("${omission}").`;
        if (normalizeNewlines(edit.old_string) === normalizeNewlines(edit.new_string)) continue;
        const candidates = [edit.old_string, withEol(edit.old_string, fileEol)].filter((v, i, arr) => arr.indexOf(v) === i);
        const matched = candidates.find(c => original.includes(c));
        if (!matched) {
          const newCands = [edit.new_string, withEol(edit.new_string, fileEol)].filter((v, i, arr) => arr.indexOf(v) === i);
          if (newCands.some(c => original.includes(c))) continue;
          return `Error: old_string not found in ${filePath}: "${edit.old_string.slice(0, 80)}..."`;
        }
        const occurrences = original.split(matched).length - 1;
        if (occurrences > 1) return `Error: old_string appears ${occurrences} times: "${edit.old_string.slice(0, 60)}...". Make it more specific.`;
        replacements.push({ old: matched, nw: withEol(edit.new_string, fileEol) });
      }
      if (replacements.length === 0) return `Skipped: ${filePath} already has the requested content.`;

      let updated = original;
      for (const { old, nw } of replacements) updated = updated.replace(old, nw);
      fs.writeFileSync(fullPath, updated, 'utf-8');
      return `Edited ${filePath} (${replacements.length} change(s)).\n${generateDiff(original, updated, filePath)}`;
    } catch (err: any) {
      return `Error editing file: ${err.message}`;
    }
  },
};

// ─── List Directory ───────────────────────────────────────────────────────────
export const listDirTool: ToolDefinition = {
  name: 'list_directory',
  displayName: 'Listing',
  description: 'List contents of a directory with file sizes and directory indicators. Shows relative paths.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path (default: current directory)' },
      recursive: { type: 'boolean', description: 'List recursively (default: false)' },
      depth: { type: 'number', description: 'Max depth if recursive (default: 2)' },
    },
    required: [],
  },
  getLabel: ({ path: p, recursive }) => `${p || '.'}${recursive ? ' (recursive)' : ''}`,
  async execute({ path: dirPath = '.', recursive = false, depth = 2 }) {
    try {
      const fullPath = resolvePath(dirPath);
      if (!fs.existsSync(fullPath)) return `Directory not found: ${dirPath}`;
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) return `Not a directory: ${dirPath}`;

      const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'coverage', '.cache', '.tmp-dist']);
      const entries: string[] = [];

      function walk(currentDir: string, currentDepth: number) {
        const files = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const file of files) {
          if (IGNORE.has(file.name)) continue;
          const relPath = path.relative(process.cwd(), path.join(currentDir, file.name));
          if (file.isDirectory()) {
            entries.push(`📁 ${relPath}/`);
            if (recursive && currentDepth < depth) {
              walk(path.join(currentDir, file.name), currentDepth + 1);
            }
          } else {
            const size = formatBytes(fs.statSync(path.join(currentDir, file.name)).size);
            const ext = path.extname(file.name);
            const label = getFileLabel(ext);
            entries.push(`  [${label}] ${relPath} (${size})`);
          }
        }
      }

      walk(fullPath, 1);
      return entries.length > 0
        ? `Directory: ${dirPath} (${entries.length} items):\n${entries.join('\n')}`
        : `Directory: ${dirPath} (empty)`;
    } catch (err: any) {
      return `Error listing directory: ${err.message}`;
    }
  },
};

// ─── Read Codebase (Bulk Context Loading) ─────────────────────────────────────
export const readCodebaseTool: ToolDefinition = {
  name: 'read_codebase',
  displayName: 'Loading Codebase',
  description: 'Read key source files across the project to gain broad codebase context. Filters out binary, large, and generated files automatically.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Root directory to start from (default: cwd)' },
      include: { type: 'string', description: 'Glob/ext filter (e.g. "*.ts", "src/**")' },
      max_files: { type: 'number', description: 'Max files to read (default 20, max 50)' },
      max_bytes: { type: 'number', description: 'Max total content size in bytes (default 100KB)' },
    },
    required: [],
  },
  getLabel: ({ path: p, include }) => `read_codebase: ${p || '.'}${include ? ` (${include})` : ''}`,
  async execute({ path: rootPath = '.', include, max_files = 20, max_bytes = 102400 }) {
    try {
      const root = resolvePath(rootPath);
      if (!fs.existsSync(root)) return `Error: path not found: ${rootPath}`;

      const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'coverage', '.cache', '.tmp-dist']);
      const SKIP_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib', '.lock', '.svg', '.map', '.min.js', '.min.css']);

      let includeRegex: RegExp | null = null;
      if (include) {
        const globPattern = include.replace(/\./g, '\\.').replace(/\*/g, '.*');
        includeRegex = new RegExp(`^${globPattern}$`, 'i');
      }

      const filesToRead: string[] = [];
      const fileCap = Math.min(Math.max(1, Number(max_files) || 20), 50);
      const byteCap = Math.min(Math.max(1024, Number(max_bytes) || 102400), 512000);

      function collect(dir: string) {
        if (filesToRead.length >= fileCap) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

        for (const entry of entries) {
          if (filesToRead.length >= fileCap) break;
          if (IGNORE_DIRS.has(entry.name)) continue;

          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            collect(full);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (SKIP_EXTS.has(ext)) continue;
            if (includeRegex && !includeRegex.test(entry.name) && !includeRegex.test(full)) continue;

            try {
              const stat = fs.statSync(full);
              if (stat.size > 50000) continue;
              filesToRead.push(full);
            } catch { /* skip unstattable */ }
          }
        }
      }

      const stat = fs.statSync(root);
      if (stat.isFile()) {
        filesToRead.push(root);
      } else {
        collect(root);
      }

      if (filesToRead.length === 0) {
        return `read_codebase: no matching text files found in ${rootPath}.`;
      }

      let totalBytes = 0;
      const chunks: string[] = [];
      let readCount = 0;

      for (const filePath of filesToRead) {
        if (totalBytes >= byteCap) break;
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const relPath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
          const ext = path.extname(filePath).slice(1) || 'text';

          if (totalBytes + content.length > byteCap) {
            const remaining = byteCap - totalBytes;
            if (remaining > 200) {
              chunks.push(`--- ${relPath} (truncated) ---\n\`\`\`${ext}\n${content.slice(0, remaining)}\n\`\`\``);
              readCount++;
            }
            break;
          }

          chunks.push(`--- ${relPath} ---\n\`\`\`${ext}\n${content}\n\`\`\``);
          totalBytes += content.length;
          readCount++;
        } catch { /* skip unreadable */ }
      }

      const header = `read_codebase: loaded ${readCount} file(s), ${(totalBytes / 1024).toFixed(1)} KB total content:`;
      return `${header}\n\n${chunks.join('\n\n')}`;
    } catch (err: any) {
      return `Error in read_codebase: ${err.message}`;
    }
  },
};
