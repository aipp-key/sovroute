/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Binary Supply-Chain & Release Integrity Verifier
 *
 * Enforces cryptographic verification of downloaded binaries and archives
 * against official published release manifests before extraction or execution.
 *
 * FAIL-CLOSED: Any hash mismatch immediately unlinks the corrupt artifact
 * and halts execution.
 */

import { createHash } from 'node:crypto';
import { readFileSync, rmSync, existsSync } from 'node:fs';

export const OFFICIAL_REGTEST_BINARIES = {
  BITCOIN_CORE: {
    version: '28.0.0',
    platform: 'win64',
    archiveFilename: 'bitcoin-28.0-win64.zip',
    archiveUrl: 'https://bitcoincore.org/bin/bitcoin-core-28.0/bitcoin-28.0-win64.zip',
    // Source: https://bitcoincore.org/bin/bitcoin-core-28.0/SHA256SUMS
    archiveSha256: '85282f4ec1bcb0cfe8db0f195e8e0f6fb77cfbe89242a81fff2bc2e9292f7acf',
    checksumManifestUrl: 'https://bitcoincore.org/bin/bitcoin-core-28.0/SHA256SUMS',
  },
  LND: {
    version: '0.18.5-beta',
    platform: 'windows-amd64',
    archiveFilename: 'lnd-windows-amd64-v0.18.5-beta.zip',
    archiveUrl: 'https://github.com/lightningnetwork/lnd/releases/download/v0.18.5-beta/lnd-windows-amd64-v0.18.5-beta.zip',
    // Source: https://github.com/lightningnetwork/lnd/releases/download/v0.18.5-beta/manifest-v0.18.5-beta.txt
    archiveSha256: '24b8b6ad91dd1487dfada1588e55de3d0b67af93e3b3cb1a2548c3fb56309b8e',
    binarySha256: {
      'lnd.exe': '18427850a024f58cde8d7b863d71a001bb243449d75d4c5ae32a618be52daed1',
      'lncli.exe': '8f87436dbbc7d1e14c5b03e58f9f30a8ffe1cae7d40136a7765a1a5ae4cd6d7c',
    },
    checksumManifestUrl: 'https://github.com/lightningnetwork/lnd/releases/download/v0.18.5-beta/manifest-v0.18.5-beta.txt',
  },
} as const;

export class BinaryIntegrityVerifier {
  /**
   * Calculates the SHA-256 hash of a file on disk.
   */
  public static computeSha256(filePath: string): string {
    if (!existsSync(filePath)) {
      throw new Error(`FILE_NOT_FOUND: Cannot compute hash of missing file: ${filePath}`);
    }
    const buffer = readFileSync(filePath);
    return createHash('sha256').update(buffer).digest('hex').toLowerCase();
  }

  /**
   * Verifies file SHA-256 against expected hash.
   * Returns true if match, false otherwise. Does not delete file.
   */
  public static verifyFile(filePath: string, expectedSha256: string): boolean {
    const computed = this.computeSha256(filePath);
    return computed === expectedSha256.toLowerCase();
  }

  /**
   * Strict fail-closed verification.
   * If hash does not match, immediately deletes the suspicious file and throws SecurityError.
   */
  public static verifyOrReject(
    filePath: string,
    expectedSha256: string,
    componentName: string
  ): void {
    const computed = this.computeSha256(filePath);
    const expected = expectedSha256.toLowerCase();

    if (computed !== expected) {
      // Unlink corrupted or tampered file immediately to prevent accidental execution
      try {
        rmSync(filePath, { force: true });
      } catch {
        // Ignore unlink failure
      }

      throw new Error(
        `BINARY_INTEGRITY_VERIFICATION_FAILED: ${componentName} checksum mismatch!\n` +
        `  Expected SHA256: ${expected}\n` +
        `  Computed SHA256: ${computed}\n` +
        `  Action: Compromised/corrupt archive deleted immediately. Refusing execution.`
      );
    }
  }
}
