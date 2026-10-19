import { useEffect, useState } from "react";
import { browserPad } from "./browserPad";
import { t, useLocale } from "./i18n";

/**
 * Website demo only: tells visitors they can drive the demo with a controller, and which buttons
 * do what once one is connected (the browser shows a controller after its first button press).
 */
export default function DemoPad() {
  useLocale();
  const [pad, setPad] = useState<string | null>(() => ([...(navigator.getGamepads?.() ?? [])].find(Boolean)?.id ?? null));
  const [fresh, setFresh] = useState(false);

  useEffect(
    () =>
      browserPad.onConnect((id) => {
        setPad(id);
        setFresh(!!id);
      }),
    [],
  );
  // the button legend stays a few seconds after connecting, then folds into a small badge
  useEffect(() => {
    if (!fresh) return;
    const id = setTimeout(() => setFresh(false), 7000);
    return () => clearTimeout(id);
  }, [fresh]);

  return (
    <div className={`demo-pad ${pad ? "on" : ""} ${fresh ? "fresh" : ""}`} role="status" aria-live="polite">
      <svg className="demo-pad-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 7h10a5 5 0 0 1 4.9 6l-.8 4a2.5 2.5 0 0 1-4.4 1L15 16H9l-1.7 2a2.5 2.5 0 0 1-4.4-1l-.8-4A5 5 0 0 1 7 7Zm0 3v1.5H5.5v1.5H7v1.5h1.5V13H10v-1.5H8.5V10Zm9 .5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-2 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" />
      </svg>
      {!pad ? (
        <span>{t("demo.padHint")}</span>
      ) : fresh ? (
        <span>
          <b>{t("demo.padConnected")}</b> {t("demo.padLegend")}
        </span>
      ) : (
        <span>{t("demo.padOn")}</span>
      )}
    </div>
  );
}
