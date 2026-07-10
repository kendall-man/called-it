import {
  ConciergeLifecycle,
  createConciergeSignalController,
} from './lifecycle.js';

let installed = false;

export function installConciergeProcessLifecycle(
  lifecycle: ConciergeLifecycle,
  timeoutMs: number,
): void {
  if (installed) return;
  installed = true;
  const controller = createConciergeSignalController({
    lifecycle,
    timeoutMs,
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    },
    exit: (code) => process.exit(code),
    log(event, fields) {
      process.stderr.write(
        `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`,
      );
    },
  });
  process.on('SIGINT', () => controller.signal('SIGINT'));
  process.on('SIGTERM', () => controller.signal('SIGTERM'));
  const finalizeExit = (): void => {
    const exitCode = controller.complete();
    if (exitCode !== null) process.exitCode = exitCode;
  };
  process.once('beforeExit', finalizeExit);
  process.once('exit', finalizeExit);
}
