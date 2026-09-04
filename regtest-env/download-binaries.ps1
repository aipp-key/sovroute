# ===================================================================
# UNIVERSAL AGENT ASSET ROUTER — REGTEST BINARY DOWNLOADER
# Pinned Versions:
# - Bitcoin Core: v28.0
# - LND: v0.18.5-beta
# ===================================================================

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = Join-Path $scriptDir "bin"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$bitcoinZip = Join-Path $binDir "bitcoin-28.0-win64.zip"
$lndZip = Join-Path $binDir "lnd-windows-amd64-v0.18.5-beta.zip"

# 1. Download & Extract Bitcoin Core v28.0
if (-not (Test-Path (Join-Path $binDir "bitcoind.exe"))) {
    Write-Host "[1/2] Downloading Bitcoin Core v28.0..."
    $bitcoinUrl = "https://bitcoincore.org/bin/bitcoin-core-28.0/bitcoin-28.0-win64.zip"
    curl.exe -L -s -o $bitcoinZip $bitcoinUrl
    
    Write-Host "Extracting Bitcoin Core binaries..."
    tar.exe -xf $bitcoinZip -C $binDir
    
    Copy-Item (Join-Path $binDir "bitcoin-28.0/bin/bitcoind.exe") $binDir -Force
    Copy-Item (Join-Path $binDir "bitcoin-28.0/bin/bitcoin-cli.exe") $binDir -Force
    
    Remove-Item $bitcoinZip -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $binDir "bitcoin-28.0") -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Bitcoin Core v28.0 ready: $(Join-Path $binDir 'bitcoind.exe')"
} else {
    Write-Host "Bitcoin Core already present in $binDir"
}

# 2. Download & Extract LND v0.18.5-beta
if (-not (Test-Path (Join-Path $binDir "lnd.exe"))) {
    Write-Host "[2/2] Downloading LND v0.18.5-beta..."
    $lndUrl = "https://github.com/lightningnetwork/lnd/releases/download/v0.18.5-beta/lnd-windows-amd64-v0.18.5-beta.zip"
    curl.exe -L -s -o $lndZip $lndUrl
    
    Write-Host "Extracting LND binaries..."
    tar.exe -xf $lndZip -C $binDir
    
    Copy-Item (Join-Path $binDir "lnd-windows-amd64-v0.18.5-beta/lnd.exe") $binDir -Force
    Copy-Item (Join-Path $binDir "lnd-windows-amd64-v0.18.5-beta/lncli.exe") $binDir -Force
    
    Remove-Item $lndZip -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $binDir "lnd-windows-amd64-v0.18.5-beta") -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "LND v0.18.5-beta ready: $(Join-Path $binDir 'lnd.exe')"
} else {
    Write-Host "LND already present in $binDir"
}

Write-Host "All regtest binaries verified."
