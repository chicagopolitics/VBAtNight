# Run the local processing pipeline with the right interpreter, from anywhere.
#
#   .\process.ps1 --videos C:\vb\videos --dry-run
#   .\process.ps1 --videos C:\vb\videos --limit 1
#
# Exists because the two easy mistakes are invisible until they fail:
#   * `python process_games.py` picks whatever is first on PATH (a system
#     3.12 here) instead of the venv that actually has torch;
#   * the script path is relative, so it works from the repo root and breaks
#     from pipeline/, or the reverse.
# This resolves both: the venv's python, and the script next to THIS file,
# regardless of the current directory. All arguments pass straight through.
#
# (If PowerShell refuses to run it: powershell -ExecutionPolicy Bypass -File .\process.ps1 ...)

$ErrorActionPreference = "Stop"

$venv = if ($env:VBPIPE_VENV) { $env:VBPIPE_VENV } else { "C:\vb\venv" }
$py = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $py)) {
    throw "No venv python at $py. See pipeline/README.md -> 'Run (local GPU, Windows)'. " +
          "Set VBPIPE_VENV if yours lives elsewhere."
}

$script = Join-Path $PSScriptRoot "process_games.py"
& $py $script @args
exit $LASTEXITCODE
