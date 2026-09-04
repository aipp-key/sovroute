/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Cryptographic Release Manifest & Signature Verifier (Phase 2.2B)
 *
 * Strict OpenPGP release manifest verification enforcing:
 * - Version-bound trust policies
 * - Full 40-character fingerprint matching against pinned trust roots
 * - STRICT OpenPGP: ZERO insecure overrides or validation bypasses
 * - Anti-sybil: duplicate signatures from the same signer do not inflate count
 * - Rejection of unauthorized valid signatures
 * - Integrity of release archive and binary hashes
 *
 * FAIL-CLOSED: Any failure to satisfy the full quorum halts immediately.
 */

import * as openpgp from 'openpgp';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TRUSTED_BINARY_MANIFEST, type SignerTrustSpec } from './trusted-binary-manifest.ts';

export class SupplyChainError extends Error {
  constructor(message: string) {
    super(`SUPPLY_CHAIN_VERIFICATION_FAILED: ${message}`);
    this.name = 'SupplyChainError';
  }
}

export interface VerifiedManifestResult {
  readonly verified: boolean;
  readonly component: string;
  readonly version: string;
  readonly distinctVerifiedSignerCount: number;
  readonly requiredQuorum: number;
  readonly signerFingerprints: readonly string[];
  readonly expectedArchiveHash: string;
}

export class ManifestVerifier {
  /**
   * Loads all armored PGP public keys from a directory and ensures each
   * matches an authorized pinned fingerprint if an expected list is supplied.
   *
   * OFFLINE & IMMUTABLE: Keys are loaded strictly from local project files.
   */
  public static async loadKeysFromDir(
    dirPath: string,
    authorizedSigners?: readonly SignerTrustSpec[]
  ): Promise<openpgp.Key[]> {
    if (!existsSync(dirPath)) {
      throw new SupplyChainError(`Trusted keys directory not found: ${dirPath}`);
    }

    const files = readdirSync(dirPath).filter((f) => f.endsWith('.asc'));
    if (files.length === 0) {
      throw new SupplyChainError(`No .asc public key files found in: ${dirPath}`);
    }

    const authorizedFpSet = authorizedSigners
      ? new Set(authorizedSigners.map((s) => s.fingerprint.toUpperCase()))
      : null;

    const keys: openpgp.Key[] = [];
    for (const f of files) {
      const filePath = join(dirPath, f);
      const armored = readFileSync(filePath, 'utf8');
      try {
        const key = await openpgp.readKey({ armoredKey: armored });
        const keyFp = key.getFingerprint().toUpperCase();

        if (authorizedFpSet && !authorizedFpSet.has(keyFp)) {
          throw new SupplyChainError(
            `Key file ${f} in ${dirPath} has fingerprint ${keyFp} which is NOT in the pinned authorized signer list!`
          );
        }

        keys.push(key);
      } catch (err: unknown) {
        if (err instanceof SupplyChainError) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new SupplyChainError(`Failed to parse public key ${f}: ${msg}`);
      }
    }
    return keys;
  }

  /**
   * Verifies Bitcoin Core SHA256SUMS against SHA256SUMS.asc containing
   * multiple developer PGP detached signatures.
   *
   * Enforces:
   * - Strict OpenPGP verification at signature creation time
   * - No insecure verification flags
   * - >=6 distinct valid builder signatures
   */
  public static async verifyBitcoinCoreManifest(
    manifestContent: string,
    ascContent: string,
    keysDir?: string
  ): Promise<VerifiedManifestResult> {
    const spec = TRUSTED_BINARY_MANIFEST.BITCOIN_CORE;
    const defaultKeysDir = join(process.cwd(), 'src', 'supply-chain', 'keys', 'bitcoin-core');
    const targetKeysDir = keysDir ?? defaultKeysDir;

    // 1. Check archive hash exists in manifest
    const expectedHash = spec.archiveSha256.toLowerCase();
    const manifestLower = manifestContent.toLowerCase();
    if (!manifestLower.includes(expectedHash) || !manifestContent.includes(spec.archiveFilename)) {
      throw new SupplyChainError(
        `Bitcoin Core manifest does not contain expected hash for ${spec.archiveFilename}`
      );
    }

    // 2. Extract signature blocks from .asc
    const rawBlocks = ascContent.split('-----BEGIN PGP SIGNATURE-----');
    const blocks: string[] = [];
    for (const b of rawBlocks) {
      if (b.includes('-----END PGP SIGNATURE-----')) {
        const clean = b.split('-----END PGP SIGNATURE-----')[0];
        blocks.push(`-----BEGIN PGP SIGNATURE-----\n${clean}-----END PGP SIGNATURE-----`);
      }
    }

    if (blocks.length === 0) {
      throw new SupplyChainError('No valid PGP signature blocks found in Bitcoin Core .asc file');
    }

    // 3. Load trusted builder keys and index authorized fingerprints
    const trustedKeys = await this.loadKeysFromDir(targetKeysDir, keysDir ? undefined : spec.trustedSigners);
    const authorizedFingerprints = new Set(
      spec.trustedSigners.map((s) => s.fingerprint.toUpperCase())
    );

    // 4. Verify signatures against loaded keys (counting DISTINCT authorized signers)
    const verifiedDistinctSigners = new Set<string>();

    for (const block of blocks) {
      try {
        const signature = await openpgp.readSignature({ armoredSignature: block });
        // Extract authenticated signature creation timestamp for strict historical validity
        const sigDate = signature.packets[0]?.created ?? null;
        const message = await openpgp.createMessage({ text: manifestContent });

        for (const key of trustedKeys) {
          const keyFp = key.getFingerprint().toUpperCase();

          // Anti-sybil / least-authority: only check keys in authorized pinned list
          if (!authorizedFingerprints.has(keyFp)) {
            continue;
          }

          try {
            // STRICT verification: default security policy with zero insecure overrides
            const verificationResult = await openpgp.verify({
              message,
              signature,
              verificationKeys: [key],
              date: sigDate, // Strictly evaluate validity at authenticated signature creation time
            });

            const verified = await verificationResult.signatures[0]?.verified;
            if (verified) {
              verifiedDistinctSigners.add(keyFp);
            }
          } catch {
            // Block was not signed by this key or signature invalid
          }
        }
      } catch {
        // Unparseable signature block
      }
    }

    // 5. Enforce quorum
    if (verifiedDistinctSigners.size < spec.minRequiredSignatures) {
      throw new SupplyChainError(
        `Bitcoin Core manifest verification failed: found ${verifiedDistinctSigners.size} ` +
        `distinct verified signatures, but at least ${spec.minRequiredSignatures} required. ` +
        `Checked against ${authorizedFingerprints.size} pinned builder fingerprints.`
      );
    }

    return {
      verified: true,
      component: spec.component,
      version: spec.version,
      distinctVerifiedSignerCount: verifiedDistinctSigners.size,
      requiredQuorum: spec.minRequiredSignatures,
      signerFingerprints: Array.from(verifiedDistinctSigners),
      expectedArchiveHash: spec.archiveSha256,
    };
  }

  /**
   * Verifies LND manifest-v*.txt against per-developer .sig files.
   *
   * Enforces:
   * - Strict OpenPGP verification at signature creation time
   * - No insecure verification flags
   * - >=5 distinct valid maintainer signatures (Exact upstream quorum)
   */
  public static async verifyLndManifest(
    manifestContent: string | Uint8Array,
    signatures: Array<{ filename: string; data: Uint8Array | string }>,
    keysDir?: string
  ): Promise<VerifiedManifestResult> {
    const spec = TRUSTED_BINARY_MANIFEST.LND;
    const defaultKeysDir = join(process.cwd(), 'src', 'supply-chain', 'keys', 'lnd');
    const targetKeysDir = keysDir ?? defaultKeysDir;

    const manifestText = typeof manifestContent === 'string'
      ? manifestContent
      : new TextDecoder().decode(manifestContent);

    // 1. Check archive and binary hashes in manifest
    const expectedArchiveHash = spec.archiveSha256.toLowerCase();
    if (!manifestText.toLowerCase().includes(expectedArchiveHash) || !manifestText.includes(spec.archiveFilename)) {
      throw new SupplyChainError(
        `LND manifest does not contain expected archive hash for ${spec.archiveFilename}`
      );
    }

    for (const [binName, binHash] of Object.entries(spec.binaries)) {
      if (!manifestText.toLowerCase().includes(binHash.toLowerCase()) || !manifestText.includes(binName)) {
        throw new SupplyChainError(
          `LND manifest does not contain expected binary hash for ${binName}`
        );
      }
    }

    // 2. Load trusted maintainer keys and index authorized fingerprints
    const trustedKeys = await this.loadKeysFromDir(targetKeysDir, keysDir ? undefined : spec.trustedSigners);
    const authorizedFingerprints = new Set(
      spec.trustedSigners.map((s) => s.fingerprint.toUpperCase())
    );

    const manifestBytes = typeof manifestContent === 'string'
      ? new TextEncoder().encode(manifestContent)
      : manifestContent;

    // 3. Verify signatures and count DISTINCT authorized signers
    const verifiedDistinctSigners = new Set<string>();

    for (const sigItem of signatures) {
      let signature: openpgp.Signature;
      try {
        if (typeof sigItem.data === 'string') {
          signature = await openpgp.readSignature({ armoredSignature: sigItem.data });
        } else {
          signature = await openpgp.readSignature({ binarySignature: sigItem.data });
        }
      } catch {
        continue; // Skip unparseable signature
      }

      // Extract authenticated signature creation timestamp
      const sigDate = signature.packets[0]?.created ?? null;
      const message = await openpgp.createMessage({ binary: manifestBytes });

      for (const key of trustedKeys) {
        const keyFp = key.getFingerprint().toUpperCase();

        if (!authorizedFingerprints.has(keyFp)) {
          continue;
        }

        try {
          // STRICT verification: evaluate validity at signature creation time with standard policy
          const res = await openpgp.verify({
            message,
            signature,
            verificationKeys: [key],
            date: sigDate, // Strictly evaluate validity at authenticated signature creation time
          });

          const verified = await res.signatures[0]?.verified;
          if (verified) {
            verifiedDistinctSigners.add(keyFp);
          }
        } catch {
          // Verification failed for this key
        }
      }
    }

    // 4. Enforce exact upstream quorum
    if (verifiedDistinctSigners.size < spec.minRequiredSignatures) {
      throw new SupplyChainError(
        `LND manifest verification failed: found ${verifiedDistinctSigners.size} ` +
        `distinct verified signatures, but at least ${spec.minRequiredSignatures} required. ` +
        `Checked against ${authorizedFingerprints.size} pinned maintainer fingerprints.`
      );
    }

    return {
      verified: true,
      component: spec.component,
      version: spec.version,
      distinctVerifiedSignerCount: verifiedDistinctSigners.size,
      requiredQuorum: spec.minRequiredSignatures,
      signerFingerprints: Array.from(verifiedDistinctSigners),
      expectedArchiveHash: spec.archiveSha256,
    };
  }
}
