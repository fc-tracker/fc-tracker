/**
 * Settings → Account: sign in with a code by e-mail (no password), then the name shown on the
 * trackers (username, or an EA name the user may show instead), the sync of this PC's data,
 * the devices signed in, export and delete. Every wait says what is happening.
 */
import { useEffect, useState } from "react";
import {
  deleteAccount,
  devices as loadDevices,
  exportData,
  removeAvatar,
  revokeDevice,
  sendCode,
  signOut,
  startAccount,
  syncNow,
  updateProfile,
  uploadAvatar,
  useAccount,
  verifyCode,
  type Device,
} from "./account";
import { t, tError } from "./i18n";
import { timeAgo as ago } from "./SyncConflict";
import { Avatar } from "./OverlayMenu";
import "./account.css";

const NAME_RE = /^[\p{L}\p{N} _.\-]{3,16}$/u;

export function Account() {
  const acc = useAccount();
  useEffect(() => void startAccount(), []);
  if (acc.status === "loading") return <p className="ln-note">{t("account.loading")}</p>;
  if (acc.status === "out") return <div className="acct"><SignIn /></div>;
  // the first sign-in made the account: the profile comes first (the name others see)
  if (acc.user && !acc.user.username) return <div className="acct"><Welcome /></div>;
  return <div className="acct"><SignedIn /></div>;
}

/** Profile & account in a dialog (overlay menu, FC-Tracker Web) – the same panel as the
 *  launcher's Settings → Account. */
export function ProfileDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="acct-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="acct-dialog" role="dialog" aria-modal="true" aria-label={t("menu.profile")}>
        <div className="acct-dialog-head">
          <h2>{t("menu.profile")}</h2>
          <button className="acct-x" onClick={onClose} aria-label={t("web.close")}>
            ×
          </button>
        </div>
        <Account />
      </section>
    </div>
  );
}

/** Right after the first sign-in: pick the name the trackers show (the EA name can come later). */
function Welcome() {
  const [name, setName] = useState("");
  const [ea, setEa] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = NAME_RE.test(name.trim()) && (ea.trim() === "" || NAME_RE.test(ea.trim()));
  return (
    <form
      className="ln-rows"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        updateProfile({ username: name.trim(), ...(ea.trim() ? { ea_name: ea.trim() } : {}) })
          .catch((err) => setError(tError(err)))
          .finally(() => setBusy(false));
      }}
    >
      <div className="ln-row">
        <div>
          <b>{t("profile.welcome")}</b>
          <p>{t("profile.welcomeText")}</p>
        </div>
      </div>
      <div className="ln-row stack">
        <div>
          <b>{t("account.username")}</b>
          <p>{busy ? t("account.saving") : (error ?? t("account.usernameText"))}</p>
        </div>
        <div className="ln-seg">
          <input className="ln-input wide" value={name} maxLength={16} autoFocus aria-label={t("account.username")} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="ln-row stack">
        <div>
          <b>{t("account.eaName")}</b>
          <p>{t("account.eaNameText")}</p>
        </div>
        <div className="ln-seg">
          <input className="ln-input wide" value={ea} maxLength={16} placeholder={t("account.optional")} aria-label={t("account.eaName")} onChange={(e) => setEa(e.target.value)} />
          <button className="ln-btn small" type="submit" disabled={busy || !ok}>
            {t("profile.create")}
          </button>
        </div>
      </div>
    </form>
  );
}

/** The picture next to the name (trackers, dashboard): any image, made a 256×256 square here. */
function PictureRow() {
  const acc = useAccount();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = (f: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    f()
      .catch((e) => setNote(tError(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="ln-row">
      <div className="acct-pic">
        <Avatar size={48} />
        <div>
          <b>
            {t("profile.picture")}
            {acc.user?.verified && <span className="me-verified" title={t("profile.verified")} aria-label={t("profile.verified")} />}
          </b>
          <p>{busy ? t("profile.uploading") : (note ?? (acc.user?.verified ? t("profile.verifiedText") : t("profile.pictureText")))}</p>
        </div>
      </div>
      <div className="ln-seg">
        <label className={`ln-btn small ${busy ? "ghost" : ""}`}>
          {t("profile.choose")}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) run(() => uploadAvatar(f));
            }}
          />
        </label>
        {acc.user?.avatar_url && (
          <button className="ln-btn small ghost" disabled={busy} onClick={() => run(removeAvatar)}>
            {t("profile.removePicture")}
          </button>
        )}
      </div>
    </div>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<"sending" | "checking" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!resendAt) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [resendAt]);

  const send = async (to: string) => {
    setBusy("sending");
    setError(null);
    try {
      await sendCode(to);
      setSentTo(to.trim());
      setCode("");
      setResendAt(Date.now() + 60_000);
    } catch (e) {
      setError(tError(e));
    } finally {
      setBusy(null);
    }
  };
  const check = async () => {
    if (!sentTo) return;
    setBusy("checking");
    setError(null);
    try {
      await verifyCode(sentTo, code);
    } catch (e) {
      setError(tError(e));
    } finally {
      setBusy(null);
    }
  };
  const wait = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));

  return (
    <div className="ln-rows">
      <div className="ln-row">
        <div>
          <b>{t("account.title")}</b>
          <p>{t("account.pitch")}</p>
        </div>
      </div>
      {!sentTo ? (
        <form
          className="ln-row stack"
          onSubmit={(e) => {
            e.preventDefault();
            void send(email);
          }}
        >
          <div>
            <b>{t("account.email")}</b>
            <p>{busy === "sending" ? t("account.sending") : error ?? t("account.emailText")}</p>
          </div>
          <div className="ln-seg">
            <input
              className="ln-input wide"
              type="email"
              autoComplete="email"
              value={email}
              placeholder={t("account.emailPlaceholder")}
              aria-label={t("account.email")}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button className="ln-btn small" type="submit" disabled={busy != null || !email.includes("@")}>
              {t("account.sendCode")}
            </button>
          </div>
        </form>
      ) : (
        <form
          className="ln-row stack"
          onSubmit={(e) => {
            e.preventDefault();
            void check();
          }}
        >
          <div>
            <b>{t("account.code")}</b>
            <p aria-live="polite">
              {busy === "checking" ? t("account.checking") : busy === "sending" ? t("account.sending") : error ?? t("account.codeSent", { email: sentTo })}
            </p>
          </div>
          <div className="ln-seg">
            <input
              className="ln-input code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              placeholder="123456"
              aria-label={t("account.code")}
              autoFocus
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
            />
            <button className="ln-btn small" type="submit" disabled={busy != null || code.replace(/\D/g, "").length !== 6}>
              {t("account.verify")}
            </button>
            <button className="ln-btn small ghost" type="button" disabled={busy != null || wait > 0} onClick={() => void send(sentTo)}>
              {wait > 0 ? t("account.resendIn", { n: wait }) : t("account.resend")}
            </button>
            <button className="ln-btn small ghost" type="button" disabled={busy != null} onClick={() => { setSentTo(null); setError(null); }}>
              {t("account.otherEmail")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function SignedIn() {
  const acc = useAccount();
  const user = acc.user;
  const [name, setName] = useState(user?.username ?? "");
  const [ea, setEa] = useState(user?.ea_name ?? "");
  const [saving, setSaving] = useState<"name" | "ea" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [list, setList] = useState<Device[] | null>(null);
  const [busy, setBusy] = useState<"export" | "delete" | "out" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setName(user?.username ?? "");
    setEa(user?.ea_name ?? "");
  }, [user?.username, user?.ea_name]);
  const refreshDevices = () => loadDevices().then(setList).catch(() => setList([]));
  useEffect(() => {
    void refreshDevices();
  }, []);

  const save = async (what: "name" | "ea", patch: Parameters<typeof updateProfile>[0]) => {
    setSaving(what);
    setNote(null);
    try {
      await updateProfile(patch);
      setNote(t("account.saved"));
    } catch (e) {
      setNote(tError(e));
    } finally {
      setSaving(null);
    }
  };

  const sync = acc.sync;
  const syncText =
    sync.phase === "syncing" ? t("account.syncing") : sync.phase === "conflict" ? t("account.conflict.pending") : sync.phase === "error" ? tError(sync.error) : sync.at ? t("account.synced", { when: ago(sync.at) }) : t("account.syncText");

  return (
    <div className="ln-rows">
      <div className="ln-row">
        <div>
          <b>{t("menu.profile")}</b>
          <p>{user ? t("account.signedInAs", { email: user.email }) : t("account.loading")}</p>
        </div>
        <button className="ln-btn small ghost" disabled={busy != null} onClick={() => { setBusy("out"); void signOut().finally(() => setBusy(null)); }}>
          {busy === "out" ? t("account.signingOut") : t("account.signOut")}
        </button>
      </div>

      <PictureRow />

      <div className="ln-row">
        <div>
          <b>{t("account.username")}</b>
          <p>{saving === "name" ? t("account.saving") : !user?.username ? t("account.pickUsername") : (note ?? t("account.usernameText"))}</p>
        </div>
        <div className="ln-seg">
          <input className="ln-input" value={name} maxLength={16} aria-label={t("account.username")} onChange={(e) => setName(e.target.value)} />
          <button
            className="ln-btn small"
            disabled={saving != null || !NAME_RE.test(name.trim()) || name.trim() === user?.username}
            onClick={() => void save("name", { username: name.trim() })}
          >
            {t("account.save")}
          </button>
        </div>
      </div>

      <div className="ln-row">
        <div>
          <b>{t("account.eaName")}</b>
          <p>{saving === "ea" ? t("account.saving") : t("account.eaNameText")}</p>
        </div>
        <div className="ln-seg">
          <input className="ln-input" value={ea} maxLength={16} placeholder={t("account.optional")} aria-label={t("account.eaName")} onChange={(e) => setEa(e.target.value)} />
          <button
            className="ln-btn small"
            disabled={saving != null || (ea.trim() !== "" && !NAME_RE.test(ea.trim())) || ea.trim() === (user?.ea_name ?? "")}
            onClick={() => void save("ea", { ea_name: ea.trim() })}
          >
            {t("account.save")}
          </button>
        </div>
      </div>

      <div className="ln-row">
        <div>
          <b>{t("account.shownAs")}</b>
          <p>{user?.display_name ?? t("account.noName")}</p>
        </div>
        <div className="ln-seg" role="group" aria-label={t("account.shownAs")}>
          <button className={`ln-btn small ${user?.show_ea ? "ghost" : ""}`} aria-pressed={!user?.show_ea} disabled={saving != null} onClick={() => void save("ea", { show_ea: false })}>
            {t("account.showUsername")}
          </button>
          <button
            className={`ln-btn small ${user?.show_ea ? "" : "ghost"}`}
            aria-pressed={!!user?.show_ea}
            disabled={saving != null || !user?.ea_name}
            onClick={() => void save("ea", { show_ea: true })}
          >
            {t("account.showEa")}
          </button>
        </div>
      </div>

      <div className="ln-row">
        <div>
          <b>{t("account.sync")}</b>
          <p aria-live="polite">{syncText}</p>
        </div>
        <button className="ln-btn small ghost" disabled={sync.phase === "syncing"} onClick={() => void syncNow()}>
          {t("account.syncNow")}
        </button>
      </div>

      <div className="ln-row">
        <div>
          <b>{t("account.devices")}</b>
          {list == null ? (
            <p>{t("account.loadingDevices")}</p>
          ) : (
            <ul className="ln-list">
              {list.map((d) => (
                <li key={d.id}>
                  <span>
                    {d.name}
                    {d.this ? ` · ${t("account.thisDevice")}` : ` · ${t("account.lastSeen", { when: new Date(d.last_seen).toLocaleDateString() })}`}
                  </span>
                  {!d.this && (
                    <button className="ln-btn small ghost" onClick={() => void revokeDevice(d.id).then(refreshDevices)}>
                      {t("account.signOutDevice")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="ln-row">
        <div>
          <b>{t("account.yourData")}</b>
          <p>{busy === "export" ? t("account.exporting") : busy === "delete" ? t("account.deleting") : confirmDelete ? t("account.deleteConfirm") : t("account.yourDataText")}</p>
        </div>
        <div className="ln-seg">
          <button className="ln-btn small ghost" disabled={busy != null} onClick={() => { setBusy("export"); void exportData().catch((e) => setNote(tError(e))).finally(() => setBusy(null)); }}>
            {t("account.export")}
          </button>
          <button
            className={`ln-btn small ${confirmDelete ? "danger" : "ghost"}`}
            disabled={busy != null}
            onClick={() => {
              if (!confirmDelete) return setConfirmDelete(true);
              setBusy("delete");
              void deleteAccount().catch((e) => { setNote(tError(e)); setBusy(null); });
            }}
          >
            {confirmDelete ? t("account.deleteYes") : t("account.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}
