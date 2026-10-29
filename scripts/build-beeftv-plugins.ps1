param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [Parameter(Mandatory = $true)][string]$OutputDir
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$sourceRoot = (Resolve-Path -LiteralPath $SourceDir).Path
[System.IO.Directory]::CreateDirectory($OutputDir) | Out-Null
$outputRoot = (Resolve-Path -LiteralPath $OutputDir).Path
$packageCount = 0
foreach ($pluginDir in Get-ChildItem -LiteralPath $sourceRoot -Directory) {
  $manifestPath = Join-Path $pluginDir.FullName 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { continue }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $manifest.id) { throw "Missing plugin ID: $manifestPath" }
  $archivePath = Join-Path $outputRoot ($pluginDir.Name + '.beeftv-plugin')
  $stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create)
  $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($allowedRoot in @('manifest.json', 'README.md', 'docs', 'assets', 'web', 'backend', 'LICENSE')) {
      $itemPath = Join-Path $pluginDir.FullName $allowedRoot
      if (-not (Test-Path -LiteralPath $itemPath)) { continue }
      $item = Get-Item -LiteralPath $itemPath
      $files = if ($item.PSIsContainer) { Get-ChildItem -LiteralPath $itemPath -File -Recurse } else { @($item) }
      foreach ($file in $files) {
        $entryName = $file.FullName.Substring($pluginDir.FullName.Length + 1).Replace('\', '/')
        $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
        $entryStream = $entry.Open()
        $inputStream = [System.IO.File]::OpenRead($file.FullName)
        try { $inputStream.CopyTo($entryStream) } finally { $inputStream.Dispose(); $entryStream.Dispose() }
      }
    }
  } finally { $archive.Dispose(); $stream.Dispose() }
  $packageCount++
}
if ($packageCount -eq 0) { throw 'No BeefTV protocol packages were built' }
Write-Output "Built $packageCount BeefTV protocol packages"
