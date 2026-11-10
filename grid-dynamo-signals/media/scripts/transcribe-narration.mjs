import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mode = process.argv[2];
if (!['intro', 'ui'].includes(mode)) throw new Error('usage: node media/scripts/transcribe-narration.mjs intro|ui');
const reuseJson = process.argv.includes('--reuse-json');
const apiKey = process.env.OPENAI_API_KEY;
if (!reuseJson && !apiKey) throw new Error('OPENAI_API_KEY must be provided through the process environment');

const markdown = await fs.readFile(path.join(root, 'media/narration', mode === 'intro' ? 'intro-script.md' : 'ui-walkthrough-script.md'), 'utf8');
const sections = markdown.split(/^##\s+/m).slice(1).map((section) => {
  const [title, ...lines] = section.split('\n');
  const text = lines.join(' ').replace(/\[[^\]]+\]\([^)]+\)/g, '').replace(/[`*_#]/g, '').replace(/\s+/g, ' ').trim();
  return { title: title.trim(), text };
});
const outputDir = path.join(root, 'media/generated/captions');
const onlyArg = process.argv.indexOf('--only');
const indices = onlyArg < 0 ? sections.map((_, index) => index) : [Number(process.argv[onlyArg + 1]) - 1];
if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= sections.length)) throw new Error(`--only requires a section number from 1 to ${sections.length}`);
await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
await fs.chmod(outputDir, 0o700);

function stamp(value) {
  const ms = Math.max(0, Math.round(value * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function alignSourceWords(words, sourceText) {
  const matches = [...sourceText.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*(?:[-/][\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*)*/gu)];
  let wordIndex = 0;
  const aligned = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const lexicalParts = match[0].split(/[-/]/u);
    const spoken = words.slice(wordIndex, wordIndex + lexicalParts.length);
    const normalize = (value) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}'’]/gu, '').replaceAll('’', "'");
    if (spoken.length !== lexicalParts.length) {
      throw new Error(`timestamp words differ from the narration source near “${match[0]}”; review transcription before caption export`);
    }
    for (let partIndex = 0; partIndex < lexicalParts.length; partIndex += 1) {
      const expected = normalize(lexicalParts[partIndex]);
      const recognized = normalize(spoken[partIndex].word);
      if (expected !== recognized) console.log(`caption source correction: ${spoken[partIndex].word} → ${lexicalParts[partIndex]} (voice generated from narration source)`);
    }
    const nextIndex = matches[index + 1]?.index ?? sourceText.length;
    const between = sourceText.slice(match.index + match[0].length, nextIndex).trimStart();
    const punctuation = between.match(/^[,;:.!?…]+["'’)\]]*/u)?.[0] ?? '';
    aligned.push({
      word: `${match[0]}${punctuation}`,
      start: spoken[0].start,
      end: spoken.at(-1).end,
    });
    wordIndex += lexicalParts.length;
  }
  if (wordIndex !== words.length) throw new Error(`timestamp word count differs from the narration source (${words.length - wordIndex} unmatched word(s))`);
  return aligned;
}

function makeSrt(words, sourceText, mediaDuration) {
  const alignedWords = alignSourceWords(words, sourceText);
  const cues = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const text = current.map((word) => word.word.trim()).join(' ');
    const lines = [];
    let line = '';
    const maxLineLength = mode === 'ui' ? 50 : 38;
    for (const word of text.split(/\s+/)) {
      if (line && `${line} ${word}`.length > maxLineLength) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
    cues.push({ start: current[0].start, end: current.at(-1).end, text: lines.join('\n') });
    current = [];
  };
  for (const raw of alignedWords) {
    const word = { ...raw, word: raw.word.trim() };
    if (!word.word || !Number.isFinite(word.start) || !Number.isFinite(word.end)) continue;
    const before = current.map((item) => item.word).join(' ');
    const pause = current.length && word.start - current.at(-1).end > 0.65;
    const punctuation = /[.!?;]["')\]]?$/.test(current.at(-1)?.word ?? '');
    if (current.length && (pause || punctuation || `${before} ${word.word}`.length > 78 || word.end - current[0].start > 5.8)) flush();
    current.push(word);
  }
  flush();
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    if (cue.end - cue.start >= 0.7) continue;
    const priorEnd = cues[index - 1]?.end ?? 0;
    const nextStart = cues[index + 1]?.start ?? mediaDuration;
    const targetEnd = Math.min(cue.start + 0.7, nextStart, mediaDuration);
    const extraEnd = Math.max(0, targetEnd - cue.end);
    cue.end += extraEnd;
    const stillShort = 0.7 - (cue.end - cue.start);
    if (stillShort > 0) cue.start = Math.max(priorEnd, cue.start - stillShort);
  }
  return `${cues.map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}`).join('\n\n')}\n`;
}

for (const index of indices) {
  const suffix = String(index + 1).padStart(2, '0');
  const name = mode === 'intro' ? `slide-${suffix}` : `ui-${suffix}`;
  const audioPath = path.join(root, 'media/generated/narration', `${name}.wav`);
  const audio = await fs.readFile(audioPath);
  let result;
  const jsonPath = path.join(outputDir, `${name}.json`);
  if (reuseJson) {
    result = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  } else {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), `${name}.wav`);
      form.append('model', process.env.WHISPER_MODEL || 'whisper-1');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('prompt', sections[index].text.slice(0, 900));
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (response.ok) {
        result = await response.json();
        break;
      }
      const detail = (await response.text()).slice(0, 240).replace(/\s+/g, ' ');
      if (attempt === 3 || ![429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`transcription failed for ${name}: HTTP ${response.status} ${response.statusText}; ${detail}`);
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  if (!Array.isArray(result.words) || result.words.length === 0) throw new Error(`transcription returned no word timestamps for ${name}`);
  const srtPath = path.join(outputDir, `${name}.srt`);
  await fs.writeFile(jsonPath, `${JSON.stringify({ ...result, source: `media/narration/${mode === 'intro' ? 'intro-script.md' : 'ui-walkthrough-script.md'}`, section: sections[index].title, audioSha256: crypto.createHash('sha256').update(audio).digest('hex') }, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(srtPath, makeSrt(result.words, sections[index].text, Number(result.duration)), { mode: 0o600 });
  console.log(`captioned ${name}: ${result.words.length} timed words`);
}
