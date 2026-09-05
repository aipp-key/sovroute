/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Deterministic Local Fake EVM Atomic Backend
 *
 * Simulates HTLCErc20 and HTLCCoordinator smart contracts in local memory.
 * Enforces SEC-10 (claim vs refund mutual exclusion) and SEC-21 (block timestamp consensus).
 */

import { createHash } from 'node:crypto';
import { OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS } from './base-guard.ts';
import type {
  IEvmAtomicBackend,
  EvmHtlcParams,
  EvmHtlcState,
  SecretPreimage,
  EvmHtlcClaimedEvidence,
  EvmHtlcRefundedEvidence,
  ChainCapacityObservation,
  IChainCapacityProvider,
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

export class FakeEvmAtomicBackend implements IEvmAtomicBackend, IChainCapacityProvider {
  readonly backendName = 'FakeEvmAtomicBackend';
  readonly chainId: number = 84532; // Canonical Base Sepolia test semantics (FF-9)
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

  private mockBalances = new Map<string, { latest: bigint; finalized: bigint }>();
  private defaultOperatorAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  private swapKeyToHtlcId = new Map<string, string>();
  private htlcIdToSwapKey = new Map<string, string>();
  private persistence?: any;
  private chainValid = true;
  private tokenValid = true;
  public enforceExactCanonicalToken = true;
  private verificationFailureReason?: string | undefined;

  constructor(config?: { chainId?: number; enforceExactCanonicalToken?: boolean; persistence?: any }) {
    if (config?.chainId !== undefined) {
      this.chainId = config.chainId;
    }
    if (config?.enforceExactCanonicalToken !== undefined) {
      this.enforceExactCanonicalToken = config.enforceExactCanonicalToken;
    }
    if (config?.persistence) {
      this.persistence = config.persistence;
      this.rehydrateBindings();
    }
  }

  public setWalletBalance(tokenAddress: string, latest: bigint, finalized?: bigint): void {
    const token = tokenAddress.toLowerCase();
    this.mockBalances.set(token, {
      latest,
      finalized: finalized !== undefined ? finalized : latest,
    });
  }

  public setChainValidationResult(valid: boolean, reason?: string): void {
    this.chainValid = valid;
    this.verificationFailureReason = reason;
  }

  public setTokenValidationResult(valid: boolean, reason?: string): void {
    this.tokenValid = valid;
    this.verificationFailureReason = reason;
  }

  public setPersistence(persistence: any): void {
    this.persistence = persistence;
  }

  public getTokenAddress(): string {
    return OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS;
  }

  public rehydrateBindings(): number {
    if (!this.persistence) return 0;
    try {
      const bindings = this.persistence.listSovereignSwapsWithEvmBindings();
      let count = 0;
      for (const b of bindings) {
        this.swapKeyToHtlcId.set(b.evmSwapKey, b.evmHtlcId);
        this.htlcIdToSwapKey.set(b.evmHtlcId, b.evmSwapKey);
        count++;
      }
      return count;
    } catch {
      return 0;
    }
  }

  public async observeWalletCapacity(tokenAddress: string): Promise<ChainCapacityObservation> {
    const token = tokenAddress.toLowerCase();
    const bal = this.mockBalances.get(token) ?? { latest: 0n, finalized: 0n };
    const safeWalletCapacity = bal.latest < bal.finalized ? bal.latest : bal.finalized;

    return {
      tokenAddress: token,
      chainId: this.chainId,
      operatorAddress: this.defaultOperatorAddress,
      walletBalanceLatest: bal.latest,
      walletBalanceFinalized: bal.finalized,
      safeWalletCapacity,
      latestBlockNumber: this.currentBlockNumber,
      finalizedBlockNumber: Math.max(0, this.currentBlockNumber - (this.finalityPolicy?.requiredConfirmations ?? 2)),
      blockHash: `0x_mock_block_hash_${this.currentBlockNumber}`,
      observedAt: new Date(),
    };
  }

  public async verifyChainAndToken(
    expectedChainId: number,
    tokenAddress: string
  ): Promise<{ valid: boolean; reason?: string }> {
    if (!this.chainValid || (expectedChainId && expectedChainId !== this.chainId)) {
      return {
        valid: false,
        reason: this.verificationFailureReason ?? `WRONG_CHAIN_ID: expected ${expectedChainId}, got ${this.chainId}`,
      };
    }
    const token = tokenAddress.toLowerCase();
    if (this.enforceExactCanonicalToken && token !== OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase()) {
      return {
        valid: false,
        reason: this.verificationFailureReason ?? `TOKEN_CONTRACT_MISMATCH: Token ${tokenAddress} is not canonical Base Sepolia USDC ${OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS}`,
      };
    }
    if (!this.tokenValid) {
      return {
        valid: false,
        reason: this.verificationFailureReason ?? `INVALID_TOKEN: Token ${tokenAddress} failed validation`,
      };
    }
    return { valid: true };
  }

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
      const persistedBinding = this.persistence?.getSovereignSwapBySwapKey?.(swapKey)?.evmHtlcId;
      const fallbackHtlcId = this.swapKeyToHtlcId.get(swapKey) ?? persistedBinding;
      return {
        swapKey,
        htlcId: fallbackHtlcId,
        funded: false,
        completed: false,
        refunded: false,
        balance: 0n,
        timelock: 0,
        blockTimestamp: this.currentBlockTimestamp,
      };
    }

    const htlcId =
      this.swapKeyToHtlcId.get(swapKey) ??
      `0x${createHash('sha256').update(swapKey).digest('hex')}`;
    return {
      swapKey,
      htlcId,
      funded: htlc.funded,
      completed: htlc.completed,
      refunded: htlc.refunded,
      balance: htlc.balance,
      timelock: htlc.params.refundLocktime,
      blockTimestamp: this.currentBlockTimestamp,
    };
  }

  public async getContractHtlcState(htlcId: string): Promise<{ status: number; amount: bigint } | null> {
    const swapKey = this.htlcIdToSwapKey.get(htlcId);
    if (!swapKey) {
      for (const [key, stored] of this.htlcs.entries()) {
        const computedId = this.swapKeyToHtlcId.get(key) ?? `0x${createHash('sha256').update(key).digest('hex')}`;
        if (computedId === htlcId) {
          if (stored.completed) return { status: 2, amount: stored.balance };
          if (stored.refunded) return { status: 3, amount: stored.balance };
          if (stored.funded) return { status: 1, amount: stored.balance };
          return { status: 0, amount: 0n };
        }
      }
      return null;
    }
    const htlc = this.htlcs.get(swapKey);
    if (!htlc) return null;
    if (htlc.completed) return { status: 2, amount: htlc.balance };
    if (htlc.refunded) return { status: 3, amount: htlc.balance };
    if (htlc.funded) return { status: 1, amount: htlc.balance };
    return { status: 0, amount: 0n };
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
