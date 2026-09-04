/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Runtime Startup Binary Verifier Gate
 *
 * Enforces pre-execution verification of all required regtest binaries:
 * - bitcoind.exe (Bitcoin Core v28.0.0)
 * - lnd.exe (LND v0.18.5-beta)
 * - lncli.exe (LND v0.18.5-beta)
 *
 * FAIL-CLOSED: Any binary missing or hash mismatch halts startup immediately.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BinaryIntegrityVerifier } from './binary-verifier.ts';
import { TRUSTED_BINARY_MANIFEST } from './trusted-binary-manifest.ts';
import { SupplyChainError } from './manifest-verifier.ts';

export interface BinaryVerificationStatus {
  readonly name: string;
  readonly path: string;
  readonly expectedSha256: string;
  readonly computedSha256: string;
  readonly verified: boolean;
}

export interface TrustedBinarySetResult {
  readonly allVerified: boolean;
  readonly binaries: readonly BinaryVerificationStatus[];
}

export class StartupVerifier {
  /**
   * Verifies all required regtest binaries on disk before launching processes.
   * Throws SupplyChainError (fail-closed) if any binary is missing or tampered.
   */
  public static verifyTrustedBinarySet(binDir?: string): TrustedBinarySetResult {
    const targetBinDir = binDir ?? join(process.cwd(), 'regtest-env', 'bin');

    const expectedSet = [
      {
        name: 'bitcoind.exe',
        expectedSha256: TRUSTED_BINARY_MANIFEST.BITCOIN_CORE.binaries['bitcoind.exe'],
        component: 'Bitcoin Core v28.0.0',
      },
      {
        name: 'lnd.exe',
        expectedSha256: TRUSTED_BINARY_MANIFEST.LND.binaries['lnd.exe'],
        component: 'LND v0.18.5-beta',
      },
      {
        name: 'lncli.exe',
        expectedSha256: TRUSTED_BINARY_MANIFEST.LND.binaries['lncli.exe'],
        component: 'LND v0.18.5-beta (CLI)',
      },
    ];

    const results: BinaryVerificationStatus[] = [];

    for (const item of expectedSet) {
      const filePath = join(targetBinDir, item.name);

      if (!existsSync(filePath)) {
        throw new SupplyChainError(
          `STARTUP_GUARD_FAILED: Required executable missing: ${item.name} at ${filePath}`
        );
      }

      const computed = BinaryIntegrityVerifier.computeSha256(filePath);
      const expected = item.expectedSha256.toLowerCase();

      if (computed !== expected) {
        throw new SupplyChainError(
          `STARTUP_GUARD_FAILED: Tampering or integrity mismatch detected on ${item.name} (${item.component})!\n` +
          `  File: ${filePath}\n` +
          `  Expected SHA-256: ${expected}\n` +
          `  Computed SHA-256: ${computed}\n` +
          `  Refusing to launch any regtest process.`
        );
      }

      results.push({
        name: item.name,
        path: filePath,
        expectedSha256: expected,
        computedSha256: computed,
        verified: true,
      });
    }

    return {
      allVerified: true,
      binaries: results,
    };
  }
}
