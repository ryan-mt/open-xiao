$ErrorActionPreference = 'SilentlyContinue'
Write-Host "APPDATA=$env:APPDATA"
Write-Host "LOCALAPPDATA=$env:LOCALAPPDATA"

$candidates = @(
  (Join-Path $env:APPDATA 'com.nguye.openxiao'),
  (Join-Path $env:LOCALAPPDATA 'com.nguye.openxiao'),
  (Join-Path $env:APPDATA 'Grok'),
  (Join-Path $env:LOCALAPPDATA 'Grok')
)

foreach ($p in $candidates) {
  Write-Host "CHECK $p exists=$(Test-Path $p)"
  if (Test-Path $p) {
    Get-ChildItem $p -Recurse -Force | ForEach-Object { Write-Host $_.FullName }
  }
}

Get-ChildItem $env:APPDATA -Directory | Where-Object {
  $_.Name -match 'grok|nguye|xai'
} | ForEach-Object { Write-Host "ROAMING_DIR $($_.FullName)" }

Get-ChildItem $env:LOCALAPPDATA -Directory | Where-Object {
  $_.Name -match 'grok|nguye|xai'
} | ForEach-Object { Write-Host "LOCAL_DIR $($_.FullName)" }

$authFiles = Get-ChildItem $env:APPDATA, $env:LOCALAPPDATA -Recurse -Filter auth.json -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'grok|nguye|xai' }
foreach ($f in $authFiles) {
  Write-Host "AUTH $($f.FullName)"
}
