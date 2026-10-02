# Compatible with Windows PowerShell 5.1 and PowerShell 7.
$ErrorActionPreference = 'Stop'

try {
    if ($env:OS -ne 'Windows_NT') {
        throw 'Run build-win.ps1 on Windows.'
    }
    if (-not (Get-Command go -CommandType Application -ErrorAction SilentlyContinue)) {
        throw 'Install Go (see go.mod for the required version) and add it to PATH.'
    }

    # Resolve the project from this script, including paths containing spaces.
    Push-Location -LiteralPath $PSScriptRoot
    try {
        # Use the project version without requiring a global Wails CLI installation.
        $wailsVersion = & go list -m -f '{{.Version}}' github.com/wailsapp/wails/v2
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        if ([string]::IsNullOrWhiteSpace($wailsVersion)) {
            throw 'Unable to resolve the Wails version from go.mod.'
        }

        Write-Host "Building DiskLanded for Windows x64, Wails $wailsVersion..."
        & go run "github.com/wailsapp/wails/v2/cmd/wails@$wailsVersion" build `
            -skipbindings -trimpath -m -nosyncgomod -platform windows/amd64
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        Write-Host "Built: $(Join-Path $PSScriptRoot 'build\bin\DiskLanded.exe')"
    }
    finally {
        Pop-Location
    }
}
catch {
    [Console]::Error.WriteLine("Error: $($_.Exception.Message)")
    exit 1
}
