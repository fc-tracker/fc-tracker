// The FC-Tracker account (SERVER.md): sign-in with a 6-digit code by e-mail, no password. The
// device keeps a refresh token (the app: Windows Credential Manager; the browser: its own storage)
// and gets short access tokens with it.
//
// Signed in, everything the device keeps locally is kept on the account too – in parts, each
// with its own version (gallery, webapp, champions, settings). The device stays the first copy:
// it keeps all of it locally, works without the account and without the server. Every few
// minutes (and right after a Web App sync) each part is compared with the account's:
//   only this device changed it  → sent
//   only the account has a newer → taken
//   both changed since they last agreed → the user decides: the account's (written x min ago on
//   device y), this device's (written x h ago), or both combined – nothing is chosen silently.
// The Gallery tracker works without an account. Errors are codes, shown as error.<code>.
import { useEffect, useState } from "react";
import { api, events, IS_WEB } from "./api";
import { getLocale } from "./i18n";
import { applySettings, readSettings, type SharedSettings } from "./syncSettings";
import { pack, unpack } from "./gzip";
import { applySaved, savedSquads, savedWrittenAt, type SavedSquad } from "./savedSquads";

const API = "https://api.fc-tracker.com";
const SYNC_EVERY = 3 * 60 * 1000;
const META = "fct.sync.part.";

export type User = {
  id: string;
  email: string;
  username: string | null;
  ea_name: string | null;
  show_ea: boolean;
  display_name: string | null;
  locale: string;
  created_at: string;
  /** Marked by FC-Tracker (known creators, the team) – never set by the user. */
  verified?: boolean;
  avatar_url?: string | null;
};
export type Device = { id: string; name: string; kind: string; created_at: string; last_seen: string; this: boolean };
export type Part = "gallery" | "webapp" | "champions" | "settings" | "saved";
/** Local and account copies of a part both changed since they last agreed. */
export type Conflict = { part: Part; cloudAt: number; cloudDevice: string | null; localAt: number };
export type SyncState = { phase: "idle" | "syncing" | "error" | "conflict"; at: number | null; error: string | null; conflicts: Conflict[] };
export type AccountState = { status: "loading" | "out" | "in"; user: User | null; sync: SyncState };

type Secret = { refresh: string; email: string };
export type CloudPart = { version: number; written_at: number | null; updated_at: number; device: string | null };
type Local = { data: string; writtenAt: number };

let state: AccountState = { status: "loading", user: null, sync: { phase: "idle", at: null, error: null, conflicts: [] } };
const listeners = new Set<(s: AccountState) => void>();
let access: { token: string; until: number } | null = null;
let secret: Secret | null = null;

function emit(patch: Partial<AccountState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}
const setSync = (s: Partial<SyncState>) => emit({ sync: { ...state.sync, ...s } });

export function useAccount(): AccountState {
  const [s, set] = useState(state);
  useEffect(() => {
    listeners.add(set);
    set(state);
    return () => void listeners.delete(set);
  }, []);
  return s;
}

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {}
  },
};

// ------------------------------------------------------------------------------- the parts

type PartDef = {
  name: Part;
  read(): Promise<Local | null>;
  /** `replace`: the account's copy becomes this device's; else it is merged in. */
  write(data: string, replace: boolean): Promise<void>;
  /** Taking a newer account copy while this device changed nothing: merge (lossless) or replace. */
  takeReplaces: boolean;
  /** Only ever taken from the account, never sent (FC-Tracker Web's Champions). */
  pullOnly?: boolean;
};

const rustPart = (name: Part): PartDef => ({
  name,
  read: async () => {
    const r = await api.syncPartExport(name);
    return r ? { data: r.data, writtenAt: r.written_at } : null;
  },
  write: (data, replace) => api.syncPartImport(name, data, replace),
  takeReplaces: false,
});

const settingsPart: PartDef = {
  name: "settings",
  read: async () => {
    const s = await readSettings();
    return { data: await pack(s.value), writtenAt: s.writtenAt };
  },
  write: async (data, replace) => applySettings(await unpack<SharedSettings>(data), replace),
  takeReplaces: true,
};

const savedPart: PartDef = {
  name: "saved",
  read: async () => ({ data: await pack(savedSquads()), writtenAt: savedWrittenAt() }),
  write: async (data, replace) => applySaved(await unpack<SavedSquad[]>(data), replace),
  takeReplaces: false,
};

/** FC-Tracker Web shows the Champions weekends the app read (dashboard, Champions tab); it never
 *  writes them – the account's copy is simply taken. */
const WEB_CHAMPS = "fct.web.champions";
const webChampionsPart: PartDef = {
  name: "champions",
  read: async () => ({ data: store.get(WEB_CHAMPS + ".packed") ?? "", writtenAt: 0 }),
  write: async (data) => {
    store.set(WEB_CHAMPS, JSON.stringify(await unpack(data)));
    store.set(WEB_CHAMPS + ".packed", data);
    window.dispatchEvent(new Event("fct-web-champions"));
  },
  takeReplaces: true,
  pullOnly: true,
};

// FC-Tracker Web has the Gallery and Web App parts in the app's formats; Champions only comes in.
const PARTS: PartDef[] = IS_WEB
  ? [rustPart("gallery"), rustPart("webapp"), webChampionsPart, settingsPart, savedPart]
  : [rustPart("gallery"), rustPart("webapp"), rustPart("champions"), settingsPart, savedPart];

type Meta = { v: number; fp: string | null };
const loadMeta = (p: Part): Meta => {
  try {
    return { v: 0, fp: null, ...JSON.parse(store.get(META + p) ?? "{}") };
  } catch {
    return { v: 0, fp: null };
  }
};
const saveMeta = (p: Part, m: Meta) => store.set(META + p, JSON.stringify(m));
const clearMeta = () => PARTS.forEach((p) => store.set(META + p.name, null));

/** Short, cheap fingerprint of a part's data: unchanged data is not sent again. */
function fingerprint(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 3) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

// ------------------------------------------------------------------------------ the API

async function saveSecret(s: Secret | null) {
  secret = s;
  await api.setAccountSecret(s ? JSON.stringify(s) : null);
}

/** A request to the API; throws the error code (string). */
async function call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${await token()}`;
  let r: Response;
  try {
    r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw "offline";
  }
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    const code = (json && typeof json.error === "string" && json.error) || "server";
    if (code === "signed_out" && auth) await signedOutHere();
    throw code;
  }
  return json as T;
}

/** A valid access token (a new one from the refresh token when the last one is about to end). */
async function token(): Promise<string> {
  if (access && access.until > Date.now() + 30_000) return access.token;
  if (!secret) throw "signed_out";
  const r = await call<{ access: string; refresh: string; expires_in: number }>("POST", "/v1/auth/refresh", { refresh: secret.refresh }, false).catch(
    async (e) => {
      if (e === "signed_out") await signedOutHere();
      throw e;
    },
  );
  await saveSecret({ ...secret, refresh: r.refresh });
  access = { token: r.access, until: Date.now() + r.expires_in * 1000 };
  return r.access;
}

/** The server ended this device's sign-in (signed out elsewhere, or the token was copied). */
async function signedOutHere() {
  access = null;
  await saveSecret(null);
  emit({ status: "out", user: null, sync: { phase: "idle", at: null, error: null, conflicts: [] } });
}

function deviceName(): string {
  if (!IS_WEB) return "FC-Tracker app · Windows";
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `FC-Tracker Web · ${browser}`;
}

/** Sends a sign-in code to the address. */
export async function sendCode(email: string): Promise<void> {
  await call("POST", "/v1/auth/start", { email: email.trim(), locale: getLocale() }, false);
}

/** Checks the code; signed in from here on. */
export async function verifyCode(email: string, code: string): Promise<User> {
  const r = await call<{ access: string; refresh: string; expires_in: number; user: User }>(
    "POST",
    "/v1/auth/verify",
    { email: email.trim(), code, device: { name: deviceName(), kind: IS_WEB ? "web" : "app" }, locale: getLocale() },
    false,
  );
  // a new sign-in compares everything with the account afresh (it may be another account)
  clearMeta();
  await saveSecret({ refresh: r.refresh, email: r.user.email });
  access = { token: r.access, until: Date.now() + r.expires_in * 1000 };
  emit({ status: "in", user: r.user });
  void syncNow();
  return r.user;
}

export async function signOut(): Promise<void> {
  await call("POST", "/v1/auth/logout").catch(() => {});
  clearMeta();
  await signedOutHere();
}

export async function updateProfile(patch: { username?: string; ea_name?: string; show_ea?: boolean }): Promise<User> {
  const user = await call<User>("PATCH", "/v1/me", patch);
  emit({ user });
  return user;
}

/** A profile picture: cropped to a square and made 256×256 WebP here, then uploaded. */
export async function uploadAvatar(file: File): Promise<User> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  c.getContext("2d")!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej("avatar_invalid")), "image/webp", 0.85));
  const type = blob.type === "image/webp" ? "image/webp" : "image/png";
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const user = await call<User>("PUT", "/v1/me/avatar", { type, data: btoa(bin) });
  emit({ user });
  return user;
}

export async function removeAvatar(): Promise<User> {
  const user = await call<User>("DELETE", "/v1/me/avatar");
  emit({ user });
  return user;
}

/** Every synced part on the account: version, when and by which device it was last written. */
export const syncedParts = () => call<{ parts: Record<string, CloudPart> }>("GET", "/v1/sync").then((r) => r.parts);

export const devices = () => call<{ devices: Device[] }>("GET", "/v1/me/devices").then((r) => r.devices);
export const revokeDevice = (id: string) => call("DELETE", `/v1/me/devices/${id}`);

/** Everything the server holds about the account, saved as a file. */
export async function exportData(): Promise<void> {
  const data = await call<unknown>("GET", "/v1/me/export");
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "fc-tracker-account.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function deleteAccount(): Promise<void> {
  await call("DELETE", "/v1/me");
  clearMeta();
  await signedOutHere();
}

// ------------------------------------------------------------------------------- the sync

/** Account copies waiting for the user's choice (with their data). */
const pending = new Map<Part, { version: number; data: string }>();

async function push(p: PartDef, local: Local, base: number): Promise<void> {
  const r = await call<{ version: number }>("PUT", `/v1/sync/${p.name}`, { base_version: base, data: local.data, written_at: local.writtenAt || null });
  saveMeta(p.name, { v: r.version, fp: fingerprint(local.data) });
}

/** Takes the account's copy (merged or replacing) and remembers that the two agree now. */
async function take(p: PartDef, cloud: { version: number; data: string }, replace: boolean): Promise<void> {
  await p.write(cloud.data, replace);
  const after = await p.read();
  saveMeta(p.name, { v: cloud.version, fp: after ? fingerprint(after.data) : null });
}

async function syncPart(p: PartDef, info: CloudPart | undefined): Promise<Conflict | null> {
  const meta = loadMeta(p.name);
  const local = await p.read();
  if (!local) return null;
  const fp = fingerprint(local.data);
  const cv = info?.version ?? 0;
  if (p.pullOnly) {
    if (cv !== meta.v && cv > 0) {
      const cloud = await call<{ version: number; data?: string }>("GET", `/v1/sync/${p.name}`);
      if (cloud.data) await p.write(cloud.data, true);
      saveMeta(p.name, { v: cloud.version, fp: null });
    }
    return null;
  }
  const localChanged = fp !== meta.fp;
  const cloudChanged = cv !== meta.v;
  if (!cloudChanged) {
    if (localChanged) await push(p, local, cv);
    return null;
  }
  const cloud = await call<{ version: number; data?: string; written_at?: number | null; updated_at?: number }>("GET", `/v1/sync/${p.name}`);
  if (!cloud.data) {
    // the account's copy is gone (deleted elsewhere): this device's becomes it
    await push(p, local, cloud.version);
    return null;
  }
  if (cloud.data === local.data) {
    saveMeta(p.name, { v: cloud.version, fp });
    return null;
  }
  if (!localChanged) {
    await take(p, { version: cloud.version, data: cloud.data }, p.takeReplaces);
    return null;
  }
  pending.set(p.name, { version: cloud.version, data: cloud.data });
  return { part: p.name, cloudAt: cloud.written_at ?? cloud.updated_at ?? 0, cloudDevice: info?.device ?? null, localAt: local.writtenAt };
}

let syncing: Promise<void> | null = null;
/** Compares every part with the account's and brings the two together (see the top). */
export function syncNow(): Promise<void> {
  if (syncing) return syncing;
  syncing = run().finally(() => (syncing = null));
  return syncing;

  async function run() {
    if (state.status !== "in") return;
    setSync({ phase: "syncing", error: null });
    try {
      const { parts } = await call<{ parts: Record<string, CloudPart> }>("GET", "/v1/sync");
      const conflicts: Conflict[] = [];
      let error: string | null = null;
      for (const p of PARTS) {
        // a part waiting for the user's choice is left alone until then
        if (state.sync.conflicts.some((c) => c.part === p.name)) {
          conflicts.push(state.sync.conflicts.find((c) => c.part === p.name)!);
          continue;
        }
        try {
          const c = await syncPart(p, parts[p.name]);
          if (c) conflicts.push(c);
        } catch (e) {
          // another device was faster (409): the next round sees its copy
          if (e !== "sync_conflict") error = String(e);
        }
      }
      setSync({ phase: conflicts.length ? "conflict" : error ? "error" : "idle", at: Date.now(), error, conflicts });
    } catch (e) {
      setSync({ phase: "error", error: String(e) });
    }
  }
}

/** The user's choice for the parts that disagree: the account's, this device's, or both. */
export async function resolveConflicts(choice: "cloud" | "local" | "both"): Promise<void> {
  const list = state.sync.conflicts;
  setSync({ phase: "syncing", error: null });
  let error: string | null = null;
  for (const c of list) {
    const p = PARTS.find((x) => x.name === c.part);
    const cloud = pending.get(c.part);
    if (!p || !cloud) continue;
    try {
      if (choice === "cloud") await take(p, cloud, true);
      else {
        if (choice === "both") await p.write(cloud.data, false);
        const local = await p.read();
        if (local) await push(p, local, cloud.version);
      }
      pending.delete(c.part);
    } catch (e) {
      if (e !== "sync_conflict") error = String(e);
      pending.delete(c.part);
    }
  }
  setSync({ conflicts: [], phase: error ? "error" : "idle", error, at: Date.now() });
  // a device that wrote meanwhile shows up again – compared afresh
  await syncNow();
}

let started = false;
let soon: ReturnType<typeof setTimeout> | null = null;
/** A sync shortly (things changed here): several changes in a row make one sync. */
export function syncSoon(ms = 20_000) {
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => void syncNow(), ms);
}

/** At start: the saved sign-in, the profile, then the sync every few minutes and after every
 *  Web App sync. */
export async function startAccount(): Promise<void> {
  if (started) return;
  started = true;
  const raw = await api.accountSecret().catch(() => null);
  try {
    secret = raw ? (JSON.parse(raw) as Secret) : null;
  } catch {
    secret = null;
  }
  setInterval(() => {
    if (state.status !== "in") return;
    if (!state.user) call<User>("GET", "/v1/me").then((user) => emit({ user })).catch(() => {});
    void syncNow();
  }, SYNC_EVERY);
  // FC-Tracker Web wires its own Web App sync to syncSoon (src/web/main.tsx)
  if (!IS_WEB) {
    void events.onSyncDone(() => syncSoon(2_000));
    void events.onChampions(() => syncSoon(60_000));
  }
  if (!secret) return emit({ status: "out" });
  emit({ status: "in" });
  try {
    emit({ user: await call<User>("GET", "/v1/me") });
  } catch {
    /* offline: stays signed in, tries again with the next sync */
  }
  void syncNow();
}
