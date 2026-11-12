import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function splitSections(markdown) {
  return markdown.split(/^##\s+/m).slice(1).map((part) => {
    const newline = part.indexOf('\n');
    return {
      title: (newline < 0 ? part : part.slice(0, newline)).trim(),
      body: newline < 0 ? '' : part.slice(newline + 1).trim(),
    };
  });
}

function plainText(markdown) {
  return markdown
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[\x60*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function toSeconds(value) {
  const [minutes, seconds] = value.split(':');
  return Number(minutes) * 60 + Number(seconds);
}

export async function narrationSources() {
  const introMarkdown = await fs.readFile(path.join(root, 'media/narration/intro-script.md'), 'utf8');
  const uiMarkdown = await fs.readFile(path.join(root, 'media/narration/ui-walkthrough-script.md'), 'utf8');
  const outroMarkdown = await fs.readFile(path.join(root, 'media/narration/outro-script.md'), 'utf8');

  const intro = splitSections(introMarkdown)
    .filter(({ title }) => /^Slide \d+\s+—/.test(title))
    .map(({ title, body }) => ({ title, text: plainText(body) }));
  const ui = splitSections(uiMarkdown)
    .map(({ title, body }) => {
      const match = title.match(/^(\d{2}:\d{2}(?:\.\d+)?)[–-](\d{2}:\d{2}(?:\.\d+)?)/);
      if (!match) return null;
      return {
        title,
        start: toSeconds(match[1]),
        end: toSeconds(match[2]),
        text: plainText(body),
      };
    })
    .filter(Boolean);

  const outroBody = outroMarkdown
    .replace(/^#[^\n]*\n/, '')
    .split(/\nOn-screen links:\s*\n/)[0];
  const outro = { title: 'Exit slide', text: plainText(outroBody) };

  if (intro.length !== 6) throw new Error('expected six introduction narration sections; found ' + intro.length);
  if (ui.length !== 6) throw new Error('expected six timed UI narration sections; found ' + ui.length);
  if (!outro.text) throw new Error('exit narration is empty');
  for (const [index, section] of [...intro, ...ui, outro].entries()) {
    if (!section.text || section.text.length > 4096) throw new Error('invalid narration text in section ' + (index + 1));
  }
  for (let index = 0; index < ui.length; index += 1) {
    const section = ui[index];
    if (section.end <= section.start || (index && section.start < ui[index - 1].end)) {
      throw new Error('invalid or overlapping UI window: ' + section.title);
    }
  }
  return { intro, ui, outro };
}

export async function captionSources() {
  const markdown = await fs.readFile(path.join(root, 'media/captions/caption-copy.md'), 'utf8');
  const sections = splitSections(markdown).map(({ title, body }) => {
    let type;
    let index;
    if (/^Introduction slide \d+/.test(title)) {
      type = 'intro';
      index = Number(title.match(/^Introduction slide (\d+)/)[1]) - 1;
    } else if (/^UI \d{2}:\d{2}/.test(title)) {
      type = 'ui';
      index = null;
    } else if (/^Exit slide/.test(title)) {
      type = 'outro';
      index = 0;
    } else {
      return null;
    }

    const cues = [];
    for (const line of body.split(/\r?\n/)) {
      const item = line.match(/^\s*\d+\.\s+(.*)$/);
      if (item) cues.push(item[1].trim());
      else if (cues.length && line.trim() && !/^\s*[-*]\s+/.test(line)) cues[cues.length - 1] += ' ' + line.trim();
    }
    return { type, index, title, cues };
  }).filter(Boolean);

  const intro = sections.filter((section) => section.type === 'intro').sort((a, b) => a.index - b.index);
  const ui = sections.filter((section) => section.type === 'ui').map((section, index) => ({ ...section, index }));
  const outro = sections.find((section) => section.type === 'outro');
  if (intro.length !== 6 || ui.length !== 6 || !outro) throw new Error('caption source must define six slide sections, six UI sections, and an exit section');
  if ([...intro, ...ui, outro].some((section) => section.cues.length === 0)) throw new Error('caption section has no numbered cues');
  return { intro, ui, outro };
}

export function narrationFileName(type, index) {
  if (type === 'intro') return 'slide-' + String(index + 1).padStart(2, '0');
  if (type === 'ui') return 'ui-' + String(index + 1).padStart(2, '0');
  return 'outro-01';
}
