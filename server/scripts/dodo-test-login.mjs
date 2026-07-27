import { spawn } from 'node:child_process';
import { config } from 'dotenv';

config({ path: 'server/.env', quiet: true });

if (process.env.DODO_ENV !== 'test_mode') {
  console.error('Dodo CLI login blocked: server/.env must set DODO_ENV=test_mode');
  process.exit(1);
}
const apiKey = process.env.DODO_KAIRO_TEST_KEY?.trim();
if (!apiKey) {
  console.error('Dodo CLI login blocked: DODO_KAIRO_TEST_KEY is missing');
  process.exit(1);
}

console.log('Authenticating Dodo CLI in test mode…');
const child = spawn(
  'npx',
  ['--yes', 'dodopayments-cli@3.4.0', 'login', apiKey, 'test'],
  { stdio: 'inherit' },
);
child.on('error', (error) => {
  console.error(`Could not start Dodo CLI: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
