// Dev only (`?check` in the dev preview): the launcher's layout check matrix (BRAND-MIGRATION rule 10).
// window.__launcherMatrix() walks zoom 90 / 100 / 125 × every page (Home, Club, Settings: General + Tracking
// speed, Help: every control, Account) and the popups the URL's ?mock= shows, and returns the failures:
// horizontal scroll, overlap (top bar, footer, tiles), frames not enclosing their content, text < 12 px,
// top bar not on one row. The window sizes come from outside (resize the window, reload).

type Fail = { where: string; rule: string; what: string };

const vis = (e: Element) => {
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
};
const name = (e: Element) => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className || "").split(" ").filter(Boolean).slice(0, 3).join(".")}`;
const text = (e: Element) => (e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
const overlap = (a: DOMRect, b: DOMRect, slack = 1) => a.left < b.right - slack && b.left < a.right - slack && a.top < b.bottom - slack && b.top < a.bottom - slack;
/** Pictures, not UI text: EA's card art (src/ui FutCard / FaceChip / Grade, v2-app) and Help's scaled example stage. */
const ART = ".fut, .face-w, .grade, .cs";
const inArt = (e: Element) => !!e.closest(ART);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(where: string): Fail[] {
  const out: Fail[] = [];
  const add = (rule: string, what: string) => out.push({ where, rule, what });
  const root = document.documentElement;
  // no horizontal scroll: the page, the body and any panel
  if (root.scrollWidth > root.clientWidth + 1) add("h-scroll", `page ${root.scrollWidth} > ${root.clientWidth}`);
  for (const e of document.querySelectorAll(".ln-body, .panel, .tile, .acct-dialog, .fu-panel")) {
    const el = e as HTMLElement;
    const ox = getComputedStyle(el).overflowX;
    if (vis(el) && (ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 1) add("h-scroll", `${name(el)} ${el.scrollWidth} > ${el.clientWidth}`);
  }
  // top bar: one row, its three parts apart, inside the bar
  const top = document.querySelector(".ln-top");
  if (top) {
    const tr = top.getBoundingClientRect();
    const parts = [".ln-brandline", ".ln-tabnav", ".ln-top-right"].map((s) => top.querySelector(s)).filter((e): e is Element => !!e && vis(e));
    for (let i = 0; i < parts.length; i++) {
      const r = parts[i].getBoundingClientRect();
      if (r.top < tr.top - 1 || r.bottom > tr.bottom + 1 || r.left < tr.left - 1 || r.right > tr.right + 1) add("top-bar", `${name(parts[i])} outside the bar`);
      for (let j = i + 1; j < parts.length; j++) if (overlap(r, parts[j].getBoundingClientRect())) add("top-bar", `${name(parts[i])} overlaps ${name(parts[j])}`);
    }
    // every item of the bar, not only its parts (review LA-1: a part's content can spill out of its own box
    // – the right part overflows to the left, which no scrollWidth shows)
    const items = [...top.querySelectorAll(".ln-brand, .ln-tagline, .key, .tab, .support-btn, .coins, .chip, .ln-online")].filter(vis);
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (r.left < tr.left - 1 || r.right > tr.right + 1) add("top-bar", `${name(items[i])} "${text(items[i])}" outside the bar`);
      for (let j = i + 1; j < items.length; j++) {
        if (items[i].contains(items[j]) || items[j].contains(items[i])) continue;
        if (overlap(r, items[j].getBoundingClientRect())) add("top-bar", `${name(items[i])} "${text(items[i])}" overlaps ${name(items[j])} "${text(items[j])}"`);
      }
    }
    const tabs = [...top.querySelectorAll(".tab")].map((t) => t.getBoundingClientRect().top);
    if (tabs.length && Math.max(...tabs) - Math.min(...tabs) > 2) add("top-bar", "tabs wrap to a second row");
    for (const e of top.querySelectorAll(".tab, .support-btn, .chip, .coins")) if (vis(e) && (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth + 1) add("top-bar", `${name(e)} cut "${text(e)}"`);
  }
  // footer hints never overlap each other or leave the strip
  const foot = document.querySelector(".ln-foot");
  if (foot) {
    const keys = [...foot.querySelectorAll(".key")].filter(vis).map((k) => k.getBoundingClientRect());
    const fr = foot.getBoundingClientRect();
    keys.forEach((k, i) => {
      if (k.right > fr.right + 1 || k.left < fr.left - 1) add("overlap", `footer hint ${i} leaves the strip`);
      for (let j = i + 1; j < keys.length; j++) if (overlap(k, keys[j])) add("overlap", `footer hints ${i} and ${j}`);
    });
  }
  // tiles and rail panels never overlap one another
  const boxes = [...document.querySelectorAll(".lh-t, .ln-status, .ln-notes")].filter(vis);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i].getBoundingClientRect(), boxes[j].getBoundingClientRect())) add("overlap", `${name(boxes[i])} × ${name(boxes[j])}`);
  // frames enclose their content (§16): every visible leaf inside a frame stays inside it (a list that scrolls
  // or fades is fine – its own box is checked instead)
  for (const f of document.querySelectorAll(".panel, .tile, .lrow, .btn, .seg, .chip, .toast, .fu-panel, .acct-dialog")) {
    if (!vis(f)) continue;
    const fr = f.getBoundingClientRect();
    for (const c of f.querySelectorAll("*")) {
      if (c.children.length || !vis(c) || !(c.textContent ?? "").trim() || (inArt(c) && !f.matches(ART))) continue;
      // inside a scroller that is itself inside the frame: the scroller's job
      let p = c.parentElement;
      let scrolled = false;
      while (p && p !== f) {
        const o = getComputedStyle(p);
        if (/(auto|scroll)/.test(o.overflowY + o.overflowX)) scrolled = true;
        p = p.parentElement;
      }
      if (scrolled) continue;
      const r = c.getBoundingClientRect();
      if (r.right > fr.right + 2 || r.bottom > fr.bottom + 2 || r.left < fr.left - 2 || r.top < fr.top - 2) {
        add("frame", `${name(c)} "${text(c)}" leaves ${name(f)}`);
        break;
      }
    }
  }
  // text ≥ 12 px (CSS px – the user's zoom is theirs)
  const small = new Set<string>();
  for (const e of document.querySelectorAll(".ln *, .fu-scrim *, .acct-modal *")) {
    if (inArt(e) || !vis(e) || ![...e.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) continue;
    const fs = parseFloat(getComputedStyle(e).fontSize);
    if (fs < 11.9) small.add(`${name(e)} ${fs}px "${text(e)}"`);
  }
  small.forEach((s) => add("text<12", s));
  return out;
}

async function setZoom(z: number) {
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, ctrlKey: true }));
  key("0");
  const steps = z === 0.9 ? ["-"] : z === 1.25 ? ["+", "+"] : [];
  for (const s of steps) {
    await sleep(60);
    key(s);
  }
  await sleep(400);
}
const clickTab = async (i: number) => {
  (document.querySelectorAll(".ln-top .tab")[i] as HTMLElement | undefined)?.click();
  await sleep(500);
};

async function matrix(): Promise<Fail[]> {
  const st = document.createElement("style");
  st.textContent = "*{transition:none!important;animation:none!important}";
  document.head.appendChild(st);
  const all: Fail[] = [];
  const size = `${innerWidth}×${innerHeight}`;
  const popup = !!document.querySelector(".fu-scrim, .acct-modal, .fu-l3-dock");
  for (const z of [0.9, 1, 1.25]) {
    await setZoom(z);
    const at = (p: string) => `${size} @${Math.round(z * 100)}% ${p}`;
    if (popup) {
      all.push(...check(at("popup")));
      continue;
    }
    const tabs = [...document.querySelectorAll(".ln-top .tab")].map((t) => (t.textContent ?? "").replace(/\d+/g, "").trim());
    for (let i = 0; i < tabs.length; i++) {
      await clickTab(i);
      if (tabs[i] === "Settings") {
        const segs = [...document.querySelectorAll(".ln-page-head .seg")] as HTMLElement[];
        for (const s of segs) {
          s.click();
          await sleep(400);
          all.push(...check(at(`Settings/${(s.textContent ?? "").trim()}`)));
        }
      } else if (tabs[i] === "Help") {
        const items = [...document.querySelectorAll(".help-item")] as HTMLElement[];
        for (const it of items) {
          it.click();
          await sleep(250);
          all.push(...check(at(`Help/${(it.querySelector(".help-item-name")?.textContent ?? "").trim()}`)));
        }
      } else all.push(...check(at(tabs[i])));
    }
    await clickTab(0);
  }
  await setZoom(1);
  // one line per distinct failure (the same rule on the same element across pages/zooms is one problem)
  const seen = new Map<string, Fail & { n: number }>();
  for (const f of all) {
    const k = `${f.rule}|${f.what}`;
    const s = seen.get(k);
    if (s) s.n++;
    else seen.set(k, { ...f, n: 1 });
  }
  return [...seen.values()];
}

export function installLayoutCheck() {
  (window as unknown as { __launcherMatrix: typeof matrix; __launcherCheck: typeof check }).__launcherMatrix = matrix;
  (window as unknown as { __launcherCheck: typeof check }).__launcherCheck = check;
}
