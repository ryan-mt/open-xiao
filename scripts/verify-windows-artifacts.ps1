$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$releaseRoot = Resolve-Path (Join-Path $projectRoot 'src-tauri\target\release')
$app = Get-Item -LiteralPath (Join-Path $releaseRoot 'open-xiao.exe')
$msi = @(Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'bundle\msi') -Filter '*.msi' -File)
$nsis = @(Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'bundle\nsis') -Filter '*.exe' -File)
$artifacts = @($app) + $msi + $nsis

if ($msi.Count -ne 1 -or $nsis.Count -ne 1) {
  throw "Expected exactly one MSI and one NSIS installer. Found MSI=$($msi.Count), NSIS=$($nsis.Count)."
}

$invalid = @()
foreach ($artifact in $artifacts) {
  $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
  if ($signature.Status -ne 'Valid') {
    $invalid += "$($artifact.FullName): $($signature.Status)"
  }
}

if ($invalid.Count -gt 0) {
  throw "Unsigned or invalid release artifacts:`n$($invalid -join "`n")"
}

foreach ($artifact in $artifacts) {
  $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $artifact.FullName
  Write-Output "$($hash.Hash)  $($artifact.Name)"
}
