import type { BundleChunk } from '@sb/contracts';
import { normalizeForSearch } from '../text/normalize';
import { sha256Hex } from '../crypto/envelope';

export interface CitationCheck {
  key: string; valid: boolean; reasons: string[]; quote: string; chunk?: BundleChunk;
}

/**
 * Structural validation of model citations: the key must have been issued to THIS run, the
 * quote must actually occur in that passage, and every [Cn] marker in the answer must be
 * backed by a citation entry. This proves provenance, not semantic correctness.
 */
export function validateCitations(answer: string, citations: { key: string; quote: string }[], chunks: BundleChunk[]) {
  const byKey = new Map(chunks.map(c => [c.key, c]));
  const checks: CitationCheck[] = [];
  const seen = new Set<string>();
  for (const c of citations ?? []) {
    const key = String(c.key ?? '').replace(/^\[|\]$/g, '').trim();
    if (seen.has(key)) continue; seen.add(key);
    const reasons: string[] = [];
    const chunk = byKey.get(key);
    if (!chunk) reasons.push('unknown_key');
    const quote = String(c.quote ?? '').trim();
    if (chunk) {
      const nq = normalizeForSearch(quote);
      if (!nq || nq.length < 4) reasons.push('empty_quote');
      else if (!normalizeForSearch(chunk.text).includes(nq)) reasons.push('quote_not_in_passage');
    }
    checks.push({ key, valid: reasons.length === 0, reasons, quote, chunk });
  }
  const markers = [...new Set([...(answer ?? '').matchAll(/\[(C\d+|S\d+)\]/g)].map(m => m[1]))];
  const unbacked = markers.filter(m => !seen.has(m));
  const fabricated = markers.filter(m => !byKey.has(m));
  return { checks, markers, unbacked, fabricated, validCount: checks.filter(c => c.valid).length };
}

/** Exact excerpt for storage: the passage text itself, with its hash, so later edits cannot silently re-point it. */
export function excerptOf(chunk: BundleChunk) { const excerpt = chunk.text.slice(0, 1200); return { excerpt, excerptSha256: sha256Hex(chunk.text) }; }
