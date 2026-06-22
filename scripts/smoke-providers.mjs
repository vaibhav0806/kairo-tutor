import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function parseEnvText(text) {
  const parsed = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const equalsIndex = line.indexOf('=');
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

async function loadLocalEnv() {
  const files = ['.env.local', '.env'];
  const env = { ...process.env };

  for (const file of files) {
    if (!existsSync(file)) continue;
    Object.assign(env, parseEnvText(await readFile(file, 'utf8')));
  }

  return env;
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

async function testOpenRouter(env) {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log('OpenRouter: skipped, OPENROUTER_API_KEY is not set.');
    return;
  }

  const baseUrl = (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const model = env.OPENROUTER_MODEL || '~openai/gpt-latest';
  const payload = await postJson(
    `${baseUrl}/chat/completions`,
    {
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': env.OPENROUTER_SITE_URL || 'http://localhost:5173',
      'X-OpenRouter-Title': env.OPENROUTER_APP_TITLE || 'Kairo Tutor'
    },
    {
      model,
      messages: [
        {
          role: 'system',
          content: 'Reply with exactly: Kairo provider smoke test passed.'
        },
        {
          role: 'user',
          content: 'Run the smoke test.'
        }
      ],
      temperature: 0,
      max_tokens: 24
    }
  );

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenRouter response did not include assistant content.');
  }

  console.log(`OpenRouter: ok (${model})`);
  console.log(`OpenRouter response: ${content}`);
}

async function testSarvamTts(env) {
  const apiKey = env.SARVAM_API_KEY;
  if (!apiKey) {
    console.log('Sarvam TTS: skipped, SARVAM_API_KEY is not set.');
    return;
  }

  const baseUrl = (env.SARVAM_BASE_URL || 'https://api.sarvam.ai').replace(/\/$/, '');
  const model = env.SARVAM_TTS_MODEL || 'bulbul:v3';
  const languageCode = env.SARVAM_TTS_LANGUAGE_CODE || 'en-IN';
  const speaker = env.SARVAM_TTS_SPEAKER || 'shubh';
  const payload = await postJson(
    `${baseUrl}/text-to-speech`,
    {
      'api-subscription-key': apiKey
    },
    {
      text: 'Kairo tutor voice smoke test.',
      target_language_code: languageCode,
      speaker,
      model,
      output_audio_codec: 'wav',
      speech_sample_rate: 24000
    }
  );

  const audioBase64 = payload?.audios?.[0];
  if (!audioBase64) {
    throw new Error('Sarvam TTS response did not include audio.');
  }

  await mkdir('tmp', { recursive: true });
  const outputPath = join('tmp', 'sarvam-tts-smoke.wav');
  await writeFile(outputPath, Buffer.from(audioBase64, 'base64'));

  console.log(`Sarvam TTS: ok (${model}, ${languageCode}, ${speaker})`);
  console.log(`Sarvam audio: ${outputPath}`);
}

const env = await loadLocalEnv();

try {
  await testOpenRouter(env);
  await testSarvamTts(env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
