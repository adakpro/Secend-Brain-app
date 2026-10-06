/**
 * Search normalization for Persian/Arabic/English text. Used ONLY for index and query
 * comparison; stored originals and citation offsets always refer to the unmodified text.
 */
const MAP: Record<string, string> = {
  'ي': 'ی', 'ى': 'ی', 'ئ': 'ی', 'ك': 'ک', 'ة': 'ه', 'ۀ': 'ه', 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ؤ': 'و',
};
const DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function normalizeForSearch(input: string): string {
  let s = input.normalize('NFKC').toLowerCase();
  s = s.replace(/[يىئكةۀأإآٱؤ]/g, c => MAP[c] ?? c);
  s = s.replace(/[۰-۹]/g, c => String(DIGITS.indexOf(c))).replace(/[٠-٩]/g, c => String(ARABIC_DIGITS.indexOf(c)));
  // Harakat, tanwin, superscript alef, tatweel.
  s = s.replace(/[ً-ٰٟـ]/g, '');
  // ZWNJ / ZWJ / bidi marks become a space so "می‌شود" ~ "می شود".
  s = s.replace(/[​-‏‪-‮⁦-⁩]/g, ' ');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Space-free form so "میشود", "می شود" and "می‌شود" all match by substring. */
export const compactForSearch = (s: string) => normalizeForSearch(s).replace(/ /g, '');

export function toPersianDigits(s: string | number): string {
  return String(s).replace(/[0-9]/g, d => DIGITS[Number(d)]);
}
