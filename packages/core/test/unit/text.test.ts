import { describe, it, expect } from 'vitest';
import { normalizeForSearch, compactForSearch } from '../../src/text/normalize';

describe('Persian search normalization', () => {
  it('unifies Arabic and Persian yeh/kaf', () => {
    expect(normalizeForSearch('كتاب علي')).toBe(normalizeForSearch('کتاب علی'));
  });
  it('treats ZWNJ, space and no-space forms alike in compact form', () => {
    const a = compactForSearch('می‌شود'), b = compactForSearch('می شود'), c = compactForSearch('میشود');
    expect(a).toBe(b); expect(b).toBe(c);
  });
  it('strips harakat and tatweel, maps digits', () => {
    expect(normalizeForSearch('مُحَمَّد ـــ ۱۴۰۵')).toBe('محمد 1405');
  });
  it('does not mutate the input string', () => {
    const s = 'كتاب'; normalizeForSearch(s); expect(s).toBe('كتاب');
  });
});
