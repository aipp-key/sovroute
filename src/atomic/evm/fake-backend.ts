/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Deterministic Local Fake EVM Atomic Backend
 *
 * Simulates HTLCErc20 and HTLCCoordinator smart contracts in local memory.
 * Enforces SEC-10 (claim vs refund mutual exclusion) and SEC-21 (block timestamp consensus).
 */

import { createHash } from 'node:crypto';
import type {
  IEvmAtomicBackend,
  EvmHtlcParams,
  EvmHtlcState,
  SecretPreimage,
  EvmHtlcClaimedEvidence,
  EvmHtlcRefundedEvidence,
} from '../types.ts';

interface StoredHtlc {
  params: EvmHtlcParams;
  funded: boolean;
  completed: boolean;
  refunded: boolean;
  balance: bigint;
  fundingTxHash: string;
  fundingBlockNumber: number;
}

export class FakeEvmAtomicBackend implements IEvmAtomicBackend {
  readonly backendName = 'FakeEvmAtomicBackend';
  readonly chainId = 42161; // Arbitrum One / Base Sepolia test mock
  public finalityPolicy?: { policyTag: string; requiredConfirmations: number } | undefined = {
    policyTag: 'BASE_SEPOLIA_TEST_POLICY',
    requiredConfirmations: 2,
  };
  private htlcs = new Map<string, StoredHtlc>();
  private currentBlockTimestamp = Math.floor(Date.now() / 1000);
  private currentBlockNumber = 1000;
  private claimPreimages = new Map<string, string>();
  private txReceipts = new Map<string, { status: 'success' | 'pending' | 'reverted'; blockNumber: number; txHash: string; swapKey: string; isClaim: boolean }>();
  private storageDisagreements = new Map<string, { forceStatus?: number }>();

  async fundHtlc(
    params: EvmHtlcParams
  ): Promise<{ txHash: string; blockNumber: number; htlcId?: string }> {
    if (this.htlcs.has(params.swapKey)) {
      throw new Error(`HTLC with swapKey ${params.swapKey} already exists`);
    }

    this.currentBlockNumber++;
    const txHash = `0x${createHash('sha256').update(params.swapKey + ':fund:' + this.currentBlockNumber).digest('hex')}`;

    const stored: StoredHtlc = {
      params,
      funded: true,
      completed: false,
      refunded: false,
      balance: params.amountUnits,
      fundingTxHash: txHash,
      fundingBlockNumber: this.currentBlockNumber,
    };

    this.htlcs.set(params.swapKey, stored);
    const htlcId = `0x${createHash('sha256').update(params.swapKey).digest('hex')}`;
    return { txHash, blockNumber: this.currentBlockNumber, htlcId };
  }

  async observeHtlc(swapKey: string): Promise<EvmHtlcState> {
    const htlc = this.htlcs.get(swapKey);
    if (!htlc) {
      return {
        swapKey,
        funded: false,
        completed: false,
        refunded: false,
        balance: 0n,
        timelock: 0,
        blockTimestamp: this.currentBlockTimestamp,
      };
    }

    return {
      swapKey,
      funded: htlc.funded,
      completed: htlc.completed,
      refunded: htlc.refunded,
      balance: htlc.balance,
      timelock: htlc.params.refundLocktime,
      blockTimestamp: this.currentBlockTimestamp,
    };
  }

  async claimHtlc(params: {
    swapKey: string;
    preimage: SecretPreimage;
    destination: string;
    signature?: string;
    dexCalldata?: string;
  }): Promise<{ txHash: string; blockNumber: number; success: boolean }> {
    const htlc = this.htlcs.get(params.swapKey);
    if (!htlc || !htlc.funded) {
      throw new Error(`HTLC ${params.swapKey} does not exist or is not funded`);
    }

    if (htlc.completed) {
      throw new Error(`HTLC ${params.swapKey} is already claimed`);
    }

    if (htlc.refunded) {
      throw new Error(`HTLC ${params.swapKey} is already refunded (SEC-10 violation: mutual exclusion)`);
    }

    // Verify SHA-256(preimage) == hashLock
    const rawPreimage = params.preimage.startsWith('0x')
      ? Buffer.from(params.preimage.slice(2), 'hex')
      : Buffer.from(params.preimage, 'hex');

    const computedHash = '0x' + createHash('sha256').update(rawPreimage).digest('hex').toLowerCase();
    const expectedHash = htlc.params.hashLock.toLowerCase();

    if (computedHash !== expectedHash) {
      throw new Error(`Invalid preimage: computed hash ${computedHash} does not match hashlock ${expectedHash}`);
    }

    this.currentBlockNumber += 2;
    const blockNumber = this.currentBlockNumber - 1;
    const txHash = `0x${createHash('sha256').update(params.swapKey + ':claim:' + blockNumber).digest('hex')}`;

    htlc.completed = true;
    htlc.balance = 0n;

    const rawHex = rawPreimage.toString('hex');
    this.claimPreimages.set(txHash, rawHex);
    this.txReceipts.set(txHash, { status: 'success', blockNumber, txHash, swapKey: params.swapKey, isClaim: true });

    return { txHash, blockNumber, success: true };
  }

  async refundHtlc(
    swapKey: string
  ): Promise<{ txHash: string; blockNumber: number; refunded: boolean }> {
    const htlc = this.htlcs.get(swapKey);
    if (!htlc || !htlc.funded) {
      throw new Error(`HTLC ${swapKey} does not exist or is not funded`);
    }

    if (htlc.completed) {
      throw new Error(`HTLC ${swapKey} is already completed/claimed (SEC-10 violation: mutual exclusion)`);
    }

    if (htlc.refunded) {
      throw new Error(`HTLC ${swapKey} is already refunded`);
    }

    // Check SEC-21: Block timestamp must be >= refundLocktime
    if (this.currentBlockTimestamp < htlc.params.refundLocktime) {
      throw new Error(
        `Timelock not expired: current block timestamp ${this.currentBlockTimestamp} < locktime ${htlc.params.refundLocktime}`
      );
    }

    this.currentBlockNumber += 2;
    const blockNumber = this.currentBlockNumber - 1;
    const txHash = `0x${createHash('sha256').update(swapKey + ':refund:' + blockNumber).digest('hex')}`;

    htlc.refunded = true;
    htlc.balance = 0n;

    this.txReceipts.set(txHash, { status: 'success', blockNumber, txHash, swapKey, isClaim: false });

    return { txHash, blockNumber, refunded: true };
  }

  async extractAndVerifyClaimEvidence(params: {
    claimTxHash: string;
    expectedHtlcId: string;
    expectedHashLock: string;
    expectedClaimAddress: string;
    expectedAmount: bigint;
    requiredConfirmations?: number;
  }): Promise<EvmHtlcClaimedEvidence> {
    const receipt = this.txReceipts.get(params.claimTxHash);
    if (!receipt) {
      throw new Error(`Claim transaction ${params.claimTxHash} not found`);
    }

    if (receipt.status === 'pending') {
      return {
        evidenceType: 'EVM_HTLC_CLAIMED',
        chainId: this.chainId,
        contractAddress: '0xfake_htlc',
        htlcId: params.expectedHtlcId,
        hashLock: params.expectedHashLock,
        preimageRevealed: '',
        claimAddress: params.expectedClaimAddress,
        amount: params.expectedAmount,
        txHash: params.claimTxHash,
        blockNumber: 0,
        blockTimestamp: this.currentBlockTimestamp,
        confirmations: 0,
        finalityState: 'INSUFFICIENT_CONFIRMATIONS',
        observedAt: new Date(),
      };
    }

    if (receipt.status !== 'success') {
      throw new Error(`Claim transaction failed (status: ${receipt.status})`);
    }

    const confirmations = this.currentBlockNumber - receipt.blockNumber + 1;
    const reqConf = params.requiredConfirmations ?? 2;
    if (confirmations < reqConf) {
      return {
        evidenceType: 'EVM_HTLC_CLAIMED',
        chainId: this.chainId,
        contractAddress: '0xfake_htlc',
        htlcId: params.expectedHtlcId,
        hashLock: params.expectedHashLock,
        preimageRevealed: this.claimPreimages.get(params.claimTxHash) ?? '',
        claimAddress: params.expectedClaimAddress,
        amount: params.expectedAmount,
        txHash: params.claimTxHash,
        blockNumber: receipt.blockNumber,
        blockTimestamp: this.currentBlockTimestamp,
        confirmations,
        finalityState: 'INSUFFICIENT_CONFIRMATIONS',
        observedAt: new Date(),
      };
    }

    // Storage check & disagreement check
    const disagreement = this.storageDisagreements.get(receipt.swapKey);
    const htlc = this.htlcs.get(receipt.swapKey);
    if (disagreement?.forceStatus !== undefined ? disagreement.forceStatus !== 2 : !htlc?.completed) {
      throw new Error(`EVM_FINALITY_DISAGREEMENT: Receipt succeeded but contract storage state is not CLAIMED`);
    }

    const preimage = this.claimPreimages.get(params.claimTxHash) ?? '';
    const cleanExpected = params.expectedHashLock.replace(/^0x/, '').toLowerCase();
    const computedHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex').toLowerCase();
    if (computedHash !== cleanExpected) {
      throw new Error(`Revealed preimage hash ${computedHash} does not match expected hashlock ${cleanExpected}`);
    }

    return {
      evidenceType: 'EVM_HTLC_CLAIMED',
      chainId: this.chainId,
      contractAddress: '0xfake_htlc',
      htlcId: params.expectedHtlcId,
      hashLock: params.expectedHashLock,
      preimageRevealed: preimage,
      claimAddress: params.expectedClaimAddress,
      amount: params.expectedAmount,
      txHash: params.claimTxHash,
      blockNumber: receipt.blockNumber,
      blockTimestamp: this.currentBlockTimestamp,
      confirmations,
      finalityState: 'FINAL_ENOUGH_FOR_PROTOCOL',
      observedAt: new Date(),
    };
  }

  async verifyRefundEvidence(params: {
    refundTxHash: string;
    expectedHtlcId: string;
    expectedRefundAddress: string;
    expectedAmount: bigint;
    requiredConfirmations?: number;
  }): Promise<EvmHtlcRefundedEvidence> {
    const receipt = this.txReceipts.get(params.refundTxHash);
    if (!receipt) {
      throw new Error(`Refund transaction ${params.refundTxHash} not found`);
    }

    if (receipt.status === 'pending') {
      return {
        evidenceType: 'EVM_HTLC_REFUNDED',
        chainId: this.chainId,
        contractAddress: '0xfake_htlc',
        htlcId: params.expectedHtlcId,
        swapKey: receipt.swapKey,
        refundAddress: params.expectedRefundAddress,
        amount: params.expectedAmount,
        txHash: params.refundTxHash,
        blockNumber: 0,
        blockTimestamp: this.currentBlockTimestamp,
        confirmations: 0,
        finalityState: 'INSUFFICIENT_CONFIRMATIONS',
        observedAt: new Date(),
      };
    }

    if (receipt.status !== 'success') {
      throw new Error(`Refund transaction failed (status: ${receipt.status})`);
    }

    const confirmations = this.currentBlockNumber - receipt.blockNumber + 1;
    const reqConf = params.requiredConfirmations ?? 2;
    if (confirmations < reqConf) {
      return {
        evidenceType: 'EVM_HTLC_REFUNDED',
        chainId: this.chainId,
        contractAddress: '0xfake_htlc',
        htlcId: params.expectedHtlcId,
        swapKey: receipt.swapKey,
        refundAddress: params.expectedRefundAddress,
        amount: params.expectedAmount,
        txHash: params.refundTxHash,
        blockNumber: receipt.blockNumber,
        blockTimestamp: this.currentBlockTimestamp,
        confirmations,
        finalityState: 'INSUFFICIENT_CONFIRMATIONS',
        observedAt: new Date(),
      };
    }

    // Storage check & disagreement check
    const disagreement = this.storageDisagreements.get(receipt.swapKey);
    const htlc = this.htlcs.get(receipt.swapKey);
    if (disagreement?.forceStatus !== undefined ? disagreement.forceStatus !== 3 : !htlc?.refunded) {
      throw new Error(`EVM_FINALITY_DISAGREEMENT: Receipt succeeded but contract storage state is not REFUNDED`);
    }

    return {
      evidenceType: 'EVM_HTLC_REFUNDED',
      chainId: this.chainId,
      contractAddress: '0xfake_htlc',
      htlcId: params.expectedHtlcId,
      swapKey: receipt.swapKey,
      refundAddress: params.expectedRefundAddress,
      amount: params.expectedAmount,
      txHash: params.refundTxHash,
      blockNumber: receipt.blockNumber,
      blockTimestamp: this.currentBlockTimestamp,
      confirmations,
      finalityState: 'FINAL_ENOUGH_FOR_PROTOCOL',
      observedAt: new Date(),
    };
  }

  async getBlockTimestamp(): Promise<number> {
    return this.currentBlockTimestamp;
  }

  // --- Test Simulation Methods ---

  simulateTxPending(txHash: string): void {
    const receipt = this.txReceipts.get(txHash);
    if (receipt) receipt.status = 'pending';
  }

  setTxConfirmations(txHash: string, confs: number): void {
    const receipt = this.txReceipts.get(txHash);
    if (receipt) {
      receipt.blockNumber = this.currentBlockNumber - confs + 1;
    }
  }

  simulateStorageDisagreement(swapKey: string, forceStatus: number): void {
    this.storageDisagreements.set(swapKey, { forceStatus });
  }

  setBlockTimestamp(ts: number): void {
    this.currentBlockTimestamp = ts;
  }

  advanceTime(seconds: number): void {
    this.currentBlockTimestamp += seconds;
  }
}
