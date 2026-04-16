export interface TurnInterruptController {
    isInterrupted(): boolean;
    isHardCancelled(): boolean;
    run<T>(task: () => Promise<T>): Promise<{
        cancelled: boolean;
        value?: T;
    }>;
    stop(): void;
}
export declare function createTurnInterruptController(): TurnInterruptController;
//# sourceMappingURL=request-interrupt.d.ts.map