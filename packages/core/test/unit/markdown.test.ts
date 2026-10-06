import { describe, it, expect } from 'vitest';
import { parseMarkdown, setFrontmatterFields } from '../../src/markdown/frontmatter';
import { extractWikiLinks, buildResolver, rewriteLinks } from '../../src/markdown/links';
import { chunkText } from '../../src/markdown/chunks';

const doc = `---
title: LLM wiki
type: concept
aliases: [ویکی مدل زبانی]
custom_field: { nested: true }  # keep me
tags: [ai, pkm]
---
# LLM wiki

Links to [[Obsidian]] and [[concepts/Claude Code#Setup|CC]] but not \`[[code]]\`.

\`\`\`
[[also-not-a-link]]
\`\`\`
`;

describe('frontmatter', () => {
  it('parses data and keeps body offset aligned', () => {
    const p = parseMarkdown(doc);
    expect(p.data.title).toBe('LLM wiki');
    expect(doc.slice(p.bodyOffset).startsWith('# LLM wiki')).toBe(true);
  });
  it('round-trips unknown keys and comments when updating fields', () => {
    const out = setFrontmatterFields(doc, { updated: '2026-10-06' });
    expect(out).toContain('custom_field: { nested: true }  # keep me');
    expect(out).toContain('updated: 2026-10-06');
    expect(out.endsWith(doc.slice(parseMarkdown(doc).bodyOffset))).toBe(true);
  });
  it('rejects unsafe/custom YAML tags', () => {
    const p = parseMarkdown('---\nx: !!js/function "function(){}"\n---\nbody');
    expect(p.errors.length).toBeGreaterThan(0);
  });
});

describe('wikilinks', () => {
  it('extracts targets, headings, aliases and ignores code', () => {
    const links = extractWikiLinks(parseMarkdown(doc).body);
    expect(links.map(l => l.target)).toEqual(['Obsidian', 'concepts/Claude Code']);
    expect(links[1].heading).toBe('Setup');
    expect(links[1].alias).toBe('CC');
  });
  it('resolves by name, alias, path and reports ambiguity for same-named files', () => {
    const r = buildResolver([
      { id: 'a', path: 'wiki/concepts/Claude Code.md', title: 'Claude Code', aliases: [] },
      { id: 'b', path: 'wiki/entities/Claude Code.md', title: 'Claude Code', aliases: [] },
      { id: 'c', path: 'wiki/concepts/LLM wiki.md', title: 'LLM wiki', aliases: ['ویکی مدل زبانی'] },
    ]);
    expect(r('Claude Code')).toEqual({ status: 'ambiguous', candidates: ['a', 'b'] });
    expect(r('concepts/Claude Code')).toEqual({ status: 'resolved', id: 'a' });
    expect(r('ويكي مدل زباني')).toEqual({ status: 'resolved', id: 'c' });
    expect(r('Nope')).toEqual({ status: 'missing' });
  });
  it('rewrites links preserving heading and alias', () => {
    const { text, count } = rewriteLinks('see [[Old#H|alias]] and [[Old]]', t => t === 'Old', 'New');
    expect(text).toBe('see [[New#H|alias]] and [[New]]'); expect(count).toBe(2);
  });
});

describe('chunking', () => {
  it('keeps offsets into the original text and tracks headings and pages', () => {
    const text = '# A\n\npara one.\n\n## B\n\npara two\fpage two text';
    const chunks = chunkText(text, { maxChars: 20 });
    for (const c of chunks) expect(text.slice(c.start, c.end)).toBe(c.text);
    expect(chunks.find(c => c.text.includes('page two'))?.page).toBe(2);
    expect(chunks.find(c => c.text.includes('para two'))?.heading).toBe('B');
  });
});
