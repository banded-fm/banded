/**
 * A name folded for matching: lower case, without accents or other marks, so "nane" finds "Nané" and "bjork"
 * finds "Björk". Letters that aren't a base letter plus a mark ("ø", "ß", "æ"…) become their usual Latin spelling.
 */
const SPECIAL: Record<string, string> = {
  ø: "o", æ: "ae", œ: "oe", ß: "ss", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i", ŧ: "t", ħ: "h",
};

export function foldName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[øæœßłđðþıŧħ]/g, (c) => SPECIAL[c] ?? c);
}
