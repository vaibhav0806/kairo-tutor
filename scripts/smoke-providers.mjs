import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makeSmokePngBase64(width = 512, height = 320) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 4;
      const inBox = x > width * 0.25 && x < width * 0.75 && y > height * 0.25 && y < height * 0.75;
      row[offset] = inBox ? 23 : 244;
      row[offset + 1] = inBox ? 126 : 247;
      row[offset + 2] = inBox ? 116 : 250;
      row[offset + 3] = 255;
    }
    rows.push(row);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND')
  ]).toString('base64');
}

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

async function postJson(url, headers, body, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    const detail = error?.cause?.message ?? error?.message ?? 'request failed';
    throw new Error(`${options.label ?? 'Provider request'}: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
    throw new Error(`${options.label ?? 'Provider request'}: ${message}`);
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
          content:
            'Return only JSON with this exact shape: {"screenText":"Kairo provider smoke test passed.","voiceText":"Kairo provider smoke test passed."}'
        },
        {
          role: 'user',
          content: 'Run the smoke test.'
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 80
    },
    { label: `OpenRouter text (${model})`, timeoutMs: 30000 }
  );

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenRouter response did not include assistant content.');
  }
  JSON.parse(content);

  console.log(`OpenRouter: ok (${model})`);
  console.log(`OpenRouter response: ${content}`);

  const tinyPng = makeSmokePngBase64();
  const visionModel = env.OPENROUTER_VISION_MODEL || model;

  try {
    const visionPayload = await postJson(
      `${baseUrl}/chat/completions`,
      {
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': env.OPENROUTER_SITE_URL || 'http://localhost:5173',
        'X-OpenRouter-Title': env.OPENROUTER_APP_TITLE || 'Kairo Tutor'
      },
      {
        model: visionModel,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Return only JSON with this exact shape: {"screenText":"Kairo vision smoke test passed.","voiceText":"Kairo vision smoke test passed."}'
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${tinyPng}`
                }
              }
            ]
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 80
      }
    );
    const visionContent = visionPayload?.choices?.[0]?.message?.content;
    if (!visionContent) {
      throw new Error('OpenRouter vision response did not include assistant content.');
    }
    JSON.parse(visionContent);

    console.log(`OpenRouter vision: ok (${visionModel})`);
    console.log(`OpenRouter vision response: ${visionContent}`);
  } catch (error) {
    if (env.OPENROUTER_VISION_MODEL) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'unknown provider error';
    console.log(`OpenRouter vision: unavailable for ${visionModel}; text fallback will be used.`);
    console.log(`OpenRouter vision reason: ${message}`);
  }
}

async function testAnthropicVision(env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('Anthropic vision: skipped, ANTHROPIC_API_KEY is not set.');
    return;
  }

  const baseUrl = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const model = env.ANTHROPIC_VISION_MODEL || 'claude-fable-5';
  const tinyPng = makeSmokePngBase64();

  const payload = await postJson(
    `${baseUrl}/v1/messages`,
    {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    {
      model,
      max_tokens: 128,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: tinyPng
              }
            },
            {
              type: 'text',
              text:
                'Return JSON only. This is a blank smoke-test image, so return {"elements":[]}.'
            }
          ]
        }
      ]
    },
    { label: `Anthropic vision (${model})`, timeoutMs: 30000 }
  );

  const content = payload?.content
    ?.map((block) => (block?.type === 'text' ? block.text : ''))
    .join('');
  if (!content) {
    throw new Error('Anthropic vision response did not include text content.');
  }
  JSON.parse(content);

  console.log(`Anthropic vision: ok (${model})`);
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
  await testAnthropicVision(env);
  await testSarvamTts(env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
