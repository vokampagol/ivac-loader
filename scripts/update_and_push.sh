#!/usr/bin/env bash
set -euo pipefail

# Update these if your branch or remote are different
REMOTE=${REMOTE:-origin}
BRANCH=${BRANCH:-main}

echo "Staging files..."
git add ivac-loader.user.js main.js tests/login-harness.html

echo "Committing changes..."
git commit -m "fix(loader): robust loader, selector fixes, and add test harness"

echo "Pushing to ${REMOTE}/${BRANCH}..."
git push ${REMOTE} ${BRANCH}

echo "Done. If push failed, check your credentials or run the commands manually."
