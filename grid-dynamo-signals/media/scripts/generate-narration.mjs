import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { narrationFileName, narrationSources, root } from './editorial-source.mjs';

const mode = process.argv[2];
if (!['intro', 'ui', 'outro'].includes(mode)) {
  throw new Error('usage: node media/scripts/generate-narration.mjs intro|ui|outro [--only section-number]');
}
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY must be provided through the process environment');

const source = await narrationSources();
const sections = mode === 'outro' ? [source.outro] : source[mode];
const model = process.env.VOICE_MODEL || 'gpt-4o-mini-tts';
const voice = process.env.VOICE_NAME || 'marin';
const outputDir = path.join(root, 'media/generated/narration');
await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
await fs.chmod(outputDir, 0o700);
const manifestPath = path.join(outputDir, mode + '-manifest.json');
const outputsByName = new Map();
const onlyIndex = process.argv.indexOf('--only');
const indices = onlyIndex < 0 ? sections.map((_, index) => index) : [Number(process.argv[onlyIndex + 1]) - 1];
if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= sections.length)) {
  throw new Error('--only requires a section number from 1 to ' + sections.length);
}
if (onlyIndex >= 0) {
  const prior = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (prior.model !== model || prior.voice !== voice) throw new Error('selective regeneration must keep the existing model and voice');
  for (const output of prior.outputs) outputsByName.set(output.name, output);
}

const instructions = [
  'Speak clearly as one consistent, calm technical presenter.',
  'Use a conversational pace, with brief natural pauses at sentence boundaries.',
  'Read every input word in order from beginning to end. Do not omit, paraphrase, or truncate any sentence, and do not add words or music.',
  'Pronounce llm-d as the letters L L M D, EPP as the letters E P P, SWIM as the word swim, and Praxis as PRAK-sis.',
].join(' ');

for (const index of indices) {
  const section = sections[index];
  const name = narrationFileName(mode, index);
  const filePath = path.join(outputDir, name + '.wav');
  const outroClosing = 'Thanks for watching.';
  const parts = mode === 'outro' && section.text.endsWith(outroClosing)
    ? [section.text.slice(0, -outroClosing.length).trim(), outroClosing]
    : [section.text];
  const partPaths = [];
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const partName = name + '-part-' + String(partIndex + 1).padStart(2, '0');
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        voice,
        input: parts[partIndex],
        instructions,
        response_format: 'wav',
      }),
    });
    if (!response.ok) throw new Error('speech generation failed for ' + partName + ': HTTP ' + response.status + ' ' + response.statusText);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1024) throw new Error('speech generation returned an unexpectedly small file for ' + partName);
    const partPath = path.join(outputDir, partName + '.wav');
    await fs.writeFile(partPath, bytes, { mode: 0o600 });
    partPaths.push(partPath);
  }
  if (partPaths.length === 1) {
    await fs.copyFile(partPaths[0], filePath);
  } else {
    const listPath = path.join(outputDir, name + '-parts.ffconcat');
    const list = partPaths.map((file) => "file '" + file.replaceAll("'", "'\\''") + "'").join('\n') + '\n';
    await fs.writeFile(listPath, list, { mode: 0o600 });
    const result = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
      '-i', listPath, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', filePath,
    ], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('failed to join speech parts for ' + name + ': ' + (result.stderr || result.stdout));
  }
  const bytes = await fs.readFile(filePath);
  outputsByName.set(name, {
    name,
    title: section.title,
    file: path.relative(root, filePath),
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sourceSha256: crypto.createHash('sha256').update(section.text).digest('hex'),
  });
  console.log('generated ' + name + '.wav (' + bytes.length + ' bytes)');
}

const manifest = {
  generatedAt: new Date().toISOString(),
  source: 'media/narration/' + (mode === 'intro' ? 'intro-script.md' : mode === 'ui' ? 'ui-walkthrough-script.md' : 'outro-script.md'),
  sourceSections: sections.length,
  model,
  voice,
  disclosure: 'AI-generated narration',
  outputs: [...outputsByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
};
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
console.log('saved ' + path.relative(root, manifestPath));
