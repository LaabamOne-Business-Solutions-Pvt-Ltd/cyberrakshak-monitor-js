// Compiled (never run) by `npm run typecheck`: what an ES module app writes, against index.d.mts.
import * as monitor from '@cyberrakshak/monitor';
import monitorDefault, { init, captureException, type Options, type Problem } from '@cyberrakshak/monitor';

const options: Options = {
  key: 'crk_00000000000000000000000000000000',
  endpoint: 'http://127.0.0.1:9/api/v1/app-reports',
  release: '2026.11.21',
  environment: 'production',
  enabled: true,
  sampleRate: 0.5,
  beforeSend: (problem: Problem) => (problem.kind === 'log' ? null : { ...problem, message: problem.message.slice(0, 100) }),
  debug: false,
  context: { tenant: 't1', batch: 42, beta: true },
  platform: 'script',
  captureUncaught: true,
  captureRejections: true,
  exitSend: false,
};
init(options);
monitor.init({ key: 'crk_00000000000000000000000000000000' });
monitorDefault.captureMessage('Payment provider answered slowly', { level: 'warning', route: 'checkout' });
captureException(new Error('x'), { route: 'nightly-import', context: { batch: 42 }, level: 'error' });
const handler: (error: unknown, req: { method?: string; url?: string }, res: unknown, next: (e?: unknown) => void) => void = monitor.expressErrorHandler();
handler(new Error('x'), { method: 'GET', url: '/' }, {}, () => undefined);
const sent: Promise<boolean> = monitor.flush(2000);
const scrubbed: string = monitor.scrub('password=hunter2');
monitor.close();
void sent;
void scrubbed;

// @ts-expect-error: the key is required
init({});
// @ts-expect-error: level is 'error' or 'warning'
captureException(new Error('x'), { level: 'fatal' });
