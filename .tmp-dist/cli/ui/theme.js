import chalk from 'chalk';
export const COLORS = {
    // Accent greens (refined & modern)
    green500: '#10b981', // emerald-500
    green400: '#34d399', // emerald-400
    green300: '#6ee7b7', // emerald-300
    // Neutrals (elegant slates)
    slate900: '#0f172a',
    slate800: '#1e293b',
    slate700: '#334155',
    slate600: '#475569',
    slate500: '#64748b',
    slate400: '#94a3b8',
    slate300: '#cbd5e1',
    slate200: '#e2e8f0',
    slate100: '#f1f5f9',
    white: '#ffffff',
};
export const THEME = {
    header: chalk.hex(COLORS.white).bold,
    dim: chalk.hex(COLORS.slate500),
    body: chalk.hex(COLORS.slate300),
    accent: chalk.hex(COLORS.green400),
    userText: chalk.hex(COLORS.slate200),
    border: chalk.hex(COLORS.slate700),
    codeBg: chalk.bgHex(COLORS.slate900).hex(COLORS.slate200),
    icon: chalk.hex(COLORS.green500)
};
export const sentinelLogo = `
  ██████  ███████ ███    ██ ████████ ██ ███    ██ ███████ ██      
 ██       ██      ████   ██    ██    ██ ████   ██ ██      ██      
  ██████  █████   ██ ██  ██    ██    ██ ██ ██  ██ █████   ██      
       ██ ██      ██  ██ ██    ██    ██ ██  ██ ██ ██      ██      
  ██████  ███████ ██   ████    ██    ██ ██   ████ ███████ ███████ 
`;
//# sourceMappingURL=theme.js.map