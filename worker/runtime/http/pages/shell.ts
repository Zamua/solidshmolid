// The page shell shared by every apex page: the morning-sky look from
// design/mockups, inlined so a page is one response.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const STYLE = `
:root{--sky-top:#cfe4ff;--sky:#eaf4ff;--cloud:#fff;--mist:#f3f8ff;--blue:#3d6fe0;--blue-deep:#2a52b8;--ink:#1f2d4d;--ink-soft:#5a6b8c;--line:#dbe7fa;--sun:#ffd76a;--berry:#c2415a;
--display:'Fredoka',system-ui,sans-serif;--body:'Atkinson Hyperlegible',system-ui,sans-serif}
*{box-sizing:border-box;margin:0}
body{font:17px/1.5 var(--body);color:var(--ink);background:linear-gradient(180deg,var(--sky-top) 0%,var(--sky) 38%,var(--sky) 100%);min-height:100vh}
main{max-width:440px;margin:0 auto;padding:28px 22px 140px;position:relative}
.wordmark{font:600 22px var(--display);color:var(--blue-deep);display:flex;align-items:center;gap:8px}
h1{font:600 32px/1.12 var(--display);margin:28px 0 10px}
h2{font:600 22px/1.2 var(--display);margin:0 0 6px}
p.lede{color:var(--ink-soft)}
.small{font-size:14px;color:var(--ink-soft)}
.card{background:var(--cloud);border-radius:26px;padding:20px;box-shadow:0 1px 0 var(--line),0 14px 30px -18px rgba(42,82,184,.35);margin-top:16px}
ul.plain{list-style:none;padding:14px 20px}
ul.plain li{display:flex;gap:10px;padding:6px 0}
.btn{display:flex;align-items:center;justify-content:center;width:100%;height:56px;border:0;border-radius:18px;font:600 18px var(--display);cursor:pointer;text-decoration:none}
.btn.primary{background:var(--blue);color:#fff}
.btn.quiet{background:transparent;color:var(--blue-deep);height:48px}
.btn:focus-visible{outline:3px solid var(--sun);outline-offset:2px}
.dock{position:fixed;left:0;right:0;bottom:0;padding:26px 22px calc(30px + env(safe-area-inset-bottom));background:linear-gradient(180deg,rgba(234,244,255,0) 0%,var(--sky) 34%)}
.dock form{max-width:440px;margin:0 auto}
.center{text-align:center}
`;

const LOGO = `<svg viewBox="0 0 34 22" width="34" height="22" aria-hidden="true"><g fill="#3d6fe0"><circle cx="9" cy="14" r="7"/><circle cx="18" cy="9" r="9"/><circle cx="26" cy="14" r="7"/><rect x="9" y="12" width="17" height="9" rx="4.5"/></g></svg>`;

export function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Fredoka:wght@500;600&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body><main>
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
