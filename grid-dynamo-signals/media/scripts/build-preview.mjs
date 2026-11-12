import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { captionSources, narrationFileName, narrationSources, root } from './editorial-source.mjs';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) {
    throw new Error('usage: node media/scripts/build-preview.mjs --ui <recording.mp4> --output <directory-outside-Git>');
  }
  return path.resolve(args[index + 1]);
}
function optionValue(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error(name + ' requires a value');
  return args[index + 1];
}
const uiPath = option('--ui');
const outputDir = option('--output');
const videoPreset = optionValue('--preset', 'slow');
const videoCrf = Number(optionValue('--crf', '14'));
if (!['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].includes(videoPreset)) {
  throw new Error('unsupported x264 preset: ' + videoPreset);
}
if (!Number.isInteger(videoCrf) || videoCrf < 0 || videoCrf > 51) {
  throw new Error('CRF must be an integer from 0 through 51');
}
if (outputDir === root || outputDir.startsWith(root + path.sep)) {
  throw new Error('video, SRT, and exported preview artifacts must be written outside the Git checkout');
}
await fs.mkdir(outputDir, { recursive: true });

const generatedDir = path.join(root, 'media/generated');
const voiceDir = path.join(generatedDir, 'narration');
const wordsDir = path.join(generatedDir, 'captions/words');
const renderDir = path.join(generatedDir, 'slides/1920x1080');
const buildDir = path.join(generatedDir, 'preview-build');
await fs.rm(buildDir, { recursive: true, force: true });
await fs.mkdir(buildDir, { recursive: true, mode: 0o700 });

const fps = 30;
const voiceLead = 0.28;
const slideTail = 0.48;
const uiTail = 0.35;
const sectionLead = 0.22;
const handleDurationSeconds = 2;

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(command + ' failed: ' + String(result.stderr || result.stdout || '').slice(-6000));
  }
  return String(result.stdout || '').trim();
}

function ffprobeJson(file) {
  return JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}

function mediaDuration(file) {
  return Number(ffprobeJson(file).format.duration);
}

function ratio(value) {
  const [numerator, denominator] = value.split('/').map(Number);
  return denominator ? numerator / denominator : Number(value);
}

async function sha256(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

function stamp(value) {
  const milliseconds = Math.max(0, Math.round(value * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const fraction = milliseconds % 1000;
  return String(hours).padStart(2, '0') + ':' +
    String(minutes).padStart(2, '0') + ':' +
    String(seconds).padStart(2, '0') + ',' +
    String(fraction).padStart(3, '0');
}

function tokenize(value) {
  return value.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*(?:[-/][\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*)*/gu) || [];
}

function key(value) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let prior = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prior + (left[i - 1] === right[j - 1] ? 0 : 1));
      prior = old;
    }
  }
  return row[right.length];
}

function wrapCue(text, maxLineLength) {
  const lines = [];
  let line = '';
  for (const word of text.trim().split(/\s+/)) {
    if (line && (line + ' ' + word).length > maxLineLength) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + ' ' + word : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > 2) throw new Error('caption copy needs a shorter cue or editorial rewrap: ' + text);
  return lines.join('\n');
}

function exactSourceCaptionCheck(sourceText, cues, title) {
  const source = tokenize(sourceText).map(key);
  const captions = cues.flatMap(tokenize).map(key);
  if (source.length !== captions.length || source.some((word, index) => word !== captions[index])) {
    const mismatch = source.findIndex((word, index) => word !== captions[index]);
    throw new Error('caption words do not match narration in ' + title + ' near token ' + mismatch);
  }
}

function timedCue(text, transcription, cursor, maxLineLength, title) {
  const expected = tokenize(text);
  const words = transcription.words;
  const used = [];
  let wordCursor = cursor;
  const skipped = [];

  for (const expectedWord of expected) {
    const expectedKey = key(expectedWord);
    let selected = null;
    for (let skip = 0; skip <= 2 && !selected; skip += 1) {
      const begin = wordCursor + skip;
      for (let count = 1; count <= 5 && begin + count <= words.length; count += 1) {
        const combined = words.slice(begin, begin + count).map((word) => key(word.word)).join('');
        if (combined === expectedKey) {
          selected = { begin, count };
          break;
        }
      }
    }
    if (selected) {
      if (selected.begin > wordCursor) skipped.push(...words.slice(wordCursor, selected.begin).map((word) => word.word));
      used.push(...words.slice(selected.begin, selected.begin + selected.count));
      wordCursor = selected.begin + selected.count;
      continue;
    }

    if (wordCursor >= words.length) throw new Error('transcription ran out of words in ' + title + ' at ' + expectedWord);
    let best = { begin: wordCursor, count: 1, score: 0 };
    for (let count = 1; count <= 4 && wordCursor + count <= words.length; count += 1) {
      const combined = words.slice(wordCursor, wordCursor + count).map((word) => key(word.word)).join('');
      const score = 1 - editDistance(expectedKey, combined) / Math.max(expectedKey.length, combined.length, 1);
      if (score > best.score) best = { begin: wordCursor, count, score };
    }
    if (best.score < 0.45) {
      throw new Error('cannot align approved caption word with Whisper timestamp in ' + title + ': ' + expectedWord);
    }
    used.push(...words.slice(best.begin, best.begin + best.count));
    wordCursor = best.begin + best.count;
  }
  if (skipped.length) {
    console.log('transcription alignment skipped non-caption token(s) in ' + title + ': ' + skipped.join(' '));
  }
  if (!used.length) throw new Error('caption cue has no word timestamps in ' + title);
  return {
    cue: {
      start: Math.max(0, Number(used[0].start)),
      end: Math.max(Number(used[0].start) + 0.05, Number(used.at(-1).end)),
      text: wrapCue(text, maxLineLength),
      title,
    },
    cursor: wordCursor,
  };
}

function parseTranscription(file, expectedAudioSha, expectedSourceSha, title) {
  const result = JSON.parse(requireFileSync(file));
  if (result.audioSha256 !== expectedAudioSha || result.sourceSha256 !== expectedSourceSha) {
    throw new Error('transcription does not match the current audio/source in ' + title);
  }
  if (!Array.isArray(result.words) || result.words.length === 0) throw new Error('missing word timestamps in ' + title);
  return result;
}

import fsSync from 'node:fs';
function requireFileSync(file) {
  return fsSync.readFileSync(file, 'utf8');
}

function ffconcatPath(file) {
  return "file '" + file.replaceAll("'", "'\\''") + "'";
}

async function writeConcatList(files, target) {
  await fs.writeFile(target, files.map(ffconcatPath).join('\n') + '\n', { mode: 0o600 });
}

function encodeVideo(commandArgs) {
  const outputPath = commandArgs.at(-1);
  const outputOptions = commandArgs.slice(0, -1);
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...outputOptions,
    '-an',
    '-c:v', 'libx264', '-preset', videoPreset, '-crf', String(videoCrf),
    '-profile:v', 'high', '-level:v', '4.1',
    '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-movflags', '+faststart',
    outputPath,
  ]);
}

async function makeSilence(seconds, name) {
  if (seconds < 0.015) return null;
  const file = path.join(buildDir, name + '.wav');
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
    '-t', seconds.toFixed(6), '-ar', '48000', '-ac', '1',
    '-c:a', 'pcm_s16le', file,
  ]);
  return file;
}

async function concatAudio(files, target, listName) {
  const listPath = path.join(buildDir, listName);
  await writeConcatList(files, listPath);
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', target,
  ]);
}

async function normalizeVoice(input, output) {
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input, '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11',
    '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', output,
  ]);
  return mediaDuration(output);
}

const editorial = await narrationSources();
const approvedCaptions = await captionSources();
for (let index = 0; index < editorial.intro.length; index += 1) {
  exactSourceCaptionCheck(editorial.intro[index].text, approvedCaptions.intro[index].cues, editorial.intro[index].title);
}
for (let index = 0; index < editorial.ui.length; index += 1) {
  exactSourceCaptionCheck(editorial.ui[index].text, approvedCaptions.ui[index].cues, editorial.ui[index].title);
}
exactSourceCaptionCheck(editorial.outro.text, approvedCaptions.outro.cues, editorial.outro.title);

const modeManifests = {};
for (const mode of ['intro', 'ui', 'outro']) {
  const manifest = JSON.parse(await fs.readFile(path.join(voiceDir, mode + '-manifest.json'), 'utf8'));
  modeManifests[mode] = manifest;
}
const voiceModel = modeManifests.intro.model;
const voiceName = modeManifests.intro.voice;
for (const [mode, manifest] of Object.entries(modeManifests)) {
  if (manifest.model !== voiceModel || manifest.voice !== voiceName) {
    throw new Error('all slide, UI, and exit narration must use the same model and voice (' + mode + ' differs)');
  }
}

const sourceVideoProbe = ffprobeJson(uiPath);
const sourceVideo = sourceVideoProbe.streams.find((stream) => stream.codec_type === 'video');
if (!sourceVideo) throw new Error('UI source has no video stream');
if (ratio(sourceVideo.r_frame_rate) !== fps) throw new Error('UI source must be 30 fps; got ' + sourceVideo.r_frame_rate);
if (Number(sourceVideo.width) !== 1920 || Number(sourceVideo.height) !== 1080) {
  throw new Error('UI source must be 1920x1080; got ' + sourceVideo.width + 'x' + sourceVideo.height);
}
const uiFrames = Number(sourceVideo.nb_frames);
if (!Number.isInteger(uiFrames) || uiFrames < 100) throw new Error('could not verify source UI frame count');
const uiDuration = uiFrames / fps;

const voiceFiles = {};
const normalizedDurations = {};
for (const [mode, sections] of Object.entries(editorial)) {
  const count = Array.isArray(sections) ? sections.length : 1;
  for (let index = 0; index < count; index += 1) {
    const name = narrationFileName(mode, index);
    const input = path.join(voiceDir, name + '.wav');
    const output = path.join(buildDir, name + '-normalized.wav');
    const duration = await normalizeVoice(input, output);
    voiceFiles[name] = output;
    normalizedDurations[name] = duration;
  }
}

const allCues = [];
const sceneBoundaries = [];
const videoSegments = [];
const audioSegments = [];
const handleFrames = Math.round(handleDurationSeconds * fps);
const handleVideo = path.join(buildDir, 'black-handle-video.mp4');
encodeVideo([
  '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=' + fps,
  '-frames:v', String(handleFrames),
  '-vf', 'setsar=1,format=yuv420p',
  handleVideo,
]);
let timeline = 0;

for (let index = 0; index < editorial.intro.length; index += 1) {
  const name = narrationFileName('intro', index);
  const duration = normalizedDurations[name];
  const slideLead = index === 0 ? 1 : voiceLead;
  const frames = Math.ceil((voiceLead + duration + slideTail) * fps) + (index === 0 ? handleFrames : 0);
  const sceneDuration = frames / fps;
  const audioTail = sceneDuration - slideLead - duration;
  const audioPieces = [];
  const leading = await makeSilence(slideLead, name + '-lead');
  const trailing = await makeSilence(audioTail, name + '-tail');
  if (leading) audioPieces.push(leading);
  audioPieces.push(voiceFiles[name]);
  if (trailing) audioPieces.push(trailing);
  const sceneAudio = path.join(buildDir, name + '-scene.wav');
  await concatAudio(audioPieces, sceneAudio, name + '-audio.ffconcat');
  audioSegments.push(sceneAudio);

  const image = path.join(renderDir, 'slide-' + String(index + 1).padStart(2, '0') + '.png');
  const video = path.join(buildDir, name + '-video.mp4');
  encodeVideo([
    '-loop', '1', '-framerate', String(fps), '-i', image,
    '-frames:v', String(frames),
    '-vf', 'scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p',
    video,
  ]);
  videoSegments.push(video);
  const wordFile = path.join(wordsDir, name + '.json');
  const transcription = parseTranscription(
    wordFile,
    await sha256(path.join(voiceDir, name + '.wav')),
    crypto.createHash('sha256').update(editorial.intro[index].text).digest('hex'),
    editorial.intro[index].title,
  );
  let wordCursor = 0;
  for (const text of approvedCaptions.intro[index].cues) {
    const result = timedCue(text, transcription, wordCursor, 50, editorial.intro[index].title);
    wordCursor = result.cursor;
    allCues.push({
      start: timeline + slideLead + result.cue.start,
      end: timeline + slideLead + result.cue.end,
      text: result.cue.text,
      scene: editorial.intro[index].title,
    });
  }
  sceneBoundaries.push({
    title: editorial.intro[index].title,
    startSeconds: timeline,
    endSeconds: timeline + sceneDuration,
    narrationStartSeconds: timeline + slideLead,
    narrationDurationSeconds: duration,
    intentionalTrailingSilenceSeconds: audioTail,
  });
  timeline += sceneDuration;
}

const introEnd = timeline;
const uiVideo = path.join(buildDir, 'recorded-ui-video.mp4');
encodeVideo([
  '-i', uiPath, '-frames:v', String(uiFrames),
  '-vf', 'scale=1920:900:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:0:color=black,setsar=1,format=yuv420p',
  uiVideo,
]);
videoSegments.push(uiVideo);

let uiCursor = 0;
const uiAudioPieces = [];
const uiSectionPlacement = [];
for (let index = 0; index < editorial.ui.length; index += 1) {
  const section = editorial.ui[index];
  const name = narrationFileName('ui', index);
  const duration = normalizedDurations[name];
  const start = section.start + sectionLead;
  const end = start + duration;
  if (end > section.end - uiTail + 0.02) {
    throw new Error(section.title + ' voice takes ' + duration.toFixed(2) + 's in a ' +
      (section.end - section.start).toFixed(2) + 's window; shorten the approved narration, never speed up the recording or voice');
  }
  if (start < uiCursor - 0.01) throw new Error('UI voice sections overlap: ' + section.title);
  const gap = start - uiCursor;
  const silence = await makeSilence(gap, name + '-window-lead');
  if (silence) uiAudioPieces.push(silence);
  uiAudioPieces.push(voiceFiles[name]);
  uiCursor = end;
  uiSectionPlacement.push({
    title: section.title,
    windowStartSeconds: section.start,
    windowEndSeconds: section.end,
    voiceStartSeconds: start,
    voiceEndSeconds: end,
    voiceDurationSeconds: duration,
    intentionalSilenceBeforeSeconds: gap,
    intentionalSilenceAfterSeconds: section.end - end,
  });

  const wordFile = path.join(wordsDir, name + '.json');
  const transcription = parseTranscription(
    wordFile,
    await sha256(path.join(voiceDir, name + '.wav')),
    crypto.createHash('sha256').update(section.text).digest('hex'),
    section.title,
  );
  let wordCursor = 0;
  for (const text of approvedCaptions.ui[index].cues) {
    const result = timedCue(text, transcription, wordCursor, 46, section.title);
    wordCursor = result.cursor;
    const startAt = timeline + start + result.cue.start;
    const endAt = timeline + start + result.cue.end;
    if (endAt > timeline + section.end + 0.01) throw new Error('UI caption crosses its editorial scene boundary: ' + section.title);
    allCues.push({ start: startAt, end: endAt, text: result.cue.text, scene: section.title });
  }
}
const finalUiSilence = uiDuration - uiCursor;
if (finalUiSilence < -0.01) throw new Error('UI narration extends past the source recording');
const uiTailSilence = await makeSilence(Math.max(0, finalUiSilence), 'ui-recording-tail');
if (uiTailSilence) uiAudioPieces.push(uiTailSilence);
const uiAudio = path.join(buildDir, 'ui-single-voice-timeline.wav');
await concatAudio(uiAudioPieces, uiAudio, 'ui-audio.ffconcat');
const uiAudioDuration = mediaDuration(uiAudio);
if (Math.abs(uiAudioDuration - uiDuration) > 0.025) {
  throw new Error('UI narration track is ' + uiAudioDuration.toFixed(3) + 's; source video is ' + uiDuration.toFixed(3) + 's');
}
sceneBoundaries.push({
  title: 'Recorded UI walkthrough',
  startSeconds: timeline,
  endSeconds: timeline + uiDuration,
  sourceDurationSeconds: Number(sourceVideoProbe.format.duration),
  sourceFrames: uiFrames,
  sourceFrameRate: sourceVideo.r_frame_rate,
  voiceSections: uiSectionPlacement,
});
timeline += uiDuration;

const outroName = narrationFileName('outro', 0);
const outroDuration = normalizedDurations[outroName];
const outroFrames = Math.ceil((voiceLead + outroDuration + 0.75) * fps);
const outroSceneDuration = outroFrames / fps;
const outroTail = outroSceneDuration - voiceLead - outroDuration;
const outroAudioPieces = [];
const outroLead = await makeSilence(voiceLead, 'outro-lead');
const outroSilence = await makeSilence(outroTail, 'outro-tail');
if (outroLead) outroAudioPieces.push(outroLead);
outroAudioPieces.push(voiceFiles[outroName]);
if (outroSilence) outroAudioPieces.push(outroSilence);
const outroSceneAudio = path.join(buildDir, 'outro-scene.wav');
await concatAudio(outroAudioPieces, outroSceneAudio, 'outro-audio.ffconcat');
audioSegments.push(outroSceneAudio);

const outroImage = path.join(renderDir, 'slide-outro.png');
const outroVideo = path.join(buildDir, 'outro-video.mp4');
encodeVideo([
  '-loop', '1', '-framerate', String(fps), '-i', outroImage,
  '-frames:v', String(outroFrames),
  '-vf', 'scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p',
  outroVideo,
]);
videoSegments.push(outroVideo);
const outroWords = parseTranscription(
  path.join(wordsDir, outroName + '.json'),
  await sha256(path.join(voiceDir, outroName + '.wav')),
  crypto.createHash('sha256').update(editorial.outro.text).digest('hex'),
  editorial.outro.title,
);
let outroWordCursor = 0;
for (const text of approvedCaptions.outro.cues) {
  const result = timedCue(text, outroWords, outroWordCursor, 50, editorial.outro.title);
  outroWordCursor = result.cursor;
  allCues.push({
    start: timeline + voiceLead + result.cue.start,
    end: timeline + voiceLead + result.cue.end,
    text: result.cue.text,
    scene: editorial.outro.title,
  });
}
sceneBoundaries.push({
  title: editorial.outro.title,
  startSeconds: timeline,
  endSeconds: timeline + outroSceneDuration,
  narrationStartSeconds: timeline + voiceLead,
  narrationDurationSeconds: outroDuration,
  intentionalTrailingSilenceSeconds: outroTail,
});
timeline += outroSceneDuration;

videoSegments.push(handleVideo);
const closingSilence = await makeSilence(handleDurationSeconds, 'closing-handle');
sceneBoundaries.push({
  title: 'Closing black handle',
  startSeconds: timeline,
  endSeconds: timeline + handleDurationSeconds,
  narration: false,
});
timeline += handleDurationSeconds;

allCues.sort((a, b) => a.start - b.start);
for (let index = 0; index < allCues.length; index += 1) {
  const cue = allCues[index];
  if (cue.start >= cue.end) throw new Error('caption cue has an empty interval: ' + cue.scene);
  if (index && cue.start < allCues[index - 1].end) throw new Error('caption cues overlap: ' + cue.scene);
  if (index && cue.scene !== allCues[index - 1].scene && cue.start < allCues[index - 1].end) {
    throw new Error('caption cue crosses a scene change: ' + cue.scene);
  }
}

const videoConcatList = path.join(buildDir, 'video.ffconcat');
await writeConcatList(videoSegments, videoConcatList);
const joinedVideo = path.join(buildDir, 'joined-video.mp4');
run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'concat', '-safe', '0', '-i', videoConcatList,
  '-c', 'copy', '-movflags', '+faststart', joinedVideo,
]);

const rawVoice = path.join(buildDir, 'voice-timeline-untrimmed.wav');
await concatAudio([...audioSegments.slice(0, editorial.intro.length), uiAudio, outroSceneAudio, closingSilence], rawVoice, 'full-audio.ffconcat');
const voiceWav = path.join(outputDir, 'grid-dynamo-signals-voice.wav');
run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', rawVoice, '-af', 'apad,atrim=duration=' + timeline.toFixed(6),
  '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', voiceWav,
]);

const srtPath = path.join(outputDir, 'grid-dynamo-signals-final.srt');
const srt = allCues.map((cue, index) =>
  (index + 1) + '\n' + stamp(cue.start) + ' --> ' + stamp(cue.end) + '\n' + cue.text
).join('\n\n') + '\n';
await fs.writeFile(srtPath, srt, { mode: 0o600 });

const videoPath = path.join(outputDir, 'grid-dynamo-signals-final.mp4');
run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', joinedVideo, '-i', voiceWav, '-i', srtPath,
  '-map', '0:v:0', '-map', '1:a:0', '-map', '2:0',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng',
  '-metadata:s:s:0', 'title=English captions',
  '-movflags', '+faststart', '-t', timeline.toFixed(6), videoPath,
]);

const videoProbe = ffprobeJson(videoPath);
const streams = videoProbe.streams;
if (streams.filter((stream) => stream.codec_type === 'audio').length !== 1) {
  throw new Error('final preview must contain exactly one narration audio stream');
}
if (streams.filter((stream) => stream.codec_type === 'subtitle').length !== 1) {
  throw new Error('final preview must contain exactly one soft English caption stream');
}
const finalDuration = Number(videoProbe.format.duration);
if (Math.abs(finalDuration - timeline) > 0.06) throw new Error('final video duration differs from the assembled timeline');

const diagnosticsDir = path.join(outputDir, 'diagnostics');
await fs.mkdir(diagnosticsDir, { recursive: true });
const silenceLog = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'info', '-i', voiceWav,
  '-af', 'silencedetect=noise=-42dB:d=1.5,volumedetect',
  '-f', 'null', '-',
], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (silenceLog.status !== 0) throw new Error('FFmpeg silence/level diagnostic failed');
await fs.writeFile(path.join(diagnosticsDir, 'audio-silence-and-levels.log'), silenceLog.stderr || silenceLog.stdout || '', { mode: 0o600 });
const loudness = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'info', '-i', voiceWav,
  '-af', 'ebur128=peak=true', '-f', 'null', '-',
], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (loudness.status !== 0) throw new Error('FFmpeg loudness diagnostic failed');
await fs.writeFile(path.join(diagnosticsDir, 'audio-loudness.log'), loudness.stderr || loudness.stdout || '', { mode: 0o600 });

const sourceFiles = [
  ['slides/deck.html', path.join(root, 'media/slides/deck.html')],
  ['narration/intro-script.md', path.join(root, 'media/narration/intro-script.md')],
  ['narration/ui-walkthrough-script.md', path.join(root, 'media/narration/ui-walkthrough-script.md')],
  ['narration/outro-script.md', path.join(root, 'media/narration/outro-script.md')],
  ['captions/caption-copy.md', path.join(root, 'media/captions/caption-copy.md')],
];
const sourceExportDir = path.join(outputDir, 'sources');
await fs.mkdir(sourceExportDir, { recursive: true });
for (const [relative, source] of sourceFiles) {
  const target = path.join(sourceExportDir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}
const sourceRecordingCopy = path.join(sourceExportDir, 'source-ui-recording.mp4');
await fs.copyFile(uiPath, sourceRecordingCopy);
const frameHashes = {};
const frameExportDir = path.join(outputDir, 'frames');
await fs.mkdir(frameExportDir, { recursive: true });
for (let index = 1; index <= 6; index += 1) {
  const name = 'slide-' + String(index).padStart(2, '0') + '.png';
  const sourceFrame = path.join(renderDir, name);
  await fs.copyFile(sourceFrame, path.join(frameExportDir, name));
  frameHashes[name] = await sha256(sourceFrame);
}
await fs.copyFile(path.join(renderDir, 'slide-outro.png'), path.join(frameExportDir, 'slide-outro.png'));
frameHashes['slide-outro.png'] = await sha256(path.join(renderDir, 'slide-outro.png'));

const buildManifest = {
  createdAt: new Date().toISOString(),
  disclosure: 'AI-generated narration; original 93.766-second UI capture retained at natural speed.',
  voice: { model: voiceModel, name: voiceName, singleVoiceTrack: true, music: false },
  transcription: { model: process.env.WHISPER_MODEL || 'whisper-1', source: 'word timestamps from each generated voice segment' },
  sourceRecording: {
    path: uiPath,
    sha256: await sha256(uiPath),
    durationSeconds: Number(sourceVideoProbe.format.duration),
    frameCount: uiFrames,
    frameRate: sourceVideo.r_frame_rate,
  },
  priorPreviewDiagnosis: {
    priorPreviewPath: '/home/ubuntu/praxxis/ai-grid/prs/grid-dynamo-demo-publish-20261109T211606Z/media/preview/grid-dynamo-signals-preview.mp4',
    uiMixSilentFromSeconds: 11.5281,
    uiMixSilentThroughSeconds: 93.716,
    finalAudioSilentFromSeconds: 136.072,
    finalAudioSilentThroughSeconds: 220.352,
    finding: 'The prior UI graph placed adelay before asetpts=PTS-STARTPTS and then amix. The timestamp reset erased the lane offsets: waveform correlation shows contributions from all nine old UI tracks in the first 12 seconds, producing the reported overlap. The mixed UI waveform then became silent at 11.528 seconds and stayed silent for 82.188 seconds. This assembly uses ordered audio concatenation, with no amix or second narration layer.',
  },
  slideFrames: frameHashes,
  sceneBoundaries,
  uiVoicePlacement: uiSectionPlacement,
  totalTimelineSeconds: timeline,
  blackHandles: { openingSeconds: 0, closingSeconds: handleDurationSeconds },
  openingSilenceSeconds: 1,
  output: {
    video: path.basename(videoPath),
    videoSha256: await sha256(videoPath),
    srt: path.basename(srtPath),
    srtSha256: await sha256(srtPath),
    voiceWav: path.basename(voiceWav),
    voiceWavSha256: await sha256(voiceWav),
    durationSeconds: finalDuration,
    frameRate: fps + '/1',
    videoEncoding: { codec: 'libx264', preset: videoPreset, crf: videoCrf },
    resolution: '1920x1080',
    softSubtitleCodec: 'mov_text',
    audioStreamCount: streams.filter((stream) => stream.codec_type === 'audio').length,
    subtitleStreamCount: streams.filter((stream) => stream.codec_type === 'subtitle').length,
  },
  sourceFiles: await Promise.all(sourceFiles.map(async ([relative, file]) => ({
    path: relative,
    sha256: await sha256(file),
  }))),
  exportedSourceRecordingSha256: await sha256(sourceRecordingCopy),
  ffmpegVersion: run('ffmpeg', ['-version']).split('\n')[0],
  audioAssembly: 'All narration clips were loudness-normalized individually, then concatenated in visual order. UI clips are placed within the approved windows with explicit silence; no amix, music, or second speech track is used.',
};
const manifestPath = path.join(outputDir, 'preview-manifest.json');
await fs.writeFile(manifestPath, JSON.stringify(buildManifest, null, 2) + '\n', { mode: 0o600 });
console.log('assembled ' + videoPath + ' (' + finalDuration.toFixed(2) + 's)');
console.log('captions ' + srtPath + ' (' + allCues.length + ' cues)');
console.log('manifest ' + manifestPath);
