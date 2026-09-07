/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * EIP-712 Swap Authorization Verifier & Typed-Data Engine
 */

import { verifyTypedData, type TypedDataDomain } from 'viem';
import type { SovereignQuote } from '../pricing/types.ts';
import type {
  Eip712DomainConfig,
  SignedSwapAuthorization,
} from './types.ts';
import {
  InvalidSignatureError,
  SignatureExpiredError,
  AuthorizationParameterMismatchError,
} from './errors.ts';

export const EIP712_SWAP_AUTH_TYPES = {
  SwapAuthorization: [
    { name: 'swapper', type: 'address' },
    { name: 'destination', type: 'address' },
    { name: 'amountUsdcAtomic', type: 'uint256' },
    { name: 'amountSats', type: 'uint256' },
    { name: 'quoteId', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export class GaslessAuthorizer {
  public readonly domainConfig: Eip712DomainConfig;
  private readonly domain: TypedDataDomain;

  constructor(domainConfig: Eip712DomainConfig) {
    this.domainConfig = domainConfig;
    this.domain = {
      name: domainConfig.name,
      version: domainConfig.version,
      chainId: Number(domainConfig.chainId),
      verifyingContract: domainConfig.verifyingContract,
    };
  }

  public getDomain(): TypedDataDomain {
    return this.domain;
  }

  /**
   * Cryptographically verifies the EIP-712 authorization against swapper address and quote parameters.
   * Fails closed on any discrepancy, tampering, or expiration.
   */
  public async verifyAuthorization(
    authorization: SignedSwapAuthorization,
    quote: SovereignQuote,
    nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000))
  ): Promise<void> {
    const { message, signature } = authorization;

    // 1. Deadline check
    if (nowSeconds > message.deadline) {
      throw new SignatureExpiredError(message.deadline, nowSeconds);
    }

    // 2. Quote parameter consistency checks
    if (message.quoteId !== quote.quoteId) {
      throw new AuthorizationParameterMismatchError('quoteId', quote.quoteId, message.quoteId);
    }

    if (message.amountSats !== quote.amountSats) {
      throw new AuthorizationParameterMismatchError('amountSats', quote.amountSats.toString(), message.amountSats.toString());
    }

    if (message.amountUsdcAtomic !== quote.netUsdcAtomic) {
      throw new AuthorizationParameterMismatchError('amountUsdcAtomic', quote.netUsdcAtomic.toString(), message.amountUsdcAtomic.toString());
    }

    const expectedDest = (quote.targetDestinationAddress ?? '').toLowerCase();
    const receivedDest = message.destination.toLowerCase();
    if (receivedDest !== expectedDest) {
      throw new AuthorizationParameterMismatchError('destination', expectedDest, receivedDest);
    }

    // 3. EIP-712 Typed-Data Signature Verification
    try {
      const isValid = await verifyTypedData({
        address: message.swapper,
        domain: this.domain,
        types: EIP712_SWAP_AUTH_TYPES,
        primaryType: 'SwapAuthorization',
        message: {
          swapper: message.swapper,
          destination: message.destination,
          amountUsdcAtomic: message.amountUsdcAtomic,
          amountSats: message.amountSats,
          quoteId: message.quoteId,
          nonce: message.nonce,
          deadline: message.deadline,
        },
        signature,
      });

      if (!isValid) {
        throw new InvalidSignatureError('Signature does not match swapper address or message parameters.');
      }
    } catch (err) {
      if (err instanceof InvalidSignatureError) {
        throw err;
      }
      throw new InvalidSignatureError((err as Error).message);
    }
  }
}
