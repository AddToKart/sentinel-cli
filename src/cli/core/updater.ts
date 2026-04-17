import axios from 'axios';
import { execSync } from 'child_process';
import chalk from 'chalk';
import figures from 'figures';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Gets the current version from package.json
 */
export function getCurrentVersion(): string {
  try {
    // Try to find package.json in the current project structure
    // Since this runs from dist/cli/core/updater.js, we go up 3 levels
    const pkgPath = path.resolve(__dirname, '../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch (e) {
    return '0.0.0';
  }
}

/**
 * Gets the package name from package.json
 */
export function getPackageName(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.name;
  } catch (e) {
    return 'sentinel-cli';
  }
}

/**
 * Checks if an update is available on npm
 */
export async function checkForUpdate(): Promise<{ current: string; latest: string; updateAvailable: boolean }> {
  const current = getCurrentVersion();
  const packageName = getPackageName();

  try {
    const response = await axios.get(`https://registry.npmjs.org/${packageName}/latest`, { timeout: 2000 });
    const latest = response.data.version;
    return {
      current,
      latest,
      updateAvailable: latest !== current
    };
  } catch (e) {
    // If not published yet or network error, assume no update
    return { current, latest: current, updateAvailable: false };
  }
}

/**
 * Performs the update by running npm install -g
 */
export async function performUpdate(): Promise<boolean> {
  const packageName = getPackageName();
  console.log(chalk.blue(`\n ${figures.info} Checking for updates...`));
  
  const { current, latest, updateAvailable } = await checkForUpdate();
  
  if (!updateAvailable) {
    console.log(chalk.green(`\n ${figures.tick} You are already on the latest version (${current}).\n`));
    return false;
  }

  console.log(chalk.yellow(`\n ${figures.warning} Update available: ${chalk.dim(current)} -> ${chalk.bold(latest)}`));
  console.log(chalk.dim(` Running: npm install -g ${packageName}\n`));

  try {
    // We use execSync to run the global install.
    // Note: This might require sudo on some systems, but for global npm it's standard.
    execSync(`npm install -g ${packageName}`, { stdio: 'inherit' });
    console.log(chalk.green(`\n ${figures.tick} Successfully updated to ${latest}! Please restart Sentinel.\n`));
    return true;
  } catch (e: any) {
    console.log(chalk.red(`\n ${figures.cross} Update failed: ${e.message}\n`));
    console.log(chalk.dim(` Try running 'npm install -g ${packageName}' manually.\n`));
    return false;
  }
}
