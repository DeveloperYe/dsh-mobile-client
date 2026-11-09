# Rewrite a zip so every entry name uses '/' (aapt2 on Windows emits '\' for -A assets,
# and Android's AssetManager then cannot find assets/www/app.js).
# resources.arsc must stay uncompressed for targetSdk >= 30, so it is copied with no
# compression while everything else keeps deflate.
#
#   pwsh -File tools/fix-zip-names.ps1 -In a.apk -Out b.apk
param(
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
try { Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue } catch {}

$In = (Resolve-Path $In).Path
if (Test-Path $Out) { Remove-Item $Out -Force }

$srcZip = [System.IO.Compression.ZipFile]::OpenRead($In)
try {
    $dstStream = [System.IO.File]::Open($Out, [System.IO.FileMode]::CreateNew)
    try {
        $dstZip = New-Object System.IO.Compression.ZipArchive($dstStream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($e in $srcZip.Entries) {
                $name = $e.FullName.Replace('\', '/')
                $store = ($name -eq 'resources.arsc')
                $level = if ($store) { [System.IO.Compression.CompressionLevel]::NoCompression } else { [System.IO.Compression.CompressionLevel]::Optimal }
                $ne = $dstZip.CreateEntry($name, $level)
                $ne.LastWriteTime = $e.LastWriteTime
                $s = $e.Open()
                $t = $ne.Open()
                $s.CopyTo($t)
                $t.Dispose(); $s.Dispose()
            }
        } finally { $dstZip.Dispose() }
    } finally { $dstStream.Dispose() }
} finally { $srcZip.Dispose() }

Write-Host "rewrote entry names: $Out"
