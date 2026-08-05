# PowerShell equivalent of make_bundle.sh — zip the pipeline for Colab upload.
#
#   cd pipeline
#   .\make_bundle.ps1
#
# (If PowerShell refuses to run it: powershell -ExecutionPolicy Bypass -File .\make_bundle.ps1)
#
# Same two quirks as the bash version, for the same reasons:
#   * build the zip in TEMP and copy it in — writing a large archive in place
#     inside a OneDrive-synced folder races the sync client.
#   * stage the files first so __pycache__ stays out of the archive; stale
#     .pyc in a Colab upload is pure confusion for zero benefit.
#
# NOT Compress-Archive: Windows PowerShell 5.1 writes "vbpipe\plays.py" into the
# entry names, but the ZIP spec says "/". Linux unzippers (Colab) then read the
# backslash as part of the filename and you get flat files, no vbpipe package,
# and a ModuleNotFoundError. We write the entries ourselves with "/".

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$items = @("pyproject.toml", "README.md", "vbpipe", "ball_v3.json")
$missing = $items | Where-Object { -not (Test-Path $_) }
if ($missing) { throw "missing from $PSScriptRoot : $($missing -join ', ')" }

$stage = Join-Path $env:TEMP "vbpipe_stage"
$tmpZip = Join-Path $env:TEMP "vbpipe.zip"
Remove-Item $stage, $tmpZip, "vbpipe.zip" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage | Out-Null

foreach ($i in $items) {
    if (Test-Path $i -PathType Container) {
        Copy-Item $i -Destination $stage -Recurse
    } else {
        Copy-Item $i -Destination $stage
    }
}
Get-ChildItem $stage -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($tmpZip, "Create")
try {
    $root = (Resolve-Path $stage).Path.TrimEnd("\") + "\"
    Get-ChildItem $stage -Recurse -File | ForEach-Object {
        $entry = $_.FullName.Substring($root.Length).Replace("\", "/")
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $_.FullName, $entry) | Out-Null
    }
} finally { $zip.Dispose() }

# sanity check: every entry must use "/" and the package must be in there
$check = [System.IO.Compression.ZipFile]::OpenRead($tmpZip)
try {
    $names = $check.Entries | ForEach-Object { $_.FullName }
    if ($names -match "\\") { throw "zip contains backslash entry names - Colab will not import vbpipe" }
    if (-not ($names -contains "vbpipe/__init__.py")) { throw "zip is missing vbpipe/__init__.py" }
} finally { $check.Dispose() }

Copy-Item $tmpZip "vbpipe.zip" -Force
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

$kb = [math]::Round((Get-Item "vbpipe.zip").Length / 1KB)
Write-Host "wrote vbpipe.zip ($kb KB, $($names.Count) entries) -> copy to Drive/balltime"
