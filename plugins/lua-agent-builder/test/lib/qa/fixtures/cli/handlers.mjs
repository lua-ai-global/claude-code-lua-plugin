// Synthetic handlers for test/lib/qa/cli.test.mjs (not a test file).
import { QaError } from '../../../../../lib/qa/io.mjs';

export async function cliEcho(argv, io) {
  io.out.write(`${JSON.stringify({ ok: true, argv })}\n`);
  return 0;
}
export async function cliRefuse() {
  throw new QaError('GATE_NOT_STAMPED', 3, 'gate discovery is not stamped', 'Stamp the gate first.');
}
export async function cliBoom() {
  throw new Error('boom\nsecond line');
}
export const notAFunction = 1;
export function cliHang(argv, io) {
  io.out.write(`${JSON.stringify({ ok: true, started: true })}\n`);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      io.out.write(`${JSON.stringify({ ok: true, late: true })}\n`);
      io.err.write('late\n');
      resolve(0);
    }, 8000);
    timer.unref?.();
  });
}
export async function cliHoldLock(argv, io) {
  const { withSandboxLock } = await import('../../../../../lib/qa/state.mjs');
  return withSandboxLock(argv[0], { runId: 'r', player: 'hang' }, () => new Promise((resolve) => {
    io.out.write(`${JSON.stringify({ ok: true, locked: true })}\n`);
    setTimeout(() => resolve(0), 8000).unref();
  }));
}
