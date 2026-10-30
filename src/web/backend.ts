// The browser version's "backend": what the app's Rust side does, done in this tab – the screen
// is shared by the user (a window, a tab or a capture card), every changed Gallery page is read
// (reader.ts) and handed to the app's own model (core.ts, WebAssembly). Nothing leaves the
// browser; what it learns is kept in this browser only (localStorage).
import type { BestValue, CurrentPage, GalleryCategory, GalleryStatus, PriceShare, SetValue, ShoppingList } from "../api";
import { excludedIds } from "../excluded";
import { call, core, validPoints } from "./core";
import { trackOnce } from "../usage";
import { pack, unpack } from "../gzip";
import type { ClubEntry, SquadPrefs, SquadsView } from "../squadsData";
import { classify, Frame, pageKey, readSet, readSwap, textReader, type Box } from "./reader";

export type Source = "window" | "tab" | "card";

/** What the page shows about the reading (every wait visible). */
export interface WebStatus {
  phase: "off" | "starting" | "watching" | "reading" | "read" | "unclear" | "error";
  source: Source | null;
  /** set being read / read */
  set: string | null;
  cards: number;
  verified: boolean;
  ms: number | null;
  /** i18n code of an error */
  error: string | null;
  /** live stream size and frame rate */
  width: number;
  height: number;
  fps: number;
  /** how many set pages were read this visit (for the download prompt) */
  reads: number;
}

type Listener<T> = (v: T) => void;
const listeners: Record<string, Set<Listener<unknown>>> = {};
function on<T>(name: string, cb: Listener<T>): () => void {
  (listeners[name] ??= new Set()).add(cb as Listener<unknown>);
  return () => listeners[name]?.delete(cb as Listener<unknown>);
}
function emit<T>(name: string, v: T) {
  listeners[name]?.forEach((cb) => cb(v));
}
export const webEvents = {
  onStatus: (cb: Listener<WebStatus>) => on("status", cb),
  onGalleryUpdated: (cb: Listener<number>) => on("gallery", cb),
  onPageChanged: (cb: Listener<CurrentPage>) => on("page", cb),
  onFocusSet: (cb: Listener<string>) => on("focus", cb),
  onMissingSet: (cb: Listener<string>) => on("missing", cb),
  onMissingVisible: (cb: Listener<boolean>) => on("missingVisible", cb),
  onLooked: (cb: Listener<{ boxes: Box[]; w: number; h: number }>) => on("looked", cb),
};

const STORE = "fct.web.state";
/** When this browser last saved what it learned (shown when it and the account disagree). */
const SAVED_AT = "fct.web.savedAt";
let status: WebStatus = { phase: "off", source: null, set: null, cards: 0, verified: false, ms: null, error: null, width: 0, height: 0, fps: 0, reads: 0 };
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let page: CurrentPage | null = null;
let followKey: string | null = null;
let missingVisible = true;
let overviewCache: GalleryCategory[] | null = null;
let version = 0;

function setStatus(p: Partial<WebStatus>) {
  status = { ...status, ...p };
  emit("status", status);
}
export const webStatus = () => status;
export const webStream = () => stream;

async function restore() {
  await core();
  try {
    const saved = localStorage.getItem(STORE);
    if (saved) await call("load_state", { state: JSON.parse(saved) });
  } catch {
    /* a private window or blocked storage: start empty */
  }
}
const restored = restore();

async function persist() {
  try {
    localStorage.setItem(STORE, JSON.stringify(await call("state")));
    localStorage.setItem(SAVED_AT, String(Date.now()));
  } catch {
    /* storage full or blocked: this visit still works */
  }
}

function changed() {
  overviewCache = null;
  version++;
  emit("gallery", version);
}

// ---------------------------------------------------------------- the API the overlay uses

export const webApi = {
  galleryOverview: async (): Promise<GalleryCategory[]> => {
    await restored;
    overviewCache ??= await call<GalleryCategory[]>("overview");
    return overviewCache;
  },
  shoppingList: async (key?: string): Promise<ShoppingList | null> => {
    await restored;
    const k = key ?? followKey ?? page?.set_key ?? null;
    return k ? call<ShoppingList | null>("shopping", { key: k }) : null;
  },
  galleryStatus: async (): Promise<GalleryStatus> => {
    await restored;
    const s = await call<{ collected: number[] }>("state");
    return { summary: null, collected: s.collected.length, first_owner_known: 0 };
  },
  currentPage: async () => page,
  followSet: async (key: string) => {
    followKey = key;
    emit("missing", key);
  },
  toggleMissingList: async () => {
    missingVisible = !missingVisible;
    emit("missingVisible", missingVisible);
  },
  missingListVisible: async () => missingVisible,
  setFirstOwner: async (defId: number, value: boolean | null) => {
    await call("set_first_owner", { def_id: defId, value });
    await persist();
    changed();
  },
  bestValue: async (budget: number | null, target: number | null, steps: number | null): Promise<BestValue | null> => {
    await restored;
    return call<BestValue>("best_value", { budget, target, steps, exclude: excludedIds() });
  },
  setValue: async (key: string): Promise<SetValue | null> => {
    await restored;
    return call<SetValue | null>("set_value", { key, exclude: excludedIds() });
  },
  /** The Gallery set list from fc-tracker.com (src/gallerySets.ts). */
  gallerySetsRevision: (): Promise<number> => call<number>("gallery_sets_revision"),
  useGallerySets: async (json: string): Promise<number> => {
    const rev = await call<number>("use_gallery_sets", { json });
    changed();
    return rev;
  },
  /** The shared price pool: what this browser saw (from a club sync), and the pool coming back. */
  priceShare: async (since: number): Promise<PriceShare> => {
    await restored;
    return call<PriceShare>("price_share", { since });
  },
  pricePool: async (platform: string, prices: Record<string, [number, number]>): Promise<number> => {
    await restored;
    const n = await call<number>("price_pool", { platform, prices });
    if (n > 0) {
      await persist();
      changed();
    }
    return n;
  },
  /** The shared pool of paid prices (what users paid for cards EA gives no average for). */
  paidPool: async (platform: string, prices: Record<string, [number, number, number]>): Promise<number> => {
    await restored;
    const n = await call<number>("paid_pool", { platform, prices });
    if (n > 0) {
      await persist();
      changed();
    }
    return n;
  },
  /** Objective squads: the open events' squad objectives and the best XI from the synced club. */
  squadsPlan: async (): Promise<SquadsView> => {
    await restored;
    return call<SquadsView>("squads_plan");
  },
  squadsSearch: async (q: string): Promise<ClubEntry[]> => {
    await restored;
    return call<ClubEntry[]>("squads_search", { q });
  },
  setSquadPrefs: async (prefs: SquadPrefs): Promise<void> => {
    await call("set_squad_prefs", { prefs });
    await persist();
  },
  /** Forget everything this browser learned (the "Start over" button). */
  reset: async () => {
    await call("reset");
    page = null;
    followKey = null;
    await persist();
    changed();
  },
};

// ---------------------------------------------------------------- capture

export async function startCapture(source: Source, deviceId?: string): Promise<void> {
  stopCapture();
  setStatus({ phase: "starting", source, error: null });
  try {
    stream =
      source === "card"
        ? await navigator.mediaDevices.getUserMedia({
            video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
            audio: false,
          })
        : await navigator.mediaDevices.getDisplayMedia({
            video: { displaySurface: source === "tab" ? "browser" : "window", frameRate: { ideal: 30 } },
            audio: false,
            // @ts-expect-error Chrome options (not in the DOM types yet)
            selfBrowserSurface: "exclude",
            surfaceSwitching: "include",
          });
  } catch (e) {
    stream = null;
    const name = (e as DOMException)?.name;
    setStatus({ phase: "off", source: null, error: name === "NotAllowedError" ? "cancelled" : name === "NotFoundError" ? "no_device" : "start_failed" });
    return;
  }
  await attach(stream, source);
}

/** Reads from a stream (startCapture; on localhost also a test picture: window.__fctWeb.attach). */
export async function attach(s: MediaStream, source: Source) {
  stream = s;
  video ??= Object.assign(document.createElement("video"), { muted: true, playsInline: true, autoplay: true });
  video.srcObject = stream;
  void video.play().catch(() => {});
  stream.getVideoTracks()[0]?.addEventListener("ended", () => stopCapture());
  setStatus({ phase: "watching", source, error: null, set: null, cards: 0, ms: null });
  textReader().catch(() => setStatus({ phase: "error", error: "reader_load" }));
  countFrames();
}

export function stopCapture() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  grabber = null;
  lastSig = readSig = null;
  lastKey = "";
  if (video) video.srcObject = null;
  if (status.phase !== "off") setStatus({ phase: "off", source: null, fps: 0, width: 0, height: 0 });
}

/** Capture cards and cameras (labels need one camera permission first). */
export async function captureDevices(): Promise<MediaDeviceInfo[]> {
  const probe = await navigator.mediaDevices.getUserMedia({ video: true });
  probe.getTracks().forEach((t) => t.stop());
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
}

let frames = 0;
function countFrames() {
  if (!video || !("requestVideoFrameCallback" in HTMLVideoElement.prototype)) return;
  const v = video;
  const tick = () => {
    if (!stream) return;
    frames++;
    v.requestVideoFrameCallback(tick);
  };
  v.requestVideoFrameCallback(tick);
}
setInterval(() => {
  if (!stream || !video) return;
  setStatus({ fps: frames, width: video.videoWidth, height: video.videoHeight });
  frames = 0;
}, 1000);

// ---------------------------------------------------------------- the reading loop

const sig = document.createElement("canvas");
sig.width = 64;
sig.height = 36;
const sigCtx = sig.getContext("2d", { willReadFrequently: true })!;
let lastSig: Uint8ClampedArray | null = null;
let readSig: Uint8ClampedArray | null = null;
let busy = false;
let stableTicks = 0;
let lastSwapTry = 0;
/** The set page read last (pageKey): the same page is not read again. */
let lastKey = "";

// Frames straight from the stream (ImageCapture): they keep coming while this tab is behind the
// game, where a <video> element may stop painting. The <video> is the fallback.
let grabber: { grabFrame(): Promise<ImageBitmap> } | null = null;
async function grab(): Promise<{ img: CanvasImageSource; w: number; h: number; close(): void } | null> {
  const track = stream?.getVideoTracks()[0];
  if (!track) return null;
  const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } }).ImageCapture;
  if (IC) {
    try {
      grabber ??= new IC(track);
      const b = await grabber.grabFrame();
      return { img: b, w: b.width, h: b.height, close: () => b.close() };
    } catch {
      grabber = null;
    }
  }
  if (!video || !video.videoWidth) return null;
  return { img: video, w: video.videoWidth, h: video.videoHeight, close: () => {} };
}
function signature(img: CanvasImageSource): Uint8ClampedArray {
  sigCtx.drawImage(img, 0, 0, 64, 36);
  return sigCtx.getImageData(0, 0, 64, 36).data;
}
const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let d = 0;
  for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return d / (a.length / 4) / 3;
};

// The beat comes from a worker: a page behind the game gets its own timers slowed to once a
// minute, a worker's messages still arrive on time.
const beat = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 450)"], { type: "text/javascript" })));
beat.onmessage = async () => {
  if (!stream || busy) return;
  busy = true;
  const shot = await grab().catch(() => null);
  if (!shot) {
    busy = false;
    return;
  }
  try {
    await tick(shot);
  } finally {
    shot.close();
    busy = false;
  }
};

async function tick(shot: { img: CanvasImageSource; w: number; h: number }) {
  const now = signature(shot.img);
  const moving = lastSig ? diff(now, lastSig) > 2.5 : true;
  lastSig = now;
  stableTicks = moving ? 0 : stableTicks + 1;
  // read once the picture has settled, and only when it differs from what was read last
  if (stableTicks < 1 || (readSig && diff(now, readSig) < 2)) return;
  await readOnce(now, new Frame(shot.img, shot.w, shot.h));
}

async function readOnce(now: Uint8ClampedArray, f: Frame) {
  const t0 = performance.now();
  const kind = await classify(f).catch(() => "other" as const);
  if (kind === "set" || kind === "incomplete") {
    const key = await pageKey(f, kind).catch(() => "");
    if (key && key === lastKey) {
      readSig = now;
      return;
    }
    setStatus({ phase: "reading", set: null, cards: 0 });
    const read = await readSet(f, kind, validPoints(), (n) => setStatus({ cards: n }));
    const set = await call<{ name: string } | null>("find_set", { title: read.title });
    setStatus({ set: set?.name ?? read.title });
    emit("looked", { boxes: f.looked, w: f.w, h: f.h });
    if (!set || read.slots.length === 0) {
      setStatus({ phase: "unclear", ms: Math.round(performance.now() - t0) });
      readSig = now;
      lastKey = key;
      return;
    }
    const p = await call<CurrentPage & { set_key: string | null }>("observe_set", { read });
    readSig = now;
    lastKey = key;
    if (!p.set_key) return;
    page = p;
    followKey = null;
    await persist();
    changed();
    emit("page", p);
    emit("focus", p.set_key);
    emit("missing", p.set_key);
    trackOnce("web-first-set-read");
    setStatus({ phase: "read", set: p.set_name, cards: p.cards_read, verified: read.complete && p.verified, ms: Math.round(performance.now() - t0), reads: status.reads + 1 });
    return;
  }
  // Swap Player: a full read of the page – at most every 3 s while it changes
  if (Date.now() - lastSwapTry < 3000) return;
  lastSwapTry = Date.now();
  const swap = await readSwap(f).catch(() => null);
  readSig = now;
  if (!swap || swap.cards.length === 0) return;
  const r = await call<{ set_key: string | null; set_name: string; matched: number }>("observe_swap", { read: swap });
  if (!r.set_key || r.matched === 0) return;
  await persist();
  changed();
  emit("missing", r.set_key);
  setStatus({ phase: "read", set: r.set_name, cards: r.matched, verified: false, ms: Math.round(performance.now() - t0) });
}

// ---------------------------------------------------------------- club sync (the extension)
// The FC-Tracker extension (Chrome Web Store, 0.11+) keeps the last club sync it read in EA's
// Web App and hands it to this page – the same responses the app ingests. The page asks; only
// fc-tracker.com may (the extension's externally_connectable).

// The Chrome Web Store copy. A copy loaded from the .zip has its own id: open the page once with
// ?ext=<id> (chrome://extensions shows it) and it is remembered in this browser.
const EXTENSION_ID = (() => {
  const fromUrl = new URLSearchParams(location.search).get("ext");
  try {
    if (fromUrl && /^[a-p]{32}$/.test(fromUrl)) localStorage.setItem("fct.web.ext", fromUrl);
    return localStorage.getItem("fct.web.ext") ?? "bpinmgkhbofecfagbehkmpmcnnehclem";
  } catch {
    return fromUrl && /^[a-p]{32}$/.test(fromUrl) ? fromUrl : "bpinmgkhbofecfagbehkmpmcnnehclem";
  }
})();

export interface ClubSync {
  /** null: no answer (extension missing, older than 0.11, or another browser) */
  version: string | null;
  syncAt: number | null;
  syncing: boolean;
  /** the sync this page has read in (ms) */
  readAt: number | null;
  cards: number;
  reading: boolean;
}
let club: ClubSync = { version: null, syncAt: null, syncing: false, readAt: null, cards: 0, reading: false };
export const webClub = () => club;
export const onClub = (cb: Listener<ClubSync>) => on("club", cb);
function setClub(p: Partial<ClubSync>) {
  club = { ...club, ...p };
  emit("club", club);
}

type Reply = { ok?: boolean; version?: string; syncAt?: number | null; syncing?: boolean; at?: number | null; entries?: unknown[] } | null;
function ext(msg: object): Promise<Reply> {
  const rt = (window as unknown as { chrome?: { runtime?: { sendMessage?: (id: string, m: object, cb: (r: Reply) => void) => void; lastError?: unknown } } }).chrome?.runtime;
  if (!rt?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      rt.sendMessage!(EXTENSION_ID, msg, (r) => {
        void rt.lastError;
        resolve(r ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

let sentSets = false;
async function checkClub() {
  const hello = await ext({ type: "hello" });
  if (!hello?.ok) return setClub({ version: null, syncing: false });
  // "Sync my club" opens the Web App; it counts as syncing until the extension says otherwise
  // (a sync starts once the Web App is signed in) – at most a minute without its word
  const opening = Date.now() - openedAt < 60_000 && !(hello.syncAt && hello.syncAt > openedAt);
  setClub({ version: hello.version ?? "?", syncAt: hello.syncAt ?? null, syncing: !!hello.syncing || opening });
  if (!sentSets) {
    sentSets = true;
    await restored;
    void ext({ type: "sets", sets: await call("sync_filters") });
  }
  const state = await call<{ synced_at: number | null; collected: number[] }>("state");
  if (club.readAt == null) setClub({ readAt: state.synced_at, cards: state.collected.length });
  if (hello.syncAt && hello.syncAt > (state.synced_at ?? 0) && !club.reading) {
    setClub({ reading: true });
    try {
      const sync = await ext({ type: "get-sync" });
      if (sync?.entries?.length) {
        const r = await call<{ collected: number; synced_at: number | null }>("ingest_sync", { sync: { at: sync.at, entries: sync.entries } });
        await persist();
        changed();
        setClub({ readAt: r.synced_at, cards: r.collected });
        trackOnce("web-first-sync");
        emit("club-synced", r.synced_at);
      }
    } finally {
      setClub({ reading: false });
    }
  }
}
void restored.then(checkClub);
setInterval(() => document.visibilityState === "visible" && void checkClub(), 10_000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void checkClub());

/** The page needs a newer extension: it asks the Chrome Web Store now and reloads into it. */
export async function askExtensionUpdate() {
  await ext({ type: "update" });
  setTimeout(() => void checkClub(), 15_000);
}

let openedAt = 0;
/** "Sync my club": the extension opens the Web App, which syncs by itself. */
export async function syncClub() {
  openedAt = Date.now();
  setClub({ syncing: true });
  await ext({ type: "open-webapp" });
  setTimeout(() => void checkClub(), 61_000);
}

// ---------------------------------------------------------------- account sync (src/account.ts)
// The Gallery data travels in the app's snapshot format and the Web App part in the app's
// webdata format – one copy on the account for the app and this page (PC ⇄ console).

/** A Web App club sync was read in: the account takes it at once. */
export const onClubSynced = (cb: Listener<number | null>) => on("club-synced", cb);

export async function syncPartExport(part: string): Promise<{ data: string; written_at: number }> {
  await restored;
  const fn = part === "gallery" ? "sync_export" : part === "webapp" ? "webapp_export" : null;
  if (!fn) throw "bad_request";
  let at = 0;
  try {
    at = Number(localStorage.getItem(SAVED_AT) ?? 0);
  } catch {}
  return { data: await pack(await call(fn)), written_at: at };
}

export async function syncPartImport(part: string, data: string, replace: boolean): Promise<void> {
  await restored;
  const fn = part === "gallery" ? "sync_import" : part === "webapp" ? "webapp_import" : null;
  if (!fn) throw "bad_request";
  await call(fn, { data: await unpack(data), replace });
  await persist();
  changed();
}

// ---------------------------------------------------------------- shared objectives (src/objectives.ts)
export async function objectivesShare(): Promise<unknown> {
  await restored;
  return call("objectives_share");
}

export async function applySharedObjectives(catalog: unknown): Promise<boolean> {
  await restored;
  const added = await call<boolean>("apply_shared_objectives", { catalog });
  if (added) {
    await persist();
    changed();
  }
  return added;
}
