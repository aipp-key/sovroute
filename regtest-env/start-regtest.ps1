# ===================================================================
# UNIVERSAL AGENT ASSET ROUTER — START REGTEST NODES
# ===================================================================

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = Join-Path $scriptDir "bin"
$dataDir = Join-Path $scriptDir "data"

$bitcoindBin = Join-Path $binDir "bitcoind.exe"
$bitcoinCliBin = Join-Path $binDir "bitcoin-cli.exe"
$lndBin = Join-Path $binDir "lnd.exe"
$lncliBin = Join-Path $binDir "lncli.exe"

$bitcoindConf = Join-Path $scriptDir "bitcoind.conf"
$bitcoindData = Join-Path $dataDir "bitcoind"
$lndAConf = Join-Path $scriptDir "lnd-a.conf"
$lndAData = Join-Path $dataDir "lnd-a"
$lndBConf = Join-Path $scriptDir "lnd-b.conf"
$lndBData = Join-Path $dataDir "lnd-b"

Write-Host "Starting bitcoind..."
Start-Process -FilePath $bitcoindBin -ArgumentList "-conf=`"$bitcoindConf`"", "-datadir=`"$bitcoindData`"" -WindowStyle Hidden

# Wait for bitcoind RPC
Write-Host "Waiting for bitcoind RPC..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $info = & $bitcoinCliBin -regtest -datadir="$bitcoindData" -rpcuser=regtest -rpcpassword=regtest getblockchaininfo 2>$null
        if ($info -and $info -match '"chain":\s*"regtest"') {
            $ready = $true
            break
        }
    } catch {
        # Retry
    }
    Start-Sleep -Seconds 1
}

if (-not $ready) {
    throw "bitcoind failed to start"
}
Write-Host "bitcoind online."

# Start LND-A
Write-Host "Starting LND-A..."
Start-Process -FilePath $lndBin -ArgumentList "--configfile=`"$lndAConf`"", "--lnddir=`"$lndAData`"" -WindowStyle Hidden

# Start LND-B
Write-Host "Starting LND-B..."
Start-Process -FilePath $lndBin -ArgumentList "--configfile=`"$lndBConf`"", "--lnddir=`"$lndBData`"" -WindowStyle Hidden

# Wait for LND-A
Write-Host "Waiting for LND-A..."
$readyA = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $infoA = & $lncliBin --network=regtest --rpcserver=127.0.0.1:10009 --lnddir="$lndAData" getinfo 2>$null
        if ($infoA -and $infoA -match '"identity_pubkey"') {
            $readyA = $true
            break
        }
    } catch {
        # Retry
    }
    Start-Sleep -Seconds 1
}

if (-not $readyA) {
    throw "LND-A failed to start"
}
Write-Host "LND-A online."

# Wait for LND-B
Write-Host "Waiting for LND-B..."
$readyB = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $infoB = & $lncliBin --network=regtest --rpcserver=127.0.0.1:10010 --lnddir="$lndBData" getinfo 2>$null
        if ($infoB -and $infoB -match '"identity_pubkey"') {
            $readyB = $true
            break
        }
    } catch {
        # Retry
    }
    Start-Sleep -Seconds 1
}

if (-not $readyB) {
    throw "LND-B failed to start"
}
Write-Host "LND-B online."

Write-Host "======================================================"
Write-Host "ALL REGTEST NODES ONLINE"
Write-Host "  bitcoind: 127.0.0.1:18443"
Write-Host "  LND-A:    127.0.0.1:18080 (REST), 127.0.0.1:10009 (gRPC)"
Write-Host "  LND-B:    127.0.0.1:18081 (REST), 127.0.0.1:10010 (gRPC)"
Write-Host "======================================================"
