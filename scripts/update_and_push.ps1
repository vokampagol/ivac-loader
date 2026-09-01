Param(
  [string]$Remote = 'origin',
  [string]$Branch = 'main'
)

Write-Output "Staging files..."
git add ivac-loader.user.js main.js tests/login-harness.html

Write-Output "Committing changes..."
git commit -m "fix(loader): robust loader, selector fixes, and add test harness"

Write-Output "Pushing to $Remote/$Branch..."
git push $Remote $Branch

Write-Output "Done. If push failed, check your credentials or run the commands manually."
