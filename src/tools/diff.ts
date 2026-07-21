import { normalizeNewlines } from './security.js';

/** Generate a unified diff between old and new content with hunk headers */
export function generateDiff(oldContent: string, newContent: string, filePath: string, contextLines: number = 2): string {
  const normOld = normalizeNewlines(oldContent);
  const normNew = normalizeNewlines(newContent);
  if (normOld === normNew) return '(no changes)';

  const a = normOld.split('\n');
  const b = normNew.split('\n');
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = 0; i < n; i++) {
    const curRow = dp[i + 1]!;
    const prevRow = dp[i]!;
    for (let j = 0; j < m; j++) {
      if (a[i] === b[j]) {
        curRow[j + 1] = (prevRow[j] ?? 0) + 1;
      } else {
        curRow[j + 1] = Math.max(curRow[j] ?? 0, prevRow[j + 1] ?? 0);
      }
    }
  }

  type Op = { type: 'equal' | 'delete' | 'insert'; line: string; aIdx?: number; bIdx?: number };
  const ops: Op[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: 'equal', line: a[i - 1]!, aIdx: i - 1, bIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (dp[i]![j - 1] ?? 0) >= (dp[i - 1]![j] ?? 0))) {
      ops.push({ type: 'insert', line: b[j - 1]!, bIdx: j - 1 });
      j--;
    } else {
      ops.push({ type: 'delete', line: a[i - 1]!, aIdx: i - 1 });
      i--;
    }
  }

  ops.reverse();

  const diffLines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let inHunk = false;
  let hunkOps: Op[] = [];
  let hunkOldStart = 0;
  let hunkNewStart = 0;

  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx]!;
    const isChange = op.type !== 'equal';

    if (isChange) {
      if (!inHunk) {
        inHunk = true;
        const startIdx = Math.max(0, idx - contextLines);
        hunkOps = ops.slice(startIdx, idx + 1);
        const first = hunkOps[0]!;
        hunkOldStart = first.aIdx ?? ops.slice(0, startIdx).filter(o => o.type !== 'insert').length;
        hunkNewStart = first.bIdx ?? ops.slice(0, startIdx).filter(o => o.type !== 'delete').length;
      } else {
        hunkOps.push(op);
      }
    } else if (inHunk) {
      let nextChange = -1;
      for (let k = idx; k < Math.min(ops.length, idx + contextLines * 2 + 1); k++) {
        if (ops[k]!.type !== 'equal') {
          nextChange = k;
          break;
        }
      }

      if (nextChange !== -1) {
        hunkOps.push(op);
      } else {
        const trailing = ops.slice(idx, Math.min(ops.length, idx + contextLines));
        hunkOps.push(...trailing);

        let oldCount = 0;
        let newCount = 0;
        const formatted: string[] = [];
        for (const ho of hunkOps) {
          if (ho.type === 'equal') { oldCount++; newCount++; formatted.push(`  ${ho.line}`); }
          else if (ho.type === 'delete') { oldCount++; formatted.push(`- ${ho.line}`); }
          else if (ho.type === 'insert') { newCount++; formatted.push(`+ ${ho.line}`); }
        }

        diffLines.push(`@@ -${hunkOldStart + 1},${oldCount} +${hunkNewStart + 1},${newCount} @@`);
        diffLines.push(...formatted);

        idx += trailing.length - 1;
        inHunk = false;
        hunkOps = [];
      }
    }
  }

  if (inHunk && hunkOps.length > 0) {
    let oldCount = 0;
    let newCount = 0;
    const formatted: string[] = [];
    for (const ho of hunkOps) {
      if (ho.type === 'equal') { oldCount++; newCount++; formatted.push(`  ${ho.line}`); }
      else if (ho.type === 'delete') { oldCount++; formatted.push(`- ${ho.line}`); }
      else if (ho.type === 'insert') { newCount++; formatted.push(`+ ${ho.line}`); }
    }
    diffLines.push(`@@ -${hunkOldStart + 1},${oldCount} +${hunkNewStart + 1},${newCount} @@`);
    diffLines.push(...formatted);
  }

  return diffLines.join('\n');
}
