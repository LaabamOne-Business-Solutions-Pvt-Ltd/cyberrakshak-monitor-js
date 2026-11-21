// Compiled (never run) by `npm run typecheck`: what a CommonJS app writes, against index.d.ts.
import monitor = require('@cyberrakshak/monitor');

monitor.init({ key: 'crk_00000000000000000000000000000000', release: '1.4.2', environment: 'staging', platform: 'server' });
monitor.captureException(new Error('x'), { route: 'GET /orders/:id' });
monitor.default.captureMessage('also reachable as .default', { level: 'error' });
const done: Promise<boolean> = monitor.flush();
void done;
monitor.init({ key: 'crk_00000000000000000000000000000000', scrubNames: ['x-brand-key'], scrubPatterns: ['upload-[0-9]+'] });
const reported: Promise<boolean> = monitor.captureRequestError(new Error('x'), { method: 'GET' }, { routePath: '/app/a/route' });
void reported;

// @ts-expect-error: sampleRate is a number
monitor.init({ key: 'crk_00000000000000000000000000000000', sampleRate: '1' });
