import { useRef, useState, type KeyboardEvent } from "react";
import ControlStage, { CONTROLS, type ControlId } from "./ControlDemo";
import { t, type MessageKey } from "./i18n";
import { DpadGlyph, PadButton, PlayStationLogo, XboxLogo, usePadLayout, type PadLayout } from "./padGlyphs";

type Topic = "controls";

/**
 * Help (launcher), category "Controls" – laid out like the game's own settings: the controls on
 * the left (buttons of the user's controller, detected or picked), and on the right a looping
 * example of the selected one with its description and keyboard keys.
 */
export default function Help({ topic = "controls" }: { topic?: Topic }) {
  const { layout, choice, controller, setChoice } = usePadLayout();
  const [sel, setSel] = useState<ControlId>("overlay");
  const list = useRef<HTMLDivElement>(null);
  const pick = (l: PadLayout) => setChoice(choice === l ? "auto" : l);
  const current = CONTROLS.find((c) => c.id === sel) ?? CONTROLS[0];

  // ↑ / ↓ move through the list like a menu
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = CONTROLS.findIndex((c) => c.id === sel);
    const next = CONTROLS[(i + (e.key === "ArrowDown" ? 1 : CONTROLS.length - 1)) % CONTROLS.length];
    setSel(next.id);
    list.current?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.focus();
  };

  return (
    <section className="ln-page ln-help">
      <h1>{t("nav.help")}</h1>
      <div className="help-bar">
        <nav className="help-tabs" aria-label={t("nav.help")}>
          <span className={topic === "controls" ? "on" : ""}>{t("help.cat.controls")}</span>
        </nav>
        <p className="help-detected">
          {controller ? t("help.detected", { name: controller.name }) : t("help.noController")}
          {choice !== "auto" && (
            <button className="ln-link help-auto" onClick={() => setChoice("auto")}>
              {t("help.auto")}
            </button>
          )}
        </p>
        <div className="help-switch" role="group" aria-label={t("help.layout")}>
          <button className={layout === "playstation" ? "on" : ""} aria-pressed={layout === "playstation"} onClick={() => pick("playstation")}>
            <PlayStationLogo /> PlayStation
          </button>
          <button className={layout === "xbox" ? "on" : ""} aria-pressed={layout === "xbox"} onClick={() => pick("xbox")}>
            <XboxLogo /> Xbox
          </button>
        </div>
      </div>

      <div className="help-main">
        <div className="help-list" role="listbox" aria-label={t("help.cat.controls")} ref={list} onKeyDown={onKey}>
          {(["show", "overlay"] as const).map((g) => (
            <div key={g} className="help-group" role="group" aria-label={t(`help.group.${g}`)}>
              <p className="help-group-title">{t(`help.group.${g}`)}</p>
              {CONTROLS.filter((c) => c.group === g).map((c) => (
                <button
                  key={c.id}
                  data-id={c.id}
                  role="option"
                  aria-selected={c.id === sel}
                  tabIndex={c.id === sel ? 0 : -1}
                  className={`help-item ${c.id === sel ? "on" : ""}`}
                  onClick={() => setSel(c.id)}
                  onFocus={() => setSel(c.id)}
                >
                  <span className="help-item-name">{t(`help.c.${c.id}.title` as MessageKey)}</span>
                  <span className="help-item-pad">
                    {c.gesture && <small>{t(`help.${c.gesture}`)}</small>}
                    {c.id === "move" ? <DpadGlyph size={24} /> : c.buttons.map((b) => <PadButton key={b} id={b} layout={layout} size={22} />)}
                  </span>
                </button>
              ))}
            </div>
          ))}
          <p className="ln-hint help-note">{t("help.matchNote")}</p>
        </div>

        <article className="help-preview" aria-live="polite">
          <header className="help-preview-head" key={sel}>
            <p className="help-eyebrow">{t(`help.group.${current.group}`)}</p>
            <h2 className="help-title">
              {t(`help.c.${sel}.title` as MessageKey)
                .split(" ")
                .map((w, k) => (
                  <span className="help-w" key={k}>
                    <span style={{ ["--k" as string]: k }}>{w}</span>
                  </span>
                ))}
            </h2>
          </header>
          <ControlStage key={`${sel}-${layout}`} id={sel} layout={layout} />
          <p className="help-desc" key={`d-${sel}`}>
            {t(`help.c.${sel}.desc` as MessageKey)}
          </p>
          <p className="help-keys">
            <span>{t("help.keyboard")}</span>
            {current.keys.length ? current.keys.map((k) => <kbd key={k}>{k}</kbd>) : <kbd>{t("help.wheel")}</kbd>}
          </p>
        </article>
      </div>
    </section>
  );
}
