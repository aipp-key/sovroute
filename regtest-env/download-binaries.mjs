import { createWriteStream, existsSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  BinaryIntegrityVerifier,
  OFFICIAL_REGTEST_BINARIES,
} from '../src/supply-chain/binary-verifier.ts';
import { TRUSTED_BINARY_MANIFEST } from '../src/supply-chain/trusted-binary-manifest.ts';
import { ManifestVerifier } from '../src/supply-chain/manifest-verifier.ts';
import { StartupVerifier } from '../src/supply-chain/startup-verifier.ts';

const binDir = join(process.cwd(), 'regtest-env', 'bin');

async function downloadFile(url, destPath) {
  console.log(`Downloading ${url} -> ${destPath}...`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Failed to download: ${res.status} ${res.statusText}`);

  const totalBytes = Number(res.headers.get('content-length') || 0);
  let downloadedBytes = 0;
  let lastReport = 0;

  const reader = res.body.getReader();
  const stream = new Readable({
    async read() {
      const { done, value } = await reader.read();
      if (done) {
        this.push(null);
      } else {
        downloadedBytes += value.length;
        const now = Date.now();
        if (now - lastReport > 2000) {
          const mb = (downloadedBytes / (1024 * 1024)).toFixed(1);
          const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
          console.log(`Progress: ${mb}MB / ${totalMb}MB`);
          lastReport = now;
        }
        this.push(value);
      }
    },
  });

  const fileStream = createWriteStream(destPath);
  await pipeline(stream, fileStream);
  console.log(`Downloaded ${destPath} successfully.`);
}

async function main() {
  console.log('======================================================');
  console.log('CRYPTOGRAPHIC SUPPLY-CHAIN BINARY & MANIFEST VERIFICATION');
  console.log('======================================================');

  const bitcoindExe = join(binDir, 'bitcoind.exe');
  const bitcoinCliExe = join(binDir, 'bitcoin-cli.exe');
  const lndExe = join(binDir, 'lnd.exe');
  const lncliExe = join(binDir, 'lncli.exe');

  // -----------------------------------------------------------------
  // 1. Bitcoin Core v28.0.0 — Signed Manifest & Binary Verification
  // -----------------------------------------------------------------
  if (!existsSync(bitcoindExe)) {
    console.log('\n[1/2] Fetching and verifying Bitcoin Core signed manifest...');
    const manifestUrl = TRUSTED_BINARY_MANIFEST.BITCOIN_CORE.manifestUrl;
    const signatureUrl = TRUSTED_BINARY_MANIFEST.BITCOIN_CORE.signatureUrl;

    const manifestText = await (await fetch(manifestUrl)).text();
    const ascText = await (await fetch(signatureUrl)).text();

    console.log('Verifying Bitcoin Core PGP signatures against pinned builder fingerprints...');
    const btcManifestResult = await ManifestVerifier.verifyBitcoinCoreManifest(manifestText, ascText);
    console.log(`[PASS] Bitcoin Core manifest authentic! Verified signers: ${btcManifestResult.signerFingerprints.join(', ')}`);

    const btcZip = join(binDir, TRUSTED_BINARY_MANIFEST.BITCOIN_CORE.archiveFilename);
    await downloadFile(TRUSTED_BINARY_MANIFEST.BITCOIN_CORE.archiveUrl, btcZip);

    console.log('Verifying Bitcoin Core archive SHA-256 against authenticated manifest...');
    BinaryIntegrityVerifier.verifyOrReject(
      btcZip,
      TRUSTED_BINARY_MANIFEST.BITCOIN_CORE.archiveSha256,
      'Bitcoin Core Archive'
    );
    console.log('[PASS] Bitcoin Core archive checksum verified.');

    console.log('Extracting Bitcoin Core...');
    execSync(`tar.exe -xf "${btcZip}" -C "${binDir}"`);
    copyFileSync(join(binDir, 'bitcoin-28.0', 'bin', 'bitcoind.exe'), bitcoindExe);
    copyFileSync(join(binDir, 'bitcoin-28.0', 'bin', 'bitcoin-cli.exe'), bitcoinCliExe);
    rmSync(btcZip, { force: true });
    rmSync(join(binDir, 'bitcoin-28.0'), { recursive: true, force: true });

    console.log('Verifying extracted bitcoind.exe SHA-256 against trusted manifest...');
    BinaryIntegrityVerifier.verifyOrReject(
      bitcoindExe,
      TRUSTED_BINARY_MANIFEST.BITCOIN_CORE.binaries['bitcoind.exe'],
      'bitcoind.exe'
    );
    console.log('[PASS] Bitcoin Core v28.0.0 installed and cryptographically verified.');
  } else {
    console.log('\n[1/2] Verifying cached bitcoind.exe SHA-256 against trusted manifest...');
    BinaryIntegrityVerifier.verifyOrReject(
      bitcoindExe,
      TRUSTED_BINARY_MANIFEST.BITCOIN_CORE.binaries['bitcoind.exe'],
      'Cached bitcoind.exe'
    );
    console.log('[PASS] Cached bitcoind.exe verified against trusted binary manifest.');
  }

  // -----------------------------------------------------------------
  // 2. LND v0.18.5-beta — Signed Manifest & Binary Verification
  // -----------------------------------------------------------------
  if (!existsSync(lndExe) || !existsSync(lncliExe)) {
    console.log('\n[2/2] Fetching and verifying LND signed manifest...');
    const manifestUrl = TRUSTED_BINARY_MANIFEST.LND.manifestUrl;
    const manifestText = await (await fetch(manifestUrl)).text();

    const sigFiles = [
      'manifest-guggero-v0.18.5-beta.sig',
      'manifest-ellemouton-v0.18.5-beta.sig',
      'manifest-roasbeef-v0.18.5-beta.sig',
      'manifest-yyforyongyu-v0.18.5-beta.sig',
      'manifest-ziggie1984-v0.18.5-beta.sig',
    ];

    const signatures = [];
    for (const sf of sigFiles) {
      const sigBuf = new Uint8Array(
        await (await fetch(`https://github.com/lightningnetwork/lnd/releases/download/v0.18.5-beta/${sf}`)).arrayBuffer()
      );
      signatures.push({ filename: sf, data: sigBuf });
    }

    console.log('Verifying LND PGP signatures against pinned maintainer fingerprints (quorum >= 5)...');
    const lndManifestResult = await ManifestVerifier.verifyLndManifest(
      manifestText,
      signatures
    );
    console.log(`[PASS] LND manifest authentic! Verified ${lndManifestResult.distinctVerifiedSignerCount}/${lndManifestResult.requiredQuorum} distinct signers: ${lndManifestResult.signerFingerprints.join(', ')}`);

    const lndZip = join(binDir, TRUSTED_BINARY_MANIFEST.LND.archiveFilename);
    await downloadFile(TRUSTED_BINARY_MANIFEST.LND.archiveUrl, lndZip);

    console.log('Verifying LND archive SHA-256 against authenticated manifest...');
    BinaryIntegrityVerifier.verifyOrReject(
      lndZip,
      TRUSTED_BINARY_MANIFEST.LND.archiveSha256,
      'LND Archive'
    );
    console.log('[PASS] LND archive checksum verified.');

    console.log('Extracting LND...');
    execSync(`tar.exe -xf "${lndZip}" -C "${binDir}"`);
    copyFileSync(join(binDir, 'lnd-windows-amd64-v0.18.5-beta', 'lnd.exe'), lndExe);
    copyFileSync(join(binDir, 'lnd-windows-amd64-v0.18.5-beta', 'lncli.exe'), lncliExe);
    rmSync(lndZip, { force: true });
    rmSync(join(binDir, 'lnd-windows-amd64-v0.18.5-beta'), { recursive: true, force: true });

    console.log('Verifying extracted LND binaries SHA-256...');
    BinaryIntegrityVerifier.verifyOrReject(
      lndExe,
      TRUSTED_BINARY_MANIFEST.LND.binaries['lnd.exe'],
      'lnd.exe'
    );
    BinaryIntegrityVerifier.verifyOrReject(
      lncliExe,
      TRUSTED_BINARY_MANIFEST.LND.binaries['lncli.exe'],
      'lncli.exe'
    );
    console.log('[PASS] Extracted LND binaries verified.');
  } else {
    console.log('\n[2/2] Verifying cached LND binaries SHA-256 against trusted manifest...');
    BinaryIntegrityVerifier.verifyOrReject(
      lndExe,
      TRUSTED_BINARY_MANIFEST.LND.binaries['lnd.exe'],
      'Cached lnd.exe'
    );
    BinaryIntegrityVerifier.verifyOrReject(
      lncliExe,
      TRUSTED_BINARY_MANIFEST.LND.binaries['lncli.exe'],
      'Cached lncli.exe'
    );
    console.log('[PASS] Cached LND binaries verified against official release manifest.');
  }

  // -----------------------------------------------------------------
  // 3. Comprehensive Startup Gate Verification
  // -----------------------------------------------------------------
  console.log('\n[3/3] Enforcing full runtime startup verification gate...');
  const startupResult = StartupVerifier.verifyTrustedBinarySet(binDir);
  console.log(`[PASS] All ${startupResult.binaries.length} binaries verified for execution.`);

  console.log('======================================================');
  console.log('ALL REGTEST BINARIES INTEGRITY & AUTHENTICITY VERIFIED');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('\n[FATAL] Cryptographic supply-chain verification failed:', err);
  process.exit(1);
});
