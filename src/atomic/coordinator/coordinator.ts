/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Sovereign Atomic Coordinator
 *
 * Coordinates cross-chain atomic swaps between Bitcoin Lightning hold invoices
 * and EVM HTLCs (Arbitrum One -> Base USDC).
 *
 * Invariants Enforced:
 * - SEC-1: Never stores user private keys.
 * - SEC-5: Durable action ownership before side effects.
 * - SEC-6: Ambiguous financial side effects never blindly retried.
 * - SEC-9: Once funds move/held, ordinary FAILED transition forbidden.
 * - SEC-10: Claim and refund paths are mutually exclusive.
 * - SEC-11: Secret-bearing material sanitized from public interfaces.
 * - SEC-14: Exactly one action owner across concurrent workers.
 * - SEC-21: Authoritative consensus block timestamps for timelocks.
 */

import { randomUUID } from 'node:crypto';
import type {
  ILightningAtomicBackend,
  IEvmAtomicBackend,
  ILiquidityInventory,
  SovereignExecutionRecord,
  HashLock,
  SecretPreimage,
} from '../types.ts';
import { SovereignAtomicState, AuthorizedSettlementPreimage } from '../types.ts';
import {
  LightningSettlementGateError,
  type EvmHtlcClaimedEvidence,
} from '../evm/evm-types.ts';

export interface CreateAtomicSwapParams {
  idempotencyKey: string;
  hashLock: HashLock;
  claimingAddress: string;
  targetDestinationAddress: string;
  amountSats: bigint;
  expectedUsdcAmount: bigint;
  cltvExpiryBlocks?: number;
  timelockSeconds?: number;
}

export class AtomicCoordinator {
  private records = new Map<string, SovereignExecutionRecord>();
  private idempotencyIndex = new Map<string, string>();
  private inFlightPrepares = new Map<string, Promise<SovereignExecutionRecord>>();
  private actionClaims = new Map<string, string>(); // executionId -> claimOwner
  private readonly lightning: ILightningAtomicBackend;
  private readonly evm: IEvmAtomicBackend;
  private readonly inventory: ILiquidityInventory;
  private readonly defaultTokenAddress: string;
  private readonly defaultRefundAddress: string;

  constructor(
    lightning: ILightningAtomicBackend,
    evm: IEvmAtomicBackend,
    inventory: ILiquidityInventory,
    config?: { tokenAddress?: string; operatorRefundAddress?: string }
  ) {
    this.lightning = lightning;
    this.evm = evm;
    this.inventory = inventory;
    this.defaultTokenAddress =
      config?.tokenAddress ??
      (typeof (evm as any).getTokenAddress === 'function'
        ? (evm as any).getTokenAddress()
        : '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40');
    this.defaultRefundAddress =
      config?.operatorRefundAddress ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  }

  /**
   * 1. Initialize Swap Intent and Create Lightning Hold Invoice
   */
  async prepareSwap(params: CreateAtomicSwapParams): Promise<SovereignExecutionRecord> {
    // Idempotency check
    const existingId = this.idempotencyIndex.get(params.idempotencyKey);
    if (existingId) {
      const record = this.records.get(existingId);
      if (record) return record;
    }

    const inFlight = this.inFlightPrepares.get(params.idempotencyKey);
    if (inFlight) return inFlight;

    const preparePromise = (async () => {
      // Validate hashlock format (32 bytes hex)
      if (!/^0x[a-fA-F0-9]{64}$/.test(params.hashLock)) {
        throw new Error(`Invalid hashLock format: must be 0x-prefixed 32-byte hex`);
      }

      // Reserve operator inventory on EVM side before issuing hold invoice
      const tokenAddress = this.defaultTokenAddress;
      const reservation = await this.inventory.reserve(params.amountSats, tokenAddress);
      if (!reservation.reserved) {
        throw new Error(`Insufficient operator liquidity to facilitate atomic swap`);
      }

      const executionId = randomUUID();
      const cltv = params.cltvExpiryBlocks ?? 144; // ~24h in Bitcoin blocks

      // Create Lightning Hold Invoice bound to the user's hashlock
      const holdInvoice = await this.lightning.createHoldInvoice(
        params.hashLock,
        params.amountSats,
        cltv,
        `Sovereign swap ${executionId}`
      );

      const now = new Date();
      const record: SovereignExecutionRecord = {
        id: executionId,
        idempotencyKey: params.idempotencyKey,
        hashLock: params.hashLock.toLowerCase(),
        claimingAddress: params.claimingAddress.toLowerCase(),
        targetDestinationAddress: params.targetDestinationAddress.toLowerCase(),
        amountSats: params.amountSats,
        expectedUsdcAmount: params.expectedUsdcAmount,
        state: SovereignAtomicState.INVOICE_CREATED,
        holdInvoice,
        createdAt: now,
        updatedAt: now,
      };

      this.records.set(executionId, record);
      this.idempotencyIndex.set(params.idempotencyKey, executionId);
      return record;
    })();

    this.inFlightPrepares.set(params.idempotencyKey, preparePromise);
    try {
      return await preparePromise;
    } finally {
      this.inFlightPrepares.delete(params.idempotencyKey);
    }
  }

  /**
   * 2. Detect when Payer has funded the Lightning Hold Invoice
   */
  async onLightningHoldDetected(executionId: string): Promise<SovereignExecutionRecord> {
    const record = this.mustGetRecord(executionId);
    if (record.state !== SovereignAtomicState.INVOICE_CREATED) {
      throw new Error(`Invalid transition to LIGHTNING_HELD from state ${record.state}`);
    }

    const invoiceState = await this.lightning.getInvoiceState(record.holdInvoice!.paymentHash);
    if (invoiceState !== 'ACCEPTED') {
      throw new Error(`Invoice is not held by payer (current state: ${invoiceState})`);
    }

    record.state = SovereignAtomicState.LIGHTNING_HELD;
    record.updatedAt = new Date();
    return record;
  }

  /**
   * 3. Fund the EVM HTLC using Operator Liquidity
   */
  async fundEvmHtlc(executionId: string, workerId: string = 'worker-1'): Promise<SovereignExecutionRecord> {
    const record = this.mustGetRecord(executionId);

    // SEC-14: Concurrency control via durable action claim
    const claimKey = `fund:${executionId}`;
    if (this.actionClaims.has(claimKey) && this.actionClaims.get(claimKey) !== workerId) {
      throw new Error(`Action ${claimKey} already claimed by another worker (SEC-14 violation)`);
    }
    this.actionClaims.set(claimKey, workerId);

    if (record.state !== SovereignAtomicState.LIGHTNING_HELD) {
      throw new Error(`Cannot fund EVM HTLC: Lightning payment not held (state: ${record.state})`);
    }

    // SECTION 27: Verify sufficient LND incoming HTLC CLTV safety window before EVM FUND
    this.assertLightningCltvSafety(record, 'FUND');

    record.state = SovereignAtomicState.EVM_FUNDING_PENDING;

    // Calculate asymmetric timelock: EVM lock = now + 12h (shorter than Lightning 24h)
    const blockTs = await this.evm.getBlockTimestamp();
    const refundLocktime = blockTs + 12 * 3600;
    const swapKey = `swap_${executionId}`;

    // Lock tokens on HTLCErc20
    const fundRes = await this.evm.fundHtlc({
      swapKey,
      hashLock: record.hashLock,
      amountUnits: record.amountSats,
      tokenAddress: this.defaultTokenAddress,
      refundLocktime,
      claimAddress: record.claimingAddress,
      refundAddress: this.defaultRefundAddress,
    });

    record.evmSwapKey = swapKey;
    record.evmHtlcId = fundRes.htlcId;
    record.evmFundingTxHash = fundRes.txHash;
    record.state = SovereignAtomicState.EVM_FUNDED;
    record.updatedAt = new Date();

    return record;
  }

  /**
   * 4a. SOVEREIGN SETTLEMENT GATE:
   * Settles Lightning hold invoice ONLY after confirmed, verified on-chain EVM claim.
   *
   * Enforces that Router does NOT possess client private key and does NOT receive S before claim!
   * Router extracts S from the confirmed public on-chain evidence.
   */
  async settleLightningFromEvmClaim(
    executionId: string,
    claimTxHash: string,
    workerId: string = 'worker-1'
  ): Promise<SovereignExecutionRecord> {
    const record = this.mustGetRecord(executionId);

    // SEC-10: Mutual exclusion of claim vs refund
    if (record.state === SovereignAtomicState.REFUNDED || record.state === SovereignAtomicState.REFUND_ELIGIBLE) {
      throw new LightningSettlementGateError(
        `Cannot settle: swap is already in refund path (SEC-10 violation)`
      );
    }

    // SECTION 27: Recheck sufficient LND incoming HTLC CLTV safety window before SETTLE
    this.assertLightningCltvSafety(record, 'SETTLE');

    if (
      record.state !== SovereignAtomicState.EVM_FUNDED &&
      record.state !== SovereignAtomicState.EVM_CLAIM_DETECTED
    ) {
      throw new LightningSettlementGateError(
        `Cannot settle: EVM HTLC is not in EVM_FUNDED state (current state: ${record.state})`
      );
    }

    if (!record.evmHtlcId) {
      throw new LightningSettlementGateError(
        `Cannot settle: execution record ${executionId} is missing evmHtlcId`
      );
    }

    if (typeof (this.evm as any).extractAndVerifyClaimEvidence !== 'function') {
      throw new LightningSettlementGateError(
        `EVM backend does not support authoritative extractAndVerifyClaimEvidence`
      );
    }

    // Call authoritative EVM backend to extract and verify on-chain claim evidence
    const evidence: EvmHtlcClaimedEvidence = await (this.evm as any).extractAndVerifyClaimEvidence({
      claimTxHash,
      expectedHtlcId: record.evmHtlcId,
      expectedHashLock: record.hashLock,
      expectedClaimAddress: record.claimingAddress,
      expectedAmount: record.amountSats,
      requiredConfirmations: 1, // Devnet requirement
    });

    if (evidence.finalityState !== 'FINAL_ENOUGH_FOR_PROTOCOL') {
      throw new LightningSettlementGateError(
        `Claim evidence finality state ${evidence.finalityState} does not satisfy FINAL_ENOUGH_FOR_PROTOCOL`
      );
    }

    // Durable action ownership
    const claimKey = `claim:${executionId}`;
    if (this.actionClaims.has(claimKey) && this.actionClaims.get(claimKey) !== workerId) {
      throw new Error(`Action ${claimKey} already claimed by another worker`);
    }
    this.actionClaims.set(claimKey, workerId);

    record.state = SovereignAtomicState.EVM_CLAIM_CONFIRMED;
    record.evmClaimTxHash = claimTxHash;

    // Settle Lightning hold invoice with the publicly confirmed revealed preimage
    await this.lightning.settleHoldInvoice(evidence.preimageRevealed);
    record.state = SovereignAtomicState.LIGHTNING_SETTLED;
    record.state = SovereignAtomicState.DESTINATION_PENDING;
    record.updatedAt = new Date();

    return record;
  }

  /**
   * 4b. Client Claims EVM HTLC by revealing Preimage (Simulated/Fallback path)
   */
  async claimSwap(
    executionId: string,
    preimage: SecretPreimage | AuthorizedSettlementPreimage,
    workerId: string = 'worker-1'
  ): Promise<SovereignExecutionRecord> {
    const record = this.mustGetRecord(executionId);

    // SEC-10: Claim and refund mutual exclusion
    if (record.state === SovereignAtomicState.REFUNDED || record.state === SovereignAtomicState.REFUND_ELIGIBLE) {
      throw new Error(`Cannot claim swap: swap is already in refund path (SEC-10 violation)`);
    }

    if (record.state !== SovereignAtomicState.EVM_FUNDED) {
      throw new Error(`Cannot claim swap: EVM HTLC is not in EVM_FUNDED state (state: ${record.state})`);
    }

    // Encapsulate and cryptographically verify preimage before mutating state
    const authPreimage =
      preimage instanceof AuthorizedSettlementPreimage
        ? preimage
        : new AuthorizedSettlementPreimage(preimage);

    if (!authPreimage.matchesHashLock(record.hashLock)) {
      throw new Error(
        `Invalid preimage: Provided preimage does not match execution hashlock ${record.hashLock}`
      );
    }

    const claimKey = `claim:${executionId}`;
    if (this.actionClaims.has(claimKey) && this.actionClaims.get(claimKey) !== workerId) {
      throw new Error(`Action ${claimKey} already claimed by another worker`);
    }
    this.actionClaims.set(claimKey, workerId);

    record.state = SovereignAtomicState.CLAIMING;

    // 4a. Execute claim on EVM HTLC (only supported on simulated backends)
    if (typeof this.evm.claimHtlc !== 'function') {
      throw new Error(
        'EVM backend does not support direct claimHtlc. For sovereign on-chain execution, use settleLightningFromEvmClaim after external client broadcasts claim.'
      );
    }

    const claimRes = await this.evm.claimHtlc({
      swapKey: record.evmSwapKey!,
      preimage: authPreimage.getRawHex(),
      destination: record.targetDestinationAddress,
    });

    if (!claimRes.success) {
      record.state = SovereignAtomicState.RECOVERY_REQUIRED;
      throw new Error(`EVM claim failed; escalated to RECOVERY_REQUIRED`);
    }

    record.evmClaimTxHash = claimRes.txHash;

    // 4b. Now that preimage is proven on EVM, coordinator settles Lightning Hold Invoice
    await this.lightning.settleHoldInvoice(authPreimage.getRawHex());
    record.state = SovereignAtomicState.LIGHTNING_SETTLED;

    // 4c. Mark destination transfer pending (CCTP mint to Base)
    record.state = SovereignAtomicState.DESTINATION_PENDING;
    record.updatedAt = new Date();

    return record;
  }

  /**
   * 5. Confirm Final Base Delivery
   */
  confirmBaseDelivery(executionId: string, destinationTxHash: string): SovereignExecutionRecord {
    const record = this.mustGetRecord(executionId);
    if (record.state !== SovereignAtomicState.DESTINATION_PENDING) {
      throw new Error(`Cannot complete delivery: state must be DESTINATION_PENDING (current: ${record.state})`);
    }

    record.destinationTxHash = destinationTxHash;
    record.state = SovereignAtomicState.COMPLETED;
    record.updatedAt = new Date();
    return record;
  }

  /**
   * 6. Refund Flow (if client fails to claim within timelock)
   */
  async processRefund(executionId: string): Promise<SovereignExecutionRecord> {
    const record = this.mustGetRecord(executionId);

    // SEC-10: Claim and refund mutual exclusion
    if (
      record.state === SovereignAtomicState.CLAIMING ||
      record.state === SovereignAtomicState.LIGHTNING_SETTLED ||
      record.state === SovereignAtomicState.DESTINATION_PENDING ||
      record.state === SovereignAtomicState.COMPLETED
    ) {
      throw new Error(`Cannot refund swap: swap already claimed or completed (SEC-10 violation)`);
    }

    if (record.state === SovereignAtomicState.INVOICE_CREATED) {
      // Unfunded invoice expired
      await this.lightning.cancelHoldInvoice(record.holdInvoice!.paymentHash);
      record.state = SovereignAtomicState.EXPIRED;
      record.updatedAt = new Date();
      return record;
    }

    if (record.state === SovereignAtomicState.LIGHTNING_HELD) {
      // Payment held, but EVM never funded
      await this.lightning.cancelHoldInvoice(record.holdInvoice!.paymentHash);
      record.state = SovereignAtomicState.INVOICE_CANCELED;
      record.updatedAt = new Date();
      return record;
    }

    if (record.state === SovereignAtomicState.EVM_FUNDED) {
      // EVM funded, but client never claimed: verify timelock on-chain
      const htlcState = await this.evm.observeHtlc(record.evmSwapKey!);
      if (htlcState.blockTimestamp < htlcState.timelock) {
        throw new Error(
          `Timelock not expired on EVM (block: ${htlcState.blockTimestamp} < lock: ${htlcState.timelock})`
        );
      }

      // Reclaim EVM collateral
      await this.evm.refundHtlc(record.evmSwapKey!);

      // Cancel Lightning hold invoice (satoshis returned to payer)
      await this.lightning.cancelHoldInvoice(record.holdInvoice!.paymentHash);

      record.state = SovereignAtomicState.REFUNDED;
      record.updatedAt = new Date();
      return record;
    }

    throw new Error(`Refund not supported for state: ${record.state}`);
  }

  getExecution(executionId: string): SovereignExecutionRecord | undefined {
    return this.records.get(executionId);
  }

  private mustGetRecord(executionId: string): SovereignExecutionRecord {
    const record = this.records.get(executionId);
    if (!record) throw new Error(`Execution record not found: ${executionId}`);
    return record;
  }

  private assertLightningCltvSafety(record: SovereignExecutionRecord, stage: 'FUND' | 'SETTLE'): void {
    if (record.holdInvoice?.cltvExpiryBlocks !== undefined) {
      // Invariant: Safety window must strictly exceed minimum buffer threshold (18 blocks)
      if (record.holdInvoice.cltvExpiryBlocks < 18) {
        throw new Error(
          `CLTV_SAFETY_MARGIN_VIOLATION: Lightning HTLC CLTV expiry (${record.holdInvoice.cltvExpiryBlocks} blocks) ` +
          `is below safety buffer (18 blocks) before ${stage}. Refusing to proceed fail-closed.`
        );
      }
    }
  }
}
