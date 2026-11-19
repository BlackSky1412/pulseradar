param(
    [string]$AdbPath = "D:\Install\Android\SDK\platform-tools\adb.exe",
    [string]$DeviceSerial = "192.168.1.9:36215",
    [string]$PackageName = "com.example.streamrecorder.debug",
    [string]$AndroidBaseUrl = "http://192.168.1.9:8765",
    [string]$ServerBaseUrl = "http://192.168.1.10:3000",
    [int]$LogcatLines = 500,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

Write-Host "=== StreamRecorder SM_N770F Verification ==="
Write-Host "AdbPath       : $AdbPath"
Write-Host "DeviceSerial  : $DeviceSerial"
Write-Host "PackageName   : $PackageName"
Write-Host "AndroidBaseUrl: $AndroidBaseUrl"
Write-Host "ServerBaseUrl : $ServerBaseUrl"
Write-Host "DryRun        : $DryRun"

if (-not (Test-Path $AdbPath)) {
    if ($DryRun) {
        Write-Warning "ADB not found at $AdbPath (continuing DryRun syntax validation)"
    } else {
        Write-Error "ADB executable not found at $AdbPath"
        exit 1
    }
}

function Invoke-StepCmd {
    param(
        [string]$Label,
        [string]$CommandDisplay,
        [scriptblock]$Action
    )
    Write-Host ""
    Write-Host "[$Label]"
    if ($DryRun) {
        Write-Host "[DRY-RUN] $CommandDisplay"
        Write-Host "Result: SKIP (DryRun)"
        return $null
    }
    $output = & $Action
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$Label failed with exit code $LASTEXITCODE"
        exit 1
    }
    return $output
}

# 1. Device connectivity
$state = Invoke-StepCmd -Label "1. ADB Device State" -CommandDisplay "`"$AdbPath`" -s $DeviceSerial get-state" -Action {
    & $AdbPath -s $DeviceSerial get-state
}
if (-not $DryRun) {
    $trimmedState = ($state | Out-String).Trim()
    if ($trimmedState -ne "device") {
        Write-Error "Expected device state 'device', got '$trimmedState'"
        exit 1
    }
    Write-Host "Device state: $trimmedState"
}

# 2. Installed debug package (--user 0 required on Samsung Dual Messenger devices)
$pkgOut = Invoke-StepCmd -Label "2. Installed Package (--user 0)" -CommandDisplay "`"$AdbPath`" -s $DeviceSerial shell pm list packages --user 0 $PackageName" -Action {
    & $AdbPath -s $DeviceSerial shell pm list packages --user 0 $PackageName
}
if (-not $DryRun) {
    $pkgStr = ($pkgOut | Out-String)
    if ($pkgStr -notmatch "package:$([regex]::Escape($PackageName))") {
        Write-Error "Package '$PackageName' not installed for --user 0. Output: $pkgStr"
        exit 1
    }
    Write-Host "Verified package: $PackageName"
}

# 3. Foreground service & process running (--user 0)
$pidOut = Invoke-StepCmd -Label "3a. Process PID" -CommandDisplay "`"$AdbPath`" -s $DeviceSerial shell pidof $PackageName" -Action {
    & $AdbPath -s $DeviceSerial shell pidof $PackageName
}
if (-not $DryRun) {
    $pidStr = ($pidOut | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($pidStr)) {
        Write-Error "App process $PackageName is not running. Start via: `"$AdbPath`" -s $DeviceSerial shell am start-foreground-service --user 0 -n `"$PackageName/com.example.streamrecorder.service.StreamMonitorService`""
        exit 1
    }
    Write-Host "PID: $pidStr"
}

$svcOut = Invoke-StepCmd -Label "3b. Foreground Service (--user 0)" -CommandDisplay "`"$AdbPath`" -s $DeviceSerial shell dumpsys activity services --user 0 $PackageName" -Action {
    & $AdbPath -s $DeviceSerial shell dumpsys activity services --user 0 $PackageName
}
if (-not $DryRun) {
    $svcStr = ($svcOut | Out-String)
    if ($svcStr -notmatch "StreamMonitorService") {
        Write-Error "StreamMonitorService not active in dumpsys activity services --user 0"
        exit 1
    }
    Write-Host "StreamMonitorService active (--user 0)"
}

# 4. Phone HTTP GET /health probe
if ($DryRun) {
    Write-Host ""
    Write-Host "[4. Phone HTTP GET /health]"
    Write-Host "[DRY-RUN] Invoke-RestMethod -Uri `"$AndroidBaseUrl/health`" -Method Get -TimeoutSec 5"
    Write-Host "Result: SKIP (DryRun)"
} else {
    Write-Host ""
    Write-Host "[4. Phone HTTP GET /health]"
    $androidHealth = Invoke-RestMethod -Uri "$AndroidBaseUrl/health" -Method Get -TimeoutSec 5
    if (-not $androidHealth.ok) { Write-Error "Android /health ok != true"; exit 1 }
    if (-not $androidHealth.pollingDisabled) { Write-Error "Android /health pollingDisabled != true"; exit 1 }
    if ($androidHealth.listeningPort -ne 8765) { Write-Error "Unexpected listeningPort: $($androidHealth.listeningPort)"; exit 1 }
    if ($androidHealth.ip -notmatch "^\d{1,3}(\.\d{1,3}){3}$") { Write-Error "Invalid Android IP: $($androidHealth.ip)"; exit 1 }
    Write-Host "Android /health OK (port=$($androidHealth.listeningPort), ip=$($androidHealth.ip), userCount=$($androidHealth.userCount), activeRecordings=$($androidHealth.activeRecordings))"
}

# 5. PulseRadar Server GET /api/android/status probe
if ($DryRun) {
    Write-Host ""
    Write-Host "[5. Server GET /api/android/status]"
    Write-Host "[DRY-RUN] Invoke-RestMethod -Uri `"$ServerBaseUrl/api/android/status`" -Method Get -TimeoutSec 5"
    Write-Host "Result: SKIP (DryRun)"
} else {
    Write-Host ""
    Write-Host "[5. Server GET /api/android/status]"
    $serverStatus = Invoke-RestMethod -Uri "$ServerBaseUrl/api/android/status" -Method Get -TimeoutSec 5
    if (-not $serverStatus.ok) { Write-Error "Server /api/android/status ok != true"; exit 1 }
    if (-not $serverStatus.scanner.enabled) { Write-Error "Server scanner.enabled != true"; exit 1 }
    if (-not $serverStatus.device) { Write-Error "No Android device registered on server"; exit 1 }
    Write-Host "Server device OK (ip=$($serverStatus.device.ip), port=$($serverStatus.device.port), lastSeenAt=$($serverStatus.device.lastSeenAt))"
}

# 6. Logcat passive-mode audit
$logOut = Invoke-StepCmd -Label "6. Logcat Passive-Mode Audit" -CommandDisplay "`"$AdbPath`" -s $DeviceSerial logcat -d -t $LogcatLines" -Action {
    & $AdbPath -s $DeviceSerial logcat -d -t $LogcatLines
}
if (-not $DryRun) {
    $filteredLines = ($logOut | Out-String) -split "`r?`n" | Where-Object {
        $_ -match "StreamMonitorService|LocalCommandHttpServer|PulseRadarClient|NetworkMonitor"
    }
    $joined = $filteredLines -join "`n"
    if ($joined -match "Bắt đầu chu kỳ quét Live" -or $joined -match "checkAllUsers") {
        Write-Error "Forbidden local-polling log signature found in logcat!"
        exit 1
    }
    Write-Host "Logcat passive-mode audit passed ($($filteredLines.Count) matching lines, zero polling signatures)."
}

# Reference safe launch command (--user 0)
if ($DryRun) {
    Write-Host ""
    Write-Host "[Reference Safe Launch (--user 0)]"
    Write-Host "[DRY-RUN] `"$AdbPath`" -s $DeviceSerial shell am start --user 0 -n `"$PackageName/com.example.streamrecorder.MainActivity`""
}

Write-Host ""
Write-Host "Verification completed successfully."
exit 0
