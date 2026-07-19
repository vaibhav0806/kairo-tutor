// One-off: pre-generate the static onboarding voice lines (Sarvam) and ship them with the app so we
// don't spend credits on every onboarding. Run: `npx tsx scripts/gen-onboarding-audio.ts`
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CACHED_LINES } from '../src/onboarding/copy';

const KEY = process.env.SARVAM_API_KEY;
const OUT = 'src/onboarding/audio';

if (!KEY) {
  console.error('SARVAM_API_KEY missing (root .env)');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

for (const { key, text } of CACHED_LINES) {
  const res = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'api-subscription-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, target_language_code: 'en-IN', speaker: 'shubh', model: 'bulbul:v3' }),
  });
  if (!res.ok) {
    console.log('FAIL', key, res.status, (await res.text()).slice(0, 120));
    continue;
  }
  const json = (await res.json()) as { audios?: string[] };
  const b64 = json.audios?.[0];
  if (!b64) {
    console.log('NO_AUDIO', key);
    continue;
  }
  writeFileSync(`${OUT}/${key}.wav`, Buffer.from(b64, 'base64'));
  console.log('OK', key, `(${text.length} chars)`);
}
console.log('done');
