/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Base Network & Token Safety Guard (Phase 4)
 *
 * Implements SEC-1, SEC-7, SEC-15, SEC-16, BASE-SEC-1..30
 *
 * CRITICAL SAFETY BOUNDARY:
 * - Base Sepolia (84532) is the ONLY allowed mutation network in Phase 4.
 * - Base Mainnet (8453) mutations are STRICTLY FORBIDDEN and fail closed.
 * - Canonical Native Circle USDC is strictly pinned by checksummed contract address and 6 decimals.
 * - Ticker symbols ("USDC") are NEVER trusted as identity.
 * - Runtime bytecode must cryptographically match the pinned implementation hash.
 */

import { createHash } from 'node:crypto';
import {
  PINNED_HTLC_BYTECODE_RAW_SHA256,
  LEGACY_HTLC_BYTECODE_HEX_STRING_SHA256,
} from './evm-guard.ts';
export {
  PINNED_HTLC_BYTECODE_RAW_SHA256,
  LEGACY_HTLC_BYTECODE_HEX_STRING_SHA256,
};

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_MAINNET_CHAIN_ID = 8453;

// Official Circle Base Sepolia Test USDC
export const OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS =
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

// Official Circle Base Mainnet Canonical USDC (DOCUMENTATION / FUTURE POLICY ONLY — NO WRITES)
export const OFFICIAL_BASE_MAINNET_USDC_ADDRESS =
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export const OFFICIAL_USDC_DECIMALS = 6;

export class BaseNetworkGuardError extends Error {
  constructor(message: string) {
    super(`BASE_NETWORK_GUARD_VIOLATION: ${message}`);
    this.name = 'BaseNetworkGuardError';
  }
}

export class BaseTokenGuardError extends Error {
  constructor(message: string) {
    super(`BASE_TOKEN_GUARD_VIOLATION: ${message}`);
    this.name = 'BaseTokenGuardError';
  }
}

export class BaseBytecodeMismatchError extends Error {
  constructor(message: string) {
    super(`BASE_BYTECODE_MISMATCH: ${message}`);
    this.name = 'BaseBytecodeMismatchError';
  }
}

export class BaseNetworkGuard {
  /**
   * Asserts that the connected RPC network is Base Sepolia (84532).
   * Refuses Base Mainnet (8453), Ethereum Mainnet (1), Arbitrum (42161),
   * local devnet (31337 unexpectedly), and unknown networks fail-closed.
   */
  public static assertBaseSepoliaNetwork(chainId: number): void {
    if (chainId === BASE_MAINNET_CHAIN_ID) {
      throw new BaseNetworkGuardError(
        `CRITICAL SAFETY VIOLATION: Attempted mutation on Base Mainnet (chain ID ${BASE_MAINNET_CHAIN_ID}). ` +
        `Mainnet mutations are strictly prohibited. Zero real money allowed.`
      );
    }

    if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
      throw new BaseNetworkGuardError(
        `CRITICAL SAFETY VIOLATION: Expected Base Sepolia chain ID ${BASE_SEPOLIA_CHAIN_ID}, ` +
        `received actual chain ID ${chainId}. Mainnet and public networks other than Base Sepolia are strictly prohibited.`
      );
    }
  }

  /**
   * Asserts that the token is canonical Circle native test USDC on Base Sepolia.
   * Rejects lookalike tokens, USDbC, bridged tokens, and non-6-decimal tokens fail-closed.
   */
  public static assertCanonicalBaseSepoliaUsdc(tokenAddress: string, decimals?: number): void {
    const clean = tokenAddress.toLowerCase();
    const expected = OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase();

    if (clean !== expected) {
      throw new BaseTokenGuardError(
        `TOKEN IDENTITY VIOLATION: Attempted to transact with token address ${tokenAddress}. ` +
        `Canonical Base Sepolia USDC is strictly pinned to ${OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS}. ` +
        `Lookalike tokens and bridged variants are rejected fail-closed.`
      );
    }

    if (decimals !== undefined && decimals !== OFFICIAL_USDC_DECIMALS) {
      throw new BaseTokenGuardError(
        `TOKEN DECIMALS VIOLATION: Expected ${OFFICIAL_USDC_DECIMALS} decimals, got ${decimals}. ` +
        `Only canonical 6-decimal USDC is accepted.`
      );
    }
  }

  /**
   * Asserts that the runtime bytecode deployed on Base Sepolia matches the frozen pinned raw implementation hash.
   * Compares SHA256(raw bytecode bytes), NOT UTF-8 hex string.
   */
  public static assertContractBytecode(deployedBytecodeHex: string): void {
    const clean = deployedBytecodeHex.startsWith('0x')
      ? deployedBytecodeHex.slice(2)
      : deployedBytecodeHex;

    if (!clean || clean.length < 10) {
      throw new BaseBytecodeMismatchError(
        `No contract bytecode found at specified address on Base Sepolia. Contract may not be deployed.`
      );
    }

    if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
      throw new BaseBytecodeMismatchError(
        `Malformed bytecode hex representation: invalid characters or odd length.`
      );
    }

    const rawBytes = Buffer.from(clean, 'hex');
    const computedRawHash = createHash('sha256').update(rawBytes).digest('hex');

    if (computedRawHash.toLowerCase() !== PINNED_HTLC_BYTECODE_RAW_SHA256.toLowerCase()) {
      throw new BaseBytecodeMismatchError(
        `Deployed Base Sepolia contract bytecode does not match pinned implementation raw hash! ` +
        `Expected raw SHA-256: ${PINNED_HTLC_BYTECODE_RAW_SHA256}, Computed: ${computedRawHash}`
      );
    }
  }
}

