import chalk from 'chalk';
import figures from 'figures';
import { password } from '@inquirer/prompts';
import { saveConfig } from '../../config/index.js';
export async function safePrompt(promptFn) {
    try {
        return await promptFn();
    }
    catch (err) {
        if (err.name === 'ExitPromptError') {
            process.exit(0);
        }
        throw err;
    }
}
export async function ensureApiKey(providerName, config) {
    const keyMap = {
        gemini: 'GEMINI_API_KEY',
        openai: 'OPENAI_API_KEY',
        anthropic: 'ANTHROPIC_API_KEY',
        openrouter: 'OPENROUTER_API_KEY'
    };
    const configKey = keyMap[providerName];
    if (!configKey)
        return true;
    if (config[configKey]) {
        return true;
    }
    console.log(chalk.yellow(`\n ${figures.warning} API Key required for ${providerName.toUpperCase()}`));
    const key = await safePrompt(() => password({ message: `Paste your ${providerName.toUpperCase()} API Key:` }));
    if (!key || key.trim().length === 0) {
        console.log(chalk.red(` ${figures.cross} No key provided. Operation cancelled.`));
        return false;
    }
    config[configKey] = key;
    saveConfig({ [configKey]: key });
    console.log(chalk.green(` ${figures.tick} Key saved successfully for future use!\n`));
    return true;
}
//# sourceMappingURL=auth.js.map