/**
 * The site's own header and footer on the dashboard (mockup 11 / fc-tracker.com: site/v2.mjs header() + footer()):
 * the floating bar – menu far left · brand · the site's links with Dashboard active · the account and "Download →"
 * always right – and the footer with the tagline, the pages, the languages and the theme. Same markup and look as
 * the static site; the words come from the app's i18n (the dashboard is the app's page), the links follow the
 * site's language prefixes (en at the root).
 */
import { useEffect, useRef, useState } from "react";
import { LOCALE_NAMES, getLocale, t, useLocale, type Locale } from "../i18n";
import { THEMES, type Theme } from "../theme";
import { Avatar } from "../OverlayMenu";
import { Mark } from "../ui";

const SLUG = { home: "", story: "how-it-plays-out", guide: "fc-27-gallery-guide", optimize: "fc-27-gallery-optimize", champsTracker: "fc-27-champions-tracker", champions: "fc-27-champions-leaderboard", faq: "faq", download: "download", legal: "legal" } as const;
type Page = keyof typeof SLUG;
/** On its own host (dashboard.fc-tracker.com) the site's pages are on www – never served twice. */
const SITE = typeof location !== "undefined" && location.hostname === "dashboard.fc-tracker.com" ? "https://www.fc-tracker.com" : "";
const url = (page: Page, lang: Locale = getLocale()) => {
  const prefix = lang === "en" ? "" : `/${lang}`;
  return SITE + (SLUG[page] ? `${prefix}/${SLUG[page]}` : prefix || "/");
};
const NAV_KEY: Record<Page, Parameters<typeof t>[0]> = {
  home: "v2web.site.home",
  story: "v2web.site.story",
  guide: "v2web.site.guide",
  optimize: "v2web.site.optimize",
  champsTracker: "v2web.site.champsTracker",
  champions: "v2web.site.champions",
  faq: "v2web.site.faq",
  download: "v2web.site.download",
  legal: "v2web.site.privacy",
};
/** The account link's person icon. */
const Me = () => (
  <svg className="dv-sh-me" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="5.5" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M2.8 14c.6-2.8 2.7-4.3 5.2-4.3s4.6 1.5 5.2 4.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
/** A link out: FC-Tracker Web opens as its own tool. */
const Ext = () => (
  <svg className="ext" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 3h7v7M13 3 4 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
  </svg>
);
const Arrow = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
  </svg>
);

export function SiteHeader({ signedIn, name, onAccount, theme, setTheme }: { signedIn: boolean; name: string | null; onAccount: () => void; theme?: Theme; setTheme?: (t: Theme) => void }) {
  const [lang, setLang] = useLocale();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [open]);
  const link = (p: Page) => (
    <a key={p} href={url(p, lang)}>
      {t(NAV_KEY[p])}
    </a>
  );
  return (
    <header className="dv-sh">
      <div className="dv-sh-bar">
        <div className="dv-sh-more" ref={ref}>
          <button className="dv-sh-menu" aria-label={t("v2web.site.menu")} aria-expanded={open} onClick={() => setOpen(!open)}>
            <i />
            <i />
          </button>
          {open && (
            <div className="dv-sh-pop panel ring">
              <nav className="dv-sh-pop-links" aria-label={t("v2web.site.menu")}>
                {/* the site's menu, in its order (site/v2.mjs header) */}
                {(["home", "story", "guide", "champsTracker", "faq", "champions", "optimize"] as Page[]).map(link)}
                <i className="dv-sh-pop-rule" />
                <a href={`${SITE}/web`} target="_blank" rel="noopener">
                  {t("v2web.site.web")} <Ext />
                </a>
                <a href={SITE ? "/" : "/dashboard"} aria-current="page" className="on">
                  {t("v2web.site.dashboard")}
                </a>
                {link("download")}
              </nav>
              <nav className="dv-sh-pop-langs" aria-label={t("v2web.site.language")}>
                {(Object.keys(LOCALE_NAMES) as Locale[]).map((l) => (
                  <button key={l} lang={l} aria-current={l === lang ? "true" : undefined} onClick={() => setLang(l)}>
                    <b>{l.toUpperCase()}</b>
                    <span>{LOCALE_NAMES[l]}</span>
                  </button>
                ))}
              </nav>
              {theme && setTheme && (
                <div className="seg dv-sh-pop-theme" role="group" aria-label={t("overlay.theme")}>
                  {THEMES.map((th) => (
                    <button key={th} type="button" aria-pressed={theme === th} onClick={() => setTheme(th)}>
                      {t(`theme.${th}` as Parameters<typeof t>[0])}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <a className="brand" href={url("home", lang)}>
          <Mark size={26} />
          <span>FC-Tracker</span>
        </a>
        <nav className="dv-sh-nav" aria-label={t("v2web.site.menu")}>
          {(["home", "story", "guide"] as Page[]).map(link)}
        </nav>
        <div className="dv-sh-acts">
          <a className="btn btn-secondary ring btn-s dv-sh-tool" href={`${SITE}/web`} target="_blank" rel="noopener">
            {t("v2web.site.web")} <Ext />
          </a>
          {signedIn ? (
            <button className="dv-sh-login" onClick={onAccount} title={t("menu.profile")}>
              <Avatar size={24} />
              <span className="ellip">{name ?? t("account.noName")}</span>
            </button>
          ) : (
            <span className="dv-sh-login" aria-current="page">
              <Me />
              <span>{t("v2web.site.login")}</span>
            </span>
          )}
          <a className="btn btn-ink btn-s" href={url("download", lang)}>
            {t("v2web.site.download")} <Arrow />
          </a>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const [lang, setLang] = useLocale();
  return (
    <footer className="dv-sf">
      <div className="dv-sf-in">
        <span className="row dv-sf-brand">
          <Mark size={22} />
          <b>FC-Tracker</b>
          <span>{t("brand.tagline")}</span>
        </span>
        <nav className="row dv-sf-links" aria-label="FC-Tracker">
          {(["guide", "story", "champsTracker", "champions", "faq", "download"] as Page[]).map((p) => (
            <a key={p} href={url(p, lang)}>
              {t(NAV_KEY[p])}
            </a>
          ))}
          <a href={`${SITE}/web`} target="_blank" rel="noopener">
            {t("v2web.site.web")}
          </a>
          <a href={url("legal", lang)}>{t("v2web.site.privacy")}</a>
          <a href={`${SITE}/source`}>{t("v2web.site.source")}</a>
        </nav>
      </div>
      <div className="dv-sf-in dv-sf-fine">
        <p>{t("web.unofficial")}</p>
        <div className="row dv-sf-set">
          <nav className="row dv-sf-langs" aria-label={t("v2web.site.language")}>
            {(Object.keys(LOCALE_NAMES) as Locale[]).map((l) => (
              <button key={l} lang={l} aria-current={l === lang ? "true" : undefined} onClick={() => setLang(l)}>
                {LOCALE_NAMES[l]}
              </button>
            ))}
          </nav>
          <div className="dv-sf-theme" role="group" aria-label={t("overlay.theme")}>
            {THEMES.map((th) => (
              <button key={th} type="button" aria-pressed={theme === th} onClick={() => setTheme(th)}>
                {t(`theme.${th}` as Parameters<typeof t>[0])}
              </button>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
