import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error('usage: node media/scripts/export-reviewed-assets.mjs --ui <recording.mp4>');
  return path.resolve(args[index + 1]);
};
const uiPath = option('--ui');
const generated = path.join(root, 'media/generated');
const ttsDir = path.join(generated, 'narration');
const captionsDir = path.join(generated, 'captions');
const audioOut = path.join(root, 'media/audio');
const captionsOut = path.join(root, 'media/captions');
const previewAudioPath = path.join(generated, 'preview-build/preview-audio.wav');

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function duration(file) {
  return Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]));
}
async function hash(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}
function timestamp(value) {
  const ms = Math.max(0, Math.round(value * 1000));
  return `${String(Math.floor(ms / 3_600_000)).padStart(2, '0')}:${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
function parseSrt(source) {
  const blocks = source.trim().split(/\r?\n\s*\r?\n/).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split(/\r?\n/);
    const match = lines[1].match(/^(\S+)\s+-->\s+(\S+)$/);
    if (!match) throw new Error(`invalid SRT timing: ${lines[1]}`);
    const seconds = (stamp) => {
      const [hours, minutes, rest] = stamp.split(':');
      const [whole, millis] = rest.split(',');
      return Number(hours) * 3600 + Number(minutes) * 60 + Number(whole) + Number(millis) / 1000;
    };
    return { start: seconds(match[1]), end: seconds(match[2]), text: lines.slice(2).join('\n') };
  });
}
function renderSrt(cues) {
  return `${cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}`).join('\n\n')}\n`;
}

const introManifest = JSON.parse(await fs.readFile(path.join(ttsDir, 'intro-manifest.json'), 'utf8'));
const uiManifest = JSON.parse(await fs.readFile(path.join(ttsDir, 'ui-manifest.json'), 'utf8'));
if (introManifest.model !== uiManifest.model || introManifest.voice !== uiManifest.voice) throw new Error('intro and UI narration must use the same model and voice');
if (!(await fs.stat(previewAudioPath).catch(() => null))) throw new Error('build the local preview before exporting reviewed media assets');
const previewAudioDuration = duration(previewAudioPath);
const sourceUiDuration = duration(uiPath);
const leadBufferPath = path.join(generated, 'preview-build/lead-buffer.mp4');
if (!(await fs.stat(leadBufferPath).catch(() => null))) throw new Error('build the local preview with its two-second lead buffer before exporting reviewed media assets');
function extractTrack(start, trackDuration, target) {
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', previewAudioPath, '-af', `atrim=start=${start.toFixed(3)}:duration=${trackDuration.toFixed(3)},asetpts=PTS-STARTPTS`, '-ar', '48000', '-c:a', 'pcm_s16le', target]);
}

const introDir = path.join(audioOut, 'intro');
await fs.mkdir(introDir, { recursive: true });
const introCues = [];
let introOffset = duration(leadBufferPath);
const introTracks = [];
for (let index = 1; index <= 5; index += 1) {
  const name = `slide-${String(index).padStart(2, '0')}`;
  const segment = path.join(generated, 'preview-build', `${name}.mp4`);
  if (!(await fs.stat(segment).catch(() => null))) throw new Error(`missing built slide segment: ${name}`);
  const segmentDuration = duration(segment);
  const target = path.join(introDir, `${name}.wav`);
  extractTrack(introOffset, segmentDuration, target);
  introTracks.push({ file: `media/audio/intro/${name}.wav`, durationSeconds: duration(target), sha256: await hash(target) });
  const caption = await fs.readFile(path.join(captionsDir, `${name}.srt`), 'utf8');
  for (const cue of parseSrt(caption)) introCues.push({ ...cue, start: cue.start + introOffset, end: cue.end + introOffset });
  introOffset += segmentDuration;
}
if (previewAudioDuration < introOffset + sourceUiDuration - 0.1) throw new Error('final preview audio track does not contain the complete recorded UI timeline');
const introSrtPath = path.join(captionsOut, 'intro.srt');
await fs.writeFile(introSrtPath, renderSrt(introCues));

const uiScript = await fs.readFile(path.join(root, 'media/narration/ui-walkthrough-script.md'), 'utf8');
const uiSections = uiScript.split(/^##\s+/m).slice(1).map((section) => {
  const [title] = section.split('\n');
  const match = title.match(/^(\d{2}:\d{2}(?:\.\d+)?)[–-](\d{2}:\d{2}(?:\.\d+)?)/);
  if (!match) throw new Error(`UI narration section has no timestamps: ${title}`);
  const seconds = (stamp) => {
    const [minutes, whole] = stamp.split(':');
    return Number(minutes) * 60 + Number(whole);
  };
  return { start: seconds(match[1]), end: seconds(match[2]) };
});
const uiCues = [];
for (let index = 0; index < uiSections.length; index += 1) {
  const sectionCues = parseSrt(await fs.readFile(path.join(captionsDir, `ui-${String(index + 1).padStart(2, '0')}.srt`), 'utf8'));
  for (const cue of sectionCues) uiCues.push({ ...cue, start: cue.start + uiSections[index].start, end: cue.end + uiSections[index].start });
}
const uiAudioTarget = path.join(audioOut, 'ui-walkthrough.wav');
extractTrack(introOffset, sourceUiDuration, uiAudioTarget);
const uiSrtPath = path.join(captionsOut, 'ui-walkthrough.srt');
await fs.writeFile(uiSrtPath, renderSrt(uiCues));

const audioManifest = {
  generatedAt: new Date().toISOString(),
  model: introManifest.model,
  voice: introManifest.voice,
  transcriptionModel: process.env.WHISPER_MODEL || 'whisper-1',
  disclosure: 'AI-generated narration; captions transcribed from these reviewed voice tracks.',
  loudnessTarget: 'EBU R128 integrated -18 LUFS; preview WAV true peak -4 dBTP before AAC encoding',
  sources: {
    introScript: 'media/narration/intro-script.md',
    uiScript: 'media/narration/ui-walkthrough-script.md',
    sourceUiSha256: await hash(uiPath),
    sourceUiDurationSeconds: sourceUiDuration,
  },
  introTracks,
  introCaptions: { file: 'media/captions/intro.srt', sha256: await hash(introSrtPath) },
  uiTrack: { file: 'media/audio/ui-walkthrough.wav', durationSeconds: duration(uiAudioTarget), sha256: await hash(uiAudioTarget) },
  uiSections: uiSections.map(({ start, end }, index) => ({
    track: `ui-${String(index + 1).padStart(2, '0')}.wav`,
    startSeconds: start,
    endSeconds: end,
  })),
  uiCaptions: { file: 'media/captions/ui-walkthrough.srt', sha256: await hash(uiSrtPath) },
};
await fs.writeFile(path.join(audioOut, 'manifest.json'), `${JSON.stringify(audioManifest, null, 2)}\n`);
console.log(`exported reviewed narration and captions to media/audio and media/captions`);
