// The page shell shared by every apex page: the morning-sky look from
// design/mockups, inlined so a page is one response.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const STYLE = `
:root{--sky-top:#cfe4ff;--sky:#eaf4ff;--cloud:#fff;--mist:#f3f8ff;--blue:#3d6fe0;--blue-deep:#2a52b8;--ink:#1f2d4d;--ink-soft:#5a6b8c;--line:#dbe7fa;--sun:#ffd76a;--leaf:#2f9e6e;--berry:#c2415a;
--display:'Fredoka',system-ui,sans-serif;--body:'Atkinson Hyperlegible',system-ui,sans-serif}
*{box-sizing:border-box;margin:0}
html{touch-action:manipulation;background:var(--sky-top);height:100%;overflow:hidden}
body{font:17px/1.5 var(--body);color:var(--ink);background:linear-gradient(180deg,var(--sky-top) 0%,var(--sky) 38%,var(--sky) 100%);position:fixed;inset:0;overflow:hidden}
/* The masthead stays put; only the content scrolls (and bounces) beneath it. */
.scroller{position:absolute;inset:0;overflow-y:auto;-webkit-overflow-scrolling:touch}
.masthead{position:absolute;top:0;left:0;right:0;z-index:5;padding:calc(env(safe-area-inset-top) + 16px) 22px 18px;background:linear-gradient(180deg,var(--sky-top) 72%,rgba(207,228,255,0))}
.masthead-inner{max-width:396px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px}
.sky{position:absolute;inset:0 0 auto 0;height:300px;overflow:hidden;pointer-events:none}
.sky svg{position:absolute}
.sky .near{left:50%;margin-left:-201px;width:402px;height:300px}
.sky .far{display:none;width:220px;height:120px}
main{max-width:440px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 64px) 22px 170px;position:relative}
.wordmark{font:600 22px var(--display);color:var(--blue-deep);display:flex;align-items:center;gap:8px}
.account-menu{position:relative}
.account-menu summary{list-style:none;cursor:pointer}
.account-menu summary::-webkit-details-marker{display:none}
.account-menu summary::marker{content:''}
.user-chip{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:#fff;color:var(--blue-deep);font:600 17px var(--display);box-shadow:0 1px 0 var(--line),0 8px 18px -12px rgba(42,82,184,.5)}
.account-menu summary:focus-visible .user-chip{outline:3px solid var(--sun);outline-offset:2px}
.menu{position:absolute;right:0;top:48px;z-index:10;min-width:200px;background:#fff;border-radius:18px;padding:8px;box-shadow:0 18px 40px -16px rgba(31,45,77,.35)}
.menu a{display:block;padding:10px 12px;border-radius:12px;color:var(--ink);text-decoration:none;font-weight:700}
.menu a:hover{background:var(--mist)}
.menu-name{padding:8px 12px 6px;font:600 15px var(--display);color:var(--ink-soft);border-bottom:1px solid var(--line);margin-bottom:4px}
h1{font:600 32px/1.12 var(--display);margin:28px 0 10px}
h2{font:600 22px/1.2 var(--display);margin:0 0 6px}
p.lede{color:var(--ink-soft);max-width:34ch}
.small{font-size:14px;color:var(--ink-soft);overflow-wrap:anywhere}
a{color:var(--blue-deep)}
.card{background:var(--cloud);border-radius:26px;padding:20px;box-shadow:0 1px 0 var(--line),0 14px 30px -18px rgba(42,82,184,.35);margin-top:16px}
.row{display:flex;align-items:center;gap:12px}
.grow{flex:1;min-width:0}
.badge{display:inline-flex;align-items:center;font:600 13px var(--body);padding:3px 10px;border-radius:999px;background:var(--mist);color:var(--blue-deep)}
.badge.you{background:var(--sun);color:#5c4300}
.badge.kid{background:#e3f6ec;color:#1c6b49}
.label{display:block;font:600 15px var(--body);margin:0 0 8px}
.field{display:block;width:100%;height:58px;padding:0 16px;font:18px var(--body);color:var(--ink);background:var(--mist);border:2px solid var(--line);border-radius:16px}
.field:focus{outline:none;border-color:var(--blue);background:#fff}
.problem{color:var(--berry);margin-top:8px}
.icon-tile{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:var(--mist);color:var(--blue-deep);flex:none}
.ok{color:var(--leaf)}
.pod-cloud{position:relative;width:92px;height:64px;flex:none}
.pod-cloud>svg{position:absolute;inset:0;width:100%;height:100%}
.pod-cloud span{position:absolute;inset:14px 0 0 0;display:grid;place-items:center;font:600 22px var(--display);color:var(--blue-deep)}
.pod-cloud span .icon{margin-top:4px}
.pod-cloud.small{width:58px;height:42px}
.pod-cloud.small span{inset:9px 0 0 0;font-size:17px}
.choice{border:2px solid var(--line);border-radius:20px;padding:14px 16px;display:flex;gap:12px;align-items:center}
.choice+.choice{margin-top:10px}
.choice.on{border-color:var(--blue);background:var(--mist)}
.choice.off{opacity:.55}
.choice .dot{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);flex:none}
label.choice{cursor:pointer}
.choice input{position:absolute;opacity:0;pointer-events:none}
.choice:has(input:focus-visible){outline:3px solid var(--sun);outline-offset:2px}
.choice.on .dot{border:7px solid var(--blue)}
ul.plain{list-style:none;padding:0}
ul.plain.card{padding:14px 20px}
ul.plain li{display:flex;gap:10px;align-items:flex-start;padding:6px 0}
ul.plain li .icon{color:var(--blue);flex:none;margin-top:1px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:56px;border:0;border-radius:18px;font:600 18px var(--display);cursor:pointer;text-decoration:none}
.btn.primary{background:var(--blue);color:#fff;box-shadow:0 10px 20px -12px var(--blue)}
.btn.quiet{background:transparent;color:var(--blue-deep);height:48px}
.btn.danger{background:var(--berry);color:#fff}
.btn.outline{background:#fff;color:var(--ink);border:2px solid var(--line)}
.btn:disabled{opacity:.6;cursor:default}
.or{display:flex;align-items:center;gap:12px;margin:18px 0;color:var(--ink-soft);font-size:14px}
.or::before,.or::after{content:'';flex:1;border-top:1px solid var(--line)}
[hidden]{display:none!important}
.btn.danger-quiet{background:transparent;color:var(--berry);border:2px solid var(--berry)}
.stack>.btn+.btn{margin-top:12px}
.icon-btn{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;color:var(--ink-soft)}
.icon-btn:hover{background:var(--mist);color:var(--berry)}
.chip-btn{font:600 14px var(--body);color:var(--berry);background:var(--mist);border:0;border-radius:999px;padding:6px 12px;cursor:pointer}
.sentence{font:600 17px var(--body);background:var(--mist);border-radius:14px;padding:12px 14px;margin:0 0 16px;user-select:all}
.btn:focus-visible,a:focus-visible{outline:3px solid var(--sun);outline-offset:2px}
.dock{position:fixed;left:0;right:0;bottom:0;padding:26px 22px calc(30px + env(safe-area-inset-bottom));background:linear-gradient(180deg,rgba(234,244,255,0) 0%,var(--sky) 34%)}
.dock>*{max-width:396px;margin:0 auto}
.center{text-align:center}
.row-link{color:inherit;text-decoration:none;display:flex;flex-direction:column}
a.row.row-link{flex-direction:row}
.row-link:hover b{color:var(--blue-deep)}
.crumbs{font-size:15px;color:var(--ink-soft);overflow-wrap:anywhere}
.crumbs a{color:var(--blue-deep);font-weight:700;text-decoration:none}
.crumb-sep{margin:0 6px;color:var(--ink-soft)}
.file-name{display:block;overflow-wrap:anywhere}
.file-get{color:var(--ink-soft);flex:none}
.add-row{border-top:1px solid var(--line)}
.add-pod{display:flex;align-items:center;gap:10px;width:100%;padding:14px 0;border:0;background:none;color:var(--blue-deep);font:600 17px var(--display);cursor:pointer}
.add-pod:focus-visible{outline:3px solid var(--sun);outline-offset:2px;border-radius:12px}
.prose h2{margin:22px 0 6px}
.prose h2:first-child{margin-top:0}
.prose p{margin:0 0 10px}
/* Clerk takes over the element it mounts in, so the spacing lives on a wrapper. */
.clerk-mount{display:flex;justify-content:center;margin-top:28px;min-height:420px}
@media (min-width:720px){
.sky{height:420px}
.sky .near{display:none}
.sky .far{display:block}
main{max-width:480px;padding:96px 22px 80px}
.masthead{padding-top:28px}
.masthead-inner{max-width:436px}
h1{font-size:38px}
.dock{position:static;padding:30px 0 0;background:none}
.dock>*{max-width:none}
}
`;

const CLOUD_PUFFS = '<circle cx="40" cy="66" r="26"/><circle cx="72" cy="54" r="34"/><circle cx="108" cy="68" r="24"/><rect x="40" y="66" width="70" height="26" rx="13"/>';

/** Clouds at their natural size: a cluster behind the content column on a
 * phone; on wide screens, a few out in the open sky beside it. */
const SKY = `<div class="sky" aria-hidden="true">
<svg class="near" viewBox="0 0 402 300"><g fill="#fff" opacity=".85"><circle cx="40" cy="96" r="26"/><circle cx="72" cy="84" r="34"/><circle cx="108" cy="98" r="24"/><rect x="40" y="96" width="70" height="26" rx="13"/></g>
<g fill="#fff" opacity=".6"><circle cx="300" cy="58" r="18"/><circle cx="326" cy="46" r="26"/><circle cx="356" cy="60" r="18"/><rect x="300" y="58" width="58" height="20" rx="10"/></g>
<g fill="#fff" opacity=".45"><circle cx="232" cy="150" r="12"/><circle cx="250" cy="142" r="17"/><circle cx="270" cy="152" r="12"/><rect x="232" y="150" width="40" height="14" rx="7"/></g></svg>
<svg class="far" viewBox="0 0 150 100" style="left:7%;top:150px"><g fill="#fff" opacity=".7">${CLOUD_PUFFS}</g></svg>
<svg class="far" viewBox="0 0 150 100" style="right:8%;top:60px;width:160px;height:90px"><g fill="#fff" opacity=".55">${CLOUD_PUFFS}</g></svg>
<svg class="far" viewBox="0 0 150 100" style="right:22%;top:250px;width:110px;height:62px"><g fill="#fff" opacity=".45">${CLOUD_PUFFS}</g></svg>
</div>`;

/** A pod drawn as a cloud carrying its person's initial, or (given trusted
 * markup such as an icon) what it holds. */
export function podCloud(label: string | { html: string }, small = false): string {
  const inner = typeof label === 'string' ? escapeHtml(label) : label.html;
  return `<div class="pod-cloud${small ? ' small' : ''}"><svg viewBox="0 0 92 64" aria-hidden="true"><path fill="#fff" stroke="#dbe7fa" stroke-width="2" d="M22 60 h50 a16 16 0 0 0 1-32 a22 22 0 0 0-42-6 a17 17 0 0 0-9 38z"/></svg><span>${inner}</span></div>`;
}

const LOGO = `<svg viewBox="0 0 34 22" width="34" height="22" aria-hidden="true"><g fill="#3d6fe0"><circle cx="9" cy="14" r="7"/><circle cx="18" cy="9" r="9"/><circle cx="26" cy="14" r="7"/><rect x="9" y="12" width="17" height="9" rx="4.5"/></g></svg>`;

/** Sources a page may load from beyond its own fonts and styles. */
export interface CspAllow {
  script?: string[];
  connect?: string[];
  img?: string[];
  frame?: string[];
  worker?: string[];
}

export function pageCsp(allow: CspAllow = {}): string {
  const list = (base: string[], more: string[] = []) => [...base, ...more].join(' ');
  return [
    "default-src 'none'",
    allow.script?.length ? `script-src ${list(["'self'"], allow.script)}` : null,
    allow.connect?.length ? `connect-src ${list(["'self'"], allow.connect)}` : null,
    allow.worker?.length ? `worker-src ${list(["'self'"], allow.worker)}` : null,
    allow.frame?.length ? `frame-src ${list([], allow.frame)}` : null,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `img-src ${list(["'self'", 'data:'], allow.img)}`,
    "form-action 'self' https: http://localhost:* http://127.0.0.1:*",
    "frame-ancestors 'none'",
  ]
    .filter(Boolean)
    .join('; ');
}

export function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#cfe4ff">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Fredoka:wght@500;600&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body>${SKY}
<header class="masthead"><div class="masthead-inner"><div class="wordmark">${LOGO} solidshmolid</div></div></header>
<div class="scroller"><main>
${body}
</main></div></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': pageCsp(),
      'X-Frame-Options': 'DENY',
    },
  });
}
