/**
 * Resolves when `eventName` is emitted by `contract`, or rejects on timeout.
 * Register BEFORE the triggering tx to avoid races.
 *
 * Usage:
 *   const ev = waitForEvent(contract, "DataVerified");
 *   await contract.connect(x).someMethod();
 *   const [arg0, arg1] = await ev;
 */
export function waitForEvent<T extends any[] = any[]>(
    contract: any,
    eventName: string,
    timeoutMs = 5000,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const event = contract.getEvent(eventName);
        const timer = setTimeout(
            () => reject(new Error(`Timeout waiting for ${eventName}`)),
            timeoutMs,
        );
        contract.once(event, (...args: any[]) => {
            clearTimeout(timer);
            resolve(args as T);
        });
    });
}

/**
 * Same as waitForEvent but resolves only when the emitted event matches the
 * provided predicate. Useful when many similar events fly by and you want a
 * specific one (e.g. matching a verifier address).
 */
export function waitForEventMatching<T extends any[] = any[]>(
    contract: any,
    eventName: string,
    predicate: (...args: any[]) => boolean,
    timeoutMs = 5000,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const event = contract.getEvent(eventName);
        const timer = setTimeout(
            () => reject(new Error(`Timeout waiting for matching ${eventName}`)),
            timeoutMs,
        );
        const handler = (...args: any[]) => {
            if (!predicate(...args)) return;
            clearTimeout(timer);
            contract.removeListener(event, handler);
            resolve(args as T);
        };
        contract.on(event, handler);
    });
}

/**
 * Sleep for `ms` milliseconds - used sparingly to give the JS event loop a
 * chance to drain async listeners after a tx is mined.
 */
export const tick = (ms = 100) => new Promise<void>(r => setTimeout(r, ms));
