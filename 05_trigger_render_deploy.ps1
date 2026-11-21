<#
.SYNOPSIS
    PulseRadar Render Production Deployment Trigger & Health Monitor.

.DESCRIPTION
    Triggers deployment on Render via Deploy Hook URL or Render API Key, and monitors
    the service health until the live endpoint responds successfully.

.PARAMETER DeployHookUrl
    The secret Deploy Hook URL from Render Dashboard (e.g. https://api.render.com/deploy/srv-dbtteu8u01pc73d2ed60?key=SECRET).

.PARAMETER ApiKey
    The Render API Token (e.g. rnd_xxxxxxxxxxxxxxxx).

.PARAMETER ServiceId
    The Render Service ID (default: srv-dbtteu8u01pc73d2ed60).

.PARAMETER TargetUrl
    The public service URL (default: https://pulseradar-server.onrender.com).

.PARAMETER TimeoutSeconds
    Maximum seconds to wait for live health verification (default: 180).

.EXAMPLE
    .\trigger_render_deploy.ps1 -DeployHookUrl "https://api.render.com/deploy/srv-dbtteu8u01pc73d2ed60?key=mykey"

.EXAMPLE
    .\trigger_render_deploy.ps1 -ApiKey "rnd_mytoken123"

.EXAMPLE
    .\trigger_render_deploy.ps1 (Runs diagnostics and displays deployment instructions)
#>

[CmdletBinding()]
param (
    [string]$DeployHookUrl = "",
    [string]$ApiKey = "rnd_WOczb0x2xcENG1Xb0qWFcsmRroTJ",
    [string]$ServiceId = "srv-dbvfo8l9el5s73bokv1g",
    [string]$TargetUrl = "https://pulseradar-server.onrender.com",
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = "Continue"

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "   PulseRadar Server — Render Deployment & Health Monitor" -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "Target URL  : $TargetUrl"
Write-Host "Service ID  : $ServiceId"
Write-Host "Timestamp   : $([DateTime]::UtcNow.ToString('yyyy-MM-dd HH:mm:ss')) UTC"
Write-Host "-----------------------------------------------------------------"

# Step 1: Baseline Check
Write-Host "`n[Step 1/3] Checking current service baseline..." -ForegroundColor Yellow
try {
    $baseline = Invoke-WebRequest -Uri $TargetUrl -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    Write-Host "  Current HTTP Status : $($baseline.StatusCode)" -ForegroundColor Green
    if ($baseline.Content -match "<title>(.*?)</title>") {
        Write-Host "  Current Page Title  : $($Matches[1])" -ForegroundColor Cyan
    }
} catch {
    Write-Host "  Current Status: Service unreachable or non-200 ($($_.Exception.Message))" -ForegroundColor DarkGray
}

try {
    $healthBaseline = Invoke-RestMethod -Uri "$TargetUrl/api/health" -TimeoutSec 5 -ErrorAction Stop
    Write-Host "  Live /api/health    : ok=$($healthBaseline.ok), autoScanRunning=$($healthBaseline.autoScanRunning)" -ForegroundColor Green
} catch {
    Write-Host "  Live /api/health    : Endpoint not ready yet (Expected prior to Web Service deployment)" -ForegroundColor DarkGray
}

# Step 2: Trigger Deployment
Write-Host "`n[Step 2/3] Triggering deployment..." -ForegroundColor Yellow
$deployTriggered = $false

if ($DeployHookUrl) {
    Write-Host "  Triggering via provided Deploy Hook URL..." -ForegroundColor Cyan
    try {
        $hookResp = Invoke-RestMethod -Uri $DeployHookUrl -Method Post -TimeoutSec 15
        Write-Host "  Deploy Hook Response: $(ConvertTo-Json $hookResp -Compress)" -ForegroundColor Green
        $deployTriggered = $true
    } catch {
        Write-Error "  Failed to invoke Deploy Hook: $($_.Exception.Message)"
    }
} elseif ($ApiKey) {
    Write-Host "  Triggering via Render REST API (Service ID: $ServiceId)..." -ForegroundColor Cyan
    try {
        $headers = @{
            "Authorization" = "Bearer $ApiKey"
            "Accept"        = "application/json"
            "Content-Type"  = "application/json"
        }
        $body = @{ "clearCache" = "clear" } | ConvertTo-Json
        $apiResp = Invoke-RestMethod -Uri "https://api.render.com/v1/services/$ServiceId/deploys" `
            -Method Post -Headers $headers -Body $body -TimeoutSec 15
        Write-Host "  Render API Deploy Triggered: ID=$($apiResp.deploy.id), Status=$($apiResp.deploy.status)" -ForegroundColor Green
        $deployTriggered = $true
    } catch {
        Write-Error "  Failed to trigger via Render API: $($_.Exception.Message)"
    }
} else {
    Write-Host "  [NOTICE] Neither -DeployHookUrl nor -ApiKey was provided." -ForegroundColor Yellow
    Write-Host "  Deployment can be executed through any of these 3 standard Render methods:" -ForegroundColor White
    Write-Host ""
    Write-Host "  1. Render Dashboard Manual Trigger:" -ForegroundColor White
    Write-Host "     - Open: https://dashboard.render.com/web/$ServiceId" -ForegroundColor DarkCyan
    Write-Host "     - Click 'Manual Deploy' -> 'Deploy latest commit'" -ForegroundColor DarkCyan
    Write-Host ""
    Write-Host "  2. Deploy Hook Trigger:" -ForegroundColor White
    Write-Host "     - Find your deploy hook at: Dashboard -> Service Settings -> Deploy Hook" -ForegroundColor DarkCyan
    Write-Host "     - Execute: .\trigger_render_deploy.ps1 -DeployHookUrl `"https://api.render.com/deploy/$ServiceId`?key=YOUR_KEY`"" -ForegroundColor DarkCyan
    Write-Host ""
    Write-Host "  3. Git Push Trigger:" -ForegroundColor White
    Write-Host "     - Connect repository to GitHub/GitLab and push 'main' branch." -ForegroundColor DarkCyan
    Write-Host "     - Render will automatically trigger build & deploy via render.yaml." -ForegroundColor DarkCyan
    Write-Host ""
}

# Step 3: Health Monitor Loop
Write-Host "`n[Step 3/3] Probing endpoint health (/api/health)..." -ForegroundColor Yellow
$startTime = [DateTime]::UtcNow
$isHealthy = $false

while (([DateTime]::UtcNow - $startTime).TotalSeconds -lt $TimeoutSeconds) {
    $elapsed = [math]::Round(([DateTime]::UtcNow - $startTime).TotalSeconds)
    try {
        $health = Invoke-RestMethod -Uri "$TargetUrl/api/health" -TimeoutSec 5 -ErrorAction Stop
        if ($health.ok -eq $true) {
            # Also strictly verify root URL does not serve static starter template
            $rootResp = Invoke-WebRequest -Uri $TargetUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($rootResp.Content -match "Your first deploy" -or $rootResp.Content -match "sample-static-site") {
                Write-Host -NoNewline "w"
                Start-Sleep -Seconds 5
                continue
            }
            Write-Host "`n>>> DEPLOYMENT VERIFIED SUCCESSFUL! <<<" -ForegroundColor Green
            Write-Host "  Target URL        : $TargetUrl" -ForegroundColor Green
            Write-Host "  Health OK         : $($health.ok)" -ForegroundColor Green
            Write-Host "  Server Port       : $($health.port)" -ForegroundColor Green
            Write-Host "  AutoScan Running  : $($health.autoScanRunning)" -ForegroundColor Green
            Write-Host "  Server Time       : $($health.serverTime)" -ForegroundColor Green
            $isHealthy = $true
            break
        }
    } catch {
        Write-Host -NoNewline "."
        Start-Sleep -Seconds 5
    }
}

if (-not $isHealthy) {
    Write-Host "`n"
    Write-Host "-----------------------------------------------------------------"
    Write-Host "Health check timed out after $TimeoutSeconds seconds." -ForegroundColor Yellow
    Write-Host "If deployment is currently building in Render Dashboard, wait 2-3 minutes"
    Write-Host "for container build and cold-boot, then re-run:"
    Write-Host "  Invoke-RestMethod -Uri '$TargetUrl/api/health'" -ForegroundColor Cyan
    Write-Host "-----------------------------------------------------------------"
}

exit $(if ($isHealthy) { 0 } else { 1 })
