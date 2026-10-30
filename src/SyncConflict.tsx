/**
 * When this device and the account both changed the same data since they last matched: the
 * user chooses – the account's copy, this device's, or both combined. Shows when each was
 * written, so a local save that failed (or an old copy) is easy to spot. Nothing is chosen
 * silently; until then that part isn't synced.
 */
import { useState } from "react";
import "./account.css";
import { resolveConflicts, useAccount, type Part } from "./account";
import { t, type MessageKey } from "./i18n";

export function timeAgo(ms: number): string {
  if (!ms) return t("account.unknownTime");
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return t("account.justNow");
  if (min < 60) return t("account.minutesAgo", { n: min });
  const h = Math.round(min / 60);
  if (h < 48) return t("account.hoursAgo", { n: h });
  return t("account.daysAgo", { n: Math.round(h / 24) });
}

const PART_KEY: Record<Part, MessageKey> = {
  gallery: "account.part.gallery",
  webapp: "account.part.webapp",
  champions: "account.part.champions",
  settings: "account.part.settings",
  saved: "account.part.saved",
};

export default function SyncConflict() {
  const acc = useAccount();
  const [busy, setBusy] = useState(false);
  const list = acc.sync.conflicts;
  if (acc.status !== "in" || list.length === 0) return null;
  const choose = (c: "cloud" | "local" | "both") => {
    setBusy(true);
    void resolveConflicts(c).finally(() => setBusy(false));
  };
  return (
    <div className="acct-modal">
      <section className="acct-dialog acct" role="alertdialog" aria-modal="true" aria-labelledby="acct-conflict-t">
        <h2 id="acct-conflict-t">{t("account.conflict.title")}</h2>
        <p>{busy ? t("account.conflict.working") : t("account.conflict.text")}</p>
        <ul className="acct-parts">
          {list.map((c) => (
            <li key={c.part}>
              <b>{t(PART_KEY[c.part])}</b>
              <span className={c.cloudAt > c.localAt ? "newer" : ""}>
                {t("account.conflict.cloud", { when: timeAgo(c.cloudAt), device: c.cloudDevice ?? t("account.conflict.otherDevice") })}
              </span>
              <span className={c.localAt >= c.cloudAt ? "newer" : ""}>{t("account.conflict.local", { when: timeAgo(c.localAt) })}</span>
            </li>
          ))}
        </ul>
        <div className="acct-choices">
          <button className="ln-btn small" disabled={busy} onClick={() => choose("both")}>
            {t("account.conflict.useBoth")}
          </button>
          <button className="ln-btn small ghost" disabled={busy} onClick={() => choose("cloud")}>
            {t("account.conflict.useCloud")}
          </button>
          <button className="ln-btn small ghost" disabled={busy} onClick={() => choose("local")}>
            {t("account.conflict.useLocal")}
          </button>
        </div>
      </section>
    </div>
  );
}
