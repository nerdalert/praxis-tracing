import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { narrationFileName, narrationSources, root } from './editorial-source.mjs';

const mode = process.argv[2];
if (!['intro', 'ui', 'outro'].includes(mode)) {
  throw new Error('usage: node media/scripts/transcribe-narration.mjs intro|ui|outro [--reuse-json] [--only section-number]');
}
const reuseJson = process.argv.includes('--reuse-json');
const apiKey = process.env.OPENAI_API_KEY;
if (!reuseJson && !apiKey) throw new Error('OPENAI_API_KEY must be provided through the process environment');

const source = await narrationSources();
const sections = mode === 'outro' ? [source.outro] : source[mode];
const outputDir = path.join(root, 'media/generated/captions/words');
await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
await fs.chmod(outputDir, 0o700);
const onlyArg = process.argv.indexOf('--only');
const indices = onlyArg < 0 ? sections.map((_, index) => index) : [Number(process.argv[onlyArg + 1]) - 1];
if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= sections.length)) {
  throw new Error('--only requires a section number from 1 to ' + sections.length);
}
const model = process.env.WHISPER_MODEL || 'whisper-1';

for (const index of indices) {
  const section = sections[index];
  const name = narrationFileName(mode, index);
  const audioPath = path.join(root, 'media/generated/narration', name + '.wav');
  const audio = await fs.readFile(audioPath);
  const audioSha256 = crypto.createHash('sha256').update(audio).digest('hex');
  const sourceSha256 = crypto.createHash('sha256').update(section.text).digest('hex');
  const jsonPath = path.join(outputDir, name + '.json');
  let result;
  if (reuseJson) {
    result = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    if (result.audioSha256 !== audioSha256 || result.sourceSha256 !== sourceSha256 || result.model !== model) {
      throw new Error('saved transcription does not match the current source, audio, or model: ' + name);
    }
  } else {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), name + '.wav');
      form.append('model', model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('language', 'en');
      form.append('prompt', section.text.slice(0, 900));
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + apiKey },
        body: form,
      });
      if (response.ok) {
        result = await response.json();
        break;
      }
      if (attempt === 3 || ![429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error('transcription failed for ' + name + ': HTTP ' + response.status + ' ' + response.statusText);
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  if (!Array.isArray(result.words) || result.words.length === 0) {
    throw new Error('transcription returned no word timestamps for ' + name);
  }
  const saved = {
    model,
    duration: Number(result.duration),
    text: result.text,
    words: result.words.map(({ word, start, end }) => ({ word, start: Number(start), end: Number(end) })),
    source: section.title,
    audioSha256,
    sourceSha256,
  };
  await fs.writeFile(jsonPath, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
  console.log('transcribed ' + name + ': ' + saved.words.length + ' word timestamps');
}
