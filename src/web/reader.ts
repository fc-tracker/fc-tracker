// Reads FC 27 Gallery pages from a video frame in the browser – the same regions and checks as
// the app's scan.rs (2000 × 1125 reference coords in the 16:9 content box). Text comes from a
// small text reader in this tab (loaded once); frames are read in memory and dropped.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Worker = { recognize: (c: HTMLCanvasElement) => Promise<{ data: any }>; setParameters: (p: Record<string, string>) => Promise<unknown> };

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
let workerPromise: Promise<Worker> | null = null;

/** The text reader (≈ 2 MB, once per visit; the browser keeps it cached). */
export function textReader(): Promise<Worker> {
  workerPromise ??= new Promise<void>((resolve, reject) => {
    if ((window as any).Tesseract) return resolve();
    const s = document.createElement("script");
    s.src = TESSERACT;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("reader_load"));
    document.head.append(s);
  }).then(() => (window as any).Tesseract.createWorker("eng") as Promise<Worker>);
  workerPromise.catch(() => (workerPromise = null));
  return workerPromise;
}

export interface Box { x: number; y: number; w: number; h: number }

/** One frame, copied out of the video. */
export class Frame {
  readonly w: number;
  readonly h: number;
  readonly ctx: CanvasRenderingContext2D;
  private pixels: Uint8ClampedArray | null = null;
  /** content box: 16:9, centred; s = px per reference unit */
  readonly ox: number;
  readonly oy: number;
  readonly s: number;
  /** where the reader looked (frame px), for the preview */
  readonly looked: Box[] = [];

  constructor(source: CanvasImageSource, w: number, h: number) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    this.ctx = c.getContext("2d", { willReadFrequently: true })!;
    this.ctx.drawImage(source, 0, 0, w, h);
    this.w = w;
    this.h = h;
    const [cw, ch] = w / h > 16 / 9 ? [h * (16 / 9), h] : [w, w * (9 / 16)];
    this.ox = (w - cw) / 2;
    this.oy = (h - ch) / 2;
    this.s = cw / 2000;
  }

  px(x: number, y: number): [number, number] {
    return [this.ox + x * this.s, this.oy + y * this.s];
  }

  rgba(): Uint8ClampedArray {
    this.pixels ??= this.ctx.getImageData(0, 0, this.w, this.h).data;
    return this.pixels;
  }

  luma(x: number, y: number): number {
    const d = this.rgba();
    const i = (Math.min(this.h - 1, Math.max(0, y | 0)) * this.w + Math.min(this.w - 1, Math.max(0, x | 0))) * 4;
    return (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  }

  /** 64 × 36 luminance signature of the content box (did the page change?). */
  signature(): Uint8Array {
    const out = new Uint8Array(64 * 36);
    const cw = 2000 * this.s, ch = 1125 * this.s;
    for (let j = 0; j < 36; j++) {
      for (let i = 0; i < 64; i++) {
        const x = this.ox + ((i + 0.5) * cw) / 64, y = this.oy + ((j + 0.5) * ch) / 36;
        out[j * 64 + i] = this.luma(x, y);
      }
    }
    return out;
  }

  /**
   * A region (frame px) upscaled `factor`× for the text reader. `ink`: luminance threshold –
   * `light` text (white on dark) or dark text become black on white; null = contrast-stretched
   * grey, inverted when the text is light.
   */
  crop(x: number, y: number, w: number, h: number, factor: number, ink: number | null, light = true): HTMLCanvasElement {
    this.looked.push({ x, y, w, h });
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * factor));
    c.height = Math.max(1, Math.round(h * factor));
    const o = c.getContext("2d", { willReadFrequently: true })!;
    o.imageSmoothingEnabled = factor < 2.5;
    o.drawImage(this.ctx.canvas, x, y, w, h, 0, 0, c.width, c.height);
    const img = o.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      d[i] = g;
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
    for (let i = 0; i < d.length; i += 4) {
      let v: number;
      if (ink != null) v = (light ? d[i] >= ink : d[i] <= ink) ? 0 : 255;
      else {
        const n = ((d[i] - lo) * 255) / Math.max(1, hi - lo);
        v = light ? 255 - n : n;
      }
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    o.putImageData(img, 0, 0);
    return c;
  }

  /** A region in reference coords → frame px box. */
  ref(x0: number, y0: number, x1: number, y1: number): Box {
    const [a, b] = this.px(x0, y0), [c, d] = this.px(x1, y1);
    return { x: a, y: b, w: c - a, h: d - b };
  }
}

async function line(w: Worker, canvas: HTMLCanvasElement, chars: string): Promise<string> {
  await w.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: chars });
  const { data } = await w.recognize(canvas);
  return String(data.text ?? "").trim();
}

const DIGITS = "0123456789,.";
const num = (t: string): number | null => {
  const m = t.replace(/[^0-9]/g, "");
  return m ? Number(m) : null;
};

async function readNumber(w: Worker, f: Frame, b: Box): Promise<number | null> {
  for (const ink of [150, null, 120]) {
    const v = num(await line(w, f.crop(b.x, b.y, b.w, b.h, 2, ink), DIGITS));
    if (v != null) return v;
  }
  return null;
}

async function readTitle(w: Worker, f: Frame, b: Box): Promise<string> {
  const t = await line(w, f.crop(b.x, b.y, b.w, b.h, 2, 150), "");
  // without the set-number box ("Aston Villa 2") and a club badge read as one letter
  return t.replace(/[^\p{L}&'.\- ]+\s*$/u, "").replace(/\s+\d+\s*$/, "").trim().replace(/^(\S{1,2}\s+)+/, "").replace(/^[^\p{L}]+/u, "");
}

// ---------------------------------------------------------------- set page (scan.rs)

const GRID = { x0: 165, dx: 125, y0: 396, dy: 200, rows: 3, cols: 10 };
const POSITIONS = ["GK", "CB", "LB", "RB", "LWB", "RWB", "CDM", "CM", "CAM", "LM", "RM", "LW", "RW", "ST", "CF"];
/** First-owner triangle: no marker 0–7, marker 67–164 (scan.rs TRIANGLE_THRESHOLD). */
const TRIANGLE_THRESHOLD = 35;

export interface SlotRead { points: number; rating: number | null; position: string | null; first_owner: boolean }
export interface SetRead { title: string; total: number | null; base: number | null; bonus: number | null; slots: SlotRead[]; complete: boolean }

/** A card is present in a grid cell when its body has texture; an empty slot is flat and dark. */
function hasCard(f: Frame, cx: number, cy: number): boolean {
  const b = f.ref(cx - 50, cy + 30, cx + 50, cy + 140);
  let n = 0, sum = 0, sq = 0, lo = 255, hi = 0;
  for (let y = b.y; y < b.y + b.h; y += 2) {
    for (let x = b.x; x < b.x + b.w; x += 2) {
      const g = f.luma(x, y);
      n++; sum += g; sq += g * g;
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
  }
  const mean = sum / Math.max(1, n);
  return Math.sqrt(Math.max(0, sq / Math.max(1, n) - mean * mean)) > 15 || hi - lo > 90;
}

/** scan.rs triangle_debug: a downward-triangle template slid over the marker spot. */
export function triangleScore(f: Frame, cx: number, cy: number): number {
  const sc = f.s;
  const [ax, ay] = f.px(cx - 54, cy + 68), [bx, by] = f.px(cx - 28, cy + 93);
  const x0 = Math.max(0, ax) | 0, y0 = Math.max(0, ay) | 0, x1 = Math.min(f.w, bx | 0), y1 = Math.min(f.h, by | 0);
  if (x1 <= x0 || y1 <= y0) return 0;
  const d = f.rgba();
  const at = (x: number, y: number) => (y * f.w + x) * 4;
  const ch: number[][] = [[], [], []];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = at(x, y); ch[0].push(d[i]); ch[1].push(d[i + 1]); ch[2].push(d[i + 2]); }
  const bg = ch.map((v) => v.sort((p, q) => p - q)[v.length >> 1]);
  const dist = (x: number, y: number) => {
    if (x < x0 || x >= x1 || y < y0 || y >= y1) return 0;
    const i = at(x, y);
    return Math.sqrt((d[i] - bg[0]) ** 2 + (d[i + 1] - bg[1]) ** 2 + (d[i + 2] - bg[2]) ** 2) | 0;
  };
  const tw = Math.max(5, Math.round(9 * sc)), th = Math.max(4, Math.round(8 * sc)), ring = Math.max(1, Math.round(2 * sc));
  const ex = x0 + Math.round(8 * sc), ey = y0 + Math.round(9 * sc), slack = Math.max(1, Math.round(2 * sc));
  let best = -Infinity;
  for (let oy = Math.max(y0, ey - slack); oy <= Math.min(y1 - th, ey + slack); oy++) {
    for (let ox = Math.max(x0, ex - slack); ox <= Math.min(x1 - tw, ex + slack); ox++) {
      let ins = 0, nIn = 0, out = 0, nOut = 0;
      for (let r = -ring; r < th + ring; r++) {
        for (let c = -ring; c < tw + ring; c++) {
          const half = (tw / 2) * (1 - r / th);
          const inside = r >= 0 && r < th && Math.abs(c + 0.5 - tw / 2) <= half;
          const v = dist(ox + c, oy + r);
          if (inside) { ins += v; nIn++; } else if (r < 0 || r >= th || c < 0 || c >= tw) { out += v; nOut++; }
        }
      }
      const score = ((ins / Math.max(1, nIn)) | 0) - ((out / Math.max(1, nOut)) | 0);
      if (score > best) best = score;
    }
  }
  return Math.max(0, best);
}

/** A card's points chip: the first plausible reading of a few passes (the Base Grade checks the sum). */
async function readChip(w: Worker, f: Frame, b: Box, valid: Set<number>, skip = 0): Promise<number | null> {
  // small frames (1440 px) need a bigger upscale for the same glyph size
  const k = Math.max(1, Math.round(0.9 / Math.min(1, f.s)));
  const passes: [number, number | null][] = [[3 * k, 150], [4 * k, 120], [3 * k, null], [2 * k, 170]];
  for (const [factor, ink] of passes.slice(skip)) {
    const v = num(await line(w, f.crop(b.x, b.y, b.w, b.h, factor, ink), DIGITS));
    if (v != null && v >= 20 && v <= 500_000 && (valid.size === 0 || valid.has(v))) return v;
  }
  return null;
}

/** The rating in the card's corner (dark print on gold, light on special cards). */
async function readRating(w: Worker, f: Frame, cx: number, cy: number): Promise<number | null> {
  const b = f.ref(cx - 56, cy + 36, cx - 28, cy + 55);
  const k = 1 / Math.min(1, f.s);
  for (const [factor, ink, light] of [[4, null, false], [4, null, true], [5, 140, false]] as [number, number | null, boolean][]) {
    const t = await line(w, f.crop(b.x, b.y, b.w, b.h, factor * k, ink, light), "0123456789");
    const m = t.match(/\b(\d{2})\b/);
    if (m && +m[1] >= 40 && +m[1] <= 99) return +m[1];
  }
  return null;
}

// The position under the rating is too small for the browser's text reader (measured: CDM read
// as CM, RM as BM) – a wrong one would name the wrong card, so it is left out here (the app reads it).

export type PageKind = "set" | "incomplete" | "other";

/** What kind of page this is, from the score panel only (cheap: one small read). */
export async function classify(f: Frame): Promise<PageKind> {
  const w = await textReader();
  const b = f.ref(1480, 620, 1860, 690);
  const t = (await line(w, f.crop(b.x, b.y, b.w, b.h, 2, 150), "")).toLowerCase();
  if (/complete/.test(t)) return "incomplete";
  // a graded set page: both the Total Score and the Base Grade are numbers (scan.rs does the same)
  if (/\d/.test(t) && (await readNumber(w, f, f.ref(1650, 760, 1920, 790))) != null) return "set";
  return "other";
}

/** A set page: title, the score panel and every placed card (points, rating, position, triangle). */
/**
 * What identifies the page on screen without reading the cards: the title, the score panel and
 * which grid cells hold a card. The menu background moves all the time – the same key means the
 * same page, nothing to read again.
 */
export async function pageKey(f: Frame, kind: "set" | "incomplete"): Promise<string> {
  const w = await textReader();
  const title = await readTitle(w, f, f.ref(1400, 195, 1920, 265));
  const graded = kind === "set";
  const total = graded ? await readNumber(w, f, f.ref(1480, 620, 1860, 690)) : null;
  const base = graded ? await readNumber(w, f, f.ref(1650, 760, 1920, 790)) : null;
  let cells = "";
  for (let r = 0; r < GRID.rows; r++) for (let c = 0; c < GRID.cols; c++) cells += hasCard(f, GRID.x0 + GRID.dx * c, GRID.y0 + GRID.dy * r) ? "1" : "0";
  return [kind, title, total, base, cells].join("|");
}

export async function readSet(f: Frame, kind: "set" | "incomplete", valid: Set<number> = new Set(), onCard?: (done: number) => void): Promise<SetRead> {
  const w = await textReader();
  const title = await readTitle(w, f, f.ref(1400, 195, 1920, 265));
  const graded = kind === "set";
  const total = graded ? await readNumber(w, f, f.ref(1480, 620, 1860, 690)) : null;
  const base = graded ? await readNumber(w, f, f.ref(1650, 760, 1920, 790)) : null;
  const bonus = graded ? await readNumber(w, f, f.ref(1650, 791, 1920, 822)) : null;
  const slots: SlotRead[] = [];
  const chips: Box[] = [];
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      const cx = GRID.x0 + GRID.dx * c, cy = GRID.y0 + GRID.dy * r;
      if (!hasCard(f, cx, cy)) continue;
      const chip = f.ref(cx - 42, cy - 12, cx + 50, cy + 12);
      const points = await readChip(w, f, chip, valid);
      if (points == null) continue;
      const rating = await readRating(w, f, cx, cy);
      slots.push({ points, rating, position: null, first_owner: triangleScore(f, cx, cy) >= TRIANGLE_THRESHOLD });
      chips.push(chip);
      onCard?.(slots.length);
    }
  }
  // The Base Grade is the sum of the cards' points: one misread chip is found by reading it
  // the other ways until the sum fits (scan.rs does the same).
  const sum = () => slots.reduce((a, x) => a + x.points, 0);
  if (base != null && sum() !== base) {
    for (let i = 0; i < slots.length && sum() !== base; i++) {
      for (let skip = 1; skip < 4; skip++) {
        const alt = await readChip(w, f, chips[i], valid, skip);
        if (alt != null && alt !== slots[i].points && sum() - slots[i].points + alt === base) {
          slots[i].points = alt;
          break;
        }
      }
    }
  }
  return { title, total, base, bonus, slots, complete: graded };
}

// ---------------------------------------------------------------- Swap Player (scan.rs read_swap_page)

export interface SwapCard { name: string; rating: number | null; position: string | null; points: number | null }
export interface SwapRead { title: string; cards: SwapCard[] }

interface Word { text: string; x: number; y: number; w: number; h: number }

const RATING_AT = [-70, -121], POSITION_AT = [-68, -95], POINTS_AT = [5, -200];

/** The Swap Player page: every card by its name label, rating/position/points around it. Null when it is no swap page. */
export async function readSwap(f: Frame): Promise<SwapRead | null> {
  const w = await textReader();
  // the page title (top left) names the set; a set page has its title on the right instead
  const tb = f.ref(120, 205, 650, 275);
  const title = await readTitle(w, f, tb);
  if (title.length < 3) return null;
  // the whole frame at reference size: words with their boxes
  const scale = Math.min(1, 2000 / f.w);
  const c = document.createElement("canvas");
  c.width = Math.round(f.w * scale);
  c.height = Math.round(f.h * scale);
  c.getContext("2d")!.drawImage(f.ctx.canvas, 0, 0, c.width, c.height);
  await w.setParameters({ tessedit_pageseg_mode: "11", tessedit_char_whitelist: "" });
  const { data } = await w.recognize(c);
  const words: Word[] = (data.words ?? []).map((x: any) => ({
    text: String(x.text).trim(),
    x: x.bbox.x0 / scale, y: x.bbox.y0 / scale, w: (x.bbox.x1 - x.bbox.x0) / scale, h: (x.bbox.y1 - x.bbox.y0) / scale,
  })).filter((x: Word) => x.text);
  const s = Math.min(f.w / 2000, f.h / 1127);
  const has = (t: string) => words.some((x) => x.text === t);
  if (!has("Swap") && !has("Gallery")) return null;
  const digits = (t: string) => (/^[\d,.]+$/.test(t) ? Number(t.replace(/[^\d]/g, "")) : null);
  const near = (x: number, y: number, r: number, ok: (x: Word) => boolean) =>
    words.filter(ok).map((o) => [o, Math.hypot(o.x + o.w / 2 - x, o.y + o.h / 2 - y)] as const).filter(([, d]) => d <= r).sort((a, b) => a[1] - b[1])[0]?.[0] ?? null;
  // name labels: words of name height on one line, close together
  const isName = (o: Word) => {
    const letters = [...o.text].filter((ch) => /\p{L}/u.test(ch)).length;
    return letters >= 2 && letters * 2 >= o.text.length && o.h >= 11 * s && o.h <= 17 * s && !POSITIONS.includes(o.text);
  };
  const lineOf = (o: Word) => Math.round(o.y / (8 * s));
  const nameWords = words.filter(isName).sort((a, b) => lineOf(a) - lineOf(b) || a.x - b.x);
  const labels: { text: string; l: number; r: number; top: number }[] = [];
  for (const o of nameWords) {
    const last = labels[labels.length - 1];
    if (last && Math.abs(o.y - last.top) < 6 * s && o.x >= last.r - 2 * s && o.x - last.r < 18 * s) {
      last.text += " " + o.text;
      last.r = o.x + o.w;
    } else labels.push({ text: o.text, l: o.x, r: o.x + o.w, top: o.y });
  }
  const statsBelow = (cx: number, y: number) =>
    words.filter((o) => { const wy = o.y + o.h / 2, wx = o.x + o.w / 2; return wy >= y + 20 * s && wy <= y + 45 * s && Math.abs(wx - cx) <= 95 * s && (digits(o.text) ?? 999) <= 99; }).length;
  const ratingAt = (cx: number, y: number) =>
    near(cx + RATING_AT[0] * s, y + RATING_AT[1] * s, 25 * s, (o) => o.text.length === 2 && (digits(o.text) ?? 0) >= 40 && (digits(o.text) ?? 0) <= 99);
  const positionAt = (cx: number, y: number) => near(cx + POSITION_AT[0] * s, y + POSITION_AT[1] * s, 25 * s, (o) => POSITIONS.includes(o.text));
  const isStatHeader = (t: string) => t.split(/\s+/).every((p) => p.length === 3 && /^[A-Z]+$/.test(p));
  const cards: SwapCard[] = labels
    .map((l) => ({ name: l.text, cx: (l.l + l.r) / 2, y: l.top }))
    .filter((l) => (statsBelow(l.cx, l.y) >= 4 || (ratingAt(l.cx, l.y) && positionAt(l.cx, l.y))) && !isStatHeader(l.name))
    .map((l) => {
      const r = ratingAt(l.cx, l.y);
      const p = positionAt(l.cx, l.y);
      const pts = near(l.cx + POINTS_AT[0] * s, l.y + POINTS_AT[1] * s, 60 * s, (o) => digits(o.text) != null);
      return { name: l.name, rating: r ? digits(r.text) : null, position: p ? p.text : null, points: pts ? digits(pts.text) : null };
    });
  return cards.length ? { title, cards } : { title, cards: [] };
}
