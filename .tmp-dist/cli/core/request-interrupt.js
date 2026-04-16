import chalk from 'chalk';
import readline from 'readline';
export function createTurnInterruptController() {
    let escCount = 0;
    let interrupted = false;
    let hardCancelled = false;
    const cancelWaiters = new Set();
    const keypressHandler = (_str, key) => {
        if (!key || key.name !== 'escape')
            return;
        escCount += 1;
        if (escCount === 1) {
            interrupted = true;
            process.stdout.write(chalk.yellow('\n  ⚠ Interrupt requested. Press Esc again to cancel this request.\n'));
            return;
        }
        hardCancelled = true;
        process.stdout.write(chalk.red('\n  ✖ Request cancelled.\n'));
        for (const cancel of cancelWaiters)
            cancel();
        cancelWaiters.clear();
    };
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', keypressHandler);
    return {
        isInterrupted: () => interrupted,
        isHardCancelled: () => hardCancelled,
        async run(task) {
            if (hardCancelled)
                return { cancelled: true };
            const taskPromise = task()
                .then((value) => ({ kind: 'value', value }))
                .catch((error) => ({ kind: 'error', error }));
            let cancel;
            const cancelPromise = new Promise((resolve) => {
                cancel = () => resolve({ kind: 'cancel' });
                cancelWaiters.add(cancel);
            });
            const winner = await Promise.race([
                taskPromise,
                cancelPromise,
            ]);
            cancelWaiters.delete(cancel);
            if (winner.kind === 'cancel') {
                return { cancelled: true };
            }
            if (winner.kind === 'error') {
                throw winner.error;
            }
            return { cancelled: false, value: winner.value };
        },
        stop() {
            process.stdin.removeListener('keypress', keypressHandler);
            cancelWaiters.clear();
        }
    };
}
//# sourceMappingURL=request-interrupt.js.map