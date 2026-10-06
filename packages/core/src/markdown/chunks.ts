export interface Chunk { index: number; heading: string | null; start: number; end: number; page: number | null; text: string }

/**
 * Splits text into heading-aware chunks with offsets into the ORIGINAL string so a
 * citation can point at an exact span. Page boundaries (form-feed, as emitted by the PDF
 * extractor) set the page number of chunks that start after them.
 */
export function chunkText(text: string, { maxChars = 1200, offset = 0 } = {}): Chunk[] {
  const chunks: Chunk[] = [];
  let heading: string | null = null;
  let page: number | null = text.includes('\f') ? 1 : null;
  const paras: { start: number; end: number }[] = [];
  const re = /\n\s*\n|\f/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) { paras.push({ start: last, end: m.index }); last = m.index + m[0].length; }
  paras.push({ start: last, end: text.length });

  let cur: { start: number; end: number; heading: string | null; page: number | null } | null = null;
  const flush = () => {
    if (!cur) return;
    const body = text.slice(cur.start, cur.end);
    if (body.trim()) chunks.push({ index: chunks.length, heading: cur.heading, start: cur.start + offset, end: cur.end + offset, page: cur.page, text: body });
    cur = null;
  };
  for (const p of paras) {
    const seg = text.slice(p.start, p.end);
    if (page !== null) page = 1 + (text.slice(0, p.start).match(/\f/g)?.length ?? 0);
    const h = /^\s*(#{1,6})\s+(.+)$/m.exec(seg);
    if (h && seg.trimStart().startsWith('#')) { flush(); heading = h[2].trim(); }
    if (cur && (p.end - cur.start > maxChars || cur.page !== page)) flush();
    if (!cur) cur = { start: p.start, end: p.end, heading, page };
    else cur.end = p.end;
    // Very long single paragraphs are cut on sentence-ish boundaries.
    while (cur && cur.end - cur.start > maxChars * 1.5) {
      const slice = text.slice(cur.start, cur.start + maxChars);
      const cut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('。'), slice.lastIndexOf('؟ '), slice.lastIndexOf('! '), slice.lastIndexOf('\n'));
      const at: number = cur.start + (cut > maxChars / 3 ? cut + 1 : maxChars);
      const rest: number = cur.end;
      cur.end = at; flush();
      cur = { start: at, end: rest, heading, page };
    }
  }
  flush();
  return chunks;
}
