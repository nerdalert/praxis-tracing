import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const [file, ...args] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/validate-srt.mjs captions.srt [--media audio-or-video]');
  process.exit(2);
}

function timestamp(value) {
  const match = value.match(/^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) throw new Error(`Invalid SRT timestamp: ${value}`);
  const [, hours, minutes, seconds, milliseconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) throw new Error(`Invalid SRT timestamp: ${value}`);
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(milliseconds) / 1000;
}

const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
const blocks = content ? content.split(/\r?\n\s*\r?\n/) : [];
if (!blocks.length) throw new Error('SRT has no caption cues');

let previousEnd = 0;
let latestEnd = 0;
for (const [index, block] of blocks.entries()) {
  const lines = block.split(/\r?\n/);
  if (lines.length < 3 || Number(lines[0]) !== index + 1) {
    throw new Error(`Cue ${index + 1} must have its sequential index and at least one text line`);
  }
  const times = lines[1].match(/^(\S+)\s+-->\s+(\S+)$/);
  if (!times) throw new Error(`Cue ${index + 1} has an invalid timing line`);
  const start = timestamp(times[1]);
  const end = timestamp(times[2]);
  if (start >= end) throw new Error(`Cue ${index + 1} has an empty or reversed interval`);
  if (start < previousEnd) throw new Error(`Cue ${index + 1} overlaps or precedes the previous cue`);
  if (!lines.slice(2).join(' ').trim()) throw new Error(`Cue ${index + 1} has no text`);
  previousEnd = end;
  latestEnd = end;
}

const mediaIndex = args.indexOf('--media');
if (mediaIndex !== -1) {
  const media = args[mediaIndex + 1];
  if (!media) throw new Error('--media requires an audio or video path');
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', media,
  ], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`ffprobe could not read media: ${media}`);
  const duration = Number(probe.stdout.trim());
  if (!Number.isFinite(duration) || latestEnd > duration + 0.15) {
    throw new Error(`Last cue ends at ${latestEnd.toFixed(3)}s after media duration ${duration.toFixed(3)}s`);
  }
}

console.log(`PASS: ${blocks.length} cues; last cue ends at ${latestEnd.toFixed(3)}s`);
