import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const roots = [
  'jobs',
  'apprenticeships',
  'internships',
  'entry-level',
  'no-experience',
  'career-events',
  'locations',
  'how-to-get-a-data-center-job',
  'how-to-get-a-data-center-internship'
];
const authored = ['index.html', 'employers/index.html', 'subscribed/index.html'];

async function collectHtml(root) {
  const paths = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path.endsWith('.html')) paths.push(path);
    }
  }
  await walk(root);
  return paths;
}

const files = [...authored];
for (const root of roots) files.push(...await collectHtml(root));
const uniqueFiles = [...new Set(files)];
const errors = [];

const attr = (tag, name) => {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? match[2].trim() : '';
};
const hasAttr = (tag, name) => new RegExp(`\\s${name}(?:\\s*=|\\s|>)`, 'i').test(`${tag}>`);
const visibleText = value => String(value || '').replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|#160);/gi, ' ').replace(/\s+/g, ' ').trim();
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function wrappedByLabel(html, tagIndex) {
  const before = html.slice(0, tagIndex);
  return before.lastIndexOf('<label') > before.lastIndexOf('</label>');
}

function hasProgrammaticLabel(html, tag, tagIndex) {
  if (attr(tag, 'aria-label') || attr(tag, 'aria-labelledby')) return true;
  const id = attr(tag, 'id');
  if (id) {
    const labelFor = new RegExp(`<label\\b[^>]*\\sfor\\s*=\\s*(["'])${escapeRegex(id)}\\1`, 'i');
    if (labelFor.test(html)) return true;
  }
  return wrappedByLabel(html, tagIndex);
}

for (const path of uniqueFiles) {
  let html = await readFile(path, 'utf8');
  html = html.replace(/<!--([\s\S]*?)-->/g, '');

  if (!/<html\b[^>]*\blang=["']en["']/i.test(html)) errors.push(`${path}: html lang must be en`);
  if (!/<meta\b[^>]*name=["']viewport["'][^>]*>/i.test(html)) errors.push(`${path}: viewport meta is missing`);
  if (!/<title>\s*[^<]+\s*<\/title>/i.test(html)) errors.push(`${path}: non-empty title is required`);

  const mainCount = (html.match(/<main\b/gi) || []).length;
  if (mainCount !== 1) errors.push(`${path}: expected exactly one main landmark; found ${mainCount}`);
  const h1Count = (html.match(/<h1\b/gi) || []).length;
  if (h1Count !== 1) errors.push(`${path}: expected exactly one h1; found ${h1Count}`);

  const ids = [...html.matchAll(/\sid\s*=\s*(["'])(.*?)\1/gi)].map(match => match[2]).filter(Boolean);
  const seenIds = new Set();
  for (const id of ids) {
    if (seenIds.has(id)) errors.push(`${path}: duplicate id ${id}`);
    seenIds.add(id);
  }

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!hasAttr(match[0], 'alt')) errors.push(`${path}: image is missing alt attribute`);
  }

  for (const match of html.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const tag = match[0];
    const type = attr(tag, 'type').toLowerCase();
    if (match[1].toLowerCase() === 'input' && ['hidden', 'submit', 'button', 'reset'].includes(type)) continue;
    if (!hasProgrammaticLabel(html, tag, match.index || 0)) {
      errors.push(`${path}: ${match[1].toLowerCase()} control lacks a programmatic label${attr(tag, 'id') ? ` (${attr(tag, 'id')})` : ''}`);
    }
  }

  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const tag = `<button${match[1]}>`;
    if (!visibleText(match[2]) && !attr(tag, 'aria-label') && !attr(tag, 'aria-labelledby')) {
      errors.push(`${path}: button lacks an accessible name`);
    }
  }

  for (const match of html.matchAll(/<a\b[^>]*target\s*=\s*(["'])_blank\1[^>]*>/gi)) {
    const rel = attr(match[0], 'rel').toLowerCase().split(/\s+/).filter(Boolean);
    if (!rel.includes('noopener')) errors.push(`${path}: target=_blank link must include rel=noopener`);
  }

  for (const match of html.matchAll(/<iframe\b[^>]*>/gi)) {
    if (!attr(match[0], 'title')) errors.push(`${path}: iframe is missing a title`);
  }
}

if (errors.length) {
  console.error('Accessibility validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Accessibility validation passed across ${uniqueFiles.length} user-facing HTML pages.`);
