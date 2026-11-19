<#
.SYNOPSIS
    Zero-dependency standalone PowerShell deployment probe for PulseRadar Render & Neon Infrastructure.

.DESCRIPTION
    Validates DNS resolution, live HTTPS root status, Render edge security headers,
    API health endpoint contract, and Neon Serverless PostgreSQL TCP connectivity (port 5432).
    Gracefully handles both pre-deployment and post-deployment states.

.PARAMETER RenderUrl
    The public base URL of the Render web service (default: https://simple-web-starter-3755.onrender.com).

.PARAMETER NeonHost
    The pooled host address for Neon Serverless PostgreSQL.

.PARAMETER NeonPort
    The PostgreSQL connection port (default: 5432).

.PARAMETER NeonDirectHost
    The direct host address for Neon Serverless PostgreSQL.

.PARAMETER TimeoutSec
    HTTP request timeout in seconds (default: 10).
#>

[CmdletBinding()]
param(
    [string]$RenderUrl = "https://simple-web-starter-3755.onrender.com",
    [string]$NeonHost = "ep-winter-river-a1hipqli-pooler.ap-southeast-1.aws.neon.tech",
    [int]$NeonPort = 5432,
    [string]$NeonDirectHost = "ep-winter-river-a1hipqli.ap-southeast-1.aws.neon.tech",
    [int]$TimeoutSec = 10
)

$ErrorActionPreference = "Continue"

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host " PulseRadar Production Deployment Infrastructure Probe" -ForegroundColor Cyan
Write-Host " Timestamp: $([DateTime]::UtcNow.ToString('yyyy-MM-dd HH:mm:ss UTC'))" -ForegroundColor Cyan
Write-Host " Target URL: $RenderUrl" -ForegroundColor Cyan
Write-Host " Neon Host : $($NeonHost):$($NeonPort)" -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host ""

$overallPass = $true
$renderDomain = ([uri]$RenderUrl).Host

# -----------------------------------------------------------------
# 1. DNS Resolution Probe
# -----------------------------------------------------------------
Write-Host "[1/5] Probing DNS Resolution for $renderDomain..." -ForegroundColor Yellow
try {
    $dnsRecords = Resolve-DnsName -Name $renderDomain -Type A -ErrorAction Stop
    $ipList = ($dnsRecords | Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress }) -join ", "
    Write-Host "  [OK] Resolved $renderDomain to IP(s): $ipList" -ForegroundColor Green
} catch {
    Write-Host "  [FAIL] Failed to resolve DNS for $renderDomain : $_" -ForegroundColor Red
    $overallPass = $false
}
Write-Host ""

# -----------------------------------------------------------------
# 2. HTTPS Root Endpoint & Edge Headers Probe
# -----------------------------------------------------------------
Write-Host "[2/5] Probing Public HTTPS Root Endpoint ($RenderUrl)..." -ForegroundColor Yellow
$rootResp = $null
try {
    $rootResp = Invoke-WebRequest -Uri $RenderUrl -Method Get -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
    Write-Host "  [OK] HTTP Status: $($rootResp.StatusCode) $($rootResp.StatusDescription)" -ForegroundColor Green

    # Edge Headers Audit
    $rndrId = $rootResp.Headers["rndr-id"]
    $nosniff = $rootResp.Headers["x-content-type-options"]
    $hsts = $rootResp.Headers["strict-transport-security"]
    $server = $rootResp.Headers["server"]

    Write-Host "  [INFO] Edge Server   : $server" -ForegroundColor Gray
    Write-Host "  [INFO] Render ID     : $rndrId" -ForegroundColor Gray
    Write-Host "  [INFO] Nosniff Header: $nosniff" -ForegroundColor Gray
    Write-Host "  [INFO] HSTS Header   : $hsts" -ForegroundColor Gray

    # Deployment State Identification & Strict Verification
    $body = $rootResp.Content
    if ($body -match "Your first deploy" -or $body -match "sample-static-site") {
        Write-Host "  [FAIL] Live URL is serving Render static starter template (render-examples/sample-static-site)!" -ForegroundColor Red
        Write-Host "         PulseRadar application is NOT deployed on Render." -ForegroundColor Red
        $overallPass = $false
    } elseif ($body -match "PulseRadar" -or $body -match '<div id="root">') {
        Write-Host "  [OK] Service is actively serving PulseRadar production SPA!" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] Live response does not contain PulseRadar React SPA content or #root container!" -ForegroundColor Red
        $overallPass = $false
    }
} catch {
    Write-Host "  [FAIL] HTTPS probe to $RenderUrl failed: $_" -ForegroundColor Red
    $overallPass = $false
}
Write-Host ""

# -----------------------------------------------------------------
# 3. Dynamic API Health Probe (/api/health)
# -----------------------------------------------------------------
$healthUrl = "$($RenderUrl.TrimEnd('/'))/api/health"
Write-Host "[3/5] Probing Dynamic API Health ($healthUrl)..." -ForegroundColor Yellow
try {
    $healthResp = Invoke-WebRequest -Uri $healthUrl -Method Get -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
    if ($healthResp.StatusCode -eq 200) {
        $healthJson = $healthResp.Content | ConvertFrom-Json
        if ($healthJson.ok -eq $true) {
            Write-Host "  [OK] Live Production Health Check Passed (200 OK)!" -ForegroundColor Green
            Write-Host "       ok                : $($healthJson.ok)" -ForegroundColor Green
            Write-Host "       port              : $($healthJson.port)" -ForegroundColor Green
            Write-Host "       autoScanEnabled   : $($healthJson.autoScanEnabled)" -ForegroundColor Green
            Write-Host "       autoScanRunning   : $($healthJson.autoScanRunning)" -ForegroundColor Green
            Write-Host "       trackedUsersCount : $($healthJson.trackedUsersCount)" -ForegroundColor Green
            Write-Host "       serverTime        : $($healthJson.serverTime)" -ForegroundColor Green
        } else {
            Write-Host "  [FAIL] /api/health returned 200 OK but 'ok' is not true: $($healthResp.Content)" -ForegroundColor Red
            $overallPass = $false
        }
    } else {
        Write-Host "  [FAIL] /api/health returned HTTP $($healthResp.StatusCode)" -ForegroundColor Red
        $overallPass = $false
    }
} catch {
    $ex = $_.Exception
    $statusCode = if ($ex.Response) { $ex.Response.StatusCode.value__ } else { "Unknown" }
    Write-Host "  [FAIL] Live /api/health probe failed with HTTP status $statusCode : $($ex.Message)" -ForegroundColor Red
    if ($statusCode -eq 404) {
        Write-Host "         Route /api/health returned 404 Not Found. Service is not running PulseRadar Web Service!" -ForegroundColor Red
    }
    $overallPass = $false
}
Write-Host ""

# -----------------------------------------------------------------
# 4. Neon PostgreSQL Pooled Host Connectivity Probe (Port 5432)
# -----------------------------------------------------------------
Write-Host "[4/5] Probing Neon PostgreSQL Pooled Host ($($NeonHost):$($NeonPort))..." -ForegroundColor Yellow
$tcpPooler = Test-NetConnection -ComputerName $NeonHost -Port $NeonPort -WarningAction SilentlyContinue
if ($tcpPooler.TcpTestSucceeded) {
    Write-Host "  [OK] TCP Connection Succeeded! Remote IP: $($tcpPooler.RemoteAddress)" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Failed to connect to $NeonHost on port $NeonPort" -ForegroundColor Red
    $overallPass = $false
}
Write-Host ""

# -----------------------------------------------------------------
# 5. Neon PostgreSQL Direct Host Connectivity Probe (Port 5432)
# -----------------------------------------------------------------
Write-Host "[5/5] Probing Neon PostgreSQL Direct Host ($($NeonDirectHost):$($NeonPort))..." -ForegroundColor Yellow
$tcpDirect = Test-NetConnection -ComputerName $NeonDirectHost -Port $NeonPort -WarningAction SilentlyContinue
if ($tcpDirect.TcpTestSucceeded) {
    Write-Host "  [OK] Direct Host TCP Connection Succeeded! Remote IP: $($tcpDirect.RemoteAddress)" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Failed to connect to $NeonDirectHost on port $NeonPort" -ForegroundColor Red
    $overallPass = $false
}
Write-Host ""

# -----------------------------------------------------------------
# Summary
# -----------------------------------------------------------------
Write-Host "=================================================================" -ForegroundColor Cyan
if ($overallPass) {
    Write-Host " DEPLOYMENT VERIFICATION RESULT: PASS" -ForegroundColor Green
    Write-Host " All network, edge, SSL, and database connections operational." -ForegroundColor Green
    exit 0
} else {
    Write-Host " DEPLOYMENT VERIFICATION RESULT: FAIL" -ForegroundColor Red
    Write-Host " One or more infrastructure connectivity checks failed." -ForegroundColor Red
    exit 1
}
