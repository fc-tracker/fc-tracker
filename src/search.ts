// Forgiving player search (user 2026-11-05: "Etoo" finds Eto'o, "Gross" finds Groß): the same folding as the model's
// names::normalise_name – lower case, no accents, ß → ss, æ → ae, œ → oe, ø → o, and no apostrophes, dots or dashes.

const SPECIAL: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", ı: "i" };

/** A name or a query as plain words of ASCII letters and digits. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ßæœøłđðı]/g, (c) => SPECIAL[c] ?? c)
    .replace(/['’`´.\-]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Every word of the query is in the name (in any order): "vini jr" finds "Vinícius Júnior". */
export function matches(name: string, query: string): boolean {
  const n = fold(name);
  const squashed = n.replace(/ /g, "");
  const parts = n.split(" ");
  // a short word may be an abbreviation of a name word that starts the same: "jr" → "junior"
  const abbrev = (w: string) => w.length <= 4 && parts.some((p) => p[0] === w[0] && subsequence(w, p));
  return fold(query)
    .split(" ")
    .filter(Boolean)
    .every((w) => n.includes(w) || squashed.includes(w) || abbrev(w));
}

function subsequence(w: string, p: string): boolean {
  let i = 0;
  for (const c of p) if (c === w[i]) i++;
  return i === w.length;
}
