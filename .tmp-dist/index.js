#!/usr/bin/env node
import { program, startChat, runOnce } from './cli/index.js';
const args = process.argv.slice(2);
// Pipe mode: echo "fix this bug" | sentinel
if (!process.stdin.isTTY && args.length === 0) {
    let piped = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { piped += chunk; });
    process.stdin.on('end', () => {
        const prompt = piped.trim();
        if (prompt)
            runOnce(prompt);
    });
}
// One-shot: sentinel "explain this"
else if (args.length > 0 && !args[0]?.startsWith('-') && args[0] !== 'chat' && args[0] !== 'config' && args[0] !== 'run') {
    runOnce(args.join(' '));
}
// Interactive or subcommand
else if (args.length === 0) {
    startChat();
}
else {
    program.parse(process.argv);
}
//# sourceMappingURL=index.js.map