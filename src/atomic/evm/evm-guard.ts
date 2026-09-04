/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * EVM Network & Bytecode Safety Guard (Phase 3)
 *
 * Enforces:
 * - Absolute safety boundary: LOCAL DEVNET ONLY (Chain ID 31337).
 * - P0 Network Guard: Refuses Ethereum mainnet (1), Arbitrum (42161), Base (8453), etc.
 * - Contract Bytecode Pinning: Validates deployed on-chain bytecode against expected SHA-256.
 */

import { createHash } from 'node:crypto';
import { EvmNetworkGuardError, EvmBytecodeMismatchError } from './evm-types.ts';
export { EvmNetworkGuardError, EvmBytecodeMismatchError };

export const ACCEPTED_LOCAL_DEVNET_CHAIN_ID = 31337;

// Canonical RAW runtime bytecode SHA-256 (hash of raw binary bytes)
export const PINNED_HTLC_BYTECODE_RAW_SHA256 =
  '8627fe35109888bbb58873f4e8f3beb90c7c0efee1411f81de9aa21a602e1d67';

// Legacy UTF-8 hex-string hash retained for migration/audit documentation
export const LEGACY_HTLC_BYTECODE_HEX_STRING_SHA256 =
  '10dc4b0c4864722e9770f035a0d64f2963d642bc165146bba4871a0e131a58cd';
export const PINNED_HTLC_BYTECODE_SHA256 = PINNED_HTLC_BYTECODE_RAW_SHA256;

export class EvmNetworkGuard {
  /**
   * Asserts that the connected chain ID matches the approved local devnet ID (31337).
   * Refuses all public, testnet, and mainnet chains fail-closed.
   */
  public static assertSafeLocalNetwork(actualChainId: number): void {
    if (actualChainId !== ACCEPTED_LOCAL_DEVNET_CHAIN_ID) {
      throw new EvmNetworkGuardError(
        `REFUSING_NON_LOCAL_NETWORK: RealLocalEvmAtomicBackend is strictly restricted to ` +
        `local devnet chain ID ${ACCEPTED_LOCAL_DEVNET_CHAIN_ID}. Attempted chain ID: ${actualChainId}. ` +
        `Mainnet and public testnets are strictly prohibited.`
      );
    }
  }

  /**
   * Asserts that the bytecode at the deployed address matches the pinned expected raw bytecode hash.
   */
  public static assertContractBytecode(deployedBytecodeHex: string): void {
    const clean = deployedBytecodeHex.startsWith('0x')
      ? deployedBytecodeHex.slice(2)
      : deployedBytecodeHex;

    if (!clean || clean.length < 10) {
      throw new EvmBytecodeMismatchError(
        `No contract bytecode found at specified address. Contract may not be deployed.`
      );
    }

    if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
      throw new EvmBytecodeMismatchError(
        `Malformed bytecode hex representation: invalid characters or odd length.`
      );
    }

    const rawBytes = Buffer.from(clean, 'hex');
    const computedRawHash = createHash('sha256').update(rawBytes).digest('hex');

    if (computedRawHash.toLowerCase() !== PINNED_HTLC_BYTECODE_RAW_SHA256.toLowerCase()) {
      throw new EvmBytecodeMismatchError(
        `Deployed contract bytecode does not match pinned implementation raw hash! ` +
        `Expected raw SHA-256: ${PINNED_HTLC_BYTECODE_RAW_SHA256}, Computed: ${computedRawHash}`
      );
    }
  }
}
