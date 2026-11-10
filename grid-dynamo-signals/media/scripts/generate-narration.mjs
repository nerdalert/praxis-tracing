import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mode = process.argv[2];
if (!['intro', 'ui'].includes(mode)) {
  throw new Error('usage: node media/scripts/generate-narration.mjs intro|ui');
}
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY must be provided through the process environment');

const scriptPath = path.join(root, 'media/narration', mode === 'intro' ? 'intro-script.md' : 'ui-walkthrough-script.md');
const markdown = await fs.readFile(scriptPath, 'utf8');
const sections = markdown.split(/^##\s+/m).slice(1).map((section) => {
  const [title, ...lines] = section.split('\n');
  return { title, body: lines.join('\n') };
});
if (sections.length !== (mode === 'intro' ? 5 : 9)) {
  throw new Error(`expected ${mode === 'intro' ? 5 : 9} narration sections; found ${sections.length}`);
}
const narration = sections.map((section, index) => {
  const text = section.body
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .replace(/[`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > 4096) throw new Error(`section ${index + 1} has invalid length ${text.length}`);
  return { title: section.title.trim(), text };
});
const onlyIndex = process.argv.indexOf('--only');
const indices = onlyIndex < 0
  ? narration.map((_, index) => index)
  : [Number(process.argv[onlyIndex + 1]) - 1];
if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= narration.length)) throw new Error(`--only requires a section number from 1 to ${narration.length}`);

const model = process.env.VOICE_MODEL || 'gpt-4o-mini-tts';
const voice = process.env.VOICE_NAME || 'marin';
const outputDir = path.join(root, 'media/generated/narration');
await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
await fs.chmod(outputDir, 0o700);
const manifestPath = path.join(outputDir, `${mode}-manifest.json`);
const outputsByName = new Map();
if (onlyIndex >= 0) {
  const prior = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (prior.model !== model || prior.voice !== voice) throw new Error('selective regeneration must keep the manifest model and voice');
  for (const output of prior.outputs) outputsByName.set(output.name, output);
}

for (const index of indices) {
  const scene = narration[index];
  const suffix = String(index + 1).padStart(2, '0');
  const name = mode === 'intro' ? `slide-${suffix}` : `ui-${suffix}`;
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      voice,
      input: scene.text,
      instructions: 'Speak clearly and naturally as a calm technical presenter. Keep a measured conversational pace, pronounce product names clearly, and do not add words that are not in the input.',
      response_format: 'wav',
    }),
  });
  if (!response.ok) throw new Error(`speech generation failed for ${name}: HTTP ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1024) throw new Error(`speech generation returned an unexpectedly small file for ${name}`);
  const filePath = path.join(outputDir, `${name}.wav`);
  await fs.writeFile(filePath, bytes, { mode: 0o600 });
  outputsByName.set(name, {
    name,
    title: scene.title,
    file: path.relative(root, filePath),
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sourceSha256: crypto.createHash('sha256').update(scene.text).digest('hex'),
  });
  console.log(`generated ${name}.wav (${bytes.length} bytes)`);
}

await fs.writeFile(manifestPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: path.relative(root, scriptPath),
  model,
  voice,
  disclosure: 'AI-generated narration',
  outputs: [...outputsByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
}, null, 2)}\n`, { mode: 0o600 });
console.log(`saved ${path.relative(root, manifestPath)}`);
