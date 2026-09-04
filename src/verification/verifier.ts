import type { DestinationSettlementEvidence } from '../domain/types.ts';

export const BASE_USDC_CONTRACT_ADDRESS =
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase();

export interface ChainVerificationRequest {
  txHash: string;
  network: string; // e.g. "base"
  expectedRecipient: string; // e.g. 0x...
  expectedToken: string; // e.g. "USDC"
  expectedMinAmountAtomic: string;
  maxToleranceBps?: number; // Basis points of acceptable negative slippage (default 0)
}

export interface ChainVerificationResult {
  verified: boolean;
  status:
    | 'CONFIRMED'
    | 'NOT_FOUND'
    | 'REVERTED'
    | 'WRONG_TOKEN'
    | 'WRONG_RECIPIENT'
    | 'AMOUNT_MISMATCH'
    | 'WRONG_NETWORK';
  blockNumber?: number | undefined;
  confirmedAmountAtomic?: string | undefined;
  confirmedTokenContract?: string | undefined;
  confirmedRecipient?: string | undefined;
  reason?: string | undefined;
  evidence?: DestinationSettlementEvidence | undefined;
}

export interface IChainVerifier {
  verifySettlement(request: ChainVerificationRequest): Promise<ChainVerificationResult>;
}

/**
 * Deterministic Mock Chain Verifier with exhaustive failure injection
 */
export class MockChainVerifier implements IChainVerifier {
  public simulatedOutcomes: Map<string, Partial<ChainVerificationResult>> = new Map();

  constructor() {
    // Default mock known tx hashes
    this.simulatedOutcomes.set('0xfake_or_reverted_tx_hash', {
      verified: false,
      status: 'REVERTED',
      reason: 'On-chain transaction receipt status is 0 (REVERTED)',
    });
  }

  public setOutcome(txHash: string, outcome: Partial<ChainVerificationResult>): void {
    this.simulatedOutcomes.set(txHash, outcome);
  }

  public async verifySettlement(
    request: ChainVerificationRequest
  ): Promise<ChainVerificationResult> {
    // 1. Verify network is Base
    if (request.network.toLowerCase() !== 'base') {
      return {
        verified: false,
        status: 'WRONG_NETWORK',
        reason: `Unsupported destination network for Base verifier: ${request.network}`,
      };
    }

    // Check if custom injected outcome exists
    const injected = this.simulatedOutcomes.get(request.txHash);
    if (injected) {
      const status = injected.status ?? 'CONFIRMED';
      return {
        verified: injected.verified ?? (status === 'CONFIRMED'),
        status,
        blockNumber: injected.blockNumber ?? 12345678,
        confirmedAmountAtomic: injected.confirmedAmountAtomic ?? request.expectedMinAmountAtomic,
        confirmedTokenContract: injected.confirmedTokenContract ?? BASE_USDC_CONTRACT_ADDRESS,
        confirmedRecipient: injected.confirmedRecipient ?? request.expectedRecipient,
        reason: injected.reason,
        evidence: {
          network: 'base',
          asset: 'USDC',
          amountAtomic: injected.confirmedAmountAtomic ?? request.expectedMinAmountAtomic,
          destinationAddress: injected.confirmedRecipient ?? request.expectedRecipient,
          txHash: request.txHash,
          blockNumber: injected.blockNumber ?? 12345678,
          tokenContract: injected.confirmedTokenContract ?? BASE_USDC_CONTRACT_ADDRESS,
          verifiedOnChain: injected.verified ?? (status === 'CONFIRMED'),
          onChainStatus: status,
          verifiedAt: new Date().toISOString(),
          evidenceSource: 'BASE_RPC',
          rawEvidence: { simulated: true, txHash: request.txHash },
        },
      };
    }

    // Default valid transaction verification
    const now = new Date().toISOString();
    return {
      verified: true,
      status: 'CONFIRMED',
      blockNumber: 12345678,
      confirmedAmountAtomic: request.expectedMinAmountAtomic,
      confirmedTokenContract: BASE_USDC_CONTRACT_ADDRESS,
      confirmedRecipient: request.expectedRecipient,
      evidence: {
        network: 'base',
        asset: 'USDC',
        amountAtomic: request.expectedMinAmountAtomic,
        destinationAddress: request.expectedRecipient,
        txHash: request.txHash,
        blockNumber: 12345678,
        tokenContract: BASE_USDC_CONTRACT_ADDRESS,
        verifiedOnChain: true,
        onChainStatus: 'CONFIRMED',
        verifiedAt: now,
        evidenceSource: 'BASE_RPC',
        rawEvidence: {
          blockNumber: 12345678,
          status: 1,
          contract: BASE_USDC_CONTRACT_ADDRESS,
        },
      },
    };
  }
}
