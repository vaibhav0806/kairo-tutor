import { config } from 'dotenv';

config({ path: 'server/.env', quiet: true });

const required = [
  'DODO_KAIRO_TEST_KEY',
  'DODO_TEST_WEBHOOK_SECRET',
  'DODO_KAIRO_TEST_PRODUCT_ID',
];
const missing = required.filter((name) => !process.env[name]?.trim());

if (process.env.DODO_ENV !== 'test_mode') {
  console.error('billing test blocked: server/.env must set DODO_ENV=test_mode');
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`billing test blocked: missing ${missing.join(', ')}`);
  process.exit(1);
}

console.log('billing test environment verified: test mode with key, webhook secret, and product configured');
