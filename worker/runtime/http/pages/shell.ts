// The page shell shared by every apex page: the morning-sky look from
// design/mockups, inlined so a page is one response.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const STYLE = `
:root{--sky-top:#cfe4ff;--sky:#eaf4ff;--cloud:#fff;--mist:#f3f8ff;--blue:#3d6fe0;--blue-deep:#2a52b8;--ink:#1f2d4d;--ink-soft:#5a6b8c;--line:#dbe7fa;--sun:#ffd76a;--leaf:#2f9e6e;--berry:#c2415a;
--display:'Fredoka',system-ui,sans-serif;--body:'Atkinson Hyperlegible',system-ui,sans-serif}
*{box-sizing:border-box;margin:0}
body{font:17px/1.5 var(--body);color:var(--ink);background:linear-gradient(180deg,var(--sky-top) 0%,var(--sky) 38%,var(--sky) 100%);min-height:100vh}
.sky-clouds{position:absolute;inset:0 0 auto 0;width:100%;height:300px;pointer-events:none}
main{max-width:440px;margin:0 auto;padding:28px 22px 170px;position:relative}
.wordmark{font:600 22px var(--display);color:var(--blue-deep);display:flex;align-items:center;gap:8px}
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
.icon-tile{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:var(--mist);color:var(--blue-deep);flex:none}
.ok{color:var(--leaf)}
.pod-cloud{position:relative;width:92px;height:64px;flex:none}
.pod-cloud svg{position:absolute;inset:0;width:100%;height:100%}
.pod-cloud span{position:absolute;inset:14px 0 0 0;display:grid;place-items:center;font:600 22px var(--display);color:var(--blue-deep)}
.pod-cloud.small{width:58px;height:42px}
.pod-cloud.small span{inset:9px 0 0 0;font-size:17px}
.choice{border:2px solid var(--line);border-radius:20px;padding:14px 16px;display:flex;gap:12px;align-items:center}
.choice+.choice{margin-top:10px}
.choice.on{border-color:var(--blue);background:var(--mist)}
.choice.off{opacity:.55}
.choice .dot{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);flex:none}
.choice.on .dot{border:7px solid var(--blue)}
ul.plain{list-style:none;padding:0}
ul.plain.card{padding:14px 20px}
ul.plain li{display:flex;gap:10px;align-items:flex-start;padding:6px 0}
ul.plain li .icon{color:var(--blue);flex:none;margin-top:1px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:56px;border:0;border-radius:18px;font:600 18px var(--display);cursor:pointer;text-decoration:none}
.btn.primary{background:var(--blue);color:#fff;box-shadow:0 10px 20px -12px var(--blue)}
.btn.quiet{background:transparent;color:var(--blue-deep);height:48px}
.btn:focus-visible,a:focus-visible{outline:3px solid var(--sun);outline-offset:2px}
.dock{position:fixed;left:0;right:0;bottom:0;padding:26px 22px calc(30px + env(safe-area-inset-bottom));background:linear-gradient(180deg,rgba(234,244,255,0) 0%,var(--sky) 34%)}
.dock>*{max-width:396px;margin:0 auto}
.center{text-align:center}
`;

const SKY = `<svg class="sky-clouds" viewBox="0 0 402 300" preserveAspectRatio="xMidYMin slice" aria-hidden="true">
<g fill="#fff" opacity=".85"><circle cx="40" cy="96" r="26"/><circle cx="72" cy="84" r="34"/><circle cx="108" cy="98" r="24"/><rect x="40" y="96" width="70" height="26" rx="13"/></g>
<g fill="#fff" opacity=".6"><circle cx="300" cy="58" r="18"/><circle cx="326" cy="46" r="26"/><circle cx="356" cy="60" r="18"/><rect x="300" y="58" width="58" height="20" rx="10"/></g>
<g fill="#fff" opacity=".45"><circle cx="232" cy="150" r="12"/><circle cx="250" cy="142" r="17"/><circle cx="270" cy="152" r="12"/><rect x="232" y="150" width="40" height="14" rx="7"/></g>
</svg>`;

/** A pod drawn as a cloud carrying its person's initial. */
export function podCloud(initial: string, small = false): string {
  return `<div class="pod-cloud${small ? ' small' : ''}"><svg viewBox="0 0 92 64" aria-hidden="true"><path fill="#fff" stroke="#dbe7fa" stroke-width="2" d="M22 60 h50 a16 16 0 0 0 1-32 a22 22 0 0 0-42-6 a17 17 0 0 0-9 38z"/></svg><span>${escapeHtml(initial)}</span></div>`;
}

const LOGO = `<svg viewBox="0 0 34 22" width="34" height="22" aria-hidden="true"><g fill="#3d6fe0"><circle cx="9" cy="14" r="7"/><circle cx="18" cy="9" r="9"/><circle cx="26" cy="14" r="7"/><rect x="9" y="12" width="17" height="9" rx="4.5"/></g></svg>`;

export function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Fredoka:wght@500;600&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body>${SKY}<main>
<div class="wordmark">${LOGO} solidshmolid</div>
${body}
</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
    },
  });
}
