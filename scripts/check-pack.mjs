// What `npm pack` would put in each tarball, against what it must: exactly these files, and the library files byte for
// byte the ones in the repository (for @cyberrakshak/monitor, the ones served at https://app.cyberrakshak.ai/sdk/node/).
//   node scripts/check-pack.mjs        (after npm run build)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const WANT = {
  '@cyberrakshak/monitor': ['CHANGELOG.md', 'LICENSE', 'README.md', 'cyberrakshak-monitor.cjs', 'cyberrakshak-monitor.mjs', 'index.d.mts', 'index.d.ts', 'package.json'],
  '@cyberrakshak/react-native': ['CHANGELOG.md', 'LICENSE', 'README.md', 'lib/cyberrakshak-monitor.d.ts', 'lib/cyberrakshak-monitor.js', 'package.json'],
};
const DIRS = { '@cyberrakshak/monitor': 'packages/monitor', '@cyberrakshak/react-native': 'packages/react-native' };

let failed = 0;
for (const [name, want] of Object.entries(WANT)) {
  // --ignore-scripts: the files must already be built; prepack is not run here.
  const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '-w', name], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  const [info] = JSON.parse(out);
  const got = info.files.map((f) => f.path).sort();
  const sha = (rel) => createHash('sha256').update(readFileSync(join(root, DIRS[name], rel))).digest('hex');
  const problems = [];
  if (JSON.stringify(got) !== JSON.stringify([...want].sort())) problems.push('files are ' + got.join(', ') + '; want ' + want.join(', '));
  if (info.version !== JSON.parse(readFileSync(join(root, DIRS[name], 'package.json'), 'utf8')).version) problems.push('version');
  console.log(`${name}@${info.version}: ${info.entryCount} files, ${info.size} bytes packed, ${info.unpackedSize} unpacked`);
  for (const f of info.files) console.log(`  ${String(f.size).padStart(6)}  ${f.path}${/\.(mjs|cjs|js)$/.test(f.path) ? '  sha256 ' + sha(f.path) : ''}`);
  for (const p of problems) console.error('  PROBLEM: ' + p);
  failed += problems.length;
}
process.exit(failed ? 1 : 0);
