#requires -Version 7.0
param([string]$ElectronPath, [switch]$Smoke, [switch]$CloseDuringStartup)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$trialRoot = Join-Path $repoRoot '_sandbox\bilibili-native-spike'
$clientPath = Join-Path $trialRoot 'client\哔哩哔哩.exe'
if ($CloseDuringStartup -and -not $Smoke) { throw '-CloseDuringStartup requires -Smoke.' }
$hasher = [System.Security.Cryptography.SHA256]::Create()
try { $trialKey = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($repoRoot.ToLowerInvariant()))).Replace('-', '') }
finally { $hasher.Dispose() }
$trialMutex = [Threading.Mutex]::new($false, "Local\NekoBilibiliTrial-$trialKey")
$ownsMutex = $false
try {
try { $ownsMutex = $trialMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
if (-not $ownsMutex) { throw 'Another trial launcher is already running in this checkout.' }
if (-not $ElectronPath) {
    $candidates = @(
        (Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'),
        (Join-Path (Split-Path $repoRoot -Parent) '_archive\neko-fish\node_modules\electron\dist\electron.exe')
    )
    $ElectronPath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $ElectronPath -or -not (Test-Path -LiteralPath $ElectronPath)) { throw 'Pass -ElectronPath with an installed Electron executable.' }
if (-not (Test-Path -LiteralPath $clientPath)) { throw 'Extract the official signed Windows x64 client into _sandbox/bilibili-native-spike/client first. See README.md.' }
$signature = Get-AuthenticodeSignature -LiteralPath $clientPath
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '上海哔哩哔哩科技有限公司') { throw 'Client publisher signature verification failed.' }
if ((Get-Item -LiteralPath $clientPath).VersionInfo.FileVersion -ne '1.19.0.5062') { throw 'This experimental controls mask is verified only for client 1.19.0.5062.' }
$existing = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $clientPath })
if ($existing.Count) { throw 'The isolated client is already running. Exit it before starting another trial.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /platform:x64 /r:System.Drawing.dll /r:System.Web.Extensions.dll "/out:$trialRoot\WindowBridge.exe" (Join-Path $PSScriptRoot 'WindowBridge.cs')
if ($LASTEXITCODE -ne 0) { throw 'WindowBridge compilation failed.' }
$launchArgs = @((Join-Path $PSScriptRoot 'main.cjs'))
if ($Smoke) { $launchArgs += '--smoke' }
Write-Host 'Launching isolated trial; no HTTP port. Close the host to restore the client. PID records: _sandbox/bilibili-native-spike/pids.json'
$savedRunAsNode = $env:ELECTRON_RUN_AS_NODE
$trialStartedAt = Get-Date
try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    # Quoted full path is necessary for both spaces and Unicode in the checkout.
    $argumentText = '"' + $launchArgs[0] + '"'
    if ($Smoke) { $argumentText += ' --smoke' }
    if ($CloseDuringStartup) { $argumentText += ' --close-during-startup' }
    $trialProcess = Start-Process -FilePath $ElectronPath -ArgumentList $argumentText -PassThru
    $trialProcess.WaitForExit()
    if ($Smoke) {
        $events = Get-Content (Join-Path $trialRoot 'smoke.jsonl') | ForEach-Object { $_ | ConvertFrom-Json }
        if (-not ($events | Where-Object { $_.type -eq 'smoke-complete' })) { throw 'Smoke did not complete; inspect smoke.jsonl.' }
    }
} finally {
    if ($Smoke -and $trialProcess -and $trialProcess.HasExited) {
        # The official launcher can restart itself. Limit cleanup to this fresh isolated executable.
        Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $clientPath -and $_.CreationDate -ge $trialStartedAt } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    }
    if ($null -ne $savedRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $savedRunAsNode }
}
} finally {
    if ($ownsMutex) { $trialMutex.ReleaseMutex() }
    $trialMutex.Dispose()
}
