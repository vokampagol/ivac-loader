# How to publish the updated userscript and helper

Follow these steps locally to commit and push the changes made in this workspace.

1. Review the changes in your working tree:

```bash
git status
git diff --staged
```

2. Run the provided helper script (bash):

```bash
chmod +x ./scripts/update_and_push.sh
./scripts/update_and_push.sh
```

Or use PowerShell on Windows:

```powershell
.\scripts\update_and_push.ps1
```

3. After a successful push, the raw userscript will be available at:

```
https://raw.githubusercontent.com/<your-username>/ivac-loader/main/ivac-loader.user.js
```

Replace `<your-username>` with your GitHub account (or organization) name if different.

Notes:
- If your default branch is not `main`, set the `BRANCH` environment variable before running the bash script, or pass parameters to the PowerShell script.
- If you prefer to create a release or tag, run:

```bash
git tag -a v1.0.1 -m "Release: robust loader"
git push origin v1.0.1
```

Security and CSP:
- If the site enforces a strict Content Security Policy (CSP), `raw.githubusercontent.com` script loads may be blocked. In that case publish `main.js` via GitHub Pages or another allowed host and update `ivac-loader.user.js` `REPO/BRANCH/FILE` accordingly.

## Which userscript to install in Tampermonkey

Install **only** `ivac-loader.user.js` (v1.6). It downloads the latest `main.js` from this repo on every page load,
so later changes to `main.js` need no reinstall. Do **not** install `ivac-helper.user.js` (old Phase-1 UI) at the same
time - both create `#ivac-helper-panel`.

`main.js` features: Device ID (saved with GM_setValue), auto OTP fetch ~5 s after Login (API secret is entered once in
the CONFIG tab and stored only in Tampermonkey storage - never commit it), FILES tab (1 primary + 3 secondary PDFs,
kept in memory only), LOG tab. Cloudflare / CAPTCHA are never bypassed and no form is auto-submitted by the file tools.

## Automation (START / STOP)

The START button (always visible at the top of the panel) walks the booking pages:
`/signin` -> OTP page -> `/` -> `/appointment/notice` -> `/appointment/file-upload` -> `/appointment/mission` -> `/appointment/time-slot`.

- FILES tab: **Select PDFs & START** (or drag & drop). A file name containing "primary" is the primary applicant, the others are secondary 1-3.
- Calendar: only circled dates are tried, ascending; each date gets 15 s (CONFIG), then the next date, then the next month (CONFIG: months, rounds, pause).
- Stops by itself when a slot is found and beeps. "Auto-click Continue Booking" in CONFIG is **off** by default; payment is never automated.
- Cloudflare / CAPTCHA are never bypassed - automation waits until the check is passed.
- LOG tab -> **Inspect page** lists the buttons / file inputs / calendar cells the script sees (use it if a step does not react).

## Private repository

`raw.githubusercontent.com` answers **404** for a private repo. Either make the repo public, or in Tampermonkey click the
extension icon -> "IVAC: set GitHub token (private repo)" and paste a fine-grained token (this repo only, Contents: Read-only).
The token is kept in Tampermonkey storage only. The loader also keeps the last working `main.js` and uses it when GitHub is unreachable.
Auto-update of the loader itself (`@updateURL`) does not work for a private repo - paste new loader versions manually.
