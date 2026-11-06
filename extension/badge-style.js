// The in-page badge's styles (relay.js): the parts of brand.css the badge uses, as a string that goes
// straight into the badge's closed shadow root. Nothing is loaded from the extension into EA's page
// (no web-accessible files, no fonts, no <link>) – the Web App can't see or fetch anything of ours;
// the badge uses the system font stack. Same tokens as brand.css (glass default, dark, light).
const fctBadgeCss = `
.fct {
  --red: #EF4359; --red-press: #D8324B; --mint: #2FD6A8; --amber: #F5B03B;
  --f-body: "Segoe UI", system-ui, -apple-system, sans-serif;
  --s-2: 8px; --s-3: 12px; --cut-s: 5px; --cut-m: 8px;
  --ease: cubic-bezier(.2, .7, .2, 1); --t-fast: 120ms;
}
.fct, .fct[data-theme="glass"] {
  color-scheme: dark;
  --surface: rgba(18, 16, 22, .2); --fill: rgba(255, 255, 255, .08);
  --line: rgba(255, 255, 255, .2); --line-strong: rgba(255, 255, 255, .22);
  --text: #F4F3F6; --text-3: rgba(244, 243, 246, .6);
  --accent: var(--red); --on-accent: #FFFFFF; --done: var(--mint); --warn: var(--amber);
  --blur: blur(26px) saturate(140%); --text-shadow: 0 1px 0 rgba(0, 0, 0, .55); --float: rgba(18, 17, 23, .62);
}
.fct[data-theme="dark"] {
  color-scheme: dark;
  --surface: #1A1619; --fill: #2A2428; --line: #2E282C; --line-strong: #3E373C;
  --text: #F2F1F4; --text-3: #908E97;
  --blur: none; --text-shadow: none; --float: #1A1619;
}
.fct[data-theme="light"] {
  color-scheme: light;
  --surface: #FFFFFF; --fill: #EEEAE2; --line: #E2DCD1; --line-strong: #CEC6B8;
  --text: #15120F; --text-3: #6B655D; --done: #1FBF92;
  --blur: none; --text-shadow: none; --float: #FFFFFF;
}
.fct *, .fct *::before, .fct *::after { box-sizing: border-box; }
.fct { font-family: var(--f-body); font-size: 14px; line-height: 1.45; color: var(--text); -webkit-font-smoothing: antialiased; text-shadow: var(--text-shadow); }
.fct button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-shadow: inherit; }
.fct [hidden] { display: none !important; }
.fct .btn, .fct .toast {
  --cut: var(--cut-m);
  clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
}
.fct .ring { position: relative; --bw: 1px; --ring: var(--line); }
.fct .ring::after {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 4;
  --bwd: calc(var(--bw) * .909);
  background: var(--ring);
  clip-path: polygon(evenodd,
    var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut), var(--cut) 0,
    calc(var(--cut) + var(--bwd)) var(--bw), calc(100% - var(--bw)) var(--bw),
    calc(100% - var(--bw)) calc(100% - var(--cut) - var(--bwd)),
    calc(100% - var(--cut) - var(--bwd)) calc(100% - var(--bw)),
    var(--bw) calc(100% - var(--bw)), var(--bw) calc(var(--cut) + var(--bwd)),
    calc(var(--cut) + var(--bwd)) var(--bw));
}
.fct .eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--text-3); line-height: 1.2; }
.fct .btn {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  height: 32px; padding: 0 var(--s-3); --cut: var(--cut-s);
  font-weight: 650; font-size: 13px; letter-spacing: .02em; line-height: 1; white-space: nowrap; cursor: pointer; text-decoration: none;
}
.fct.ready .btn { transition: background var(--t-fast) var(--ease), color var(--t-fast); }
.fct .btn-primary { background: var(--accent); color: var(--on-accent); text-shadow: none; }
.fct .btn-primary:hover { background: var(--red-press); }
.fct .btn-secondary { background: var(--surface); color: var(--text); --ring: var(--line-strong); }
.fct .btn-secondary:hover { background: var(--fill); }
.fct .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.fct .toast {
  --ring: var(--line); position: relative; display: flex; align-items: center; gap: var(--s-3);
  min-height: 48px; padding: 10px 12px 10px 0; background: var(--float);
  -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
}
.fct .toast .edge { width: 3px; align-self: stretch; background: var(--accent); flex: none; }
.fct .toast.done .edge { background: var(--done); }
.fct .toast.warn .edge { background: var(--warn); }
.fct .body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.fct .text { font-weight: 600; font-size: 14px; line-height: 1.3; }
.fct .text.urgent { font-weight: 700; }
.fct .acts { display: flex; gap: var(--s-2); flex: none; }
.fct .busy { position: absolute; left: 3px; right: 0; bottom: 0; height: 2px; overflow: hidden; background: var(--fill); }
.fct .busy::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 30%; background: var(--accent); animation: fct-busy 1.1s var(--ease) infinite; }
@keyframes fct-busy { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
@media (prefers-reduced-motion: reduce) {
  .fct .busy::before { animation: none; width: 100%; opacity: .5; }
  .fct * { transition: none !important; }
}
`;
