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
