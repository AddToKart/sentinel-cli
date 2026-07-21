#!/usr/bin/env node
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'index.ts');

const result = spawnSync('npx', ['tsx', entryPoint, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
  shell: true,
});

process.exit(result.status ?? 0);
