//! In-game Gallery scan: reads the FC27 "Swap Player" card selector from a screenshot.
//!
//! Every collected card of a set is listed there with name, rating, position, Gallery points
//! and – the reason this exists – the first-owner marker (a small "1" triangle on the card).
//! We only look at pixels of a screenshot (like OBS); the game process is never touched.
//!
//! Text comes from Windows' built-in OCR (Windows.Media.Ocr), pixels from WIC decoding.

use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapDecoder, BitmapEncoder, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{Buffer, DataReader, InMemoryRandomAccessStream, DataWriter};

/// One recognised word with its box in image pixels.
#[derive(Debug, Clone)]
pub struct Word {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// A decoded image: BGRA8 pixels + the OCR words.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
    pub words: Vec<Word>,
}

impl Frame {
    /// FC27 draws its UI in a 16:9 area centred on screen (letterboxed on 16:10 like 2880×1800).
    /// Returns (offset x, offset y, scale) mapping 2000×1125 reference coords to frame pixels.
    pub fn content_box(&self) -> (f32, f32, f32) {
        let (w, h) = (self.width as f32, self.height as f32);
        let (cw, ch) = if w / h > 16.0 / 9.0 { (h * 16.0 / 9.0, h) } else { (w, w * 9.0 / 16.0) };
        ((w - cw) / 2.0, (h - ch) / 2.0, cw / 2000.0)
    }

    /// Luminance (0–255) at a pixel.
    pub fn luma(&self, x: u32, y: u32) -> u8 {
        let i = ((y.min(self.height - 1) * self.width + x.min(self.width - 1)) * 4) as usize;
        let (b, g, r) = (self.bgra[i] as u32, self.bgra[i + 1] as u32, self.bgra[i + 2] as u32);
        ((r * 299 + g * 587 + b * 114) / 1000) as u8
    }
}

fn err(e: windows::core::Error) -> String {
    format!("scan_failed:{e}")
}

/// Decodes an encoded image (PNG, JPEG, WebP …) and runs OCR on it. Used by the fixture tests
/// today; kept public for scanning saved screenshots.
#[cfg_attr(not(test), allow(dead_code))]
pub fn analyse_bytes(bytes: &[u8]) -> Result<Frame, String> {
    let stream = InMemoryRandomAccessStream::new().map_err(err)?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(err)?;
    writer.WriteBytes(bytes).map_err(err)?;
    writer.StoreAsync().map_err(err)?.join().map_err(err)?;
    writer.DetachStream().map_err(err)?;
    stream.Seek(0).map_err(err)?;

    let decoder = BitmapDecoder::CreateAsync(&stream).map_err(err)?.join().map_err(err)?;
    let bitmap = decoder.GetSoftwareBitmapAsync().map_err(err)?.join().map_err(err)?;
    let bitmap = SoftwareBitmap::Convert(&bitmap, BitmapPixelFormat::Bgra8).map_err(err)?;
    analyse_bitmap(&bitmap)
}

pub fn analyse_bitmap(bitmap: &SoftwareBitmap) -> Result<Frame, String> {
    let width = bitmap.PixelWidth().map_err(err)? as u32;
    let height = bitmap.PixelHeight().map_err(err)? as u32;

    let len = width * height * 4;
    let buffer = Buffer::Create(len).map_err(err)?;
    bitmap.CopyToBuffer(&buffer).map_err(err)?;
    let reader = DataReader::FromBuffer(&buffer).map_err(err)?;
    let mut bgra = vec![0u8; len as usize];
    reader.ReadBytes(&mut bgra).map_err(err)?;

    let words = ocr(&ocr_engine()?, bitmap)?;
    Ok(Frame { width, height, bgra, words })
}

fn ocr_engine() -> Result<OcrEngine, String> {
    OcrEngine::TryCreateFromLanguage(&Language::CreateLanguage(&HSTRING::from("en-US")).map_err(err)?).map_err(err)
}

fn ocr(engine: &OcrEngine, bitmap: &SoftwareBitmap) -> Result<Vec<Word>, String> {
    let result = engine.RecognizeAsync(bitmap).map_err(err)?.join().map_err(err)?;
    let mut words = Vec::new();
    for line in result.Lines().map_err(err)? {
        for word in line.Words().map_err(err)? {
            let r = word.BoundingRect().map_err(err)?;
            words.push(Word { text: word.Text().map_err(err)?.to_string(), x: r.X, y: r.Y, w: r.Width, h: r.Height });
        }
    }
    Ok(words)
}

/// A JPEG of a picture (half size above 2000 px wide) – diagnostics only.
pub fn save_jpeg(path: &std::path::Path, w: u32, h: u32, bgra: &[u8]) -> Result<(), String> {
    let scaled = (w > 2000).then(|| downscale2(w, h, bgra));
    let (w, h, px) = match &scaled {
        Some((sw, sh, small)) => (*sw, *sh, small.as_slice()),
        None => (w, h, bgra),
    };
    let bitmap = bitmap_from_bgra(px, w, h)?;
    let stream = InMemoryRandomAccessStream::new().map_err(err)?;
    let encoder = BitmapEncoder::CreateAsync(BitmapEncoder::JpegEncoderId().map_err(err)?, &stream).map_err(err)?.join().map_err(err)?;
    encoder.SetSoftwareBitmap(&bitmap).map_err(err)?;
    encoder.FlushAsync().map_err(err)?.join().map_err(err)?;
    let size = stream.Size().map_err(err)? as u32;
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).map_err(err)?).map_err(err)?;
    reader.LoadAsync(size).map_err(err)?.join().map_err(err)?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).map_err(err)?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

/// A screen recorder runs: our capture is held steady (see `game::recorder_running`) – one capture
/// session (the watcher), no one-frame captures, no hiding our windows from capture.
pub static STEADY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn steady() -> bool {
    STEADY.load(std::sync::atomic::Ordering::Relaxed)
}

/// Where the last read's picture came from (diagnostics): the running capture, a one-frame
/// capture of the game window, or the screen copy.
pub static LAST_SOURCE: std::sync::Mutex<&str> = std::sync::Mutex::new("");

fn bitmap_from_bgra(pixels: &[u8], w: u32, h: u32) -> Result<SoftwareBitmap, String> {
    let writer = DataWriter::new().map_err(err)?;
    writer.WriteBytes(pixels).map_err(err)?;
    let buffer = writer.DetachBuffer().map_err(err)?;
    SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w as i32, h as i32).map_err(err)
}

impl Frame {
    /// Crops a region (frame pixels), upscales it `factor`× (nearest neighbour – keeps glyph
    /// edges sharp) and OCRs it, optionally binarised: pixels brighter than `light_text` become
    /// black ink on white paper – ideal for FC27's white digits on dark chips.
    fn ocr_region_with(
        &self,
        engine: &OcrEngine,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        factor: u32,
        light_text: Option<u8>,
    ) -> Result<String, String> {
        self.ocr_region_ink(engine, x, y, w, h, factor, light_text, false)
    }

    /// Binarised OCR for dark text (pixels darker than `threshold` become ink) – the rating and
    /// position printed on gold cards.
    #[allow(clippy::too_many_arguments)]
    fn ocr_region_ink(
        &self,
        engine: &OcrEngine,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        factor: u32,
        threshold: Option<u8>,
        dark_text: bool,
    ) -> Result<String, String> {
        let light_text = threshold;
        let (x0, y0) = (x.max(0.0) as u32, y.max(0.0) as u32);
        let (cw, ch) = ((w as u32).min(self.width - x0), (h as u32).min(self.height - y0));
        // Windows OCR needs at least ~40 px; pad around the text with the edge colour.
        let pad = 16;
        let (ow, oh) = (cw * factor + 2 * pad, ch * factor + 2 * pad);
        let mut out = vec![0u8; (ow * oh * 4) as usize];
        for oy in 0..oh {
            for ox in 0..ow {
                let sx = x0 + (ox.saturating_sub(pad) / factor).min(cw - 1);
                let sy = y0 + (oy.saturating_sub(pad) / factor).min(ch - 1);
                let si = ((sy * self.width + sx) * 4) as usize;
                let di = ((oy * ow + ox) * 4) as usize;
                match light_text {
                    Some(t) => {
                        let l = self.luma(sx, sy);
                        let ink = if dark_text { l < t } else { l > t };
                        let v = if ink { 0 } else { 255 };
                        out[di..di + 4].copy_from_slice(&[v, v, v, 255]);
                    }
                    None => {
                        out[di..di + 4].copy_from_slice(&self.bgra[si..si + 4]);
                        out[di + 3] = 255;
                    }
                }
            }
        }
        let words = ocr(engine, &bitmap_from_bgra(&out, ow, oh)?)?;
        Ok(words.into_iter().map(|w| w.text).collect::<Vec<_>>().join(" "))
    }
}

/// A selected card read from a set page (the in-game set grid – no names on these cards).
#[derive(Debug, Clone, PartialEq)]
pub struct GridCard {
    /// 0-based slot, row-major (10 per row).
    pub slot: usize,
    /// Chosen value (see `resolve_points`); `readings` holds every OCR candidate.
    pub points: Option<u32>,
    pub readings: Vec<u32>,
    pub rating: Option<u32>,
    pub position: Option<String>,
    pub first_owner: bool,
    pub marker_score: u32,
    /// Nation flag colours (see `flag_signature`).
    pub flag: Vec<u8>,
}

/// Set grid geometry in 2000×1125 reference coords (same on every set page, verified on the
/// user's 16:10 screen and a 16:9 recording): 10 columns, points chip centres at
/// x = 165 + 125·col, y = 396 + 200·row.
const GRID_X0: f32 = 165.0;
const GRID_DX: f32 = 125.0;
const GRID_Y0: f32 = 396.0;
const GRID_DY: f32 = 200.0;
const GRID_ROWS: usize = 3;
const GRID_COLS: usize = 10;

impl Frame {
    /// Contrast pixels per 100 in a box given in reference coords relative to (cx, cy).
    fn contrast_ref(&self, cx: f32, cy: f32, dx: (f32, f32), dy: (f32, f32)) -> u32 {
        let (ox, oy, s) = self.content_box();
        let mut samples = Vec::new();
        let (x0, x1) = ((ox + (cx + dx.0) * s) as i32, (ox + (cx + dx.1) * s) as i32);
        let (y0, y1) = ((oy + (cy + dy.0) * s) as i32, (oy + (cy + dy.1) * s) as i32);
        for y in y0.max(0)..y1.max(0) {
            for x in x0.max(0)..x1.max(0) {
                samples.push(self.luma(x as u32, y as u32));
            }
        }
        if samples.is_empty() {
            return 0;
        }
        let mut sorted = samples.clone();
        sorted.sort_unstable();
        let median = sorted[sorted.len() / 2] as i32;
        (samples.iter().filter(|&&l| (l as i32 - median).abs() > 70).count() * 100 / samples.len()) as u32
    }

    /// Brightness range (max − min of the 5th/95th percentiles) of a card body.
    fn luma_spread_ref(&self, cx: f32, cy: f32) -> u32 {
        let (ox, oy, s) = self.content_box();
        let mut samples = Vec::new();
        for dy in (30..140).step_by(4) {
            for dx in (-50..50).step_by(4) {
                let (x, y) = (ox + (cx + dx as f32) * s, oy + (cy + dy as f32) * s);
                samples.push(self.luma(x as u32, y as u32));
            }
        }
        samples.sort_unstable();
        let n = samples.len();
        (samples[n * 95 / 100] as u32).saturating_sub(samples[n * 5 / 100] as u32)
    }

    fn ref_to_px(&self, x: f32, y: f32) -> (f32, f32) {
        let (ox, oy, s) = self.content_box();
        (ox + x * s, oy + y * s)
    }
}

/// Gallery points that can exist on a card (lowest is a bronze at 20).
fn plausible_points(p: u32) -> bool {
    (20..=500_000).contains(&p)
}

/// Reads a points chip several ways (binarised and raw, different upscales) and returns every
/// distinct plausible reading, most frequent first. The caller picks the one that matches a
/// known card value and checks the sum against the in-game Base Grade.
fn read_chip(frame: &Frame, engine: &OcrEngine, x: f32, y: f32, w: f32, h: f32) -> Result<Vec<u32>, String> {
    let mut seen: Vec<(u32, usize)> = Vec::new();
    for (factor, light) in [(3, Some(150)), (4, Some(120)), (2, Some(150)), (3, None), (4, None)] {
        let text = frame.ocr_region_with(engine, x, y, w, h, factor, light)?;
        let cleaned: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        if let Some(p) = digits(&cleaned).filter(|p| plausible_points(*p)) {
            match seen.iter_mut().find(|(v, _)| *v == p) {
                Some((_, n)) => *n += 1,
                None => seen.push((p, 1)),
            }
        }
    }
    seen.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(seen.into_iter().map(|(v, _)| v).collect())
}

/// A card is present in a grid cell when its body (face + stats) has real texture; an empty
/// slot is a flat dark placeholder.
fn cell_has_card(frame: &Frame, cx: f32, cy: f32) -> bool {
    frame.contrast_ref(cx, cy, (-50.0, 50.0), (30.0, 140.0)) >= 15 || frame.luma_spread_ref(cx, cy) > 90
}

/// Picks each slot's points from its own OCR readings and checks the result against what the
/// user can possibly have in that set:
/// - every value must be the points of a collected card, and no value may appear more often
///   than the user has cards with it (`available`: points → number of collected cards);
/// - the sum must equal the in-game Base Grade.
/// Corrections only use a slot's *own* other readings (or fill one unreadable chip with the
/// difference). Live frames can be misread while cards animate; several errors that happen to
/// cancel out in the sum are caught by the availability check. Returns true when verified.
pub fn resolve_points(
    cards: &mut [GridCard],
    available: &std::collections::BTreeMap<u32, usize>,
    base: Option<u32>,
) -> bool {
    let known = |p: &u32| available.is_empty() || available.contains_key(p);
    // Live OCR confuses 1 ↔ 7 and can lose the part before the comma ("4,100" → "700" /
    // "100"). Values a collected card actually has are added as extra readings.
    if !available.is_empty() {
        for c in cards.iter_mut() {
            let extra: Vec<u32> = c
                .readings
                .iter()
                .filter(|r| !available.contains_key(r))
                .flat_map(|r| ocr_variants(*r, available))
                .collect();
            for v in extra {
                if !c.readings.contains(&v) {
                    c.readings.push(v);
                }
            }
        }
    }
    for c in cards.iter_mut() {
        c.points = c.readings.iter().copied().find(known).or_else(|| c.readings.first().copied());
    }
    let feasible = |cs: &[GridCard]| {
        if available.is_empty() {
            return true;
        }
        let mut used: std::collections::BTreeMap<u32, usize> = std::collections::BTreeMap::new();
        for p in cs.iter().filter_map(|c| c.points) {
            *used.entry(p).or_default() += 1;
        }
        used.iter().all(|(p, n)| available.get(p).is_some_and(|have| n <= have))
    };
    let Some(base) = base else {
        // Incomplete set (no Base Grade shown): verified only when every chip read one single
        // value a collected card has, and the values fit what the user owns.
        // Readings no card has ("1688" next to "7688") don't make a chip ambiguous.
        return !available.is_empty()
            && cards.iter().all(|c| c.readings.iter().filter(|r| available.contains_key(r)).count() == 1 && c.points.is_some_and(|p| available.contains_key(&p)))
            && feasible(cards);
    };
    let ok = |cs: &[GridCard]| {
        cs.iter().all(|c| c.points.is_some()) && cs.iter().filter_map(|c| c.points).sum::<u32>() == base && feasible(cs)
    };
    if ok(cards) {
        return true;
    }
    let unknown: Vec<usize> = (0..cards.len()).filter(|&i| cards[i].points.is_none()).collect();
    if unknown.len() == 1 {
        let diff = base as i64 - cards.iter().filter_map(|c| c.points).sum::<u32>() as i64;
        if diff > 0 {
            cards[unknown[0]].points = Some(diff as u32);
            if ok(cards) {
                return true;
            }
            cards[unknown[0]].points = None;
        }
        return false;
    }
    if !unknown.is_empty() {
        return false;
    }
    // One misread chip: try that chip's other readings.
    for i in 0..cards.len() {
        let current = cards[i].points;
        for r in cards[i].readings.clone() {
            if Some(r) == current {
                continue;
            }
            cards[i].points = Some(r);
            if ok(cards) {
                return true;
            }
        }
        cards[i].points = current;
    }
    false
}

/// First-owner triangle "▼" on a set-grid card, under the boot icon (see `triangle_debug`).
/// Score = template contrast (inside − around the triangle). Fixtures: no marker 0–7, marker 67–164
/// (67 = a triangle half covered by player art).
const TRIANGLE_THRESHOLD: u32 = 35;
/// Below the threshold but this close: maybe a missed triangle (light cards at 1080p scored 32).
pub(crate) const TRIANGLE_GRAY: u32 = 20;

impl Frame {
    pub fn triangle_score(&self, cx: f32, cy: f32) -> u32 {
        self.triangle_debug(cx, cy).0
    }

    /// (score, best inside contrast, best outside contrast, offset x, offset y).
    /// Template match: a downward triangle (the marker is ~9×8 px at 2000 px width, dark on gold
    /// cards, light on special cards, holo-coloured on holographic cards) slid over the marker
    /// area; score = how much more the pixels *inside* the triangle differ from the card than the
    /// pixels right *around* it. Card art and badges are not triangle-shaped, so they score low.
    pub fn triangle_debug(&self, cx: f32, cy: f32) -> (u32, u32, u32, i32, i32) {
        let (_, _, sc) = self.content_box();
        let (ax, ay) = self.ref_to_px(cx - 54.0, cy + 68.0);
        let (bx, by) = self.ref_to_px(cx - 28.0, cy + 93.0);
        let (x0, y0, x1, y1) = (ax.max(0.0) as i32, ay.max(0.0) as i32, (bx as i32).min(self.width as i32), (by as i32).min(self.height as i32));
        if x1 <= x0 || y1 <= y0 {
            return (0, 0, 0, 0, 0);
        }
        let rgb = |x: i32, y: i32| {
            let i = ((y as u32 * self.width + x as u32) * 4) as usize;
            [self.bgra[i + 2] as i32, self.bgra[i + 1] as i32, self.bgra[i] as i32]
        };
        let mut ch: [Vec<i32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
        for y in y0..y1 {
            for x in x0..x1 {
                let p = rgb(x, y);
                for k in 0..3 {
                    ch[k].push(p[k]);
                }
            }
        }
        let bg: Vec<i32> = ch.iter_mut().map(|v| {
            v.sort_unstable();
            v[v.len() / 2]
        }).collect();
        let dist = |x: i32, y: i32| -> i32 {
            if x < x0 || x >= x1 || y < y0 || y >= y1 {
                return 0;
            }
            let p = rgb(x, y);
            (((p[0] - bg[0]).pow(2) + (p[1] - bg[1]).pow(2) + (p[2] - bg[2]).pow(2)) as f32).sqrt() as i32
        };
        let tw = (9.0 * sc).round().max(5.0) as i32; // top width
        let th = (8.0 * sc).round().max(4.0) as i32; // height
        let ring = (2.0 * sc).round().max(1.0) as i32;
        let mut best = (i32::MIN, 0, 0, 0, 0);
        // The marker sits at a fixed spot (≈ 8, 9 px into the box at 2000 px width); searching only
        // ± 2 px around it keeps card art and badges elsewhere in the box out of the match.
        let (ex, ey, slack) = (x0 + (8.0 * sc).round() as i32, y0 + (9.0 * sc).round() as i32, (2.0 * sc).round().max(1.0) as i32);
        for oy in (ey - slack).max(y0)..=(ey + slack).min(y1 - th) {
            for ox in (ex - slack).max(x0)..=(ex + slack).min(x1 - tw) {
                let (mut ins, mut n_in, mut out, mut n_out) = (0i64, 0i64, 0i64, 0i64);
                for r in -ring..(th + ring) {
                    for c in -ring..(tw + ring) {
                        let inside = (0..th).contains(&r) && {
                            // Row r spans the centre ± half its width (full width at the top).
                            let half = (tw as f32 / 2.0) * (1.0 - r as f32 / th as f32);
                            ((c as f32 + 0.5) - tw as f32 / 2.0).abs() <= half
                        };
                        let d = dist(ox + c, oy + r) as i64;
                        if inside {
                            ins += d;
                            n_in += 1;
                        } else if r < 0 || r >= th || c < 0 || c >= tw {
                            out += d;
                            n_out += 1;
                        }
                    }
                }
                let (mi, mo) = ((ins / n_in.max(1)) as i32, (out / n_out.max(1)) as i32);
                if mi - mo > best.0 {
                    best = (mi - mo, mi, mo, ox - x0, oy - y0);
                }
            }
        }
        (best.0.max(0) as u32, best.1 as u32, best.2 as u32, best.3, best.4)
    }
}

/// The nation flag on a set-grid card (left of the league/club badges, measured on the user's
/// PL page): 3 columns × 2 rows of mean RGB = 18 bytes. Identical nations measure ~10–35 apart,
/// different flags 100+ – enough to tell e.g. Norway from Brazil.
const FLAG_X: (f32, f32) = (-44.0, -20.0);
const FLAG_Y: (f32, f32) = (114.0, 128.0);

impl Frame {
    pub fn flag_signature(&self, cx: f32, cy: f32) -> Vec<u8> {
        let mut out = Vec::with_capacity(18);
        for row in 0..2 {
            for col in 0..3 {
                let (x0, x1) = (cx + FLAG_X.0 + 8.0 * col as f32, cx + FLAG_X.0 + 8.0 * (col + 1) as f32);
                let (y0, y1) = (cy + FLAG_Y.0 + 7.0 * row as f32, cy + FLAG_Y.0 + 7.0 * (row + 1) as f32);
                let (a, b) = self.ref_to_px(x0, y0);
                let (c, d) = self.ref_to_px(x1, y1);
                let (mut r, mut g, mut bl, mut n) = (0u32, 0u32, 0u32, 0u32);
                for y in (b as u32)..(d as u32).min(self.height) {
                    for x in (a as u32)..(c as u32).min(self.width) {
                        let i = ((y * self.width + x) * 4) as usize;
                        bl += self.bgra[i] as u32;
                        g += self.bgra[i + 1] as u32;
                        r += self.bgra[i + 2] as u32;
                        n += 1;
                    }
                }
                let n = n.max(1);
                out.extend([(r / n) as u8, (g / n) as u8, (bl / n) as u8]);
            }
        }
        out
    }
}

/// Values a misread chip may really be: 1↔7 swapped in any digits, or a lost leading part
/// ("700" → "4,700"/"4,100"…), kept only when a collected card of the set has that value.
fn ocr_variants(reading: u32, available: &std::collections::BTreeMap<u32, usize>) -> Vec<u32> {
    let text = reading.to_string();
    let mut out: Vec<u32> = Vec::new();
    let positions: Vec<usize> = text.char_indices().filter(|(_, c)| *c == '1' || *c == '7').map(|(i, _)| i).collect();
    for mask in 1u32..(1 << positions.len().min(4)) {
        let mut chars: Vec<char> = text.chars().collect();
        for (bit, &pos) in positions.iter().enumerate().take(4) {
            if mask & (1 << bit) != 0 {
                chars[pos] = if chars[pos] == '1' { '7' } else { '1' };
            }
        }
        if let Ok(v) = chars.into_iter().collect::<String>().parse::<u32>() {
            out.push(v);
        }
    }
    let mut with_suffix: Vec<u32> = out.clone();
    with_suffix.push(reading);
    if text.len() == 3 {
        // Lost "4," of "4,100": any collected value ending in these three digits.
        for &v in available.keys() {
            if v >= 1000 && with_suffix.iter().any(|s| v % 1000 == *s) {
                out.push(v);
            }
        }
    }
    out.retain(|v| available.contains_key(v));
    out.sort();
    out.dedup();
    out
}

/// Reads every filled slot of a set page grid. A slot counts as filled when its points chip
/// OCRs to a number; the first-owner triangle is detected below the position label.
pub fn read_set_grid(frame: &Frame) -> Result<Vec<GridCard>, String> {
    // The cells are independent: read in parallel, one OCR engine per thread (0.4 ms to make).
    // Measured on a 5-card set page: ~190 ms one after another (2026-10-17).
    let cells: Vec<(usize, usize)> = (0..GRID_ROWS).flat_map(|r| (0..GRID_COLS).map(move |c| (r, c))).collect();
    let threads = std::thread::available_parallelism().map_or(2, |n| n.get()).clamp(1, 6);
    let results: Vec<Result<Vec<GridCard>, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                let cells = &cells;
                scope.spawn(move || {
                    let engine = ocr_engine()?;
                    let mut out = Vec::new();
                    for &(row, col) in cells.iter().skip(t).step_by(threads) {
                        if let Some(card) = read_grid_cell(frame, &engine, row, col)? {
                            out.push(card);
                        }
                    }
                    Ok(out)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("scan:thread".into()))).collect()
    });
    let mut cards = Vec::new();
    for r in results {
        cards.extend(r?);
    }
    cards.sort_by_key(|c| c.slot);
    Ok(cards)
}

/// One cell of the set page grid: `None` when it holds no card.
fn read_grid_cell(frame: &Frame, engine: &OcrEngine, row: usize, col: usize) -> Result<Option<GridCard>, String> {
    let (_, _, s) = frame.content_box();
    let (cx, cy) = (GRID_X0 + GRID_DX * col as f32, GRID_Y0 + GRID_DY * row as f32);
    let (px, py) = frame.ref_to_px(cx - 42.0, cy - 12.0);
    let readings = read_chip(frame, engine, px, py, 92.0 * s, 24.0 * s)?;
    if readings.is_empty() && !cell_has_card(frame, cx, cy) {
        return Ok(None);
    }
    // Rating and position: small dark print on the card – several passes, first valid wins.
    let passes: [(u32, Option<u8>); 4] = [(4, None), (4, Some(110)), (5, Some(90)), (3, None)];
    // Rating: a roomier box read raw works best (measured on the user's 2000-px captures).
    let (rx, ry) = frame.ref_to_px(cx - 62.0, cy + 34.0);
    let rating = [3u32, 4].iter().find_map(|f| {
        let text = frame.ocr_region_with(engine, rx, ry, 30.0 * s, 40.0 * s, *f, None).ok()?;
        text.split_whitespace().find_map(|t| digits(t).filter(|r| (40..=99).contains(r) && t.len() == 2))
    });
    let (qx, qy) = frame.ref_to_px(cx - 60.0, cy + 53.0);
    let position = passes.iter().find_map(|(f, t)| {
        let text = frame.ocr_region_ink(engine, qx, qy, 30.0 * s, 13.0 * s, *f, *t, true).ok()?;
        Some(text.trim().to_uppercase()).filter(|p| POSITIONS.contains(&p.as_str()))
    });
    let marker_score = frame.triangle_score(cx, cy);
    let flag = frame.flag_signature(cx, cy);
    Ok(Some(GridCard {
        slot: row * GRID_COLS + col,
        points: readings.first().copied(),
        readings,
        rating,
        position,
        first_owner: marker_score >= TRIANGLE_THRESHOLD,
        marker_score,
        flag,
    }))
}

/// What is on screen in FC27's Gallery.
#[derive(Debug, Clone)]
pub enum Page {
    /// The Gallery's Auto-Complete question ("Existing players will be automatically replaced by
    /// alternatives with better Gallery scores. Continue?") – it fills by points, not first owner.
    AutoComplete,
    /// A set page: the selected lineup (no names) + the in-game score panel.
    Set { title: String, total: Option<u32>, base: Option<u32>, bonus: Option<u32>, cards: Vec<GridCard> },
    /// The Swap Player selector: unselected collected cards of the set, with names, and the
    /// game's own preview of the highlighted swap (when a lineup slot is being replaced).
    Swap { title: String, cards: Vec<ScannedCard>, preview: Option<SwapPreview> },
    /// A set page with swaps not confirmed yet ("Confirm Changes"): not the real lineup.
    /// A set page with swaps made but not confirmed (`Confirm Changes`, e.g. right after in-game
    /// Optimize). `set`: the selection on screen, read like a set page – when readable.
    Pending { title: String, set: Option<Box<Page>> },
    /// A category page (Rarities, Leagues, a club category): every set as a tile with its
    /// in-game score or, for incomplete sets, "filled/slots".
    SetList { tiles: Vec<ListTile> },
    /// Gallery → Summary: level, total score and item counts.
    Summary(GallerySummary),
    /// Player cards on a screen outside the Gallery (pack opening, Unassigned, club lists):
    /// `context` is "pack" | "unassigned" | "other".
    Cards { context: &'static str, cards: Vec<ScannedCard> },
    /// Transfer market "Bidding Options" for one card: the card about to be bought and its Buy
    /// Now price.
    Bidding { card: ScannedCard, price: Option<u32> },
    /// "Your transfer market acquisition was successful…" – the card from Bidding was bought.
    BuySuccess,
    /// "Do you want to get this item for 700 FUT Coins?" – buying from a club/squad search.
    BuyConfirm { price: Option<u32> },
    /// The actions wheel of a card the user owns (Quick Sell, Send to My Club …): its name from
    /// the header ("Ross Barkley") and its Gallery points ("◆ 120"). After a purchase it shows
    /// the bought card.
    OwnedActions { name: String, points: Option<u32> },
    Other,
}

/// The coin balance: top right on Ultimate Team screens ("258,659"), or the "My Coins" row of
/// the transfer panel in a club/squad search.
pub fn read_coins(frame: &Frame) -> Option<u32> {
    let s = frame.scale();
    if let Some(label) = frame.words.windows(2).find(|w| w[0].text == "My" && w[1].text == "Coins").map(|w| w[1].clone()) {
        let on_row = frame
            .words
            .iter()
            .filter(|w| (w.y - label.y).abs() < 14.0 * s && w.x > label.x && w.text.contains(','))
            .find_map(|w| digits(&w.text));
        if on_row.is_some() {
            return on_row;
        }
    }
    frame
        .words
        .iter()
        .filter(|w| w.y < 220.0 * s && w.x > frame.width as f32 * 0.7 && w.text.contains(','))
        .filter_map(|w| digits(&w.text).map(|d| (w.x, d)))
        .filter(|(_, d)| *d >= 100)
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, d)| d)
}

/// The card on the left of "Bidding Options": name on the line above the stat header (PAC SHO …),
/// rating and position at the card's top-left.
fn read_bidding_card(frame: &Frame) -> Option<ScannedCard> {
    let s = frame.scale();
    let pac = frame.words.iter().filter(|w| w.text == "PAC" || w.text == "DIV").min_by(|a, b| a.x.total_cmp(&b.x))?;
    let mut name_words: Vec<&Word> = frame
        .words
        .iter()
        .filter(|w| w.y < pac.y - 12.0 * s && w.y > pac.y - 60.0 * s && w.x > pac.x - 90.0 * s && w.x < pac.x + 320.0 * s)
        .filter(|w| w.text.chars().filter(|c| c.is_alphabetic()).count() >= 2)
        .collect();
    name_words.sort_by(|a, b| a.x.total_cmp(&b.x));
    let name = name_words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
    if name.chars().filter(|c| c.is_alphabetic()).count() < 3 {
        return None;
    }
    let rating_word = frame
        .words
        .iter()
        .filter(|w| w.y < pac.y - 120.0 * s && w.y > pac.y - 330.0 * s && (w.x - pac.x).abs() < 80.0 * s)
        .filter(|w| w.text.len() == 2 && digits(&w.text).is_some_and(|d| (40..=99).contains(&d)))
        .min_by(|a, b| a.y.total_cmp(&b.y));
    let rating = rating_word.and_then(|w| digits(&w.text));
    let position = rating_word.and_then(|r| {
        frame
            .words
            .iter()
            .filter(|w| w.y > r.y && w.y < r.y + 70.0 * s && (w.x - r.x).abs() < 60.0 * s)
            .find(|w| POSITIONS.contains(&w.text.as_str()))
            .map(|w| w.text.clone())
    });
    Some(ScannedCard { name, rating, position, points: None, first_owner: false, marker_score: 0, flag: None })
}

/// "… get this item for 700 FUT Coins?": the price before "FUT".
fn read_confirm_price(frame: &Frame) -> Option<u32> {
    frame.words.windows(2).find(|w| w[1].text == "FUT").and_then(|w| digits(&w[0].text))
}

/// The owned card's actions wheel: the header name (top left, large) and its Gallery points
/// (the gem number below the positions).
fn read_owned_actions(frame: &Frame) -> Option<(String, Option<u32>)> {
    let s = frame.scale();
    let left = frame.width as f32 * 0.3;
    let mut head: Vec<&Word> = frame
        .words
        .iter()
        .filter(|w| w.x < left && w.y < 260.0 * s && w.h >= 24.0 * s && w.text.chars().any(|c| c.is_alphabetic()))
        .collect();
    let top = head.iter().map(|w| w.y).fold(f32::MAX, f32::min);
    head.retain(|w| (w.y - top).abs() < 16.0 * s);
    head.sort_by(|a, b| a.x.total_cmp(&b.x));
    let name = head.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
    if name.chars().filter(|c| c.is_alphabetic()).count() < 3 {
        return None;
    }
    let points = frame
        .words
        .iter()
        .filter(|w| w.x < left && w.y > top + 80.0 * s && w.y < top + 190.0 * s)
        .find_map(|w| digits(&w.text));
    Some((name, points))
}

/// The Buy Now price on the Bidding Options panel (the number on the "Buy Now" row).
fn read_buy_now_price(frame: &Frame) -> Option<u32> {
    let s = frame.scale();
    let now = frame
        .words
        .windows(2)
        .find(|w| w[0].text == "Buy" && w[1].text == "Now")
        .map(|w| w[1].clone())?;
    frame
        .words
        .iter()
        .filter(|w| (w.y - now.y).abs() < 14.0 * s && w.x > now.x + 100.0 * s)
        .filter_map(|w| digits(&w.text))
        .next()
}

/// The left panel of the Swap screen: the card going out, the highlighted card coming in and
/// the game's score after that swap with the change ("95,595 (-14,967)").
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
pub struct SwapPreview {
    pub out_points: Option<u32>,
    pub out_rating: Option<u32>,
    pub out_position: Option<String>,
    pub in_points: Option<u32>,
    pub in_rating: Option<u32>,
    pub in_position: Option<String>,
    pub total: u32,
    pub total_delta: i64,
    pub base: Option<u32>,
    pub base_delta: i64,
    pub bonus: Option<u32>,
    pub bonus_delta: i64,
}

/// "(-14,967)" / "(+550)" / "(−420)" → signed value.
fn parse_delta(text: &str) -> Option<i64> {
    let t = text.trim_matches(|c| c == '(' || c == ')');
    let negative = t.starts_with('-') || t.starts_with('\u{2212}');
    let digits: String = t.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || !(text.starts_with('(') || text.ends_with(')')) {
        return None;
    }
    let v: i64 = digits.parse().ok()?;
    Some(if negative { -v } else { v })
}

#[derive(Debug, Clone, PartialEq)]
pub struct ListTile {
    pub title: String,
    pub score: Option<u32>,
    /// (cards in the set, slots) for sets that are not complete yet.
    pub filled: Option<(u32, u32)>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GallerySummary {
    pub level: Option<u32>,
    pub score: Option<u64>,
    /// (done, total) for categories, sets and S ranks.
    pub categories: Option<(u32, u32)>,
    pub sets: Option<(u32, u32)>,
    pub s_ranks: Option<(u32, u32)>,
    pub items: Option<u32>,
    pub holographic: Option<u32>,
    pub first_owner: Option<u32>,
}

/// "12,345" / "12.345" / "12 345" (split by OCR) → 12345.
fn parse_number(words: &[&Word]) -> Option<u32> {
    let text: String = words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join("");
    let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
    let ok = !digits.is_empty() && text.chars().all(|c| c.is_ascii_digit() || matches!(c, ',' | '.'));
    ok.then(|| digits.parse().ok()).flatten()
}

fn parse_fraction(text: &str) -> Option<(u32, u32)> {
    let (a, b) = text.split_once('/')?;
    let n = |s: &str| s.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse::<u32>().ok();
    let (a, b) = (n(a)?, n(b)?);
    (a <= b && b > 0).then_some((a, b))
}

impl Frame {
    /// Words on the same text line as `w` and right of it, close enough to be one number
    /// ("2 335" read as two words).
    fn number_from(&self, w: &Word) -> Option<u32> {
        let mut parts: Vec<&Word> = vec![w];
        let mut right = w.x + w.w;
        loop {
            let next = self.words.iter().filter(|o| {
                (o.y - w.y).abs() < w.h * 0.5 && o.x > right - 2.0 && o.x - right < w.h * 0.8
                    && o.text.chars().all(|c| c.is_ascii_digit() || matches!(c, ',' | '.'))
            }).min_by(|a, b| a.x.total_cmp(&b.x));
            match next {
                Some(n) => {
                    right = n.x + n.w;
                    parts.push(n);
                }
                None => break,
            }
        }
        parse_number(&parts)
    }

    /// Category page tiles: a value line (score or "filled/slots") with the set name above it.
    fn read_set_list(&self) -> Vec<ListTile> {
        let (w, h) = (self.width as f32, self.height as f32);
        let mut tiles = Vec::new();
        for v in &self.words {
            // Tile area: left 75 % (the right panel repeats the selected set), between the
            // heading and the footer.
            let (cx, cy) = (v.x + v.w / 2.0, v.y + v.h / 2.0);
            if cx > w * 0.75 || cy < h * 0.2 || cy > h * 0.88 {
                continue;
            }
            // Only the first word of a split number starts a value.
            let starts_value = v.text.chars().next().is_some_and(|c| c.is_ascii_digit())
                && !self.words.iter().any(|o| {
                    (o.y - v.y).abs() < v.h * 0.5 && o.x < v.x && v.x - (o.x + o.w) < v.h * 0.8
                        && o.text.chars().all(|c| c.is_ascii_digit() || matches!(c, ',' | '.'))
                });
            if !starts_value {
                continue;
            }
            let (score, filled) = match parse_fraction(&v.text) {
                Some(f) => (None, Some(f)),
                None => match self.number_from(v).filter(|n| *n >= 10) {
                    Some(n) => (Some(n), None),
                    None => continue,
                },
            };
            // The set name: words above the value inside the same tile.
            let mut name: Vec<&Word> = self
                .words
                .iter()
                .filter(|o| {
                    o.y < v.y - v.h * 0.5
                        && o.y > v.y - h * 0.085
                        && o.x > v.x - w * 0.012
                        && o.x < v.x + w * 0.13
                        && o.text.chars().any(|c| c.is_alphabetic())
                })
                .collect();
            name.sort_by(|a, b| (a.y as i32 / 8, a.x as i32).cmp(&(b.y as i32 / 8, b.x as i32)));
            let title = name.iter().map(|o| o.text.as_str()).collect::<Vec<_>>().join(" ");
            if !title.is_empty() {
                tiles.push(ListTile { title, score, filled });
            }
        }
        tiles
    }

    /// A label row on the swap screen's left panel ("Base Grade 70,331 (-420)"): value + delta.
    fn preview_row(&self, label: &str) -> Option<(u32, i64)> {
        let w = self.width as f32;
        let l = self.words.iter().find(|o| o.text == label && o.x < w * 0.25)?;
        let line: Vec<&Word> = self.words.iter().filter(|o| (o.y - l.y).abs() < l.h * 0.8 && o.x > l.x && o.x < w * 0.32).collect();
        let value = line.iter().filter(|o| !o.text.starts_with('(')).find_map(|o| self.number_from(o))?;
        let delta = line.iter().find_map(|o| parse_delta(&o.text)).unwrap_or(0);
        Some((value, delta))
    }

    /// Rating and position printed on a small card ("84" above "CM").
    fn mini_card(&self, engine: &OcrEngine, cx: f32, cy: f32) -> (Option<u32>, Option<String>) {
        let (_, _, s) = self.content_box();
        let (x, y) = self.ref_to_px(cx - 20.0, cy - 30.0);
        let text = self.ocr_region_with(engine, x, y, 40.0 * s, 60.0 * s, 3, None).unwrap_or_default();
        let mut rating = None;
        let mut position = None;
        for t in text.split_whitespace() {
            if rating.is_none() {
                rating = digits(t).filter(|r| (40..=99).contains(r));
            } else if position.is_none() && t.len() <= 3 && t.chars().all(|c| c.is_ascii_uppercase()) {
                position = Some(t.to_string());
            }
        }
        (rating, position)
    }

    /// The game's preview of the highlighted swap, when the left panel shows one.
    pub fn read_swap_preview(&self) -> Option<SwapPreview> {
        let w = self.width as f32;
        let total_label = self.words.iter().find(|o| o.text == "Total" && o.x < w * 0.25)?;
        // The total line sits right below "Total Score".
        let line: Vec<&Word> = self
            .words
            .iter()
            .filter(|o| o.y > total_label.y + total_label.h * 0.6 && o.y < total_label.y + total_label.h * 4.0 && o.x < w * 0.25)
            .collect();
        let total = line.iter().filter(|o| o.text.contains(',')).find_map(|o| self.number_from(o))?;
        let total_delta = line.iter().find_map(|o| parse_delta(&o.text))?;
        let base = self.preview_row("Base");
        let bonus = self.preview_row("Bonus");
        let engine = ocr_engine().ok()?;
        let (_, _, s) = self.content_box();
        // Points chips above the two small cards (measured on the user's 2880×1800 recording).
        let chip = |cx: f32| {
            let (px, py) = self.ref_to_px(cx - 40.0, 340.0);
            read_chip(self, &engine, px, py, 80.0 * s, 26.0 * s).ok().and_then(|r| r.first().copied())
        };
        let (out_rating, out_position) = self.mini_card(&engine, 205.0, 415.0);
        let (in_rating, in_position) = self.mini_card(&engine, 444.0, 415.0);
        Some(SwapPreview {
            out_points: chip(250.0),
            out_rating,
            out_position,
            in_points: chip(489.0),
            in_rating,
            in_position,
            total,
            total_delta,
            base: base.map(|b| b.0),
            base_delta: base.map_or(0, |b| b.1),
            bonus: bonus.map(|b| b.0),
            bonus_delta: bonus.map_or(0, |b| b.1),
        })
    }

    fn read_summary(&self) -> GallerySummary {
        let h = self.height as f32;
        // The value of a label row: the right-most number / fraction on the same line.
        let row = |label: &str| -> Option<&Word> {
            let l = self.words.iter().find(|w| w.text == label)?;
            self.words
                .iter()
                .filter(|o| (o.y - l.y).abs() < l.h * 0.7 && o.x > l.x + l.w && o.text.chars().any(|c| c.is_ascii_digit()))
                .max_by(|a, b| a.x.total_cmp(&b.x))
        };
        // The big "Gallery Level N" block (not the small one in the top-right corner): the
        // "Level" word with the total score right below it.
        let below = |l: &Word| {
            self.words
                .iter()
                .filter(|o| o.y > l.y + l.h * 0.5 && o.y < l.y + h * 0.08 && o.text.contains(','))
                .find_map(|o| self.number_from(o))
        };
        let level_at = self.words.iter().position(|w| w.text == "Level" && below(w).is_some());
        let level = level_at.and_then(|i| self.words.get(i + 1)).and_then(|w| digits(&w.text));
        let score = level_at.and_then(|i| below(&self.words[i])).map(u64::from);
        GallerySummary {
            level,
            score,
            categories: row("Categories").and_then(|w| parse_fraction(&w.text)),
            sets: row("Sets").and_then(|w| parse_fraction(&w.text)),
            s_ranks: row("Ranks").and_then(|w| parse_fraction(&w.text)),
            items: row("Items").and_then(|w| digits(&w.text)),
            holographic: row("Holographic").and_then(|w| digits(&w.text)),
            first_owner: row("Owner").and_then(|w| digits(&w.text)),
        }
    }
}

impl Frame {
    /// Words whose centre lies in a reference-coords rectangle, left to right.
    fn words_in_ref(&self, x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<&Word> {
        let (a, b) = self.ref_to_px(x0, y0);
        let (c, d) = self.ref_to_px(x1, y1);
        let mut words: Vec<&Word> = self
            .words
            .iter()
            .filter(|w| {
                let (cx, cy) = (w.x + w.w / 2.0, w.y + w.h / 2.0);
                (a..=c).contains(&cx) && (b..=d).contains(&cy)
            })
            .collect();
        words.sort_by(|p, q| p.x.total_cmp(&q.x));
        words
    }

    /// A set title: the words in the region minus the small set-number box ("1", "18", …).
    fn title_in_ref(&self, x0: f32, y0: f32, x1: f32, y1: f32) -> String {
        self.words_in_ref(x0, y0, x1, y1)
            .iter()
            .filter(|w| w.text.chars().any(|c| c.is_alphabetic()))
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn number_in_ref(&self, x0: f32, y0: f32, x1: f32, y1: f32) -> Option<u32> {
        self.words_in_ref(x0, y0, x1, y1).iter().find_map(|w| digits(&w.text))
    }

    pub(crate) fn has_word(&self, text: &str) -> bool {
        self.words.iter().any(|w| w.text == text)
    }
}

/// The Gallery set on screen, from its title only (no card reading – ~0 ms after the OCR):
/// set page, incomplete set, pending changes or Swap Player. For "open the overlay / list on the
/// set I am on" right after the user switched sets with L1/R1.
pub fn gallery_title(frame: &Frame) -> Option<String> {
    if !frame.has_word("Gallery") {
        return None;
    }
    let title = if frame.has_word("Swap") && !read_swap_page(frame).is_empty() {
        frame.title_in_ref(120.0, 205.0, 650.0, 275.0)
    } else if (frame.has_word("Base") && frame.has_word("Grade")) || frame.has_word("Complete") || frame.has_word("Confirm") {
        frame.title_in_ref(1400.0, 195.0, 1920.0, 265.0)
    } else {
        return None;
    };
    (!title.is_empty()).then_some(title)
}

/// Classifies the frame and reads what the page offers. Regions are in 2000×1125 reference
/// coords (measured on the user's own 16:10 screenshots).
/// Words of our own overlay / launcher / side panel never take part in reading the game (a
/// screen copy or a recording can contain them: "Gallery", "Swap", "View", "Squad Foundations"
/// made New Items look like a swap page or a category page). Found by the "FC-TRACKER" brand.
fn without_own_ui(frame: &Frame) -> Option<Frame> {
    let s = frame.scale();
    let (ox, oy) = frame
        .words
        .iter()
        .find(|w| {
            let n = normalise_name(&w.text);
            n.len() >= 7 && edit_distance(&n, "fctracker") <= 2
        })
        .map(|w| (w.x - 60.0 * s, w.y - 40.0 * s))?;
    let words = if ox < frame.width as f32 * 0.15 {
        Vec::new() // the full overlay or the launcher covers the game
    } else {
        // the side panel: everything right of / below its brand
        frame.words.iter().filter(|w| !(w.x + w.w > ox && w.y + w.h > oy)).cloned().collect()
    };
    Some(Frame { width: frame.width, height: frame.height, bgra: Vec::new(), words })
}

pub fn analyse_page(frame: &Frame) -> Result<Page, String> {
    if let Some(clean) = without_own_ui(frame) {
        // our UI's words removed; pixels are still read from the original frame
        let mut f = Frame { bgra: frame.bgra.clone(), ..clean };
        f.words.shrink_to_fit();
        return analyse_page_inner(&f);
    }
    analyse_page_inner(frame)
}

fn analyse_page_inner(frame: &Frame) -> Result<Page, String> {
    if frame.has_word("automatically") && frame.has_word("replaced") && frame.has_word("Gallery") {
        return Ok(Page::AutoComplete);
    }
    let swap_cards = read_swap_page(frame);
    // Swap selector (inside the Gallery: "Club · Gallery · <set>" on top) – any number of collected
    // cards (Heroes had 2). Other screens with player cards and a "Swap" word (duplicates after a
    // pack) are not Gallery swap pages.
    if !swap_cards.is_empty() && frame.has_word("Swap") && frame.has_word("Gallery") {
        let title = frame.title_in_ref(120.0, 205.0, 650.0, 275.0);
        let preview = frame.read_swap_preview();
        return Ok(Page::Swap { title, cards: swap_cards, preview });
    }
    // "New Items" (after a pack is fully open, a purchase or a reward): the only screen where
    // acquisitions are read. Its breadcrumb tells where they came from – "FUT Hub > TRANSFER
    // SEARCH > LIVE SEARCH RESULTS > New Items" = bought, anything else (Store, SBC, objectives)
    // = packed / reward. Club, Transfer List, Squad etc. are never counted (user rule).
    // Transfer market: "Bidding Options" for one card, then the purchase confirmation.
    if frame.has_word("Bidding") && frame.has_word("Options") {
        if let Some(card) = read_bidding_card(frame) {
            return Ok(Page::Bidding { card, price: read_buy_now_price(frame) });
        }
    }
    if frame.has_word("acquisition") && frame.words.iter().any(|w| w.text.starts_with("successful")) {
        return Ok(Page::BuySuccess);
    }
    // Club / squad search: the transfer panel for one card ("My Coins", "Start Price", "Buy
    // Now Price"), the "get this item for … FUT Coins?" question, then the owned card's wheel.
    if frame.has_word("Start") && frame.words.windows(2).any(|w| w[0].text == "My" && w[1].text == "Coins") {
        if let Some(card) = read_bidding_card(frame) {
            return Ok(Page::Bidding { card, price: read_buy_now_price(frame) });
        }
    }
    if frame.has_word("item") && frame.has_word("FUT") && frame.words.iter().any(|w| w.text.starts_with("Coins")) && frame.has_word("get") {
        return Ok(Page::BuyConfirm { price: read_confirm_price(frame) });
    }
    let new_items_screen = frame.has_word("New") && frame.has_word("Items") && frame.has_word("Keep");
    if !new_items_screen
        && frame.words.windows(2).any(|w| w[0].text == "Quick" && w[1].text == "Sell")
        && (frame.has_word("Squad") || frame.words.windows(2).any(|w| w[0].text == "My" && w[1].text == "Club"))
    {
        if let Some((name, points)) = read_owned_actions(frame) {
            return Ok(Page::OwnedActions { name, points });
        }
    }
    if !swap_cards.is_empty() && !frame.has_word("Gallery") {
        let has = |w: &str| frame.has_word(w);
        let new_items = has("New") && has("Items") && (has("Keep") || has("Quick"));
        let context = if !new_items {
            "other"
        } else if has("TRANSFER") || has("SEARCH") || has("LIVE") {
            "bought"
        } else {
            "pack"
        };
        return Ok(Page::Cards { context, cards: swap_cards });
    }
    // Swaps made but not confirmed: the set page shows a lineup that isn't the real one yet.
    // It is read anyway: right after in-game Optimize is when a better selection matters most.
    if frame.has_word("Confirm") && frame.has_word("Changes") && (frame.has_word("Grade") || frame.has_word("Complete")) {
        let title = frame.title_in_ref(1400.0, 195.0, 1920.0, 265.0);
        let total = frame.number_in_ref(1480.0, 620.0, 1860.0, 690.0);
        let base = frame.number_in_ref(1650.0, 760.0, 1920.0, 790.0);
        // a graded set: with its score panel; a set not complete yet: no panel, the cards still count
        let incomplete = frame.has_word("Complete") && !frame.has_word("Base");
        let cards = if (total.is_some() && base.is_some()) || incomplete { read_set_grid(frame).unwrap_or_default() } else { Vec::new() };
        let set = (!cards.is_empty()).then(|| {
            Box::new(Page::Set { title: title.clone(), total, base, bonus: frame.number_in_ref(1650.0, 791.0, 1920.0, 822.0), cards })
        });
        return Ok(Page::Pending { title, set });
    }
    // Set page: the right-hand score panel ("Total Score", "Base Grade") and grid chips.
    // Both numbers must be readable, otherwise it is not a Gallery set page (e.g. a text editor
    // that happens to show the words "Base Grade").
    if frame.has_word("Base") && frame.has_word("Grade") {
        let total = frame.number_in_ref(1480.0, 620.0, 1860.0, 690.0);
        let base = frame.number_in_ref(1650.0, 760.0, 1920.0, 790.0);
        if total.is_some() && base.is_some() {
            let cards = read_set_grid(frame)?;
            if !cards.is_empty() {
                return Ok(Page::Set {
                    title: frame.title_in_ref(1400.0, 195.0, 1920.0, 265.0),
                    total,
                    base,
                    bonus: frame.number_in_ref(1650.0, 791.0, 1920.0, 822.0),
                    cards,
                });
            }
        }
    }
    // A set that isn't complete yet ("10/20", "Complete Set", "Grade Set"): no score panel, but
    // the cards placed so far and their first-owner marks are there.
    if frame.has_word("Complete") && frame.has_word("Set") && frame.has_word("Gallery") && !frame.has_word("Base") {
        let cards = read_set_grid(frame)?;
        if !cards.is_empty() {
            return Ok(Page::Set { title: frame.title_in_ref(1400.0, 195.0, 1920.0, 265.0), total: None, base: None, bonus: None, cards });
        }
    }
    // Gallery → Summary.
    if frame.has_word("Items") && frame.has_word("Holographic") && frame.has_word("Owner") {
        return Ok(Page::Summary(frame.read_summary()));
    }
    // Category page: tiles + the "View Set" button / "Sort by Score", under the Gallery header
    // (without it, any text with "View" and numbers – an editor, a browser – looked like one).
    if frame.has_word("Gallery") && (frame.has_word("View") || (frame.has_word("Sort") && frame.has_word("Score"))) {
        let tiles = frame.read_set_list();
        if tiles.len() >= 2 {
            return Ok(Page::SetList { tiles });
        }
    }
    Ok(Page::Other)
}


/// Captures the primary monitor and runs OCR on it (live tests).
#[cfg(test)]
pub fn capture_primary_screen() -> Result<Frame, String> {
    let (w, h, pixels) = capture_pixels()?;
    frame_from_pixels(w, h, pixels)
}

/// OCRs raw BGRA pixels into a Frame.
pub fn frame_from_pixels(w: u32, h: u32, pixels: Vec<u8>) -> Result<Frame, String> {
    let bitmap = bitmap_from_bgra(&pixels, w, h)?;
    let words = ocr(&ocr_engine()?, &bitmap)?;
    Ok(Frame { width: w, height: h, bgra: pixels, words })
}

/// Half resolution (2×2 box filter) – enough for big menu words, ~4× cheaper to OCR.
/// Box-filtered copy at `width` (keeps the aspect ratio). Test only: whole-frame OCR on a smaller
/// copy lost card names and was not faster (measured 2026-10-17, see DESIGN).
#[cfg(test)]
fn resize_to_width(w: u32, h: u32, px: &[u8], width: u32) -> (u32, u32, Vec<u8>) {
    if width >= w {
        return (w, h, px.to_vec());
    }
    let height = (h as u64 * width as u64 / w as u64) as u32;
    let mut out = vec![0u8; (width * height * 4) as usize];
    for y in 0..height {
        let (y0, y1) = (y * h / height, ((y + 1) * h / height).max(y * h / height + 1));
        for x in 0..width {
            let (x0, x1) = (x * w / width, ((x + 1) * w / width).max(x * w / width + 1));
            let mut acc = [0u32; 4];
            let mut n = 0u32;
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = ((sy * w + sx) * 4) as usize;
                    for c in 0..4 {
                        acc[c] += px[i + c] as u32;
                    }
                    n += 1;
                }
            }
            let o = ((y * width + x) * 4) as usize;
            for c in 0..4 {
                out[o + c] = (acc[c] / n.max(1)) as u8;
            }
        }
    }
    (width, height, out)
}

pub fn downscale2(w: u32, h: u32, px: &[u8]) -> (u32, u32, Vec<u8>) {
    let (w2, h2) = (w / 2, h / 2);
    let mut out = vec![0u8; (w2 * h2 * 4) as usize];
    for y in 0..h2 {
        for x in 0..w2 {
            for c in 0..4 {
                let at = |xx: u32, yy: u32| px[((yy * w + xx) * 4 + c) as usize] as u32;
                let v = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) / 4;
                out[((y * w2 + x) * 4 + c) as usize] = v as u8;
            }
        }
    }
    (w2, h2, out)
}

/// The game's picture (no OCR). Normally a window capture of FC27 itself (wgc.rs): it holds the
/// game's content only, so our overlay, list and toast never have to be hidden for a read – the
/// user's own recordings and screenshots don't flicker. Without the game window, or if that
/// capture fails, a GDI copy of the screen with our windows hidden for the moment of the copy.
/// Neither touches the game process.
pub fn capture_pixels() -> Result<(u32, u32, Vec<u8>), String> {
    // From the running continuous capture when there is one (no new session per read).
    if let Some(Ok(picture)) = crate::watch::full_frame(std::time::Duration::from_millis(400)) {
        *LAST_SOURCE.lock().unwrap() = "running capture";
        return Ok(picture);
    }
    if steady() {
        // a recorder runs: no new capture session and no hiding our windows – the screen copy as
        // it is (our UI's words are ignored by the page reader)
        *LAST_SOURCE.lock().unwrap() = "screen copy (recording)";
        return capture_pixels_raw();
    }
    if let Some(hwnd) = game_window() {
        match crate::wgc::capture_window(hwnd) {
            Ok(picture) => {
                *LAST_SOURCE.lock().unwrap() = "one-frame window capture";
                return Ok(picture);
            }
            Err(e) => note_capture_fallback(&e),
        }
    }
    *LAST_SOURCE.lock().unwrap() = "screen copy";
    while_own_windows_hidden(capture_pixels_raw)
}

/// The game window's own picture only (never the screen copy) – for reads while another
/// program is in front of the game.
pub fn capture_pixels_game() -> Result<(u32, u32, Vec<u8>), String> {
    if let Some(Ok(picture)) = crate::watch::full_frame(std::time::Duration::from_millis(400)) {
        *LAST_SOURCE.lock().unwrap() = "running capture";
        return Ok(picture);
    }
    if steady() {
        return Err("recording_steady".into());
    }
    *LAST_SOURCE.lock().unwrap() = "one-frame window capture";
    crate::wgc::capture_window(game_window().ok_or("no_game_window")?)
}

/// The first failed window capture is written to stderr (once); reads continue via GDI.
fn note_capture_fallback(e: &str) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| eprintln!("window capture unavailable, using the screen copy: {e}"));
}

fn capture_pixels_raw() -> Result<(u32, u32, Vec<u8>), String> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
    };
    use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    // SAFETY: plain GDI calls on handles created and released within this function.
    let bgra = unsafe {
        // Physical pixels, not the scaled size Windows reports with 150–175 % display scaling.
        let previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let (w, h) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        let blit = BitBlt(mem, 0, 0, w, h, Some(screen), 0, 0, SRCCOPY);

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(mem, bmp, 0, h as u32, Some(pixels.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);

        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        SetThreadDpiAwarenessContext(previous);
        if blit.is_err() || lines == 0 {
            return Err("scan_capture_failed".into());
        }
        for px in pixels.chunks_exact_mut(4) {
            px[3] = 255; // GDI leaves alpha at 0
        }
        (w as u32, h as u32, pixels)
    };
    Ok(bgra)
}

/// The 64×36 page signature straight from the screen: GDI scales the 16:9 content box down
/// (HALFTONE = area average) into a tiny bitmap, so watching for page changes costs almost
/// nothing and can run several times a second. 64 × 36 cells, row-major, luminance.
/// Our windows are not hidden for it (no flicker): the cells they cover are blanked instead, so
/// our own UI changing never looks like a new game page.
pub fn capture_signature() -> Result<Vec<u8>, String> {
    capture_signature_raw()
}

/// The same 64×36 signature, from the game window itself (WGC – works when Windows presents the
/// borderless game like fullscreen and the GDI screen copy is black or frozen). Heavier: a full
/// frame per call, so only used when GDI can't be trusted.
pub fn capture_signature_game() -> Result<Vec<u8>, String> {
    if steady() {
        return Err("recording_steady".into());
    }
    let hwnd = game_window().ok_or("game_window_missing")?;
    let (w, h, px) = crate::wgc::capture_window(hwnd)?;
    Ok(signature_from_pixels(w, h, &px))
}

/// BGRA pixels → the 64×36 luminance signature (16:9 centre crop, box average) of `capture_signature`.
pub fn signature_from_pixels(w: u32, h: u32, px: &[u8]) -> Vec<u8> {
    const SW: u32 = 64;
    const SH: u32 = 36;
    let (cw, ch) = if w * 9 > h * 16 { (h * 16 / 9, h) } else { (w, w * 9 / 16) };
    let (ox, oy) = ((w - cw) / 2, (h - ch) / 2);
    let mut sig = Vec::with_capacity((SW * SH) as usize);
    for sy in 0..SH {
        for sx in 0..SW {
            let (x0, x1) = (ox + sx * cw / SW, ox + (sx + 1) * cw / SW);
            let (y0, y1) = (oy + sy * ch / SH, oy + (sy + 1) * ch / SH);
            // every 4th pixel each way is plenty for an average
            let (mut sum, mut n) = (0u64, 0u64);
            let mut y = y0;
            while y < y1.max(y0 + 1) {
                let mut x = x0;
                while x < x1.max(x0 + 1) {
                    let i = ((y * w + x) * 4) as usize;
                    if i + 2 < px.len() {
                        sum += (px[i] as u64 * 114 + px[i + 1] as u64 * 587 + px[i + 2] as u64 * 299) / 1000;
                        n += 1;
                    }
                    x += 4;
                }
                y += 4;
            }
            sig.push((sum / n.max(1)) as u8);
        }
    }
    sig
}

/// A signature that is (almost) all black: the GDI copy of a game shown by independent flip.
pub fn signature_is_black(sig: &[u8]) -> bool {
    !sig.is_empty() && sig.iter().filter(|&&v| v > 12).count() * 100 / sig.len() < 2
}

/// % of cells that differ between two signatures, ignoring cells masked to 0 in `gdi` (our windows).
pub fn signature_disagreement(gdi: &[u8], game: &[u8]) -> u32 {
    if gdi.len() != game.len() || gdi.is_empty() {
        return 100;
    }
    let pairs: Vec<(u8, u8)> = gdi.iter().zip(game).filter(|(g, _)| **g != 0).map(|(a, b)| (*a, *b)).collect();
    if pairs.is_empty() {
        return 0;
    }
    (pairs.iter().filter(|(a, b)| (*a as i32 - *b as i32).abs() > 40).count() * 100 / pairs.len()) as u32
}

fn capture_signature_raw() -> Result<Vec<u8>, String> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
        SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HALFTONE, SRCCOPY,
    };
    use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    const SW: i32 = 64;
    const SH: i32 = 36;
    // SAFETY: plain GDI calls on handles created and released within this function.
    unsafe {
        let previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let (w, h) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
        let (cw, ch) = if w * 9 > h * 16 { (h * 16 / 9, h) } else { (w, w * 9 / 16) };
        let (ox, oy) = ((w - cw) / 2, (h - ch) / 2);
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, SW, SH);
        let old = SelectObject(mem, bmp.into());
        SetStretchBltMode(mem, HALFTONE);
        let ok = StretchBlt(mem, 0, 0, SW, SH, Some(screen), ox, oy, cw, ch, SRCCOPY).as_bool();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: SW,
                biHeight: -SH,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut px = vec![0u8; (SW * SH * 4) as usize];
        let lines = GetDIBits(mem, bmp, 0, SH as u32, Some(px.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        // our visible windows, in the same physical pixels as the copy (DPI context still set)
        let ours = own_window_rects();
        SetThreadDpiAwarenessContext(previous);
        if !ok || lines == 0 {
            return Err("scan_capture_failed".into());
        }
        let mut sig: Vec<u8> = px
            .chunks_exact(4)
            .map(|p| ((p[0] as u32 * 114 + p[1] as u32 * 587 + p[2] as u32 * 299) / 1000) as u8)
            .collect();
        for r in ours {
            let cx0 = ((r.left - ox) * SW / cw).clamp(0, SW);
            let cx1 = ((r.right - ox) * SW + cw - 1).div_euclid(cw).clamp(0, SW);
            let cy0 = ((r.top - oy) * SH / ch).clamp(0, SH);
            let cy1 = ((r.bottom - oy) * SH + ch - 1).div_euclid(ch).clamp(0, SH);
            for y in cy0..cy1 {
                for x in cx0..cx1 {
                    sig[(y * SW + x) as usize] = 0;
                }
            }
        }
        Ok(sig)
    }
}

/// This process: CPU time used so far (ms, all threads) and working set (MB). For the resource
/// log; the WebView2 renderer processes of our windows are separate and not included.
pub fn own_usage() -> (u64, u64) {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    // SAFETY: queries about our own process into local structs.
    unsafe {
        let p = GetCurrentProcess();
        let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        let cpu = if GetProcessTimes(p, &mut c, &mut e, &mut k, &mut u).is_ok() {
            let t = |f: FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
            (t(k) + t(u)) / 10_000
        } else {
            0
        };
        let mut m = PROCESS_MEMORY_COUNTERS { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32, ..Default::default() };
        let ram = if K32GetProcessMemoryInfo(p, &mut m, m.cb).as_bool() { m.WorkingSetSize as u64 / (1024 * 1024) } else { 0 };
        (cpu, ram)
    }
}

/// Our windows (overlay, missing list, toast, launcher), registered at startup.
static OWN_WINDOWS: std::sync::Mutex<Vec<isize>> = std::sync::Mutex::new(Vec::new());

pub fn register_own_window(hwnd: isize) {
    OWN_WINDOWS.lock().unwrap().push(hwnd);
}

/// Screen rectangles of our visible windows (physical pixels under the caller's DPI context).
fn own_window_rects() -> Vec<windows::Win32::Foundation::RECT> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsWindowVisible};
    OWN_WINDOWS
        .lock()
        .unwrap()
        .iter()
        .filter_map(|&w| {
            let hwnd = HWND(w as *mut _);
            let mut r = RECT::default();
            // SAFETY: read-only queries on our own window handles.
            unsafe { (IsWindowVisible(hwnd).as_bool() && GetWindowRect(hwnd, &mut r).is_ok()).then_some(r) }
        })
        .collect()
}

/// Fallback only (no game window, or its capture failed): our windows are hidden from captures
/// while we copy the screen ourselves (~20–35 ms per read): the user's own screenshots (Win+PrtSc, Snipping Tool, recordings) show fc-tracker
/// the rest of the time. `DwmFlush` waits until the compositor has applied the change, so our
/// picture never contains the overlay.
fn while_own_windows_hidden<T>(capture: impl FnOnce() -> T) -> T {
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    if steady() {
        // a recorder runs: no capture-exclusion toggles, no DwmFlush
        return capture();
    }
    // Only windows on screen need hiding (none in a match: no affinity changes, no DwmFlush).
    let windows: Vec<isize> = OWN_WINDOWS
        .lock()
        .unwrap()
        .iter()
        .copied()
        // SAFETY: read-only query on our own window handles.
        .filter(|&w| unsafe { IsWindowVisible(windows::Win32::Foundation::HWND(w as *mut _)).as_bool() })
        .collect();
    for &w in &windows {
        let _ = set_capture_excluded(w, true);
    }
    if !windows.is_empty() {
        // SAFETY: plain call, blocks until the next composition pass.
        unsafe {
            let _ = windows::Win32::Graphics::Dwm::DwmFlush();
        }
    }
    let out = capture();
    for &w in &windows {
        let _ = set_capture_excluded(w, false);
    }
    out
}

/// Hides a window from screen captures or shows it again (Windows 10 2004+). Works from any
/// thread (tested). Returns the affinity Windows reports afterwards, or the error.
pub fn set_capture_excluded(hwnd: isize, excluded: bool) -> Result<u32, String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowDisplayAffinity, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};
    let hwnd = HWND(hwnd as *mut _);
    // SAFETY: hwnd comes from a live Tauri window; failure only means the affinity stays as it was.
    unsafe {
        SetWindowDisplayAffinity(hwnd, if excluded { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE }).map_err(|e| e.to_string())?;
        let mut now = 0u32;
        GetWindowDisplayAffinity(hwnd, &mut now).map_err(|e| e.to_string())?;
        Ok(now)
    }
}

/// Process id of a window and whether that process is FC27 (FC27.exe / FC27_Trial.exe …).
fn window_process(hwnd: windows::Win32::Foundation::HWND) -> (u32, bool) {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    // Which program a process is never changes: asked once per process id (a query handle to
    // FC 27 many times a second was needless – CPU, and anti-cheat hygiene).
    // Entries expire after 10 s: a process id can be reused (a restarted game must be seen).
    static KNOWN: std::sync::Mutex<Vec<(u32, bool, std::time::Instant)>> = std::sync::Mutex::new(Vec::new());
    // SAFETY: read-only queries about a window's process; the handle is closed below.
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return (0, false);
        }
        {
            let mut known = KNOWN.lock().unwrap();
            known.retain(|(_, _, at)| at.elapsed() < std::time::Duration::from_secs(10));
            if let Some((_, game, _)) = known.iter().find(|(p, _, _)| *p == pid) {
                return (pid, *game);
            }
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return (pid, false) };
        let mut buf = [0u16; 260];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(process);
        let game = ok && {
            let path = String::from_utf16_lossy(&buf[..len as usize]).to_ascii_lowercase();
            path.rsplit('\\').next().is_some_and(|exe| exe.starts_with("fc27") && exe.ends_with(".exe"))
        };
        if ok {
            let mut known = KNOWN.lock().unwrap();
            // process ids are reused after a while: keep the list short
            if known.len() >= 64 {
                known.remove(0);
            }
            known.push((pid, game, std::time::Instant::now()));
        }
        (pid, game)
    }
}

/// The last foreground window that wasn't ours belonged to FC 27. Our own windows (overlay,
/// launcher) come and go on top of the game – hiding the overlay lets Windows activate any of
/// them – but they are excluded from capture, so the game is still what we read. Only another
/// program in front (browser, editor, Claude) means the game is not what the user looks at.
static LAST_OTHER_WAS_GAME: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Share of the game window (0–100) another program's foreground window must cover before
/// the game counts as hidden.
const COVERS_GAME: u32 = 60;
/// The foreign process last seen in front of the game without hiding it (for the log).
pub static LAST_FRONT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// How much of the game window (%) the window `over` covers. Minimised or invisible: 0.
fn covered_share(over: windows::Win32::Foundation::HWND, game: windows::Win32::Foundation::HWND) -> u32 {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic, IsWindowVisible};
    // SAFETY: read-only window queries.
    unsafe {
        if !IsWindowVisible(over).as_bool() || IsIconic(over).as_bool() {
            return 0;
        }
        let (mut a, mut b) = (RECT::default(), RECT::default());
        if GetWindowRect(over, &mut a).is_err() || GetWindowRect(game, &mut b).is_err() {
            return 100;
        }
        let w = (a.right.min(b.right) - a.left.max(b.left)).max(0) as i64;
        let h = (a.bottom.min(b.bottom) - a.top.max(b.top)).max(0) as i64;
        let game_area = ((b.right - b.left) as i64 * (b.bottom - b.top) as i64).max(1);
        (w * h * 100 / game_area) as u32
    }
}

/// Who owns the foreground window.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Front {
    Game,
    Ours,
    Other,
    /// No foreground window for a moment (during an activation switch): changes nothing.
    None,
}

/// One step of the "is the game in view" rule: (in view, new "last foreign window was the game").
pub fn in_view_step(front: Front, last_other_was_game: bool, game_window_exists: bool) -> (bool, bool) {
    match front {
        Front::Game => (true, true),
        Front::Ours => (last_other_was_game && game_window_exists, last_other_was_game),
        Front::Other => (false, false),
        Front::None => (last_other_was_game && game_window_exists, last_other_was_game),
    }
}

/// Is the game what the user sees? See `LAST_OTHER_WAS_GAME`. Cheap; called every tick.
pub fn game_in_view() -> bool {
    use std::sync::atomic::Ordering::Relaxed;
    // SAFETY: plain query of the foreground window handle.
    let hwnd = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
    let front = match window_process(hwnd) {
        (0, _) => Front::None,
        (_, true) => Front::Game,
        (pid, false) if pid == std::process::id() => Front::Ours,
        // a screen recorder in front (the user just pressed Record): the game is still in view
        (pid, false) if crate::game::is_recorder(pid) => {
            LAST_FRONT.store(pid, Relaxed);
            Front::None
        }
        // Another program in front only counts when it hides the game: a recording bar, an
        // overlay (Discord, Steam, NVIDIA, Game Bar) or a small window leaves the game in view.
        (pid, false) => match game_window().map(|g| covered_share(hwnd, g)) {
            Some(share) if share < COVERS_GAME => {
                LAST_FRONT.store(pid, Relaxed);
                Front::None
            }
            _ => Front::Other,
        },
    };
    let exists = matches!(front, Front::Ours | Front::None) && game_window().is_some();
    let (in_view, last) = in_view_step(front, LAST_OTHER_WAS_GAME.load(Relaxed), exists);
    LAST_OTHER_WAS_GAME.store(last, Relaxed);
    in_view
}

/// FC27's visible top-level window.
pub fn game_window() -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::core::BOOL;
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, IsIconic, IsWindowVisible};
    unsafe extern "system" fn each(hwnd: HWND, found: LPARAM) -> BOOL {
        // SAFETY: `found` points at the Option below for the duration of EnumWindows.
        unsafe {
            if IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() && window_process(hwnd).1 {
                *(found.0 as *mut Option<HWND>) = Some(hwnd);
                return BOOL(0);
            }
        }
        BOOL(1)
    }
    let mut found: Option<HWND> = None;
    // SAFETY: the callback only writes to `found`, which outlives the call.
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut found as *mut _ as isize));
    }
    found
}

/// Gives the keyboard focus back to FC27 (after our overlay closes). Windows doesn't always
/// return it by itself, and without it the game's screen stops being tracked. Only allowed
/// because our window is in front at that moment; nothing is sent to the game.
pub fn focus_game() {
    use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    if let Some(hwnd) = game_window() {
        // SAFETY: plain window-manager call on a valid top-level window handle.
        unsafe {
            let _ = SetForegroundWindow(hwnd);
        }
    }
}

/// Share (0–100) of the cells in one region (columns × rows of the 64×36 signature) that changed.
pub fn region_change(a: &[u8], b: &[u8], cols: std::ops::Range<usize>, rows: std::ops::Range<usize>) -> u32 {
    if a.len() != 64 * 36 || b.len() != a.len() {
        return 100;
    }
    let cells: Vec<usize> = rows.flat_map(|r| cols.clone().map(move |c| r * 64 + c)).collect();
    let changed = cells.iter().filter(|&&i| (a[i] as i32 - b[i] as i32).abs() > 25).count();
    (changed * 100 / cells.len().max(1)) as u32
}

/// Share (0–100) of signature cells that changed noticeably.
pub fn signature_change(a: &[u8], b: &[u8]) -> u32 {
    if a.len() != b.len() || a.is_empty() {
        return 100;
    }
    let changed = a.iter().zip(b).filter(|(x, y)| (**x as i32 - **y as i32).abs() > 25).count();
    (changed * 100 / a.len()) as u32
}

/// A card read from the Swap Player selector.
#[derive(Debug, Clone, PartialEq)]
pub struct ScannedCard {
    pub name: String,
    pub rating: Option<u32>,
    pub position: Option<String>,
    pub points: Option<u32>,
    pub first_owner: bool,
    /// Contrast pixels found in the marker area (for diagnostics / threshold tuning).
    pub marker_score: u32,
    /// Colour signature of the nation flag under the stats (see `Frame::card_flag`).
    pub flag: Option<Vec<u8>>,
}

/// Geometry of the swap-view cards relative to the name label, measured on a 1127 px high
/// frame and scaled with the frame height (FC27's UI scales with the resolution).
const REF_HEIGHT: f32 = 1127.0;
const REF_WIDTH: f32 = 2000.0;
/// First-owner triangle: left part of the card, between the position label and the face.
const MARKER_X: (f32, f32) = (-78.0, -50.0);
const MARKER_Y: (f32, f32) = (-52.0, -34.0);
/// Rating and position labels (top-left of the card), points chip (above the card).
const RATING_AT: (f32, f32) = (-70.0, -121.0);
const POSITION_AT: (f32, f32) = (-68.0, -95.0);
const POINTS_AT: (f32, f32) = (5.0, -200.0);
/// Contrast pixels (per 100 sampled) needed to call it a marker.
const MARKER_THRESHOLD: u32 = 6;

const POSITIONS: [&str; 15] = ["GK", "CB", "LB", "RB", "LWB", "RWB", "CDM", "CM", "CAM", "LM", "RM", "LW", "RW", "ST", "CF"];

/// Parses OCR'd numbers like "11,000" / "5.500" / "830". Anything else → None.
fn digits(s: &str) -> Option<u32> {
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '.') {
        return None;
    }
    s.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

impl Frame {
    /// FC27's UI is laid out for 16:9 and scaled to fit, so on 16:10 screens (e.g. 2880×1800)
    /// the width decides. Reference frame: 2000×1127.
    fn scale(&self) -> f32 {
        (self.width as f32 / REF_WIDTH).min(self.height as f32 / REF_HEIGHT)
    }

    /// Word closest to an anchor point (within `radius`) that satisfies `accept`.
    fn word_near(&self, x: f32, y: f32, radius: f32, accept: impl Fn(&Word) -> bool) -> Option<&Word> {
        self.words
            .iter()
            .filter(|w| accept(w))
            .map(|w| {
                let (wx, wy) = (w.x + w.w / 2.0, w.y + w.h / 2.0);
                (w, ((wx - x).powi(2) + (wy - y).powi(2)).sqrt())
            })
            .filter(|(_, d)| *d <= radius)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(w, _)| w)
    }

    /// Counts pixels in the marker box that contrast with the box's median brightness.
    /// Works on gold, silver and dark special cards alike (the glyph is dark on light cards
    /// and light on dark ones); a card without the marker is near-uniform there.
    fn marker_score(&self, cx: f32, name_y: f32) -> u32 {
        let s = self.scale();
        let (x0, x1) = ((cx + MARKER_X.0 * s) as i32, (cx + MARKER_X.1 * s) as i32);
        let (y0, y1) = ((name_y + MARKER_Y.0 * s) as i32, (name_y + MARKER_Y.1 * s) as i32);
        let mut samples = Vec::new();
        for y in y0.max(0)..y1.max(0) {
            for x in x0.max(0)..x1.max(0) {
                samples.push(self.luma(x as u32, y as u32));
            }
        }
        if samples.is_empty() {
            return 0;
        }
        let mut sorted = samples.clone();
        sorted.sort_unstable();
        let median = sorted[sorted.len() / 2] as i32;
        let contrast = samples.iter().filter(|&&l| (l as i32 - median).abs() > 70).count();
        (contrast * 100 / samples.len()) as u32
    }

    /// Number of numeric words in the stat row under a name (PAC SHO PAS … values).
    fn stat_numbers_below(&self, cx: f32, name_y: f32) -> usize {
        let s = self.scale();
        self.words
            .iter()
            .filter(|w| {
                let wy = w.y + w.h / 2.0;
                let wx = w.x + w.w / 2.0;
                (name_y + 20.0 * s..=name_y + 45.0 * s).contains(&wy)
                    && (wx - cx).abs() <= 95.0 * s
                    && digits(&w.text).is_some_and(|d| d <= 99)
            })
            .count()
    }

    /// Names the full-screen OCR missed: white names on light special cards (Miley, TOTW …) have
    /// too little contrast. The grid is regular, so a column that has a card (stat numbers below
    /// the name line) but no name in this row is read again on its own, binarised for light text.
    fn missed_names(&self, found: &[(String, f32, f32)]) -> Vec<(String, f32, f32)> {
        let s = self.scale();
        // Columns and rows from the names that were read.
        let mut cols: Vec<f32> = Vec::new();
        for (_, cx, _) in found {
            if !cols.iter().any(|c| (c - cx).abs() < 40.0 * s) {
                cols.push(*cx);
            }
        }
        let mut rows: Vec<f32> = Vec::new();
        for (_, _, y) in found {
            if !rows.iter().any(|r| (r - y).abs() < 10.0 * s) {
                rows.push(*y);
            }
        }
        let Ok(engine) = ocr_engine() else { return Vec::new() };
        let mut out = Vec::new();
        for &y in &rows {
            for &cx in &cols {
                let taken = found.iter().any(|(_, x, ty)| (x - cx).abs() < 40.0 * s && (ty - y).abs() < 10.0 * s);
                if taken || self.stat_numbers_below(cx, y) < 4 {
                    continue;
                }
                let (x0, y0, w, h) = (cx - 85.0 * s, y - 3.0 * s, 170.0 * s, 20.0 * s);
                for threshold in [215u8, 190, 235] {
                    let Ok(text) = self.ocr_region_with(&engine, x0, y0, w, h, 3, Some(threshold)) else { continue };
                    let name: String = text.split_whitespace().filter(|t| t.chars().filter(|c| c.is_alphabetic()).count() >= 2)
                        // Stat headers (PAC SHO …) and positions are no names.
                        .filter(|t| !(t.len() == 3 && t.chars().all(|c| c.is_ascii_uppercase())) && !POSITIONS.contains(t))
                        .collect::<Vec<_>>()
                        .join(" ");
                    if name.chars().filter(|c| c.is_alphabetic()).count() >= 3 {
                        out.push((name, cx, y));
                        break;
                    }
                }
            }
        }
        out
    }

    /// Groups OCR words into card name labels: words on the same text line that sit close
    /// together form one name (e.g. "Rúben" + "Dias"). Returns (name, centre x, top y).
    fn name_labels(&self) -> Vec<(String, f32, f32)> {
        let s = self.scale();
        let is_name_word = |w: &Word| {
            let letters = w.text.chars().filter(|c| c.is_alphabetic()).count();
            letters >= 2 && letters * 2 >= w.text.chars().count() && (11.0 * s..=17.0 * s).contains(&w.h)
                && !POSITIONS.contains(&w.text.as_str())
        };
        let mut words: Vec<&Word> = self.words.iter().filter(|w| is_name_word(w)).collect();
        // Sort by text line (tolerating a few px of jitter), then left to right.
        let line = |w: &Word| (w.y / (8.0 * s)).round() as i64;
        words.sort_by(|a, b| line(a).cmp(&line(b)).then(a.x.total_cmp(&b.x)));
        let mut labels: Vec<(String, f32, f32, f32)> = Vec::new(); // text, left, right, top
        for w in words {
            match labels.last_mut() {
                Some(l) if (w.y - l.3).abs() < 6.0 * s && w.x >= l.2 - 2.0 * s && w.x - l.2 < 18.0 * s => {
                    l.0.push(' ');
                    l.0.push_str(&w.text);
                    l.2 = w.x + w.w;
                }
                _ => labels.push((w.text.clone(), w.x, w.x + w.w, w.y)),
            }
        }
        labels.into_iter().map(|(t, l, r, y)| (t, (l + r) / 2.0, y)).collect()
    }
}

/// Reads every card on a Swap Player page. Cards are found via their name labels; rating,
/// position and points are read around them and the first-owner marker is detected by pixels.
/// The nation flag on a New Items / Swap Player card: left of the league and club badges, just
/// under the stats row (reference units, measured on 1080p New Items: flag ≈ 23 × 15, its centre
/// ≈ 24 left of the name's centre and 20 below the stats row). The selected card is drawn ~14 %
/// bigger, so the vertical place is taken from the card itself: its stats row, else the distance
/// name → rating, else the size of a card that isn't selected.
const CARD_FLAG_X: (f32, f32) = (-33.0, -15.0);
const CARD_FLAG_BELOW_STATS: f32 = 20.0;
const CARD_FLAG_BELOW_NAME: f32 = 48.0;
const CARD_FLAG_HALF_H: f32 = 5.0;

impl Frame {
    /// 3 columns × 2 rows of mean RGB over the card's flag = 18 bytes (same layout as
    /// `flag_signature` of the set grid, but its own geometry – the two are learned separately).
    pub fn card_flag(&self, cx: f32, y: f32) -> Vec<u8> {
        let s = self.scale();
        // the stats row: two-digit numbers under the name
        let mut stats: Vec<f32> = self
            .words
            .iter()
            .filter(|w| w.text.len() == 2 && w.text.chars().all(|c| c.is_ascii_digit()))
            .map(|w| (w.x + w.w / 2.0, w.y + w.h / 2.0))
            .filter(|(wx, wy)| (wx - cx).abs() < 75.0 * s && *wy > y + 8.0 * s && *wy < y + 45.0 * s)
            .map(|(_, wy)| wy)
            .collect();
        stats.sort_by(|a, b| a.total_cmp(b));
        let rating_dy = self
            .word_near(cx + RATING_AT.0 * s, y + RATING_AT.1 * s, 30.0 * s, |w| digits(&w.text).is_some_and(|d| (40..=99).contains(&d)) && w.text.len() == 2)
            .map(|w| y - (w.y + w.h / 2.0));
        let flag_cy = match (stats.get(stats.len() / 2), rating_dy) {
            (Some(sy), _) => sy + CARD_FLAG_BELOW_STATS * s,
            (None, Some(dy)) if dy > 0.0 => y + CARD_FLAG_BELOW_NAME * s * (dy / (-RATING_AT.1 * s)).clamp(0.9, 1.25),
            _ => y + CARD_FLAG_BELOW_NAME * s,
        };
        let w = (CARD_FLAG_X.1 - CARD_FLAG_X.0) / 3.0;
        let (ytop, h) = (flag_cy - CARD_FLAG_HALF_H * s, CARD_FLAG_HALF_H);
        let mut out = Vec::with_capacity(18);
        for row in 0..2 {
            for col in 0..3 {
                let x0 = (cx + (CARD_FLAG_X.0 + w * col as f32) * s).max(0.0) as u32;
                let x1 = ((cx + (CARD_FLAG_X.0 + w * (col + 1) as f32) * s).max(0.0) as u32).min(self.width);
                let y0 = (ytop + h * row as f32 * s).max(0.0) as u32;
                let y1 = ((ytop + h * (row + 1) as f32 * s).max(0.0) as u32).min(self.height);
                let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
                for yy in y0..y1 {
                    for xx in x0..x1 {
                        let i = ((yy * self.width + xx) * 4) as usize;
                        if i + 2 < self.bgra.len() {
                            b += self.bgra[i] as u32;
                            g += self.bgra[i + 1] as u32;
                            r += self.bgra[i + 2] as u32;
                            n += 1;
                        }
                    }
                }
                let n = n.max(1);
                out.extend([(r / n) as u8, (g / n) as u8, (b / n) as u8]);
            }
        }
        out
    }

    /// A rating (40–99, two digits) and a position word where a card shows them, relative to the
    /// name label at (`cx`, `y`).
    fn card_corner(&self, cx: f32, y: f32) -> bool {
        let s = self.scale();
        let rating = self.word_near(cx + RATING_AT.0 * s, y + RATING_AT.1 * s, 25.0 * s, |w| digits(&w.text).is_some_and(|d| (40..=99).contains(&d)) && w.text.len() == 2);
        let position = self.word_near(cx + POSITION_AT.0 * s, y + POSITION_AT.1 * s, 25.0 * s, |w| POSITIONS.contains(&w.text.as_str()));
        rating.is_some() && position.is_some()
    }
}

pub fn read_swap_page(frame: &Frame) -> Vec<ScannedCard> {
    let s = frame.scale();
    let is_stat_label = |t: &str| t.chars().all(|c| c.is_ascii_uppercase()) && t.len() == 3;
    let mut labels: Vec<(String, f32, f32)> = frame
        .name_labels()
        .into_iter()
        // A card has a row of six stat numbers just below the name; UI labels don't. The tiny stat
        // row is the first thing OCR loses (bronze cards on New Items, a 1080p YouTube capture:
        // "Giménez" read, her stats not) – a rating and a position at the card's corner prove it
        // too: no UI label has both.
        .filter(|(_, cx, y)| frame.stat_numbers_below(*cx, *y) >= 4 || frame.card_corner(*cx, *y))
        // "PAC SHO PAS DRI DEF PHY" (stat headers read as one line) is no name.
        .filter(|(name, _, _)| !name.split_whitespace().all(is_stat_label))
        .collect();
    labels.extend(frame.missed_names(&labels));
    labels
        .into_iter()
        .map(|(name, cx, y)| {
            let rating = frame
                .word_near(cx + RATING_AT.0 * s, y + RATING_AT.1 * s, 25.0 * s, |w| {
                    digits(&w.text).is_some_and(|d| (40..=99).contains(&d)) && w.text.len() == 2
                })
                .and_then(|w| digits(&w.text));
            let position = frame
                .word_near(cx + POSITION_AT.0 * s, y + POSITION_AT.1 * s, 25.0 * s, |w| POSITIONS.contains(&w.text.as_str()))
                .map(|w| w.text.clone());
            let points = frame
                .word_near(cx + POINTS_AT.0 * s, y + POINTS_AT.1 * s, 60.0 * s, |w| digits(&w.text).is_some())
                .and_then(|w| digits(&w.text));
            let marker_score = frame.marker_score(cx, y);
            let flag = Some(frame.card_flag(cx, y));
            ScannedCard { name, rating, position, points, first_owner: marker_score >= MARKER_THRESHOLD, marker_score, flag }
        })
        .collect()
}

/// A collected card we can match a scanned card against.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub def_id: u64,
    pub name: String,
    pub rating: Option<u32>,
    pub points: u32,
}

/// Lower-case ASCII letters only: "Rúben Dias" → "rubendias", "O'Reilly" → "oreilly".
pub fn normalise_name(s: &str) -> String {
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' | 'ć' | 'č' => 'c',
            'ñ' | 'ń' => 'n',
            'š' | 'ś' => 's',
            'ž' | 'ź' | 'ż' => 'z',
            'ý' | 'ÿ' => 'y',
            'ł' => 'l',
            'ğ' => 'g',
            'ı' => 'i',
            'ş' | 'ș' => 's',
            'ð' | 'đ' => 'd',
            'ř' => 'r',
            'ț' | 'ţ' => 't',
            'ę' | 'ė' | 'ě' => 'e',
            'ō' => 'o',
            'ă' => 'a',
            c => c,
        })
        .flat_map(|c| match c {
            'ß' => vec!['s', 's'],
            'æ' => vec!['a', 'e'],
            'œ' => vec!['o', 'e'],
            c => vec![c],
        })
        .filter(|c| c.is_ascii_lowercase())
        .collect()
}

/// Edit distance where every letter with a mark in the card's name (ž, ć, ñ …) matches one or two
/// read letters for free – Windows OCR writes them as other letters ("Mandiukié" for Mandžukić,
/// "Mufioz" for Muñoz). 0 = the names differ only in those letters.
fn wild_distance(scanned: &str, cand: &str) -> usize {
    let a: Vec<char> = normalise_name(scanned).chars().collect();
    let b: Vec<Option<char>> = cand.chars().flat_map(|c| c.to_lowercase()).filter(|c| c.is_alphabetic()).map(|c| c.is_ascii_lowercase().then_some(c)).collect();
    let (n, m) = (a.len(), b.len());
    let mut d = vec![vec![usize::MAX / 2; m + 1]; n + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for j in 0..=m {
        d[0][j] = j;
    }
    for i in 1..=n {
        for j in 1..=m {
            let best = match b[j - 1] {
                Some(c) => d[i - 1][j - 1] + (c != a[i - 1]) as usize,
                // a marked letter: one read letter, or two ("ñ" read as "fi")
                None => d[i - 1][j - 1].min(if i >= 2 { d[i - 2][j - 1] } else { usize::MAX / 2 }),
            };
            d[i][j] = best.min(d[i - 1][j] + 1).min(d[i][j - 1] + 1);
        }
    }
    d[n][m]
}

/// Matches a scanned card to exactly one collected card, or nothing when it is ambiguous.
/// Name must match (exact, or one contains the other for "Vini Jr." style short names);
/// rating and points, when read, must agree and break ties between versions of a player.
pub fn match_card<'a>(scanned: &ScannedCard, candidates: &'a [Candidate]) -> Option<&'a Candidate> {
    match_card_preferring(scanned, candidates, |_| false)
}

/// Like `match_card`, but when several cards fit (same name, rating not read – "Adli ?") the one
/// `preferred` card wins if it is the only preferred one (e.g. the card of the set the user is
/// buying for).
pub fn match_card_preferring<'a>(scanned: &ScannedCard, candidates: &'a [Candidate], preferred: impl Fn(u64) -> bool) -> Option<&'a Candidate> {
    let name = normalise_name(&scanned.name);
    if name.len() < 3 {
        return None;
    }
    let consistent = |c: &&Candidate| {
        scanned.rating.is_none_or(|r| c.rating == Some(r)) && scanned.points.is_none_or(|p| c.points == p)
    };
    let by = |exact: bool| -> Vec<&'a Candidate> {
        candidates
            .iter()
            .filter(|c| {
                let cn = normalise_name(&c.name);
                // Partly: whole words only ("Rice" ⊂ "Declan Rice"). Inside a word is no match –
                // "Riben Dias" (Rúben Dias) contains "dia" and became Boulaye Dia (live 2026-10-17).
                if exact { cn == name } else { cn.len() >= 3 && (words_within(&scanned.name, &c.name) || words_within(&c.name, &scanned.name)) }
            })
            .filter(consistent)
            .collect()
    };
    let exact = by(true);
    let pool = if exact.is_empty() {
        let partial = by(false);
        // "Leroy San" (Sané) must not become Leroy, "Riben Dia" not Dia: when a card matched on
        // fewer words than were read, and the whole read name is one slip from another card,
        // nothing is certain. Extra read words of more than 2 letters never count as noise.
        let fewer_words = |c: &Candidate| words_within(&c.name, &scanned.name) && !words_within(&scanned.name, &c.name);
        let long_extra = |c: &Candidate| {
            let mine: Vec<String> = c.name.split(|ch: char| !ch.is_alphanumeric()).map(normalise_name).collect();
            scanned.name.split(|ch: char| !ch.is_alphanumeric()).map(normalise_name).any(|w| w.len() > 2 && !mine.contains(&w))
        };
        let near_other = candidates
            .iter()
            .filter(|c| consistent(c))
            .any(|c| !partial.iter().any(|p| p.def_id == c.def_id) && edit_distance(&normalise_name(&c.name), &name) <= 1);
        if partial.iter().any(|c| fewer_words(c) && (long_extra(c) || near_other)) {
            Vec::new()
        } else {
            partial
        }
    } else {
        exact
    };
    match pool.as_slice() {
        [one] => Some(one),
        many if many.len() > 1 => match many.iter().filter(|c| preferred(c.def_id)).collect::<Vec<_>>().as_slice() {
            [one] => Some(**one),
            _ => None,
        },
        [] => {
            // One OCR slip in a name ("Cankovié" for Čanković): accepted only with a known
            // rating or points that agree, and only when exactly one card fits.
            // Long names with letters OCR keeps missing (ğ read as ö: "Aktürkoölu", 2026-10-17) may
            // slip once without stats – still only when exactly one card fits.
            let no_stats = scanned.rating.is_none() && scanned.points.is_none();
            if name.len() < 5 {
                return None;
            }
            let hard_letters = |c: &Candidate| !c.name.is_ascii() && normalise_name(&c.name).len() >= 9;
            let near: Vec<&Candidate> = candidates
                .iter()
                .filter(|c| edit_distance(&normalise_name(&c.name), &name) <= 1 || (!c.name.is_ascii() && wild_distance(&scanned.name, &c.name) == 0))
                .filter(|c| !no_stats || hard_letters(c))
                .filter(consistent)
                .collect();
            match near.as_slice() {
                [one] => Some(one),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Every word of `part` is a whole word of `whole` (each word normalised like `normalise_name`).
fn words_within(part: &str, whole: &str) -> bool {
    let words = |s: &str| -> Vec<String> { s.split(|c: char| !c.is_alphanumeric()).map(normalise_name).filter(|w| !w.is_empty()).collect() };
    let (part, whole) = (words(part), words(whole));
    !part.is_empty() && part.iter().all(|w| whole.contains(w))
}

/// Every card whose name is exactly the scanned one and whose read stats agree – the tie the
/// nation flag may break.
pub fn exact_name_matches<'a>(scanned: &ScannedCard, candidates: &'a [Candidate]) -> Vec<&'a Candidate> {
    let name = normalise_name(&scanned.name);
    candidates
        .iter()
        .filter(|c| normalise_name(&c.name) == name)
        .filter(|c| scanned.rating.is_none_or(|r| c.rating == Some(r)) && scanned.points.is_none_or(|p| c.points == p))
        .collect()
}

/// Levenshtein distance (short names only).
fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + (ca != cb) as usize).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Local screenshots (not in git – third-party footage). Set FCT_SCAN_FIXTURES to run:
    /// `cargo test --lib scan -- --ignored --nocapture`
    fn grid(readings: &[&[u32]]) -> Vec<GridCard> {
        readings
            .iter()
            .enumerate()
            .map(|(slot, r)| GridCard { slot, points: None, readings: r.to_vec(), rating: None, position: None, first_owner: false, marker_score: 0, flag: Vec::new() })
            .collect()
    }

    #[test]
    fn misreads_that_cancel_out_in_the_sum_are_rejected() {
        // Collected: two 8,300 cards, one 5,500 and two 4,100. Live read: 8,300 three times and
        // a 4,700 that does not exist – the sum still equals Base Grade (seen live 2026-10-13).
        let available = std::collections::BTreeMap::from([(8300, 2), (5500, 1), (4100, 2), (100, 1)]);
        let base = 8300 + 8300 + 5500 + 4100 + 4100;
        let mut cards = grid(&[&[8300], &[8300], &[8300], &[4700], &[100]]);
        assert!(!resolve_points(&mut cards, &available, Some(base)));
        // The correct read verifies, also when one chip has a second (wrong) reading.
        let mut cards = grid(&[&[8300], &[8300], &[5500], &[4100, 100], &[4100]]);
        assert!(resolve_points(&mut cards, &available, Some(base)));
        // One unreadable chip is filled with the difference only when the user has that value.
        let mut cards = grid(&[&[8300], &[8300], &[], &[4100], &[4100]]);
        assert!(resolve_points(&mut cards, &available, Some(base)));
        assert_eq!(cards[2].points, Some(5500));
        // Live Arsenal (2026-10-13): 4,100 read as 4,700 / 700 / 100 – fixed by 1↔7 and the lost "4,".
        let available = std::collections::BTreeMap::from([(4100, 4), (8300, 1)]);
        let mut cards = grid(&[&[4700], &[700], &[100], &[4100], &[8300]]);
        assert!(resolve_points(&mut cards, &available, Some(4 * 4100 + 8300)));
        assert!(cards.iter().take(4).all(|c| c.points == Some(4100)));
    }

    /// Live: the tiny page signature is cheap and stable on a still screen.
    #[test]
    #[ignore]
    fn signature_is_cheap() {
        let t = std::time::Instant::now();
        let a = capture_signature().unwrap();
        let b = capture_signature().unwrap();
        println!("2 signatures in {:?}, {} cells, change {}%, mean luma {}", t.elapsed(), a.len(), signature_change(&a, &b), a.iter().map(|&v| v as u32).sum::<u32>() / a.len() as u32);
        assert_eq!(a.len(), 64 * 36);
    }

    #[test]
    #[ignore]
    fn gallery_titles_from_fixtures() {
        for (file, want) in [
            ("u-bournemouth-complete.webp", Some("Bournemouth")),
            ("u-pl-swap-p2.webp", Some("Premier League")),
            ("u-totw-incomplete.webp", Some("TOTW")),
            ("u-arsenal-set.webp", Some("Arsenal")),
            ("u-newitems-bought.webp", None),
            ("u-club-players.webp", None),
            ("u-summary-2.webp", None),
        ] {
            let Some(bytes) = fixture(file) else { continue };
            let t = gallery_title(&analyse_bytes(&bytes).unwrap());
            let set = t.as_deref().and_then(crate::gallery_sets::find_set_by_title).map(|s| s.name);
            println!("{file}: {t:?} → {set:?}");
            assert_eq!(set.is_some(), want.is_some(), "{file}");
            if let (Some(set), Some(want)) = (set, want) {
                assert!(set.contains(want), "{file}: {set}");
            }
        }
    }

    /// Win32 check with a stand-in: run any GUI exe renamed to fc27*.exe, then this test.
    #[test]
    #[ignore]
    fn finds_and_focuses_the_game_window() {
        let w = game_window();
        println!("game window: {w:?}, in view before: {}", game_in_view());
        assert!(w.is_some());
        focus_game();
        std::thread::sleep(std::time::Duration::from_millis(300));
        println!("in view after focus_game: {}", game_in_view());
    }

    /// Fictional sessions for the focus rule: the overlay, the launcher and Windows activating
    /// "some" window after the overlay hides must not stop tracking; another program must.
    #[test]
    fn the_game_stays_in_view_behind_our_windows_only() {
        use Front::*;
        let run = |steps: &[(Front, bool)]| {
            let mut last = false;
            steps.iter().map(|(f, game)| {
                let (v, l) = in_view_step(*f, last, *game);
                last = l;
                v
            }).collect::<Vec<_>>()
        };
        // Game → hold View (overlay, ours) → hide: Windows activates our launcher → game again.
        assert_eq!(run(&[(Game, true), (Ours, true), (Ours, true), (Game, true)]), [true, true, true, true]);
        // Game → user alt-tabs to the browser → clicks our launcher: never the game.
        assert_eq!(run(&[(Game, true), (Other, true), (Ours, true)]), [true, false, false]);
        // Launcher opened first (no game seen yet): not in view.
        assert_eq!(run(&[(Ours, true)]), [false]);
        // A moment without any foreground window while the overlay opens changes nothing.
        assert_eq!(run(&[(Game, true), (None, true), (Ours, true)]), [true, true, true]);
        // Game closed behind our overlay: not in view.
        assert_eq!(run(&[(Game, true), (Ours, false)]), [true, false]);
    }

    /// Our windows hidden only while we capture: a magenta probe window must be missing from our
    /// capture and present in a plain capture (the user's screenshot) right after.
    #[test]
    #[ignore]
    fn own_windows_are_hidden_only_while_we_capture() {
        use windows::core::w;
        use windows::Win32::Foundation::COLORREF;
        use windows::Win32::Graphics::Gdi::{CreateSolidBrush, FillRect, GetDC, ReleaseDC};
        use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE};
        let hwnd = unsafe {
            let h = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, w!("STATIC"), w!("fct-probe"), WS_POPUP | WS_VISIBLE, 300, 300, 400, 300, None, None, None, None).unwrap();
            let _ = SetWindowPos(h, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            h
        };
        let paint = || unsafe {
            let dc = GetDC(Some(hwnd));
            let rect = windows::Win32::Foundation::RECT { left: 0, top: 0, right: 400, bottom: 300 };
            FillRect(dc, &rect, CreateSolidBrush(COLORREF(0x00FF00FF)));
            ReleaseDC(Some(hwnd), dc);
        };
        paint();
        std::thread::sleep(std::time::Duration::from_millis(300));
        paint();
        // Where the probe is in physical pixels (display scaling).
        let mut rect = windows::Win32::Foundation::RECT::default();
        unsafe {
            let _ = windows::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect);
        }
        let (cx, cy) = (((rect.left + rect.right) / 2) as u32, ((rect.top + rect.bottom) / 2) as u32);
        let magenta = |(w, _h, px): &(u32, u32, Vec<u8>)| {
            let i = ((cy * w + cx) * 4) as usize;
            px[i] > 200 && px[i + 1] < 60 && px[i + 2] > 200
        };
        let before = capture_pixels_raw().unwrap();
        let i = ((cy * before.0 + cx) * 4) as usize;
        println!("probe rect {rect:?}, centre bgra {:?}, visible before registering: {}", &before.2[i..i + 4], magenta(&before));
        register_own_window(hwnd.0 as isize);
        let mut ours = 0;
        let mut theirs = 0;
        for _ in 0..20 {
            paint();
            if magenta(&capture_pixels().unwrap()) { ours += 1; }
            if magenta(&capture_pixels_raw().unwrap()) { theirs += 1; }
        }
        unsafe { let _ = DestroyWindow(hwnd); }
        println!("probe visible in OUR capture {ours}/20, in a plain capture {theirs}/20");
        assert_eq!(ours, 0);
        assert!(theirs >= 18);
    }

    /// Can window display affinity be changed from another thread than the window's own?
    /// (Screenshot mode didn't take effect, 2026-10-14.)
    #[test]
    #[ignore]
    fn display_affinity_from_another_thread() {
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WS_EX_TOOLWINDOW, WS_OVERLAPPEDWINDOW, WS_VISIBLE};
        let (tx, rx) = std::sync::mpsc::channel::<isize>();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let owner = std::thread::spawn(move || unsafe {
            let hwnd = CreateWindowExW(WS_EX_TOOLWINDOW, w!("STATIC"), w!("fct-probe"), WS_OVERLAPPEDWINDOW | WS_VISIBLE, 0, 0, 200, 100, None, None, None, None).unwrap();
            println!("own thread exclude: {:?}", set_capture_excluded(hwnd.0 as isize, true));
            tx.send(hwnd.0 as isize).unwrap();
            done_rx.recv().unwrap();
            println!("own thread none:    {:?}", set_capture_excluded(hwnd.0 as isize, false));
            let _ = DestroyWindow(hwnd);
        });
        let hwnd = rx.recv().unwrap();
        println!("other thread none:  {:?}", set_capture_excluded(hwnd, false));
        done_tx.send(()).unwrap();
        owner.join().unwrap();
    }

    /// How long one page read takes (decode excluded): `FCT_FIXTURE` or the PL set page.
    #[test]
    #[ignore]
    fn page_read_speed() {
        let file = std::env::var("FCT_FIXTURE").unwrap_or_else(|_| "u-pl-set-a.webp".into());
        let Some(bytes) = fixture(&file) else { return };
        let t = std::time::Instant::now();
        let f = analyse_bytes(&bytes).unwrap();
        let ocr = t.elapsed();
        let t = std::time::Instant::now();
        let page = analyse_page(&f).unwrap();
        println!("{file}: decode+OCR {ocr:?}, analyse {:?} → {}", t.elapsed(), match page { Page::Set { .. } => "set", Page::Swap { .. } => "swap", Page::Cards { .. } => "cards", _ => "other" });
    }

    #[test]
    #[ignore]
    fn probe_flag_position() {
        let file = std::env::var("FCT_FIXTURE").unwrap_or_else(|_| "own-set-pl-2.webp".into());
        let Some(bytes) = fixture(&file) else { return };
        let f = analyse_bytes(&bytes).unwrap();
        let mean = |x0: f32, y0: f32, x1: f32, y1: f32| {
            let (a, b) = f.ref_to_px(x0, y0);
            let (c, d) = f.ref_to_px(x1, y1);
            let (mut r, mut g, mut bl, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in b as u32..d as u32 {
                for x in a as u32..c as u32 {
                    let i = ((y * f.width + x) * 4) as usize;
                    bl += f.bgra[i] as u32; g += f.bgra[i + 1] as u32; r += f.bgra[i + 2] as u32; n += 1;
                }
            }
            (r / n.max(1), g / n.max(1), bl / n.max(1))
        };
        for slot in [0usize, 5, 6, 3, 1] {
            let (cx, cy) = (GRID_X0 + GRID_DX * (slot % 10) as f32, GRID_Y0 + GRID_DY * (slot / 10) as f32);
            for dy in [112.0, 118.0, 124.0, 130.0] {
                let row: Vec<String> = [-40.0f32, -32.0, -24.0, -16.0].iter().map(|dx| { let m = mean(cx + dx - 3.0, cy + dy - 3.0, cx + dx + 3.0, cy + dy + 3.0); format!("{:>3},{:>3},{:>3}", m.0, m.1, m.2) }).collect();
                println!("slot {slot} dy {dy}: {}", row.join(" | "));
            }
        }
    }

    #[test]
    #[ignore]
    fn probe_rating_position() {
        let file = std::env::var("FCT_FIXTURE").unwrap_or_else(|_| "u-pl-set-a.webp".into());
        let Some(bytes) = fixture(&file) else { return };
        let f = analyse_bytes(&bytes).unwrap();
        let e = ocr_engine().unwrap();
        let (_, _, s) = f.content_box();
        for slot in [0usize, 5, 14, 25, 22] {
            let (cx, cy) = (GRID_X0 + GRID_DX * (slot % 10) as f32, GRID_Y0 + GRID_DY * (slot / 10) as f32);
            for (dx, dy, w, h) in [(-62.0, 50.0, 30.0, 16.0), (-64.0, 48.0, 34.0, 20.0), (-62.0, 52.0, 28.0, 14.0), (-66.0, 46.0, 40.0, 24.0)] {
                let (x, y) = f.ref_to_px(cx + dx, cy + dy);
                let outs: Vec<String> = [(4u32, None), (5, None), (6, None), (8, None), (5, Some(120u8))]
                    .iter()
                    .map(|(fa, t)| f.ocr_region_ink(&e, x, y, w * s, h * s, *fa, *t, true).unwrap_or_default().replace(char::is_whitespace, "_"))
                    .collect();
                println!("slot {slot} box ({dx},{dy},{w},{h}): {}", outs.join(" | "));
            }
        }
    }

    #[test]
    #[ignore]
    fn debug_triangles() {
        let file = std::env::var("FCT_FIXTURE").unwrap_or_else(|_| "u-pl-set-a.webp".into());
        let Some(bytes) = fixture(&file) else { return };
        let f = analyse_bytes(&bytes).unwrap();
        for slot in 0..30usize {
            let (cx, cy) = (GRID_X0 + GRID_DX * (slot % 10) as f32, GRID_Y0 + GRID_DY * (slot / 10) as f32);
            println!("slot {slot}: {:?}", f.triangle_debug(cx, cy));
        }
    }

    /// Writes magnified crops of the first-owner marker area (BMP) for visual inspection.
    #[test]
    #[ignore]
    fn dump_marker_crops() {
        let Ok(out) = std::env::var("FCT_CROP_OUT") else { return };
        for (file, slots) in [("u-totw-incomplete.webp", vec![0usize, 1, 2, 3, 4, 5, 6, 7, 8, 9]), ("u-pl-set-a.webp", vec![10usize, 20, 23, 27])] {
            let Some(bytes) = fixture(file) else { continue };
            let f = analyse_bytes(&bytes).unwrap();
            for slot in slots {
                let (cx, cy) = (GRID_X0 + GRID_DX * (slot % 10) as f32, GRID_Y0 + GRID_DY * (slot / 10) as f32);
                let (x0, y0) = f.ref_to_px(cx - 66.0, cy + 30.0);
                let (x1, y1) = f.ref_to_px(cx - 20.0, cy + 100.0);
                let (w, h) = ((x1 - x0) as u32, (y1 - y0) as u32);
                let k = 8u32;
                let (ow, oh) = (w * k, h * k);
                let mut px = Vec::with_capacity((ow * oh * 4) as usize);
                for y in 0..oh {
                    for x in 0..ow {
                        let i = ((((y0 as u32) + y / k) * f.width + (x0 as u32) + x / k) * 4) as usize;
                        px.extend_from_slice(&f.bgra[i..i + 4]);
                    }
                }
                let mut bmp = Vec::new();
                bmp.extend_from_slice(b"BM");
                bmp.extend_from_slice(&(54 + px.len() as u32).to_le_bytes());
                bmp.extend_from_slice(&[0; 4]);
                bmp.extend_from_slice(&54u32.to_le_bytes());
                bmp.extend_from_slice(&40u32.to_le_bytes());
                bmp.extend_from_slice(&(ow as i32).to_le_bytes());
                bmp.extend_from_slice(&(-(oh as i32)).to_le_bytes());
                bmp.extend_from_slice(&1u16.to_le_bytes());
                bmp.extend_from_slice(&32u16.to_le_bytes());
                bmp.extend_from_slice(&[0; 24]);
                bmp.extend_from_slice(&px);
                std::fs::write(format!("{out}/{}-{slot}.bmp", file.trim_end_matches(".webp")), bmp).unwrap();
            }
        }
    }

    /// Prints the OCR words of a fixture (`FCT_FIXTURE`) – for finding page markers.
    #[test]
    #[ignore]
    fn dump_words() {
        let Ok(file) = std::env::var("FCT_FIXTURE") else { return };
        let Some(bytes) = fixture(&file) else { return };
        let frame = analyse_bytes(&bytes).unwrap();
        println!("{}x{}", frame.width, frame.height);
        for w in &frame.words {
            println!("{:>5.0} {:>5.0} h{:>3.0} {}", w.x, w.y, w.h, w.text);
        }
    }

    /// Captures the real screen now, saves it as BMP (`FCT_CAPTURE_OUT`) and analyses it.
    /// `FCT_CAPTURE_OUT=…\live.bmp cargo test --release --lib live_capture -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_capture() {
        let Ok(out) = std::env::var("FCT_CAPTURE_OUT") else { return };
        let (w, h, px) = capture_pixels().unwrap();
        let mut bmp = Vec::with_capacity(54 + px.len());
        let size = 54 + px.len() as u32;
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&size.to_le_bytes());
        bmp.extend_from_slice(&[0; 4]);
        bmp.extend_from_slice(&54u32.to_le_bytes());
        bmp.extend_from_slice(&40u32.to_le_bytes());
        bmp.extend_from_slice(&(w as i32).to_le_bytes());
        bmp.extend_from_slice(&(-(h as i32)).to_le_bytes());
        bmp.extend_from_slice(&1u16.to_le_bytes());
        bmp.extend_from_slice(&32u16.to_le_bytes());
        bmp.extend_from_slice(&[0; 24]);
        bmp.extend_from_slice(&px);
        std::fs::write(&out, bmp).unwrap();
        println!("captured {w}x{h}");
        let frame = frame_from_pixels(w, h, px).unwrap();
        match analyse_page(&frame).unwrap() {
            Page::Set { title, total, base, cards, .. } => {
                println!("SET {title:?} total {total:?} base {base:?}");
                for c in &cards {
                    println!("  slot {:>2}: readings {:?} rating {:?} pos {:?} FO={} ({})", c.slot, c.readings, c.rating, c.position, c.first_owner, c.marker_score);
                }
            }
            Page::Swap { title, cards, .. } => {
                println!("SWAP {title:?}");
                for c in &cards {
                    println!("  {:?} {:?} {:?} {:?} FO={} ({})", c.name, c.rating, c.position, c.points, c.first_owner, c.marker_score);
                }
            }
            other @ (Page::Pending { .. } | Page::SetList { .. } | Page::Summary(_) | Page::Cards { .. } | Page::Bidding { .. } | Page::BuySuccess | Page::BuyConfirm { .. } | Page::OwnedActions { .. }) => println!("{other:?}"),
            Page::AutoComplete => println!("AUTO-COMPLETE"),
            Page::Other => println!("OTHER: {}", frame.words.iter().take(40).map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")),
        }
    }

    /// Whole-frame OCR on a smaller copy: are the same words found? (2000 → 1440 ≈ 2880 → 1920)
    #[test]
    #[ignore]
    fn ocr_downscaled_finds_the_same_words() {
        let Ok(files) = std::env::var("FCT_TIMING") else { return };
        for file in files.split(';') {
            let f = analyse_bytes(&std::fs::read(file).unwrap()).unwrap();
            let target = f.width * 72 / 100;
            let t = std::time::Instant::now();
            let (w2, h2, px2) = resize_to_width(f.width, f.height, &f.bgra, target);
            let words2 = ocr(&ocr_engine().unwrap(), &bitmap_from_bgra(&px2, w2, h2).unwrap()).unwrap();
            let el = t.elapsed();
            let a: std::collections::BTreeSet<String> = f.words.iter().map(|w| w.text.clone()).collect();
            let b: std::collections::BTreeSet<String> = words2.iter().map(|w| w.text.clone()).collect();
            println!("{} words at {} px, {} at {} px in {el:?} · only full: {:?} · only small: {:?}", a.len(), f.width, b.len(), w2, a.difference(&b).collect::<Vec<_>>(), b.difference(&a).collect::<Vec<_>>());
        }
    }

    /// Where a read's time goes, on screenshots: engine creation, whole-frame OCR, page analysis.
    /// `FCT_TIMING=<file>[;<file>…] cargo test --release --lib read_timing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn read_timing() {
        let Ok(files) = std::env::var("FCT_TIMING") else { return };
        for file in files.split(';') {
            let bytes = std::fs::read(file).unwrap();
            let t = std::time::Instant::now();
            let decoded = analyse_bytes(&bytes).unwrap();
            let (w, h, px) = (decoded.width, decoded.height, decoded.bgra.clone());
            let decode = t.elapsed();
            let t = std::time::Instant::now();
            let engine = ocr_engine().unwrap();
            let make_engine = t.elapsed();
            let t = std::time::Instant::now();
            let bitmap = bitmap_from_bgra(&px, w, h).unwrap();
            let words = ocr(&engine, &bitmap).unwrap();
            let whole = t.elapsed();
            let frame = Frame { width: w, height: h, bgra: px, words };
            let t = std::time::Instant::now();
            let page = analyse_page(&frame);
            let analyse = t.elapsed();
            println!("{file}: {w}x{h} decode {decode:?} · engine {make_engine:?} · whole-frame OCR {whole:?} ({} words) · page analysis {analyse:?} → {}", frame.words.len(), match page { Ok(Page::Cards { context, cards }) => format!("cards {context} {}", cards.len()), Ok(Page::Pending { .. }) => "pending".into(), Ok(Page::Set { cards, .. }) => format!("set {}", cards.len()), Ok(other) => format!("{other:?}").chars().take(40).collect(), Err(e) => e });
        }
    }

    /// Analyse one screenshot: `FCT_ONE=<file> cargo test --lib analyse_one -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn analyse_one() {
        let Ok(path) = std::env::var("FCT_ONE") else { return };
        let frame = analyse_bytes(&std::fs::read(&path).unwrap()).unwrap();
        println!("{}x{} words: {}", frame.width, frame.height, frame.words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "));
        match analyse_page(&frame) {
            Ok(Page::Set { title, total, base, cards, .. }) => {
                println!("SET {title:?} total {total:?} base {base:?}");
                for c in &cards {
                    println!("  slot {:>2}: readings {:?} rating {:?} pos {:?} FO={} ({})", c.slot, c.readings, c.rating, c.position, c.first_owner, c.marker_score);
                }
            }
            Ok(other) => println!("{other:?}"),
            Err(e) => println!("ERR {e}"),
        }
    }

    /// Stitches `<name>_q<x><y>.jpg` (2×2 or 3×3, row by row) into one picture.
    pub(crate) fn stitch_tiles(dir: &std::path::Path, name: &str) -> Option<(u32, u32, Vec<u8>)> {
        let k: u32 = if dir.join(format!("{name}_q22.jpg")).exists() { 3 } else { 2 };
        let qs: Vec<String> = (0..k).flat_map(|y| (0..k).map(move |x| format!("{x}{y}"))).collect();
        let tiles: Vec<Frame> = qs.iter().map(|q| std::fs::read(dir.join(format!("{name}_q{q}.jpg"))).ok().and_then(|b| analyse_bytes(&b).ok())).collect::<Option<_>>()?;
        let (tw, th) = (tiles[0].width, tiles[0].height);
        let (w, h) = (tw * k, th * k);
        let mut px = vec![0u8; (w * h * 4) as usize];
        for (i, t) in tiles.iter().enumerate() {
            let (ox, oy) = ((i as u32 % k) * tw, (i as u32 / k) * th);
            for y in 0..th {
                let src = &t.bgra[(y * tw * 4) as usize..((y + 1) * tw * 4) as usize];
                let at = (((oy + y) * w + ox) * 4) as usize;
                px[at..at + (tw * 4) as usize].copy_from_slice(src);
            }
        }
        Some((w, h, px))
    }

    /// Frames rebuilt from 2×2 magnified screenshots (`<name>_q<x><y>.jpg`, 800×450 each →
    /// 1600×900): classified like a live read, stitched picture saved to `<dir>/stitched/`.
    /// `FCT_TILES=<dir> cargo test --release --lib tiles_dir -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn tiles_dir() {
        let Ok(dir) = std::env::var("FCT_TILES") else { return };
        let dir = std::path::PathBuf::from(dir);
        let _ = std::fs::create_dir_all(dir.join("stitched"));
        let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter_map(|n| n.strip_suffix("_q00.jpg").map(str::to_string)).collect();
        names.sort_by(|a, b| a.parse::<f64>().unwrap_or(0.0).partial_cmp(&b.parse::<f64>().unwrap_or(0.0)).unwrap());
        for name in names {
            let Some((w, h, px)) = stitch_tiles(&dir, &name) else { println!("{name}: tiles missing"); continue };
            let _ = save_jpeg(&dir.join("stitched").join(format!("{name}.jpg")), w, h, &px);
            let frame = frame_from_pixels(w, h, px).unwrap();
            let page = analyse_page(&frame);
            let text: String = frame.words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
            println!("== {name} {w}x{h} words: {}", text.chars().take(260).collect::<String>());
            match page {
                Ok(Page::Set { title, total, base, cards, .. }) => println!("   SET {title:?} total {total:?} base {base:?} cards {}: {}", cards.len(), cards.iter().map(|c| format!("{}{}({} r{:?} {:?})", c.points.map_or("?".into(), |p| p.to_string()), if c.first_owner { "*" } else { "" }, c.marker_score, c.rating, c.position)).collect::<Vec<_>>().join(" ")),
                Ok(Page::Pending { title, set }) => match set.as_deref() {
                    Some(Page::Set { cards, .. }) => println!("   PENDING {title:?} cards {}: {}", cards.len(), cards.iter().map(|c| format!("{}{}({} r{:?} {:?})", c.points.map_or("?".into(), |p| p.to_string()), if c.first_owner { "*" } else { "" }, c.marker_score, c.rating, c.position)).collect::<Vec<_>>().join(" ")),
                    _ => println!("   PENDING {title:?} – cards not readable"),
                },
                Ok(Page::Cards { context, cards }) => println!("   CARDS {context}: {}", cards.iter().map(|c| format!("{} {:?} {:?} flag {:?}", c.name, c.rating, c.position, c.flag.as_ref().map(|f| f.chunks(3).map(|p| format!("{:02x}{:02x}{:02x}", p[0], p[1], p[2])).collect::<Vec<_>>().join(" ")))).collect::<Vec<_>>().join(" | ")),
                Ok(other) => println!("   {other:?}"),
                Err(e) => println!("   ERR {e}"),
            }
        }
    }

    fn fixture(name: &str) -> Option<Vec<u8>> {
        let dir = std::env::var("FCT_SCAN_FIXTURES").ok()?;
        std::fs::read(std::path::Path::new(&dir).join(name)).ok()
    }

    #[test]
    fn diagnostics_save_a_real_jpeg_at_half_size_above_2000_px() {
        let (w, h) = (2400u32, 1500u32);
        let px: Vec<u8> = (0..w * h).flat_map(|i| [(i % 251) as u8, (i % 7) as u8 * 30, 90, 255]).collect();
        let path = std::env::temp_dir().join(format!("fct-diag-{}.jpg", std::process::id()));
        save_jpeg(&path, w, h, &px).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
        // decoded back: half size
        let frame = analyse_bytes(&bytes).unwrap();
        assert_eq!((frame.width, frame.height), (1200, 750));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_misread_word_never_hands_the_card_to_a_shorter_name() {
        // live-like cases from the fixture tester's simulation over 5,871 real cards
        let c = [cand(1, "Dia", 78, 140), cand(2, "Rúben Dias", 87, 5500), cand(3, "Leroy", 75, 90), cand(4, "Leroy Sané", 85, 2100), cand(5, "Ortega", 80, 180), cand(6, "Sara Ortega", 84, 830)];
        let m = |n: &str| match_card(&scanned(n, None, None), &c).map(|x| x.def_id);
        assert_ne!(m("Rúben Dia"), Some(1));
        assert_ne!(m("Leroy San"), Some(3));
        assert_ne!(m("Sar Ortega"), Some(5));
        // letters OCR writes as others, and letters normalising used to drop
        let d = [cand(7, "Mandžukić", 86, 5125), cand(8, "Muñoz", 82, 340), cand(9, "Eisenbeiß", 70, 35), cand(10, "Çakır", 79, 160)];
        let n = |x: &str, r: Option<u32>, p: Option<u32>| match_card(&scanned(x, r, p), &d).map(|k| k.def_id);
        assert_eq!(n("Mandiukié", None, Some(5125)), Some(7));
        assert_eq!(n("Mufioz", None, Some(340)), Some(8));
        assert_eq!(n("Eisenbeiss", None, None), Some(9));
        assert_eq!(n("Cakir", None, None), Some(10));
    }

    #[test]
    fn a_name_inside_another_word_is_no_match() {
        // live 2026-10-17: Rúben Dias read as "Riben Dias" (rating not read) became Boulaye Dia
        let cands = [cand(1, "Dia", 80, 180), cand(2, "Rúben Dias", 87, 5500)];
        assert_eq!(match_card(&scanned("Riben Dias", None, None), &cands).map(|c| c.def_id), Some(2));
        // whole words still match partly
        let rice = [cand(3, "Declan Rice", 88, 8300)];
        assert_eq!(match_card(&scanned("Rice", None, None), &rice).map(|c| c.def_id), Some(3));
    }

    #[test]
    fn one_ocr_slip_in_a_name_still_matches_when_stats_agree() {
        let cands = [cand(1, "Čanković", 80, 180), cand(2, "Zelem", 80, 180)];
        assert_eq!(match_card(&scanned("Cankovié", Some(80), Some(180)), &cands).map(|c| c.def_id), Some(1));
        // Without stats a near name is not enough.
        assert!(match_card(&scanned("Cankovié", None, None), &cands).is_none());
        // A long name with a letter OCR misses (ğ → ö) slips once without stats.
        let tr = [cand(3, "Aktürkoğlu", 79, 160), cand(4, "Kökçü", 82, 340)];
        assert_eq!(match_card(&scanned("Aktürkoölu", None, None), &tr).map(|c| c.def_id), Some(3));
        // Two slips is too far.
        assert!(match_card(&scanned("Canlovié", Some(80), Some(180)), &cands).is_none());
    }

    fn cand(def_id: u64, name: &str, rating: u32, points: u32) -> Candidate {
        Candidate { def_id, name: name.into(), rating: Some(rating), points }
    }

    fn scanned(name: &str, rating: Option<u32>, points: Option<u32>) -> ScannedCard {
        ScannedCard { name: name.into(), rating, position: None, points, first_owner: true, marker_score: 20, flag: None }
    }

    #[test]
    fn matching_uses_name_then_rating_and_points_for_versions() {
        let cands = vec![
            cand(1, "Rúben Dias", 87, 5_500),
            cand(2, "Donnarumma", 89, 11_000),
            cand(3, "Donnarumma", 91, 23_750), // a special version of the same player
            cand(4, "O'Reilly", 83, 410),
        ];
        assert_eq!(match_card(&scanned("Rüben Dias", Some(87), None), &cands).map(|c| c.def_id), Some(1));
        assert_eq!(match_card(&scanned("OReilly", None, None), &cands).map(|c| c.def_id), Some(4));
        // Two versions and nothing read to tell them apart → refuse rather than guess.
        assert!(match_card(&scanned("Donnarumma", None, None), &cands).is_none());
        assert_eq!(match_card(&scanned("Donnarumma", None, Some(11_000)), &cands).map(|c| c.def_id), Some(2));
        assert!(match_card(&scanned("Haaland", Some(91), None), &cands).is_none());
    }

    /// End to end on the fixture against the developer's real synced cards.
    #[test]
    #[ignore]
    fn matches_fixture_against_real_collection() {
        let Some(bytes) = fixture("swap-mancity.webp") else { return };
        let store = crate::store::Store::copy_of_user_data();
        let candidates: Vec<Candidate> = store
            .snapshot
            .gallery
            .values()
            .filter(|c| c.collected)
            .filter_map(|c| Some(Candidate { def_id: c.def_id, name: c.name.clone()?, rating: c.rating.map(|r| r as u32), points: c.score as u32 }))
            .collect();
        println!("{} collected candidates with names", candidates.len());
        for s in read_swap_page(&analyse_bytes(&bytes).unwrap()) {
            let m = match_card(&s, &candidates);
            println!("{:<12} FO={:<5} → {:?}", s.name, s.first_owner, m.map(|c| (c.def_id, c.name.clone(), c.rating, c.points)));
        }
    }

    #[test]
    #[ignore]
    fn captures_the_real_screen() {
        let start = std::time::Instant::now();
        let frame = capture_primary_screen().unwrap();
        println!("captured {}x{}, {} words in {:?}", frame.width, frame.height, frame.words.len(), start.elapsed());
        assert!(frame.width > 0 && !frame.words.is_empty());
    }

    #[test]
    #[ignore]
    fn reads_swap_page() {
        let file = std::env::var("FCT_FIXTURE").unwrap_or_else(|_| "swap-mancity.webp".into());
        let Some(bytes) = fixture(&file) else { return };
        let frame = analyse_bytes(&bytes).unwrap();
        for c in read_swap_page(&frame) {
            println!(
                "{:<14} {:>3} {:<4} {:>7} FO={} (marker {})",
                c.name,
                c.rating.map_or("?".into(), |r| r.to_string()),
                c.position.clone().unwrap_or_default(),
                c.points.map_or("?".into(), |p| p.to_string()),
                c.first_owner,
                c.marker_score
            );
        }
    }

    #[test]
    #[ignore]
    fn reads_set_grid() {
        let file = std::env::var("FCT_FIXTURE").unwrap_or_else(|_| "own-set-pl.webp".into());
        let Some(bytes) = fixture(&file) else { return };
        let mut frame = analyse_bytes(&bytes).unwrap();
        // FCT_SCALE=1.44 simulates a bigger screen (e.g. 2000 → 2880 px wide), bilinear.
        if let Some(k) = std::env::var("FCT_SCALE").ok().and_then(|v| v.parse::<f32>().ok()) {
            let (w, h) = ((frame.width as f32 * k) as u32, (frame.height as f32 * k) as u32);
            let mut px = vec![0u8; (w * h * 4) as usize];
            for y in 0..h {
                for x in 0..w {
                    let (fx, fy) = (x as f32 / k, y as f32 / k);
                    let (x0, y0) = (fx as u32, fy as u32);
                    let (x1, y1) = ((x0 + 1).min(frame.width - 1), (y0 + 1).min(frame.height - 1));
                    let (ax, ay) = (fx - x0 as f32, fy - y0 as f32);
                    for ch in 0..4 {
                        let p = |xx: u32, yy: u32| frame.bgra[((yy * frame.width + xx) * 4 + ch) as usize] as f32;
                        let v = p(x0, y0) * (1.0 - ax) * (1.0 - ay) + p(x1, y0) * ax * (1.0 - ay) + p(x0, y1) * (1.0 - ax) * ay + p(x1, y1) * ax * ay;
                        px[((y * w + x) * 4 + ch) as usize] = v as u8;
                    }
                }
            }
            frame = frame_from_pixels(w, h, px).unwrap();
        }
        let start = std::time::Instant::now();
        let cards = read_set_grid(&frame).unwrap();
        println!("{} cards in {:?}", cards.len(), start.elapsed());
        for c in &cards {
            println!(
                "slot {:>2}: {:>6} {:?} {:>3} {:<4} FO={} ({})",
                c.slot,
                c.points.map_or("?".into(), |p| p.to_string()),
                c.readings,
                c.rating.map_or("?".into(), |r| r.to_string()),
                c.position.clone().unwrap_or_default(),
                c.first_owner,
                c.marker_score
            );
        }
    }

    #[test]
    #[ignore]
    fn classifies_own_pages() {
        for file in ["own-set-pl.webp", "own-swap-pl.webp", "own-set-arsenal.webp", "own-summary.webp", "set-seriea.webp", "swap-mancity.webp",
            "vid-6.jpg", "vid-8.jpg", "vid-10.jpg", "vid-12.jpg", "vid-22.jpg", "vid-30.jpg", "vid-38.jpg", "vid-48.jpg",
            "swap-28.jpg", "swap-30.jpg", "swap-34.jpg", "swap-36.jpg", "swap-54.jpg",
            "u-pl-swap-p1.webp", "u-pl-swap-p2.webp", "u-pl-swap-p3.webp", "u-pl-set-a.webp", "u-pl-set-b.webp", "u-summary-2.webp",
            "u-totw-incomplete.webp", "u-holo-set.webp", "u-arsenal-swap.webp", "u-arsenal-set.webp", "u-heroes-swap.webp",
            "u-club-players.webp", "u-squad-ps.webp", "u-newitems-bought.webp", "u-transfer-list.webp", "u-newitems-untradeable.webp",
            "u-newitems-pack-12.webp", "u-newitems-pack-12b.webp", "buy-bidding.webp", "buy-confirm.webp", "buy-success.webp", "u-newitems-store-12.webp",
            "club-buy-market.webp", "club-buy-confirm.webp", "club-buy-actions.webp", "squad-442.webp"] {
            let Some(bytes) = fixture(file) else { continue };
            let frame = analyse_bytes(&bytes).unwrap();
            match analyse_page(&frame).unwrap() {
                Page::Set { title, total, base, bonus, cards } => {
                    let sum: u32 = cards.iter().filter_map(|c| c.points).sum();
                    println!("{file}: SET '{title}' total {total:?} base {base:?} bonus {bonus:?} · {} cards, points sum {sum}", cards.len())
                }
                Page::Swap { title, cards, preview } => println!("{file}: SWAP '{title}' · {} cards · preview {preview:?}", cards.len()),
                Page::Pending { title, set } => println!("{file}: PENDING '{title}' read={}", set.is_some()),
                Page::SetList { tiles } => println!("{file}: LIST {tiles:?}"),
                Page::Summary(s) => println!("{file}: SUMMARY {s:?}"),
                Page::Cards { context, cards } => println!("{file}: CARDS {context} {:?}", cards.iter().map(|c| (&c.name, c.rating)).collect::<Vec<_>>()),
                Page::Bidding { card, price } => println!("{file}: BIDDING {} {:?} {:?} price {price:?} coins {:?}", card.name, card.rating, card.position, read_coins(&frame)),
                Page::BuySuccess => println!("{file}: BUY SUCCESS coins {:?}", read_coins(&frame)),
                Page::BuyConfirm { price } => println!("{file}: BUY CONFIRM price {price:?}"),
                Page::OwnedActions { name, points } => println!("{file}: OWNED ACTIONS '{name}' points {points:?}"),
                Page::AutoComplete => println!("{file}: AUTO-COMPLETE"),
                Page::Other => println!("{file}: OTHER"),
            }
        }
    }

    /// Base Grade checksum on every fixture set page (user's own pages use their real card values).
    #[test]
    #[ignore]
    fn resolves_fixture_grids_against_base_grade() {
        let store = crate::store::Store::copy_of_user_data();
        let values = |pred: &dyn Fn(&crate::store::GalleryCard) -> bool| -> std::collections::BTreeMap<u32, usize> {
            let mut m = std::collections::BTreeMap::new();
            for c in store.snapshot.gallery.values().filter(|c| c.collected && pred(c)) {
                *m.entry(c.score as u32).or_default() += 1;
            }
            m
        };
        let cases: Vec<(&str, std::collections::BTreeMap<u32, usize>)> = vec![
            ("own-set-pl.webp", values(&|c| c.league == Some(13))),
            ("own-set-arsenal.webp", values(&|c| matches!(c.team, Some(1) | Some(116009)))),
            ("set-seriea.webp", Default::default()), // someone else's account: no known values
        ];
        for (file, valid) in cases {
            let Some(bytes) = fixture(file) else { continue };
            let Page::Set { base, mut cards, .. } = analyse_page(&analyse_bytes(&bytes).unwrap()).unwrap() else {
                println!("{file}: not a set page");
                continue;
            };
            let ok = resolve_points(&mut cards, &valid, base);
            let sum: u32 = cards.iter().filter_map(|c| c.points).sum();
            let fo = cards.iter().filter(|c| c.first_owner).count();
            println!("{file}: {} cards, sum {sum} vs base {base:?} → verified {ok}, {fo} first owner", cards.len());
        }
    }

    /// User's PL set page against the real synced collection (Premier League league cards).
    #[test]
    #[ignore]
    fn identifies_real_pl_lineup() {
        use crate::lineup::{identify, SetCard, SlotObs};
        let Some(bytes) = fixture("own-set-pl.webp") else { return };
        let grid = read_set_grid(&analyse_bytes(&bytes).unwrap()).unwrap();
        let store = crate::store::Store::copy_of_user_data();
        let cards: Vec<SetCard> = store
            .snapshot
            .gallery
            .values()
            .filter(|c| c.collected && c.league == Some(13))
            .map(|c| SetCard { def_id: c.def_id, points: c.score as u32, rating: c.rating.map(|r| r as u32), position: c.position.clone(), nation: c.nation })
            .collect();
        let slots: Vec<SlotObs> = grid
            .iter()
            .map(|g| SlotObs { points: g.points.unwrap(), rating: g.rating, position: g.position.clone(), first_owner: g.first_owner, flag: Some(g.flag.clone()), uncertain: false })
            .collect();
        let id = identify(&slots, &cards, &std::collections::BTreeSet::new(), false, &std::collections::BTreeMap::new());
        println!("collected PL cards: {}, slots identified: {}, ambiguous: {}, FO facts: {}", cards.len(), id.slots.len(), id.ambiguous, id.first_owner.len());
        for (slot, def) in &id.slots {
            let c = &store.snapshot.gallery[def];
            println!("slot {slot:>2} → {} {} ({}) FO={}", c.rating.unwrap_or(0), c.name.clone().unwrap_or_default(), c.score, id.first_owner[def]);
        }
    }

    /// ASCII view of set-grid cells (content coords: chip centre x = 165 + 125·col, y = 396 + 200·row).
    #[test]
    #[ignore]
    fn grid_cell_ascii() {
        let Some(bytes) = fixture("own-set-pl.webp") else { return };
        let frame = analyse_bytes(&bytes).unwrap();
        let (ox, oy, s) = frame.content_box();
        for (col, row) in [(0usize, 0usize), (2, 0), (4, 0), (0, 1)] {
            let (cx, cy) = (165.0 + 125.0 * col as f32, 396.0 + 200.0 * row as f32);
            println!("--- cell col {col} row {row}");
            for dy in (-20..150).step_by(5) {
                let line: String = (-60..60)
                    .step_by(2)
                    .map(|dx| {
                        let x = ox + (cx + dx as f32) * s;
                        let y = oy + (cy + dy as f32) * s;
                        match frame.luma(x as u32, y as u32) {
                            0..=60 => '#',
                            61..=110 => '+',
                            111..=170 => '.',
                            _ => ' ',
                        }
                    })
                    .collect();
                println!("{dy:>4} {line}");
            }
        }
    }

    /// ASCII view of the area left of/below the position label, to design the marker detector.
    #[test]
    #[ignore]
    fn marker_area_ascii() {
        let Some(bytes) = fixture("swap-mancity.webp") else { return };
        let frame = analyse_bytes(&bytes).unwrap();
        for name in ["Yamashita", "Knaak", "Miedema", "Foden", "Donnarumma"] {
            let w = frame.words.iter().find(|w| w.text == name).unwrap();
            let cx = (w.x + w.w / 2.0) as i32;
            let ny = w.y as i32;
            println!("--- {name} (name at {cx},{ny})");
            for y in (ny - 140..ny - 10).step_by(4) {
                let row: String = (cx - 95..cx - 25)
                    .step_by(2)
                    .map(|x| {
                        let l = frame.luma(x.max(0) as u32, y.max(0) as u32);
                        match l {
                            0..=60 => '#',
                            61..=110 => '+',
                            111..=170 => '.',
                            _ => ' ',
                        }
                    })
                    .collect();
                println!("{:>5} {row}", y);
            }
        }
    }

    #[test]
    #[ignore]
    fn ocr_dump_swap_view() {
        let file = std::env::var("FCT_FIXTURE").unwrap_or_else(|_| "swap-mancity.webp".into());
        let Some(bytes) = fixture(&file) else { return };
        let frame = analyse_bytes(&bytes).unwrap();
        println!("{}x{} – {} words", frame.width, frame.height, frame.words.len());
        for w in &frame.words {
            println!("{:>6.0},{:>5.0} {:>4.0}x{:<3.0} {}", w.x, w.y, w.w, w.h, w.text);
        }
    }
}
