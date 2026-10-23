"""Builds the mockup screens from one shell, so every screen shares fonts, icons and the sky."""

from pathlib import Path

HERE = Path(__file__).parent

HEAD = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Fredoka:wght@500;600&display=swap" rel="stylesheet">
<script src="https://unpkg.com/@phosphor-icons/web@2.1.1"></script>
<link rel="stylesheet" href="sky.css">
</head><body>
<div class="status"><span>9:41</span><span><i class="ph ph-cell-signal-full"></i><i class="ph ph-wifi-high"></i><i class="ph-fill ph-battery-high"></i></span></div>
"""

# Soft clouds drifting across the top of every screen.
SKY = """<svg class="sky-clouds" viewBox="0 0 402 300" preserveAspectRatio="xMidYMin slice" aria-hidden="true">
<g fill="#fff" opacity=".85"><circle cx="40" cy="96" r="26"/><circle cx="72" cy="84" r="34"/><circle cx="108" cy="98" r="24"/><rect x="40" y="96" width="70" height="26" rx="13"/></g>
<g fill="#fff" opacity=".6"><circle cx="300" cy="58" r="18"/><circle cx="326" cy="46" r="26"/><circle cx="356" cy="60" r="18"/><rect x="300" y="58" width="58" height="20" rx="10"/></g>
<g fill="#fff" opacity=".45"><circle cx="232" cy="150" r="12"/><circle cx="250" cy="142" r="17"/><circle cx="270" cy="152" r="12"/><rect x="232" y="150" width="40" height="14" rx="7"/></g>
</svg>
"""

LOGO = """<svg viewBox="0 0 34 22" aria-hidden="true"><g fill="#3d6fe0"><circle cx="9" cy="14" r="7"/><circle cx="18" cy="9" r="9"/><circle cx="26" cy="14" r="7"/><rect x="9" y="12" width="17" height="9" rx="4.5"/></g></svg>"""


def pod(initial: str, tint: str = '#fff', size: str = '') -> str:
    return f"""<div class="pod-cloud {size}"><svg viewBox="0 0 92 64" aria-hidden="true"><g fill="{tint}" stroke="#dbe7fa" stroke-width="2">
<path d="M22 60 h50 a16 16 0 0 0 1-32 a22 22 0 0 0-42-6 a17 17 0 0 0-9 38z"/></g></svg><span>{initial}</span></div>"""


SCREENS: dict[str, tuple[str, str]] = {}

SCREENS['01-welcome'] = ('Welcome', f"""{SKY}
<div class="screen">
  <div class="wordmark">{LOGO} solidshmolid</div>
  <div style="margin:96px 0 0">
    <div class="row" style="gap:6px;margin-bottom:6px">{pod('D')}{pod('S','#f3f8ff')}{pod('M')}</div>
    <h1>A home for your data, kept in your own cloud</h1>
    <p class="lede">Get a pod: a private space your apps can use with your permission. Its files live in your Dropbox, where you can always see them.</p>
  </div>
  <ul class="plain card" style="margin-top:26px">
    <li><i class="ph ph-folder-simple-lock"></i><span>Your files stay in your Dropbox, not on our servers.</span></li>
    <li><i class="ph ph-users-three"></i><span>Make pods for your whole family and manage them in one place.</span></li>
    <li><i class="ph ph-door-open"></i><span>Leave anytime. Your folder is still a complete pod.</span></li>
  </ul>
</div>
<div class="dock"><button class="btn primary">Create your pod</button><button class="btn quiet">I already have one</button></div>
""")

SCREENS['02-name'] = ('Pick your name', f"""{SKY}
<div class="screen">
  <div class="wordmark">{LOGO} solidshmolid</div>
  <h1 style="margin-top:64px">Pick a name for your pod</h1>
  <p class="lede">It becomes your address on the web. Apps and friends will see it.</p>
  <div class="card" style="margin-top:24px">
    <div style="display:flex;justify-content:center;margin-bottom:10px">{pod('D')}</div>
    <label class="label">Name</label>
    <div class="field focus"><span>dana</span><span class="suffix">.solidshmolid.com</span></div>
    <p class="small" style="margin-top:10px"><i class="ph-bold ph-check-circle ok"></i> dana is free. Lowercase letters, numbers and dashes.</p>
  </div>
</div>
<div class="dock"><button class="btn primary">Continue</button></div>
""")

SCREENS['03-storage'] = ('Connect storage', f"""{SKY}
<div class="screen">
  <div class="wordmark">{LOGO} solidshmolid</div>
  <h1 style="margin-top:44px">Where should your pod live?</h1>
  <p class="lede">Pick the storage you already use. You can add more later.</p>
  <div class="card" style="margin-top:22px;padding:8px 8px">
    <div class="choice on"><div class="dot"></div><div class="grow"><b>Dropbox</b><div class="small">A folder called Apps/solidshmolid</div></div><i class="ph ph-dropbox-logo" style="font-size:28px;color:#0061fe"></i></div>
    <div class="choice" style="opacity:.55"><div class="dot"></div><div class="grow"><b>Google Drive</b><div class="small">Coming soon</div></div><i class="ph ph-google-drive-logo" style="font-size:28px"></i></div>
    <div class="choice" style="opacity:.55"><div class="dot"></div><div class="grow"><b>OneDrive</b><div class="small">Coming soon</div></div><i class="ph ph-cloud" style="font-size:28px"></i></div>
  </div>
  <ul class="plain" style="margin-top:18px">
    <li><i class="ph ph-eye"></i><span>We can only open that one folder, nothing else in your Dropbox.</span></li>
    <li><i class="ph ph-plugs"></i><span>Disconnect anytime from your account or from Dropbox.</span></li>
  </ul>
</div>
<div class="dock"><button class="btn primary"><i class="ph ph-dropbox-logo"></i>Connect Dropbox</button></div>
""")

MEMBERS = [
    ('D', 'Dana', 'dana', '<span class="badge you">You</span> <span class="badge">Manager</span>', 38, '540 MB'),
    ('A', 'Alex', 'alex', '<span class="badge">Adult</span>', 22, '310 MB'),
    ('M', 'Maya', 'maya', '<span class="badge kid">Teen</span>', 14, '200 MB'),
    ('S', 'Sam', 'sam', '<span class="badge kid">Kid</span>', 6, '85 MB'),
    ('L', 'Leo', 'leo', '<span class="badge kid">Kid</span>', 3, '46 MB'),
]

rows = '\n'.join(
    f"""<div class="row" style="padding:12px 0;border-top:{'0' if i == 0 else '1px solid var(--line)'}">
  {pod(m[0], '#f3f8ff', 'small')}
  <div class="grow"><div class="row" style="gap:8px"><b>{m[1]}</b> {m[3]}</div>
  <div class="small">{m[2]}.solidshmolid.com</div>
  <div class="row" style="gap:10px;margin-top:6px"><div class="meter grow"><b style="width:{m[4]}%"></b></div><span class="small" style="width:52px;text-align:right">{m[5]}</span></div></div>
  <i class="ph ph-caret-right" style="color:var(--ink-soft)"></i></div>"""
    for i, m in enumerate(MEMBERS)
)

SCREENS['04-household'] = ('Household', f"""{SKY}
<div class="screen">
  <div class="row"><div class="wordmark grow">{LOGO} solidshmolid</div><div class="icon-tile" style="width:40px;height:40px;border-radius:50%;background:#fff;font:600 17px var(--display)">D</div></div>
  <h1 style="margin-top:40px">The Riveras</h1>
  <p class="lede" style="margin-bottom:18px">5 pods. Everyone signs in as themselves.</p>
  <div class="card" style="padding:6px 16px">{rows}</div>
  <div class="card row" style="margin-top:14px">
    <div class="icon-tile"><i class="ph ph-dropbox-logo"></i></div>
    <div class="grow"><b>Dana's Dropbox</b><div class="small">All 5 pods live here: 1.2 GB</div></div>
  </div>
</div>
<div class="dock"><button class="btn primary"><i class="ph ph-user-plus"></i>Add someone</button></div>
""")

SCREENS['05-add-member'] = ('Add someone', SCREENS['04-household'][1].replace('<div class="dock">', '<div class="dock" style="display:none">') + f"""
<div class="sheet-backdrop"></div>
<div class="sheet">
  <div class="grabber"></div>
  <h2>Add someone to the household</h2>
  <p class="small" style="margin-bottom:16px">Their pod lives in your Dropbox until they move it.</p>
  <label class="label">Their name</label>
  <div class="field focus" style="margin-bottom:14px"><span>Leo</span></div>
  <label class="label">Pod address</label>
  <div class="field" style="margin-bottom:16px"><span>leo</span><span class="suffix">.solidshmolid.com</span></div>
  <div class="choice on"><div class="dot"></div><div class="grow"><b>A child</b><div class="small">You set up their device with a code. No email needed.</div></div></div>
  <div class="choice"><div class="dot"></div><div class="grow"><b>An adult</b><div class="small">We email them an invite and they sign in on their own.</div></div></div>
  <button class="btn primary" style="margin-top:18px">Add Leo</button>
</div>
""")

def _modules() -> str:
    # A plausible-looking code: a seeded scatter plus the three finder squares.
    seed = 2463534242
    cells = []
    for y in range(25):
        for x in range(25):
            seed ^= (seed << 13) & 0xFFFFFFFF
            seed ^= seed >> 17
            seed ^= (seed << 5) & 0xFFFFFFFF
            finder = (x < 8 and y < 8) or (x > 16 and y < 8) or (x < 8 and y > 16)
            if not finder and seed % 100 < 47:
                cells.append(f'<rect x="{x * 9}" y="{y * 9}" width="9" height="9"/>')
    return ''.join(cells)


QR = _modules()

SCREENS['06-device-setup'] = ("Set up Sam's device", f"""{SKY}
<div class="screen">
  <div class="row"><i class="ph ph-arrow-left" style="font-size:24px"></i><div class="grow"></div></div>
  <h1 style="margin-top:30px">Set up Sam's tablet</h1>
  <p class="lede">Open the camera on Sam's tablet and point it at this code. It signs Sam in and asks for Face ID to remember them.</p>
  <div class="card" style="margin-top:22px;text-align:center;padding:26px">
    <svg viewBox="0 0 225 225" width="210" height="210" aria-label="QR code"><g fill="#1f2d4d">{QR}</g>
      <g fill="none" stroke="#1f2d4d" stroke-width="9"><rect x="4.5" y="4.5" width="54" height="54" rx="6"/><rect x="166.5" y="4.5" width="54" height="54" rx="6"/><rect x="4.5" y="166.5" width="54" height="54" rx="6"/></g>
      <g fill="#1f2d4d"><rect x="18" y="18" width="27" height="27" rx="4"/><rect x="180" y="18" width="27" height="27" rx="4"/><rect x="18" y="180" width="27" height="27" rx="4"/></g></svg>
    <p style="font:600 18px var(--display);margin-top:14px">Works once, for 14:32 more</p>
    <p class="small">Only for Sam. Next time, Face ID is enough.</p>
  </div>
</div>
<div class="dock"><button class="btn quiet"><i class="ph ph-arrows-clockwise"></i>Make a new code</button></div>
""")

SCREENS['07-consent'] = ('Sign in to an app', f"""{SKY}
<div class="screen">
  <div class="wordmark">{LOGO} solidshmolid</div>
  <div class="card" style="margin-top:56px;text-align:center;padding:28px 22px">
    <div class="row" style="justify-content:center;gap:14px">
      <div class="icon-tile" style="width:64px;height:64px;border-radius:20px;font-size:34px;background:#fff1c9;color:#8a5a00"><i class="ph ph-paint-brush"></i></div>
      <i class="ph ph-arrows-left-right" style="font-size:22px;color:var(--ink-soft)"></i>
      {pod('S')}
    </div>
    <h2 style="margin-top:16px">Sketchpad wants to use Sam's pod</h2>
    <p class="small">sketchpad.example</p>
  </div>
  <ul class="plain card" style="margin-top:14px">
    <li><i class="ph ph-user-circle"></i><span>It will know this is <b>sam.solidshmolid.com</b>.</span></li>
    <li><i class="ph ph-folder-open"></i><span>It can read and save what Sam's pod allows it to.</span></li>
    <li><i class="ph ph-hand"></i><span>Sam's parent can remove it anytime.</span></li>
  </ul>
</div>
<div class="dock"><button class="btn primary">Allow</button><button class="btn quiet">Don't allow</button></div>
""")

SCREENS['08-delete'] = ("Delete Leo's pod", f"""{SKY}
<div class="screen">
  <div class="row"><i class="ph ph-arrow-left" style="font-size:24px"></i></div>
  <h1 style="margin-top:30px">Delete the files too?</h1>
  <p class="lede">Leo's pod is gone from solidshmolid. Its folder is still in your Dropbox, and you can keep it.</p>
  <div class="card" style="margin-top:20px">
    <div class="row"><div class="icon-tile" style="background:#fdebee;color:var(--berry)"><i class="ph ph-warning"></i></div>
    <p class="grow">This permanently deletes <b>Apps/solidshmolid/leo</b> from Dropbox: 31 files, 46 MB.</p></div>
    <label class="label" style="margin-top:16px">To confirm, type the sentence below</label>
    <p style="background:var(--mist);border-radius:12px;padding:10px 12px;font-size:16px">yes, delete my data in Dropbox</p>
    <div class="field focus" style="margin-top:10px"><span>yes, delete my data in Drop</span></div>
  </div>
</div>
<div class="dock"><button class="btn disabled">Delete files from Dropbox</button><button class="btn quiet">Keep the files</button></div>
""")


def main() -> None:
    for name, (title, body) in SCREENS.items():
        (HERE / f'{name}.html').write_text(HEAD.format(title=title) + body + '\n</body></html>\n')


if __name__ == '__main__':
    main()
