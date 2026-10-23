/** `npm run doctor`: checks a teammate's machine is set up. Prints PASS/FAIL per item. */
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

let failed = 0;
const check = (ok: boolean, label: string, hint = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !hint ? '' : `\n      -> ${hint}`}`);
  if (!ok) failed++;
};

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
check(
  major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19),
  `Node ${process.versions.node} (need 22.12+)`,
  'install Node 22 LTS (nvm install 22)',
);
check(existsSync('node_modules'), 'dependencies installed', 'run: npm install');
check(existsSync('.env'), '.env exists', 'copy .env.example to .env');
if (existsSync('.env')) {
  const env = readFileSync('.env', 'utf8');
  check(
    !/HOST_KEY=change-me-before-the-event/.test(env),
    'HOST_KEY changed from the example',
    'edit HOST_KEY in .env',
  );
}
const lan = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i!.address);
check(
  lan.length > 0,
  `LAN address(es): ${lan.join(', ') || 'none'}`,
  'connect to Wi-Fi or a hotspot',
);
console.log(
  failed ? `\n${failed} problem(s). Fix them, then run npm run doctor again.` : '\nAll good.',
);
process.exit(failed ? 1 : 0);
