import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const index = args.indexOf('--preview-dir');
if (index < 0 || !args[index + 1]) {
  throw new Error('usage: node media/scripts/export-reviewed-assets.mjs --preview-dir <local-output-directory>');
}
const directory = path.resolve(args[index + 1]);
const manifestPath = path.join(directory, 'preview-manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const files = [
  manifest.output.video,
  manifest.output.srt,
  manifest.output.voiceWav,
  'sources/slides/deck.html',
  'sources/narration/intro-script.md',
  'sources/narration/ui-walkthrough-script.md',
  'sources/narration/outro-script.md',
  'sources/captions/caption-copy.md',
  'sources/source-ui-recording.mp4',
];
const hashes = {};
for (const relative of files) {
  const file = path.join(directory, relative);
  const bytes = await fs.readFile(file);
  hashes[relative] = crypto.createHash('sha256').update(bytes).digest('hex');
}
const exportManifest = {
  createdAt: new Date().toISOString(),
  previewManifestSha256: crypto.createHash('sha256').update(await fs.readFile(manifestPath)).digest('hex'),
  files: hashes,
};
const target = path.join(directory, 'export-manifest.json');
await fs.writeFile(target, JSON.stringify(exportManifest, null, 2) + '\n', { mode: 0o600 });
console.log('verified and indexed ' + files.length + ' local preview/export artifacts');
console.log(target);
