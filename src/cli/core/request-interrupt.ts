import chalk from 'chalk';
import readline from 'readline';

type CancelToken = { kind: 'cancel' };
type ValueToken<T> = { kind: 'value'; value: T };
type ErrorToken = { kind: 'error'; error: unknown };

export interface TurnInterruptController {
  isInterrupted(): boolean;
  isHardCancelled(): boolean;
  getSignal(): AbortSignal;
  run<T>(task: () => Promise<T>): Promise<{ cancelled: boolean; value?: T }>;
  stop(): void;
}

export function createTurnInterruptController(): TurnInterruptController {
  let escCount = 0;
  let interrupted = false;
  let hardCancelled = false;
  const cancelWaiters = new Set<() => void>();
  const abortController = new AbortController();

  const keypressHandler = (_str: string, key: any) => {
    if (!key || key.name !== 'escape') return;
    escCount += 1;
    if (escCount === 1) {
      interrupted = true;
      process.stdout.write(chalk.yellow('\n  ⚠ Interrupt requested. Press Esc again to cancel this request.\n'));
      return;
    }

    hardCancelled = true;
    abortController.abort();
    process.stdout.write(chalk.red('\n  ✖ Request cancelled.\n'));
    for (const cancel of cancelWaiters) cancel();
    cancelWaiters.clear();
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', keypressHandler);

  return {
    isInterrupted: () => interrupted,
    isHardCancelled: () => hardCancelled,
    getSignal: () => abortController.signal,
    async run<T>(task: () => Promise<T>): Promise<{ cancelled: boolean; value?: T }> {
      if (hardCancelled) return { cancelled: true };

      const taskPromise: Promise<ValueToken<T> | ErrorToken> = task()
        .then((value): ValueToken<T> => ({ kind: 'value', value }))
        .catch((error): ErrorToken => ({ kind: 'error', error }));

      let cancel!: () => void;
      const cancelPromise = new Promise<CancelToken>((resolve) => {
        cancel = () => resolve({ kind: 'cancel' });
        cancelWaiters.add(cancel);
      });

      const winner = await Promise.race<ValueToken<T> | ErrorToken | CancelToken>([
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
      if (!abortController.signal.aborted && hardCancelled) {
        abortController.abort();
      }
    }
  };
}
