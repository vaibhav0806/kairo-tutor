/**
 * Generate the Settings voice previews once, at development time, so shipped builds never spend a
 * provider call to play one.
 *
 * A preview is a fixed sentence in a fixed voice — the same bytes for every user, forever — so
 * synthesizing it per click was paying repeatedly for an answer that cannot change. It also cost
 * the user a wait on the very control whose job is to sound instant.
 *
 * This imports the server's OWN synthesis path rather than re-implementing a Sarvam request, so
 * the baked audio is byte-identical to what the live endpoint would have returned: same line, same
 * model, same language, same codec. If any of those change, re-run this.
 *
 *   npm run voices:bake        (from the repo root; needs SARVAM_API_KEY in server/.env)
 *
 * Only Sarvam is baked. ElevenLabs voices come from a live catalog that changes without us, so
 * there is no fixed set to bake — those still synthesize on demand.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeBuffered } from '../src/speech/synthesis';
import { listVoices } from '../src/speech/catalog';

// Must match PREVIEW_LINE in src/proxy/speech.ts — the endpoint and the bake have to agree.
const PREVIEW_LINE = "Hey, I'm Kairo. I'll show you exactly where to click — you stay in control.";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src-tauri', 'assets', 'voice-previews');

async function main() {
  const voices = await listVoices('sarvam');
  if (!voices.length) throw new Error('no Sarvam voices in the catalog');
  mkdirSync(OUT_DIR, { recursive: true });

  let total = 0;
  const baked: string[] = [];
  for (const voice of voices) {
    const audio = await synthesizeBuffered(PREVIEW_LINE, { provider: 'sarvam', voiceId: voice.id });
    const bytes = Buffer.from(audio.audio_base64, 'base64');
    const file = join(OUT_DIR, `sarvam-${voice.id}.wav`);
    writeFileSync(file, bytes);
    total += bytes.length;
    baked.push(voice.id);
    console.log(`  ${voice.id.padEnd(10)} ${String(bytes.length).padStart(8)} bytes  ${audio.mime_type}`);
  }

  console.log(`\nbaked ${baked.length} previews, ${(total / 1024 / 1024).toFixed(2)} MB total`);
  console.log('voice ids:', baked.join(', '));
  console.log(`\nwritten to ${OUT_DIR}`);
  console.log('Commit these — src-tauri embeds them at compile time.');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('bake failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
