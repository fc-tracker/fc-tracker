import { useEffect, useRef, useState } from "react";
import { api, type TrackingInfo, type TrackingPrefs } from "./api";
import { t, type MessageKey } from "./i18n";

const PRESETS = ["auto", "light", "balanced", "fast", "max", "custom"] as const;

/**
 * Settings → Tracking speed: how often the game is looked at and how soon each kind of screen is
 * read. A preset (Auto picks one from the PC's specs) or every value by hand – changing a value
 * switches to Custom. Saved in ui.json; nothing runs during a match.
 */
export default function Speed() {
  const [info, setInfo] = useState<TrackingInfo | null>(null);
  const save = useRef<number>(0);
  useEffect(() => {
    api.trackingSpeed().then(setInfo).catch(() => {});
  }, []);
  if (!info) return null;

  const e = info.effective;
  const apply = (prefs: TrackingPrefs, now = false) => {
    setInfo({ ...info, prefs, effective: prefs.preset === "custom" ? prefs : info.effective });
    window.clearTimeout(save.current);
    const send = () => api.setTrackingSpeed(prefs).then(setInfo).catch(() => {});
    if (now) send();
    else save.current = window.setTimeout(send, 400);
  };
  // editing any value: Custom, starting from the values in force
  const edit = (patch: Partial<TrackingPrefs>) => apply({ ...e, ...patch, preset: "custom" });
  const pc = info.specs;
  const looks = Math.round(1000 / Math.max(16, e.watch_ms));

  return (
    <div className="speed">
      <p className="speed-lead">{t("speed.lead")}</p>
      <p className="speed-pc">
        {t("speed.pc", { threads: pc.threads, ram: pc.ram_gb })}
        {pc.gpu && ` · ${pc.gpu}`}
        {pc.on_battery && ` · ${t("speed.battery")}`}
        {" – "}
        <b>{t("speed.recommended", { preset: t(`speed.p.${pc.recommended}` as MessageKey) })}</b>
      </p>

      <div className="speed-presets" role="group" aria-label={t("speed.preset")}>
        {PRESETS.map((p) => (
          <button
            key={p}
            className={`ln-btn small ${info.prefs.preset === p ? "" : "ghost"}`}
            aria-pressed={info.prefs.preset === p}
            onClick={() => apply(p === "custom" ? { ...e, preset: "custom" } : { ...info.prefs, preset: p }, true)}
          >
            {t(`speed.p.${p}` as MessageKey)}
          </button>
        ))}
      </div>
      {info.prefs.preset === "auto" && <p className="ln-hint">{t("speed.autoHint", { preset: t(`speed.p.${pc.recommended}` as MessageKey) })}</p>}

      <div className="ln-rows">
        <Row title={t("speed.continuous")} text={t("speed.continuousText")}>
          <button className={`ln-btn small ${e.continuous ? "" : "ghost"}`} aria-pressed={e.continuous} onClick={() => edit({ continuous: !e.continuous })}>
            {e.continuous ? t("settings.on") : t("settings.off")}
          </button>
        </Row>
        <Row title={t("speed.watch")} text={t("speed.watchText")}>
          <Num value={e.watch_ms} min={e.continuous ? 16 : 50} max={1000} step={e.watch_ms < 100 ? 1 : 10} unit="ms" onChange={(v) => edit({ watch_ms: v })} />
        </Row>
        <Row title={t("speed.same")} text={t("speed.sameText")}>
          <button className={`ln-btn small ${e.same_for_all ? "" : "ghost"}`} aria-pressed={e.same_for_all} onClick={() => edit({ same_for_all: !e.same_for_all })}>
            {e.same_for_all ? t("settings.on") : t("settings.off")}
          </button>
        </Row>
        {e.same_for_all ? (
          <Row title={t("speed.all")} text={t("speed.allText")}>
            <Secs ms={e.all_ms} onChange={(v) => edit({ all_ms: v })} />
          </Row>
        ) : (
          <>
            <Row title={t("speed.still")} text={t("speed.stillText")}>
              <Secs ms={e.still_ms} onChange={(v) => edit({ still_ms: v })} />
            </Row>
            <Row title={t("speed.animated")} text={t("speed.animatedText")}>
              <Secs ms={e.animated_ms} onChange={(v) => edit({ animated_ms: v })} />
            </Row>
            <Row title={t("speed.market")} text={t("speed.marketText")}>
              <Secs ms={e.market_ms} onChange={(v) => edit({ market_ms: v })} />
            </Row>
          </>
        )}
        <Row title={t("speed.inMatch")} text={t("speed.inMatchText")}>
          <Num value={e.match_ms} min={500} max={3000} step={100} unit="ms" onChange={(v) => edit({ match_ms: v })} />
        </Row>
      </div>
      <p className="ln-hint">
        {t("speed.cost", { looks })} {t("speed.match")}
      </p>
    </div>
  );
}

function Row({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <div className="ln-row">
      <div>
        <b>{title}</b>
        <p>{text}</p>
      </div>
      {children}
    </div>
  );
}

/** A number with a slider and a field. */
function Num({ value, min, max, step, unit, onChange }: { value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  return (
    <span className="speed-num">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(ev) => onChange(clamp(Number(ev.target.value)))} aria-label={unit} />
      <input type="number" min={min} max={max} step={step} value={value} onChange={(ev) => onChange(clamp(Number(ev.target.value)))} />
      <span>{unit}</span>
    </span>
  );
}

/** A read delay, shown and typed in seconds (0–10 s, 0.05 s steps). */
function Secs({ ms, onChange }: { ms: number; onChange: (ms: number) => void }) {
  const [text, setText] = useState((ms / 1000).toFixed(2));
  useEffect(() => setText((ms / 1000).toFixed(2)), [ms]);
  const set = (s: number) => onChange(Math.round(Math.min(10, Math.max(0, s)) * 1000));
  return (
    <span className="speed-num">
      <input type="range" min={0} max={5} step={0.05} value={ms / 1000} onChange={(ev) => set(Number(ev.target.value))} aria-label="s" />
      <input
        type="number"
        min={0}
        max={10}
        step={0.05}
        value={text}
        onChange={(ev) => setText(ev.target.value)}
        onBlur={() => set(Number(text.replace(",", ".")) || 0)}
        onKeyDown={(ev) => ev.key === "Enter" && set(Number(text.replace(",", ".")) || 0)}
      />
      <span>s</span>
    </span>
  );
}
