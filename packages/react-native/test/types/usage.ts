// Compiled (never run) by `npm run typecheck`: what an app writes, against the published lib/cyberrakshak-monitor.d.ts.
import * as monitor from '@cyberrakshak/react-native';
import monitorDefault, { type Options, type Problem, type Storage } from '@cyberrakshak/react-native';

const storage: Storage = {
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: async () => undefined,
};
const options: Options = {
  key: 'crk_00000000000000000000000000000000',
  release: '1.4.2+57',
  environment: 'production',
  sampleRate: 1,
  beforeSend: (problem: Problem) => (problem.route === 'Secret' ? null : problem),
  context: { build: 57 },
  storage,
  capturePromiseRejections: true,
};
monitor.init(options);
monitor.setRoute('Checkout');
monitor.captureException(new Error('x'), { componentStack: '\n    in App', context: { orderStep: 2 } });
monitorDefault.captureMessage('slow', { level: 'warning' });
const sent: Promise<boolean> = monitor.flush(2000);
const scrubbed: string = monitor.scrub('token=abc');
monitor.close();
void sent;
void scrubbed;

// @ts-expect-error: the key is required
monitor.init({ release: '1' });
