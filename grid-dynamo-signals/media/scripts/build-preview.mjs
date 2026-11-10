import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`usage: node media/scripts/build-preview.mjs --ui <recording.mp4> --output <local-output-directory>`);
  return path.resolve(args[index + 1]);
}
const uiPath = option('--ui');
const outputDir = option('--output');
const generated = path.join(root, 'media/generated');
const slidesDir = path.join(root, 'media/slides/rendered');
const buildDir = path.join(generated, 'preview-build');
await fs.rm(buildDir, { recursive: true, force: true });
await fs.mkdir(buildDir, { recursive: true, mode: 0o700 });
await fs.mkdir(outputDir, { recursive: true });

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function duration(file) {
  return Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]));
}
function timestamp(value) {
  const ms = Math.max(0, Math.round(value * 1000));
  return `${String(Math.floor(ms / 3_600_000)).padStart(2, '0')}:${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
function parseSrt(source) {
  const blocks = source.trim().split(/\r?\n\s*\r?\n/);
  return blocks.filter(Boolean).map((block) => {
    const lines = block.split(/\r?\n/);
    const match = lines[1].match(/^(\S+)\s+-->\s+(\S+)$/);
    if (!match) throw new Error(`invalid SRT timing: ${lines[1]}`);
    const seconds = (stamp) => {
      const [h, m, rest] = stamp.split(':');
      const [s, ms] = rest.split(',');
      return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    };
    return { start: seconds(match[1]), end: seconds(match[2]), text: lines.slice(2).join('\n') };
  });
}
function srtText(cues) {
  return `${cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}`).join('\n\n')}\n`;
}
async function sha256(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}
function encodeSegment(inputArgs, outputPath) {
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputArgs, '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', outputPath]);
}
function normalizeVoice(inputPath, outputPath) {
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11', '-c:a', 'pcm_s16le', outputPath]);
}

const bufferDuration = 2;
const leadBufferPath = path.join(buildDir, 'lead-buffer.mp4');
const tailBufferPath = path.join(buildDir, 'tail-buffer.mp4');
const blackBufferArgs = [
  '-f', 'lavfi', '-i', `color=c=black:s=1920x1080:r=30:d=${bufferDuration}`,
  '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${bufferDuration}`,
  '-map', '0:v:0', '-map', '1:a:0', '-t', String(bufferDuration),
];
encodeSegment(blackBufferArgs, leadBufferPath);
encodeSegment(blackBufferArgs, tailBufferPath);
const segmentPaths = [leadBufferPath];
const captionCues = [];
let timeline = duration(leadBufferPath);
for (let index = 1; index <= 5; index += 1) {
  const suffix = String(index).padStart(2, '0');
  const imagePath = path.join(slidesDir, `slide-${suffix}.png`);
  const audioPath = path.join(generated, 'narration', `slide-${suffix}.wav`);
  const normalizedAudioPath = path.join(buildDir, `slide-${suffix}.wav`);
  const captionsPath = path.join(generated, 'captions', `slide-${suffix}.srt`);
  normalizeVoice(audioPath, normalizedAudioPath);
  const audioDuration = duration(normalizedAudioPath);
  const segmentDuration = Math.ceil((audioDuration + 0.8) * 30) / 30;
  const segmentPath = path.join(buildDir, `slide-${suffix}.mp4`);
  encodeSegment([
    '-loop', '1', '-framerate', '30', '-i', imagePath, '-i', normalizedAudioPath,
    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p',
    '-af', `apad,atrim=duration=${segmentDuration.toFixed(3)}`, '-t', segmentDuration.toFixed(3),
  ], segmentPath);
  segmentPaths.push(segmentPath);
  for (const cue of parseSrt(await fs.readFile(captionsPath, 'utf8'))) captionCues.push({ ...cue, start: cue.start + timeline, end: cue.end + timeline });
  timeline += duration(segmentPath);
}

const uiDuration = duration(uiPath);
const uiScript = await fs.readFile(path.join(root, 'media/narration/ui-walkthrough-script.md'), 'utf8');
const uiSections = uiScript.split(/^##\s+/m).slice(1).map((section) => {
  const [title] = section.split('\n');
  const match = title.match(/^(\d{2}:\d{2}(?:\.\d+)?)[–-](\d{2}:\d{2}(?:\.\d+)?)/);
  if (!match) throw new Error(`UI narration section has no start/end time: ${title}`);
  const toSeconds = (stamp) => {
    const [minutes, seconds] = stamp.split(':');
    return Number(minutes) * 60 + Number(seconds);
  };
  return { title: title.trim(), start: toSeconds(match[1]), end: toSeconds(match[2]) };
});
const uiAudioPaths = uiSections.map((_, index) => path.join(generated, 'narration', `ui-${String(index + 1).padStart(2, '0')}.wav`));
if (!uiSections.length) throw new Error('UI narration must contain timestamped sections');
if (Math.abs(uiSections.at(-1).end - uiDuration) > 0.1) throw new Error(`last UI section ends at ${uiSections.at(-1).end}s but the source recording is ${uiDuration.toFixed(3)}s`);
for (let index = 0; index < uiSections.length; index += 1) {
  const section = uiSections[index];
  const windowDuration = section.end - section.start;
  if (windowDuration <= 0 || (index && section.start < uiSections[index - 1].end - 0.01)) throw new Error(`UI narration section has an invalid or overlapping timeline: ${section.title}`);
  const voiceDuration = duration(uiAudioPaths[index]);
  if (voiceDuration > windowDuration - 0.1) throw new Error(`${section.title} voice is ${voiceDuration.toFixed(2)}s for a ${windowDuration.toFixed(2)}s window; shorten the narration. The recording and speech are never sped up.`);
}
const uiNarrationPath = path.join(buildDir, 'ui-narration.wav');
const sectionFilters = uiSections.map((section, index) => {
  const delayMs = Math.round(section.start * 1000);
  return `[${index}:a]loudnorm=I=-18:TP=-1.5:LRA=11,adelay=${delayMs}:all=1,apad=whole_dur=${uiDuration.toFixed(3)},atrim=duration=${uiDuration.toFixed(3)},asetpts=PTS-STARTPTS[track${index}]`;
});
const sectionInputs = uiAudioPaths.flatMap((file) => ['-i', file]);
const sectionLabels = uiSections.map((_, index) => `[track${index}]`).join('');
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...sectionInputs, '-filter_complex', `${sectionFilters.join(';')};${sectionLabels}amix=inputs=${uiSections.length}:duration=longest:dropout_transition=0:normalize=0[out]`, '-map', '[out]', '-c:a', 'pcm_s16le', uiNarrationPath]);
const uiNarrationDuration = duration(uiNarrationPath);
const uiSegment = path.join(buildDir, 'recorded-ui.mp4');
const uiDisplayFilter = 'scale=1920:900:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:0:color=black,setsar=1,format=yuv420p';
encodeSegment([
  '-i', uiPath, '-i', uiNarrationPath, '-map', '0:v:0', '-map', '1:a:0',
  '-vf', uiDisplayFilter,
  '-af', `apad,atrim=duration=${uiDuration.toFixed(3)}`, '-t', uiDuration.toFixed(3),
], uiSegment);
const introDuration = timeline;
segmentPaths.push(uiSegment, tailBufferPath);
for (let index = 0; index < uiSections.length; index += 1) {
  const captionsPath = path.join(generated, 'captions', `ui-${String(index + 1).padStart(2, '0')}.srt`);
  for (const cue of parseSrt(await fs.readFile(captionsPath, 'utf8'))) captionCues.push({ ...cue, start: cue.start + introDuration + uiSections[index].start, end: cue.end + introDuration + uiSections[index].start });
}

const listPath = path.join(buildDir, 'segments.txt');
await fs.writeFile(listPath, segmentPaths.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join('\n') + '\n');
const joinedPath = path.join(buildDir, 'joined.mp4');
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', joinedPath]);
const finalAudioPath = path.join(buildDir, 'preview-audio.wav');
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', joinedPath, '-map', '0:a:0', '-af', 'loudnorm=I=-18:TP=-4:LRA=11', '-ar', '48000', '-c:a', 'pcm_s16le', finalAudioPath]);
const fullSrtPath = path.join(outputDir, 'grid-dynamo-signals-preview.srt');
await fs.writeFile(fullSrtPath, srtText(captionCues), 'utf8');
const mp4Path = path.join(outputDir, 'grid-dynamo-signals-preview.mp4');
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', joinedPath, '-i', finalAudioPath, '-i', fullSrtPath, '-map', '0:v:0', '-map', '1:a:0', '-map', '2:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English captions', '-movflags', '+faststart', mp4Path]);

const manifest = {
  createdAt: new Date().toISOString(),
  video: path.basename(mp4Path),
  videoSha256: await sha256(mp4Path),
  captions: path.basename(fullSrtPath),
  captionsSha256: await sha256(fullSrtPath),
  sourceUiSha256: await sha256(uiPath),
  sourceUiDurationSeconds: uiDuration,
  leadAndTailBufferSeconds: { beginning: duration(leadBufferPath), end: duration(tailBufferPath) },
  introSlideCount: 5,
  uiNarrationDurationSeconds: uiNarrationDuration,
  audioLoudnessTarget: { integratedLufs: -18, truePeakDbtpBeforeAac: -4 },
  uiNarrationMarkers: uiSections.map(({ title, start, end }) => ({ title, startSeconds: start, endSeconds: end })),
  previewDurationSeconds: duration(mp4Path),
  uiVideoScale: '83.3% of source height, with a 180 px bottom caption band',
  frameRate: '30 fps',
  disclosure: 'AI-generated narration; recorded UI is historical and shows capture-time status only.',
};
await fs.writeFile(path.join(outputDir, 'preview-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`assembled ${mp4Path} (${manifest.previewDurationSeconds.toFixed(2)}s)`);
