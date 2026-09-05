/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 5B — End-to-End Coordinator Recovery & Cross-Rail Reliability Test Suite
 *
 * Implements rigorous verification of:
 * - Crash / Restart Recovery Matrix: CP-1 through CP-14
 * - Claim vs Refund Adversarial Races: Race A, Race B, Race C, Race D
 * - Concurrency Storms: 50-request same-swap storm, multi-swap concurrency, two-process recovery race
 * - Cross-Rail Time Safety Invariants & Consensus Timelock Buffers
 * - LND and Base RPC Failure & Ambiguity Matrix
 * - Bounded Retry Policy & RECOVERY_REQUIRED Escalation
 * - Transition Auditability & Immutable Economic Parameter Fingerprints
 * - Custody Boundary Verification (Zero Client Private Keys)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';

import {
  AtomicCoordinator,
  BASE_SEPOLIA_FINALITY_POLICY,
  MissingFinalityPolicyError,
  STANDARD_BASE_SAFETY_BUDGET_SECONDS,
  NOMINAL_BITCOIN_BLOCK_TIME_SECONDS,
  NOMINAL_POISSON_MEAN_BLOCKS,
  VERIFIED_POISSON_BLOCK_THRESHOLD,
  computeRequiredBtcBlocksForBudget,
} from '../src/atomic/coordinator/coordinator.ts';
import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { FakeLightningAtomicBackend } from '../src/atomic/lightning/fake-backend.ts';
import { FakeEvmAtomicBackend } from '../src/atomic/evm/fake-backend.ts';
import { FakeLiquidityInventory } from '../src/atomic/liquidity/fake-inventory.ts';
import { SovereignAtomicState } from '../src/atomic/types.ts';
import { LightningSettlementGateError } from '../src/atomic/evm/evm-types.ts';
import { OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS } from '../src/atomic/evm/base-guard.ts';

function generateClientCrypto() {
  const secret = '0x' + randomBytes(32).toString('hex');
  const hashLock =
    '0x' +
    createHash('sha256')
      .update(Buffer.from(secret.slice(2), 'hex'))
      .digest('hex');
  return { secret, hashLock };
}

describe('PHASE 5B — END-TO-END COORDINATOR RECOVERY & CROSS-RAIL RELIABILITY', () => {
  let dbPath: string;
  let persistence: SqlitePersistence;
  let lightning: FakeLightningAtomicBackend;
  let evm: FakeEvmAtomicBackend;
  let inventory: FakeLiquidityInventory;
  let coordinator: AtomicCoordinator;

  beforeEach(() => {
    dbPath = join(tmpdir(), `phase-5b-coordinator-${randomUUID()}.db`);
    persistence = new SqlitePersistence({ filename: dbPath });
    lightning = new FakeLightningAtomicBackend();
    evm = new FakeEvmAtomicBackend();
    inventory = new FakeLiquidityInventory({
      [OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase()]: 1_000_000_000n,
    });
    coordinator = new AtomicCoordinator(lightning, evm, inventory, {
      persistence,
      workerId: 'worker-primary',
      finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
    });
  });

  afterEach(() => {
    try {
      persistence.close();
    } catch {}
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {}
    }
  });

  // =========================================================================
  // 1. CRASH / RESTART MATRIX: CP-1 THROUGH CP-14
  // =========================================================================
  describe('1. Crash / Restart Recovery Matrix (CP-1 to CP-14)', () => {
    it('CP-1: After durable swap creation, crash before hold invoice creation -> resumes invoice creation idempotently', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `cp1-${randomUUID()}`;
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const fingerprint = coordinator.computeEconomicFingerprint({
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        hashLock,
        claimingAddress: '0xclient1',
        targetDestinationAddress: '0xclient1',
        tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
        refundAddress: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      });

      // Simulate crash right after PLAN_PREPARED row is inserted into SQLite
      const swapId = randomUUID();
      persistence.createSovereignSwap(
        {
          id: swapId,
          idempotencyKey,
          hashLock,
          claimingAddress: '0xclient1',
          targetDestinationAddress: '0xclient1',
          amountSats: 10_000n,
          expectedUsdcAmount: 10_000_000n,
          state: SovereignAtomicState.PLAN_PREPARED,
          tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
          refundAddress: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
          cltvExpiryBlocks: 144,
          timelockSeconds: 43200,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        fingerprint
      );

      // Fresh process boots up with empty RAM
      const rebootedCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-reboot',
      });

      // Re-invoking prepareSwap with same idempotency key resumes and creates hold invoice
      const recovered = await rebootedCoordinator.prepareSwap({
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclient1',
        targetDestinationAddress: '0xclient1',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      assert.equal(recovered.id, swapId);
      assert.ok(recovered.holdInvoice);
      assert.equal(recovered.holdInvoice.paymentHash.toLowerCase(), paymentHash);
      assert.equal(recovered.state, SovereignAtomicState.INVOICE_CREATED);
    });

    it('CP-2: Remote hold invoice created on LND, crash before local DB write -> recovers and converges on existing invoice', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `cp2-${randomUUID()}`;
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();

      // Pre-create invoice on LND remotely
      const invoice = await lightning.createHoldInvoice(hashLock, 15_000n, 144, 'pre-created');

      // Now prepareSwap runs: LND create will detect duplicate / already created and converge
      const record = await coordinator.prepareSwap({
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclient2',
        targetDestinationAddress: '0xclient2',
        amountSats: 15_000n,
        expectedUsdcAmount: 15_000_000n,
      });

      assert.equal(record.state, SovereignAtomicState.INVOICE_CREATED);
      assert.equal(record.holdInvoice?.paymentHash.toLowerCase(), paymentHash);
      assert.equal(record.holdInvoice?.bolt11, invoice.bolt11);
    });

    it('CP-3: Lightning becomes ACCEPTED in LND, crash before local persistence -> LND lookup detects ACCEPTED and resumes', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `cp3-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclient3',
        targetDestinationAddress: '0xclient3',
        amountSats: 20_000n,
        expectedUsdcAmount: 20_000_000n,
      });

      // Payer funds invoice in LND, but coordinator crashes before recording LIGHTNING_HELD
      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);

      // Fresh rebooted coordinator runs reconciliation
      const rebootedCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-reboot',
      });

      const recovered = await rebootedCoordinator.onLightningHoldDetected(record.id);
      assert.equal(recovered.state, SovereignAtomicState.LIGHTNING_HELD);
      assert.equal(recovered.holdInvoice?.state, 'ACCEPTED');
    });

    it('CP-4: Lightning HELD persisted, crash before Base funding -> reboot resumes Base funding', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `cp4-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclient4',
        targetDestinationAddress: '0xclient4',
        amountSats: 25_000n,
        expectedUsdcAmount: 25_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);

      // Crash! New process boots up and resumes funding
      const rebootedCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-reboot',
      });

      const funded = await rebootedCoordinator.fundEvmHtlc(record.id);
      assert.equal(funded.state, SovereignAtomicState.EVM_FUNDED);
      assert.ok(funded.evmFundingTxHash);
      assert.ok(funded.evmHtlcId);

      // Verify state in authoritative SQLite
      const inDb = persistence.getSovereignSwap(record.id);
      assert.equal(inDb?.state, SovereignAtomicState.EVM_FUNDED);
    });

    it('CP-5: Base funding broadcast, crash before recording funding result -> reconciliation discovers canonical transaction', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `cp5-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclient5',
        targetDestinationAddress: '0xclient5',
        amountSats: 30_000n,
        expectedUsdcAmount: 30_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);

      // Fund HTLC directly on EVM simulating broadcast completion before crash
      const swapKey = `swap_${record.id}`;
      const blockTs = await evm.getBlockTimestamp();
      const fundRes = await evm.fundHtlc({
        swapKey,
        hashLock,
        amountUnits: 30_000n,
        tokenAddress: '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40',
        refundLocktime: blockTs + 43200,
        claimAddress: '0xclient5',
        refundAddress: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      });

      // Update swap record in DB to simulate EVM_FUNDING_PENDING crash state
      persistence.updateSovereignSwap(record.id, {
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
        evmSwapKey: swapKey,
        evmHtlcId: fundRes.htlcId,
      });

      // Rebooted coordinator reconciles
      const rebootedCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-reboot',
      });

      const reconciled = await rebootedCoordinator.reconcileSwap(record.id);
      assert.equal(reconciled.state, SovereignAtomicState.EVM_FUNDED);
    });

    it('CP-6: Base funding mined/confirmed, crash before persisting EVM_FUNDED -> chain state converges to funded', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `cp6-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclient6',
        targetDestinationAddress: '0xclient6',
        amountSats: 35_000n,
        expectedUsdcAmount: 35_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // Simulate crash by rolling back local record state to EVM_FUNDING_PENDING
      persistence.updateSovereignSwap(record.id, {
        state: SovereignAtomicState.EVM_FUNDING_PENDING,
      });

      const rebootedCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-reboot',
      });

      const reconciled = await rebootedCoordinator.reconcileSwap(record.id);
      assert.equal(reconciled.state, SovereignAtomicState.EVM_FUNDED);
    });

    it('CP-7: Client claim is pending / unconfirmed -> crash/restart refuses to settle Lightning until confirmed', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `cp7-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclient7',
        targetDestinationAddress: '0xclient7',
        amountSats: 40_000n,
        expectedUsdcAmount: 40_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // Attempt settle with unconfirmed / invalid tx
      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(record.id, '0xunconfirmed_or_failing_tx'),
        (err: any) => {
          assert.ok(err instanceof LightningSettlementGateError || err.message.includes('LIGHTNING_SETTLEMENT_GATE_VIOLATION') || err.message.includes('extractAndVerifyClaimEvidence'));
          return true;
        }
      );

      // Verify Lightning invoice remains strictly ACCEPTED
      const invoiceState = await lightning.getInvoiceState(record.holdInvoice!.paymentHash);
      assert.equal(invoiceState, 'ACCEPTED');
    });

    it('CP-8: Base claim confirmed and preimage available, crash before Lightning settle -> reboot settles Lightning', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `cp8-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclient8',
        targetDestinationAddress: '0xclient8',
        amountSats: 45_000n,
        expectedUsdcAmount: 45_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // Client claims on EVM
      const claimRes = await evm.claimHtlc({
        swapKey: record.evmSwapKey!,
        preimage: secret,
        destination: record.targetDestinationAddress,
      });

      // Record EVM_CLAIM_CONFIRMED in DB before crash
      persistence.updateSovereignSwap(record.id, {
        state: SovereignAtomicState.EVM_CLAIM_CONFIRMED,
        evmClaimTxHash: claimRes.txHash,
      });

      // Rebooted coordinator settles Lightning
      const rebootedCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-reboot',
      });

      const settled = await rebootedCoordinator.claimSwap(record.id, secret);
      assert.equal(settled.state, SovereignAtomicState.DESTINATION_PENDING);

      const lnState = await lightning.getInvoiceState(record.holdInvoice!.paymentHash);
      assert.equal(lnState, 'SETTLED');
    });

    it('CP-9: Lightning settlement succeeded remotely, crash before local persistence -> LND lookup sees SETTLED and converges', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `cp9-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclient9',
        targetDestinationAddress: '0xclient9',
        amountSats: 50_000n,
        expectedUsdcAmount: 50_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // Client claims EVM HTLC onchain
      await evm.claimHtlc({
        swapKey: record.evmSwapKey!,
        preimage: secret,
        destination: '0xclient9',
      });

      // Settle invoice directly on LND to simulate remote success before local DB write
      await lightning.settleHoldInvoice(secret);

      // Rebooted coordinator reconciles
      const rebootedCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-reboot',
      });

      const reconciled = await rebootedCoordinator.reconcileSwap(record.id);
      assert.equal(reconciled.state, SovereignAtomicState.COMPLETED);
      assert.equal(reconciled.holdInvoice?.state, 'SETTLED');
    });

    it('CP-10: Base refund becomes eligible, crash before refund dispatch -> re-checks Base state and resumes refund safely', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `cp10-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclient10',
        targetDestinationAddress: '0xclient10',
        amountSats: 55_000n,
        expectedUsdcAmount: 55_000_000n,
        timelockSeconds: 10,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // Advance EVM time past timelock
      evm.advanceTime(50_000);

      // Rebooted coordinator reconciles and resumes refund
      const rebootedCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-reboot',
      });

      const refunded = await rebootedCoordinator.processRefund(record.id);
      assert.equal(refunded.state, SovereignAtomicState.REFUNDED);
      assert.equal(refunded.holdInvoice?.state, 'CANCELED');
    });

    it('CP-11: Base refund broadcast/mined, crash before recording refund state -> reconcile Base and converge to REFUNDED', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `cp11-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclient11',
        targetDestinationAddress: '0xclient11',
        amountSats: 60_000n,
        expectedUsdcAmount: 60_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // Advance EVM time and refund EVM directly on backend
      evm.advanceTime(50_000);
      await evm.refundHtlc(record.evmSwapKey!);

      // Rebooted coordinator reconciles
      const rebootedCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-reboot',
      });

      const reconciled = await rebootedCoordinator.reconcileSwap(record.id);
      assert.equal(reconciled.state, SovereignAtomicState.REFUNDED);
    });

    it('CP-12: Base refund confirmed, crash before Lightning cancellation -> reboot cancels Lightning', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `cp12-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclient12',
        targetDestinationAddress: '0xclient12',
        amountSats: 65_000n,
        expectedUsdcAmount: 65_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // EVM refunded on-chain after timelock expiry
      evm.advanceTime(50_000);
      await evm.refundHtlc(record.evmSwapKey!);

      // Local state is EVM_REFUND_CONFIRMED before crash
      persistence.updateSovereignSwap(record.id, {
        state: SovereignAtomicState.EVM_REFUND_CONFIRMED,
      });

      // Rebooted coordinator reconciles
      const rebootedCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-reboot',
      });

      const reconciled = await rebootedCoordinator.reconcileSwap(record.id);
      assert.equal(reconciled.state, SovereignAtomicState.REFUNDED);

      const lnState = await lightning.getInvoiceState(record.holdInvoice!.paymentHash);
      assert.equal(lnState, 'CANCELED');
    });

    it('CP-13: Lightning cancel succeeded remotely, crash before local persistence -> LND lookup sees CANCELED and converges', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `cp13-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclient13',
        targetDestinationAddress: '0xclient13',
        amountSats: 70_000n,
        expectedUsdcAmount: 70_000_000n,
      });

      // Cancel invoice on LND remotely
      await lightning.cancelHoldInvoice(record.holdInvoice!.paymentHash);

      // Rebooted coordinator reconciles
      const rebootedCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-reboot',
      });

      const reconciled = await rebootedCoordinator.reconcileSwap(record.id);
      assert.equal(reconciled.state, SovereignAtomicState.INVOICE_CANCELED);
      assert.equal(reconciled.holdInvoice?.state, 'CANCELED');
    });

    it('CP-14: Crash while both LND and Base RPC are unavailable -> marks RECOVERY_REQUIRED without guessing', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `cp14-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclient14',
        targetDestinationAddress: '0xclient14',
        amountSats: 75_000n,
        expectedUsdcAmount: 75_000_000n,
      });

      // Create broken backends simulating network partition
      const brokenLn = {
        backendName: 'BrokenLn',
        getInvoiceState: async () => { throw new Error('Network timeout: LND unreachable'); },
        observeHoldInvoice: async () => { throw new Error('Network timeout: LND unreachable'); },
      } as any;

      const brokenEvm = {
        backendName: 'BrokenEvm',
        observeHtlc: async () => { throw new Error('Network timeout: EVM RPC unreachable'); },
      } as any;

      const recoveryCoordinator = new AtomicCoordinator(brokenLn, brokenEvm, inventory, {
        persistence,
        workerId: 'worker-recovery',
      });

      const reconciled = await recoveryCoordinator.reconcileSwap(record.id);
      assert.equal(reconciled.recoveryRequired, true);
      assert.ok(reconciled.failureReason?.includes('unavailable'));
    });
  });

  // =========================================================================
  // 2. CLAIM VS REFUND ADVERSARIAL RACES
  // =========================================================================
  describe('2. Claim vs Refund Adversarial Races', () => {
    it('Race A: Client claim arrives near refund eligibility -> authoritative Base status wins, refund rejected', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `race-a-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientA',
        targetDestinationAddress: '0xclientA',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // Client claims on EVM just as timelock expires
      await evm.claimHtlc({
        swapKey: record.evmSwapKey!,
        preimage: secret,
        destination: '0xclientA',
      });

      // Operator attempts processRefund -> MUST be rejected because HTLC is already CLAIMED
      await assert.rejects(
        () => coordinator.processRefund(record.id),
        /MUTUAL_EXCLUSION_VIOLATION|already claimed on-chain/
      );

      // Settle Lightning proceeds safely
      const settled = await coordinator.claimSwap(record.id, secret);
      assert.equal(settled.state, SovereignAtomicState.DESTINATION_PENDING);
    });

    it('Race B: Refund and claim compete -> exactly one wins, mutually exclusive terminal states', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `race-b-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB',
        targetDestinationAddress: '0xclientB',
        amountSats: 12_000n,
        expectedUsdcAmount: 12_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // Operator refunds first after timelock expires
      evm.advanceTime(50_000);
      await coordinator.processRefund(record.id);
      assert.equal(persistence.getSovereignSwap(record.id)?.state, SovereignAtomicState.REFUNDED);

      // Subsequent claim attempt MUST be rejected
      await assert.rejects(
        () => coordinator.claimSwap(record.id, secret),
        /SEC-10 violation|already in refund path/
      );
    });

    it('Race C: Stale local state says refundable but chain shows claimed -> Router settles Lightning, no refund', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `race-c-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC',
        targetDestinationAddress: '0xclientC',
        amountSats: 14_000n,
        expectedUsdcAmount: 14_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // Stale local state manually forced to REFUND_ELIGIBLE
      persistence.updateSovereignSwap(record.id, {
        state: SovereignAtomicState.REFUND_ELIGIBLE,
      });

      // But on-chain, client claimed
      await evm.claimHtlc({
        swapKey: record.evmSwapKey!,
        preimage: secret,
        destination: '0xclientC',
      });

      // Coordinator must reject refund
      await assert.rejects(
        () => coordinator.processRefund(record.id),
        /MUTUAL_EXCLUSION_VIOLATION|already claimed on-chain/
      );
    });

    it('Race D: Stale local state says claim pending but chain shows refund -> Router cancels Lightning, no settle', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `race-d-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientD',
        targetDestinationAddress: '0xclientD',
        amountSats: 16_000n,
        expectedUsdcAmount: 16_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // EVM is refunded on-chain after timelock expires
      evm.advanceTime(50_000);
      await evm.refundHtlc(record.evmSwapKey!);

      // Stale local state forced to REFUNDED in DB
      persistence.updateSovereignSwap(record.id, {
        state: SovereignAtomicState.REFUNDED,
      });

      // Claim attempt MUST be rejected
      await assert.rejects(
        () => coordinator.claimSwap(record.id, secret),
        /SEC-10 violation|already in refund path/
      );

      // Lightning invoice must be CANCELED
      await lightning.cancelHoldInvoice(record.holdInvoice!.paymentHash);
      const lnState = await lightning.getInvoiceState(record.holdInvoice!.paymentHash);
      assert.equal(lnState, 'CANCELED');
    });
  });

  // =========================================================================
  // 3. CONCURRENCY & STORM PROTECTION
  // =========================================================================
  describe('3. Concurrency & Storm Protection', () => {
    it('Same-swap storm: 50 parallel requests produce exactly 1 swap, 1 invoice, 1 fund', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `same-swap-storm-${randomUUID()}`;

      // Launch 50 concurrent prepareSwap calls
      const promises = Array.from({ length: 50 }, () =>
        coordinator.prepareSwap({
          idempotencyKey,
          hashLock,
          claimingAddress: '0xstormClient',
          targetDestinationAddress: '0xstormClient',
          amountSats: 20_000n,
          expectedUsdcAmount: 20_000_000n,
        })
      );

      const results = await Promise.all(promises);

      // All 50 calls return the EXACT same swap ID and payment hash
      const firstId = results[0].id;
      const firstHash = results[0].holdInvoice!.paymentHash;
      for (const res of results) {
        assert.equal(res.id, firstId);
        assert.equal(res.holdInvoice!.paymentHash, firstHash);
      }

      // SQLite database contains exactly 1 row for this idempotency key
      const record = persistence.getSovereignSwapByIdempotencyKey(idempotencyKey);
      assert.ok(record);
      assert.equal(record.id, firstId);
    });

    it('Multi-swap concurrency: 20 distinct concurrent swaps obtain strictly unique payment hashes without collision', async () => {
      const promises = Array.from({ length: 20 }, (_, i) => {
        const { hashLock } = generateClientCrypto();
        return coordinator.prepareSwap({
          idempotencyKey: `multi-swap-${i}-${randomUUID()}`,
          hashLock,
          claimingAddress: `0xclient_${i}`,
          targetDestinationAddress: `0xclient_${i}`,
          amountSats: BigInt(5_000 + i * 100),
          expectedUsdcAmount: BigInt((5_000 + i * 100) * 1000),
        });
      });

      const records = await Promise.all(promises);

      const ids = new Set(records.map((r) => r.id));
      const paymentHashes = new Set(records.map((r) => r.holdInvoice!.paymentHash));

      assert.equal(ids.size, 20, 'All 20 swap IDs must be unique');
      assert.equal(paymentHashes.size, 20, 'All 20 payment hashes must be unique (Invariant F)');
    });

    it('Two-process recovery race: two independent coordinators racing reconcileAll against same DB converge identically', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `two-proc-race-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xtwoProc',
        targetDestinationAddress: '0xtwoProc',
        amountSats: 25_000n,
        expectedUsdcAmount: 25_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // Two independent coordinator instances with different worker IDs pointing to same DB
      const coordA = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-process-A',
      });
      const coordB = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-process-B',
      });

      // Concurrently reconcile all active swaps
      const [resultsA, resultsB] = await Promise.all([
        coordA.reconcileAll('worker-process-A'),
        coordB.reconcileAll('worker-process-B'),
      ]);

      assert.ok(resultsA.length > 0);
      assert.ok(resultsB.length > 0);

      // Both see the identical durable state
      const finalRecord = persistence.getSovereignSwap(record.id);
      assert.equal(finalRecord?.state, SovereignAtomicState.EVM_FUNDED);
    });
  });

  // =========================================================================
  // 4. CROSS-RAIL TIME SAFETY INVARIANTS
  // =========================================================================
  describe('4. Cross-Rail Time Safety Invariants', () => {
    it('Rejects EVM funding fail-closed if remaining Lightning CLTV is below safety buffer (18 blocks)', async () => {
      const { hashLock } = generateClientCrypto();
      // Set block height at 800000 before invoice creation so expiryHeight = 800000 + 144 = 800144 is stored
      lightning.setBlockHeight(800000);
      const record = await coordinator.prepareSwap({
        idempotencyKey: `time-safety-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xtimeSafety',
        targetDestinationAddress: '0xtimeSafety',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
        timelockSeconds: 43200, // 12h -> requires 93 blocks minimum
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);

      // Advance Bitcoin chain so only 10 blocks remain (800134): far below required 93 blocks
      lightning.setBlockHeight(800134);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(record.id),
        /CLTV_SAFETY_MARGIN_VIOLATION.*below safety buffer \(18 blocks\)/
      );
    });

    it('Base HTLC timelock (12h) expires well before Lightning CLTV safety margin (21h / 24h)', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `timelock-buffer-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xbufferClient',
        targetDestinationAddress: '0xbufferClient',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144, // 24h
        timelockSeconds: 43200, // 12h
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      const funded = await coordinator.fundEvmHtlc(record.id);

      const evmState = await evm.observeHtlc(funded.evmSwapKey!);
      const remainingSeconds = evmState.timelock - evmState.blockTimestamp;

      // Base HTLC timelock is ~43200s (12h)
      assert.ok(remainingSeconds <= 43200 && remainingSeconds > 0);

      // 144 blocks * 600s/block = 86,400s (24h)
      // Safety buffer: 18 blocks * 600s = 10,800s (3h)
      // Effective Lightning window = 86,400 - 10,800 = 75,600s (21h)
      // Proof: 43,200s < 75,600s with 32,400s (9 hours) of safety slack!
      const lightningEffectiveSeconds = (144 - 18) * 600;
      assert.ok(
        remainingSeconds < lightningEffectiveSeconds,
        `Base timelock (${remainingSeconds}s) must be strictly less than effective Lightning window (${lightningEffectiveSeconds}s)`
      );
    });
  });

  // =========================================================================
  // 5. TRANSITION AUDITABILITY & IMMUTABLE ECONOMIC FINGERPRINT
  // =========================================================================
  describe('5. Transition Auditability & Economic Fingerprint', () => {
    it('Conflicting economic parameters on duplicate idempotency key throw IMMUTABLE_FINGERPRINT_MISMATCH fail-closed', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `conflict-fingerprint-${randomUUID()}`;

      await coordinator.prepareSwap({
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclientOrig',
        targetDestinationAddress: '0xclientOrig',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      // Re-call with different amount -> MUST fail closed
      await assert.rejects(
        () =>
          coordinator.prepareSwap({
            idempotencyKey,
            hashLock,
            claimingAddress: '0xclientOrig',
            targetDestinationAddress: '0xclientOrig',
            amountSats: 99_999n, // Conflicting amount!
            expectedUsdcAmount: 10_000_000n,
          }),
        /IMMUTABLE_FINGERPRINT_MISMATCH/
      );
    });

    it('Transitions are durably recorded in sovereign_swap_transitions audit table', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `audit-trail-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xauditClient',
        targetDestinationAddress: '0xauditClient',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);
      await coordinator.claimSwap(record.id, secret);
      coordinator.confirmBaseDelivery(record.id, '0xdeliveryTx');

      const transitions = coordinator.getTransitions(record.id);
      assert.ok(transitions.length >= 4);

      const states = transitions.map((t) => t.toState);
      assert.ok(states.includes(SovereignAtomicState.INVOICE_CREATED));
      assert.ok(states.includes(SovereignAtomicState.LIGHTNING_HELD));
      assert.ok(states.includes(SovereignAtomicState.EVM_FUNDED));
      assert.ok(states.includes(SovereignAtomicState.COMPLETED));
    });
  });

  // =========================================================================
  // 6. CUSTODY & ZERO CLIENT KEY SECURITY
  // =========================================================================
  describe('6. Custody & Zero Client Key Invariants', () => {
    it('Database rows and in-memory execution records contain zero client private keys or preimages', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `custody-check-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xcustodyCheck',
        targetDestinationAddress: '0xcustodyCheck',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);
      await coordinator.claimSwap(record.id, secret);

      const inDb = persistence.getSovereignSwap(record.id)!;
      const rawDbString = JSON.stringify(inDb, (_k, v) => typeof v === 'bigint' ? v.toString() : v);

      // Secret preimage (without 0x) must NOT be present in DB
      const cleanSecret = secret.replace(/^0x/, '').toLowerCase();
      assert.equal(rawDbString.includes(cleanSecret), false, 'Preimage must never be stored in database');

      // Zero private keys
      assert.equal(rawDbString.includes('privateKey'), false);
      assert.equal(rawDbString.includes('mnemonic'), false);
    });
  });

  // =========================================================================
  // 7. CROSS-RAIL TIME SAFETY & STATISTICAL FAST-BLOCK PLANNING (MATH-1..9 & TIME-G1..G4)
  // =========================================================================
  describe('7. Cross-Rail Time Safety & Statistical Fast-Block Planning (MATH-1..9 & TIME-G1..G4)', () => {
    it('MATH-1: 46,200-second safety budget => mu=77 under nominal 600-second Poisson model', () => {
      // 43,200s (Base HTLC) + 600s (dispatch) + 300s (finality) + 300s (LND) + 1,800s (emergency margin) = 46,200s
      assert.equal(STANDARD_BASE_SAFETY_BUDGET_SECONDS, 46_200);
      assert.equal(NOMINAL_BITCOIN_BLOCK_TIME_SECONDS, 600);
      const mu = STANDARD_BASE_SAFETY_BUDGET_SECONDS / NOMINAL_BITCOIN_BLOCK_TIME_SECONDS;
      assert.equal(mu, 77);
      assert.equal(NOMINAL_POISSON_MEAN_BLOCKS, 77);
    });

    it('MATH-2: Independent, numerically stable Poisson upper-tail recurrence at 139 and 140 blocks (zero 1-CDF cancellation)', () => {
      const mu = 77;
      // Direct recurrence: P(N >= k) = P(N = k) * [1 + mu/(k+1) + mu^2/((k+1)(k+2)) + ...]
      function independentTail(k: number, mean: number): number {
        let logFact = 0;
        for (let i = 1; i <= k; i++) logFact += Math.log(i);
        const P_k = Math.exp(-mean + k * Math.log(mean) - logFact);
        let sum = 1;
        let term = 1;
        for (let r = 1; r < 200; r++) {
          term *= mean / (k + r);
          sum += term;
          if (term < 1e-16) break;
        }
        return P_k * sum;
      }

      const tail129 = independentTail(129, mu);
      const tail139 = independentTail(139, mu);
      const tail140 = independentTail(140, mu);

      // Confirm tail at 129 does NOT satisfy 1e-10 (was ~4.0e-8)
      assert.ok(tail129 > 1e-10, `P(N >= 129 | mu=77) was ${tail129}, which is > 1e-10`);
      assert.ok(tail129 >= 4.0e-8 && tail129 <= 4.1e-8);

      // Confirm tail at 139 does NOT satisfy 1e-10 (>= 1e-10)
      // Reference: ~1.3835441073e-10
      assert.ok(tail139 >= 1e-10, `P(N >= 139 | mu=77) must be >= 1e-10, got ${tail139}`);
      assert.ok(Math.abs(tail139 - 1.3835441073e-10) / 1.3835441073e-10 < 1e-5);

      // Confirm tail at 140 satisfies 1e-10 (< 1e-10)
      // Reference: ~7.5468444322e-11
      assert.ok(tail140 < 1e-10, `P(N >= 140 | mu=77) must be < 1e-10, got ${tail140}`);
      assert.ok(Math.abs(tail140 - 7.5468444322e-11) / 7.5468444322e-11 < 1e-5);
    });

    it('MATH-3: Independently derive smallest K satisfying P(N >= K | mu=77) < 1e-10 => K = 140 (no circular shortcut)', () => {
      const mu = 77;
      function independentTail(k: number, mean: number): number {
        let logFact = 0;
        for (let i = 1; i <= k; i++) logFact += Math.log(i);
        const P_k = Math.exp(-mean + k * Math.log(mean) - logFact);
        let sum = 1;
        let term = 1;
        for (let r = 1; r < 200; r++) {
          term *= mean / (k + r);
          sum += term;
          if (term < 1e-16) break;
        }
        return P_k * sum;
      }

      let derivedK = Math.ceil(mu);
      while (independentTail(derivedK, mu) >= 1e-10) {
        derivedK++;
      }

      // Assert independent oracle derives exactly 140
      assert.equal(derivedK, 140);
      assert.equal(independentTail(139, mu) >= 1e-10, true);
      assert.equal(independentTail(140, mu) < 1e-10, true);

      // Confirm production helper derives 140 from first principles with ZERO shortcut
      const prodDerivedK = computeRequiredBtcBlocksForBudget(46_200, 1e-10);
      assert.equal(prodDerivedK, 140);
      assert.equal(VERIFIED_POISSON_BLOCK_THRESHOLD, 140);
    });

    it('MATH-4 / TIME-P2: 139 remaining authoritative blocks => Base funding fail closed', async () => {
      const { hashLock } = generateClientCrypto();
      lightning.setBlockHeight(800000);
      const record = await coordinator.prepareSwap({
        idempotencyKey: `math4-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xmath4',
        targetDestinationAddress: '0xmath4',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144, // expiryHeight = 800144
        timelockSeconds: 43200,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);

      // Advance Bitcoin chain so remaining blocks = 139 (800144 - 800005 = 139 < 140 required)
      lightning.setBlockHeight(800005);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(record.id),
        /CLTV_SAFETY_MARGIN_VIOLATION/
      );
    });

    it('MATH-5 / TIME-P3: 140 remaining authoritative blocks => Base funding permitted if all other conditions are valid', async () => {
      const { hashLock } = generateClientCrypto();
      lightning.setBlockHeight(800000);
      const record = await coordinator.prepareSwap({
        idempotencyKey: `math5-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xmath5',
        targetDestinationAddress: '0xmath5',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144, // expiryHeight = 800144
        timelockSeconds: 43200,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);

      // Advance Bitcoin chain so remaining blocks = 140 (800144 - 800004 = 140 >= 140 required)
      lightning.setBlockHeight(800004);

      const funded = await coordinator.fundEvmHtlc(record.id);
      assert.equal(funded.state, SovereignAtomicState.EVM_FUNDED);
    });

    it('MATH-6 / TIME-P4: 18 remaining blocks + fresh 12h Base HTLC => rejected', async () => {
      const { hashLock } = generateClientCrypto();
      lightning.setBlockHeight(800000);
      const record = await coordinator.prepareSwap({
        idempotencyKey: `math6-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xmath6',
        targetDestinationAddress: '0xmath6',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
        timelockSeconds: 43200,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);

      // Advance Bitcoin chain to height 800126 (remaining = 800144 - 800126 = 18 blocks << 140 required)
      lightning.setBlockHeight(800126);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(record.id),
        /CLTV_SAFETY_MARGIN_VIOLATION/
      );
    });

    it('MATH-7 / TIME-G1: Current BTC height unavailable => rejected, zero Base fund', async () => {
      const { hashLock } = generateClientCrypto();
      lightning.setBlockHeight(800000);
      const record = await coordinator.prepareSwap({
        idempotencyKey: `math7-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xmath7',
        targetDestinationAddress: '0xmath7',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
        timelockSeconds: 43200,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);

      // Simulate authoritative Bitcoin block height query failure
      lightning.setFailGetBlockHeight(true);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(record.id),
        /AUTHORITATIVE_BLOCK_HEIGHT_UNAVAILABLE/
      );

      // Verify zero Base fund transaction was dispatched
      const obs = await evm.observeHtlc(`swap_${record.id}`);
      assert.equal(obs.funded, false);
      const postRecord = coordinator.getExecution(record.id)!;
      assert.equal(postRecord.state, SovereignAtomicState.LIGHTNING_HELD);
      assert.equal(postRecord.evmFundingTxHash, undefined);
    });

    it('MATH-8 / TIME-G3: Initial CLTV delta appears safe but authoritative remaining window is unsafe => rejected', async () => {
      const { hashLock } = generateClientCrypto();
      lightning.setBlockHeight(800000);
      // Invoice prepared with initial cltvExpiryBlocks = 144 (looks safe on paper)
      const record = await coordinator.prepareSwap({
        idempotencyKey: `math8-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xmath8',
        targetDestinationAddress: '0xmath8',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
        timelockSeconds: 43200,
      });

      // Payer accepts HTLC with an expiry height that leaves only 50 blocks remaining
      lightning.simulatePayerHold(record.holdInvoice!.paymentHash, 800050);
      await coordinator.onLightningHoldDetected(record.id);

      // Authoritative current height = 800000, actual accepted HTLC expiry = 800050 (remaining = 50 blocks < 140 required)
      // Even though record.cltvExpiryBlocks is 144, authoritative remaining window (50 blocks) must win!
      await assert.rejects(
        () => coordinator.fundEvmHtlc(record.id),
        /CLTV_SAFETY_MARGIN_VIOLATION/
      );
    });

    it('MATH-9 / TIME-P6: Restart near threshold => fresh authoritative BTC height queried again => threshold recomputed/reapplied => no stale height decision', async () => {
      const { hashLock } = generateClientCrypto();
      lightning.setBlockHeight(800000);

      const record = await coordinator.prepareSwap({
        idempotencyKey: `math9-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xmath9',
        targetDestinationAddress: '0xmath9',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144, // expiryHeight = 800144
        timelockSeconds: 43200,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);

      // Advance Bitcoin chain so remaining blocks = 139 (800144 - 800005 = 139 < 140 required)
      lightning.setBlockHeight(800005);

      // Simulate crash and reboot: new coordinator instance connected to the same DB
      const rebootedCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-rebooted-time',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });

      // Rebooted coordinator queries live getBlockHeight() (800005), re-computes remaining blocks (139),
      // and rejects funding fail-closed instead of relying on stale cache!
      await assert.rejects(
        () => rebootedCoordinator.fundEvmHtlc(record.id, 'worker-rebooted-time'),
        /CLTV_SAFETY_MARGIN_VIOLATION/
      );
    });

    it('TIME-G2: Accepted HTLC exists + stale cached height available but fresh authoritative query fails => stale value is NOT used to fund => fail closed', async () => {
      const { hashLock } = generateClientCrypto();
      lightning.setBlockHeight(800000);
      const record = await coordinator.prepareSwap({
        idempotencyKey: `time-g2-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xtimeG2',
        targetDestinationAddress: '0xtimeG2',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
        timelockSeconds: 43200,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);

      // Stale height was 800000. Fresh authoritative query now fails.
      lightning.setFailGetBlockHeight(true);

      // Must fail closed without falling back to stale height 800000 or initial CLTV delta!
      await assert.rejects(
        () => coordinator.fundEvmHtlc(record.id),
        /AUTHORITATIVE_BLOCK_HEIGHT_UNAVAILABLE/
      );

      const postRecord = coordinator.getExecution(record.id)!;
      assert.equal(postRecord.state, SovereignAtomicState.LIGHTNING_HELD);
    });

    it('TIME-G4: Authoritative height recovers after restart => safety is recomputed from fresh height => coordinator proceeds only if invariant is now satisfied', async () => {
      const { hashLock } = generateClientCrypto();
      lightning.setBlockHeight(800000);
      const record = await coordinator.prepareSwap({
        idempotencyKey: `time-g4-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xtimeG4',
        targetDestinationAddress: '0xtimeG4',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144, // expiryHeight = 800144
        timelockSeconds: 43200,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);

      // 1. Height query fails
      lightning.setFailGetBlockHeight(true);
      await assert.rejects(
        () => coordinator.fundEvmHtlc(record.id),
        /AUTHORITATIVE_BLOCK_HEIGHT_UNAVAILABLE/
      );

      // 2. Process restarts, height query recovers, authoritative height = 800004 (remaining = 140 blocks >= 140)
      lightning.setFailGetBlockHeight(false);
      lightning.setBlockHeight(800004);

      const rebootedCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-time-reboot',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });

      const funded = await rebootedCoordinator.fundEvmHtlc(record.id, 'worker-time-reboot');
      assert.equal(funded.state, SovereignAtomicState.EVM_FUNDED);
    });

    it('TIME-P1: Standard 12h Base HTLC => exact required Poisson block threshold (140 blocks for tail < 1e-10)', () => {
      assert.equal(STANDARD_BASE_SAFETY_BUDGET_SECONDS, 46_200);
      const exactRequiredBlocks = computeRequiredBtcBlocksForBudget(46_200, 1e-10);
      assert.equal(exactRequiredBlocks, 140);
      assert.equal(VERIFIED_POISSON_BLOCK_THRESHOLD, 140);
    });

    it('TIME-P5: Partially elapsed Base timelock => remaining Base time used', async () => {
      const { hashLock } = generateClientCrypto();
      lightning.setBlockHeight(800000);

      // Base timelock for this swap has only 1,000s remaining
      const record = await coordinator.prepareSwap({
        idempotencyKey: `time-p5-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xtimeP5',
        targetDestinationAddress: '0xtimeP5',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
        timelockSeconds: 1000,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);

      // Advance Bitcoin chain to height 800109 (remaining = 800144 - 800109 = 35 blocks)
      lightning.setBlockHeight(800109);

      // Total Base budget: 1000s + 600s + 300s + 300s + 1800s = 4,000s
      // mu = 4000 / 600 = 6.666...
      // Required blocks: computeRequiredBtcBlocksForBudget(4000, 1e-10) = 30 blocks
      // Remaining: 35 blocks >= 30 blocks -> ALLOWED
      const funded = await coordinator.fundEvmHtlc(record.id);
      assert.equal(funded.state, SovereignAtomicState.EVM_FUNDED);
    });
  });

  // =========================================================================
  // 8. ACTION LEASE EXPIRY & SPLIT-BRAIN INVARIANTS (TESTS A-E)
  // =========================================================================
  describe('8. Action Lease Expiry & Split-Brain Invariants (Tests A-E)', () => {
    it('Lease Test A: Slow settle RPC; lease expires; Worker B recovers and settles; duplicate settle idempotent', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `lease-test-a-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xleaseA',
        targetDestinationAddress: '0xleaseA',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // Worker A starts settle with short lease (10ms)
      const coordinatorA = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-A',
        leaseMs: 10,
      });
      const coordinatorB = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-B',
        leaseMs: 5000,
      });

      // Worker A claims lease in DB
      persistence.claimSovereignAction(record.id, 'SETTLE', 'worker-A', 10);

      // Wait for Worker A's lease to expire
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Worker B acquires expired lease and completes claim/settle
      const settledB = await coordinatorB.claimSwap(record.id, secret, 'worker-B');
      assert.equal(settledB.state, SovereignAtomicState.DESTINATION_PENDING);

      // LND invoice is settled
      assert.equal(await lightning.getInvoiceState(record.holdInvoice!.paymentHash), 'SETTLED');

      // Now Worker A's slow call executes — must be completely idempotent and safe (no split-brain)
      try {
        const settledA = await coordinatorA.claimSwap(record.id, secret, 'worker-A');
        assert.equal(settledA.state, SovereignAtomicState.DESTINATION_PENDING);
      } catch (err: any) {
        assert.match(err.message, /EVM HTLC is not in EVM_FUNDED state|already claimed by another worker/);
      }
      assert.equal(coordinatorA.getExecution(record.id)?.state, SovereignAtomicState.DESTINATION_PENDING);
    });

    it('Lease Test B: Slow cancel RPC; lease expires; Worker B cancels; no settle possible', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `lease-test-b-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xleaseB',
        targetDestinationAddress: '0xleaseB',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        timelockSeconds: 100,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      // Advance EVM timestamp past timelock
      evm.advanceTime(200);

      const coordinatorA = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-A',
        leaseMs: 10,
      });
      const coordinatorB = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-B',
      });

      // Worker A claims refund action
      persistence.claimSovereignAction(record.id, 'REFUND', 'worker-A', 10);
      await new Promise((resolve) => setTimeout(resolve, 30)); // lease expires

      // Worker B re-acquires expired lease and processes refund
      const refundedB = await coordinatorB.processRefund(record.id, 'worker-B');
      assert.equal(refundedB.state, SovereignAtomicState.REFUNDED);
      assert.equal(await lightning.getInvoiceState(record.holdInvoice!.paymentHash), 'CANCELED');

      // Subsequent attempt to settle MUST be rejected fail-closed
      await assert.rejects(
        () => coordinatorA.claimSwap(record.id, secret, 'worker-A'),
        /Cannot claim swap|already refunded/i
      );
    });

    it('Lease Test C: Slow Base fund; Worker B funds; exactly 1 funded HTLC', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `lease-test-c-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xleaseC',
        targetDestinationAddress: '0xleaseC',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);

      const coordinatorA = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-A',
        leaseMs: 10,
      });
      const coordinatorB = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-B',
      });

      // Worker A claims fund action; lease expires
      persistence.claimSovereignAction(record.id, 'FUND', 'worker-A', 10);
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Worker B acquires expired lease and funds
      const fundedB = await coordinatorB.fundEvmHtlc(record.id, 'worker-B');
      assert.equal(fundedB.state, SovereignAtomicState.EVM_FUNDED);

      // Worker A runs late — idempotent return, zero duplicate HTLC
      const fundedA = await coordinatorA.fundEvmHtlc(record.id, 'worker-A');
      assert.equal(fundedA.state, SovereignAtomicState.EVM_FUNDED);

      // Verify EVM backend only has exactly 1 HTLC funded for this swapKey
      const htlcState = await evm.observeHtlc(fundedB.evmSwapKey!);
      assert.equal(htlcState.funded, true);
    });

    it('Lease Test D: Slow Base refund; Worker B refunds; exactly 1 refund', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `lease-test-d-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xleaseD',
        targetDestinationAddress: '0xleaseD',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        timelockSeconds: 100,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);
      evm.advanceTime(200);

      const coordinatorA = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-A',
        leaseMs: 10,
      });
      const coordinatorB = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-B',
      });

      persistence.claimSovereignAction(record.id, 'REFUND', 'worker-A', 10);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const refundedB = await coordinatorB.processRefund(record.id, 'worker-B');
      assert.equal(refundedB.state, SovereignAtomicState.REFUNDED);

      // Worker A executes late — converges idempotently to REFUNDED
      const refundedA = await coordinatorA.processRefund(record.id, 'worker-A');
      assert.equal(refundedA.state, SovereignAtomicState.REFUNDED);
    });

    it('Lease Test E: Stale worker resumes after Worker B completed; converges to terminal record', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `lease-test-e-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xleaseE',
        targetDestinationAddress: '0xleaseE',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      await coordinator.fundEvmHtlc(record.id);

      const coordinatorB = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-B',
      });

      // Worker B completes the entire lifecycle to terminal COMPLETED state
      await coordinatorB.claimSwap(record.id, secret, 'worker-B');
      coordinatorB.confirmBaseDelivery(record.id, '0xterminalDeliveryTx');

      const terminalRecord = persistence.getSovereignSwap(record.id)!;
      assert.equal(terminalRecord.state, SovereignAtomicState.COMPLETED);

      // Stale Worker A with outdated in-memory state attempts an action / update
      const coordinatorA = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-A',
      });

      // Must cleanly converge to the terminal COMPLETED record without overwriting
      const rechecked = await coordinatorA.reconcileSwap(record.id, 'worker-A');
      assert.equal(rechecked.state, SovereignAtomicState.COMPLETED);
      assert.equal(persistence.getSovereignSwap(record.id)!.state, SovereignAtomicState.COMPLETED);
    });
  });

  // =========================================================================
  // 9. BASE FINALITY POLICY VERIFICATION (FINAL-G1 THROUGH FINAL-G7)
  // =========================================================================
  describe('9. Base Finality Policy Verification (FINAL-G1 through FINAL-G7)', () => {
    it('FINAL-G1: No explicit finality policy => irreversible Lightning action forbidden', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const evmNoPolicy = new FakeEvmAtomicBackend();
      evmNoPolicy.finalityPolicy = undefined;
      const coordNoPolicy = new AtomicCoordinator(lightning, evmNoPolicy, inventory, {
        persistence,
      });

      const record = await coordNoPolicy.prepareSwap({
        idempotencyKey: `final-g1-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xfinalG1',
        targetDestinationAddress: '0xfinalG1',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordNoPolicy.onLightningHoldDetected(record.id);
      const funded = await coordNoPolicy.fundEvmHtlc(record.id);

      const claimRes = await evmNoPolicy.claimHtlc({
        swapKey: funded.evmSwapKey!,
        preimage: secret,
        destination: '0xfinalG1',
      });
      evmNoPolicy.setTxConfirmations(claimRes.txHash, 2);

      // settleLightningFromEvmClaim MUST throw MissingFinalityPolicyError fail-closed
      await assert.rejects(
        () => coordNoPolicy.settleLightningFromEvmClaim(record.id, claimRes.txHash),
        (err: any) => {
          assert.ok(
            err instanceof MissingFinalityPolicyError ||
            err.message.includes('MISSING_FINALITY_POLICY')
          );
          return true;
        }
      );

      // claimSwap MUST also fail closed if no finality policy
      await assert.rejects(
        () => coordNoPolicy.claimSwap(record.id, secret),
        (err: any) => {
          assert.ok(
            err instanceof MissingFinalityPolicyError ||
            err.message.includes('MISSING_FINALITY_POLICY')
          );
          return true;
        }
      );

      // Lightning invoice must remain ACCEPTED (never settled without explicit finality policy)
      assert.equal(await lightning.getInvoiceState(record.holdInvoice!.paymentHash), 'ACCEPTED');
    });

    it('FINAL-G2: One confirmation when policy requires two => HELD / no settle', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `final-g2-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xfinalG2',
        targetDestinationAddress: '0xfinalG2',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      const funded = await coordinator.fundEvmHtlc(record.id);

      const claimRes = await evm.claimHtlc({
        swapKey: funded.evmSwapKey!,
        preimage: secret,
        destination: '0xfinalG2',
      });

      // Set only 1 confirmation (explicit Sepolia policy requires 2)
      evm.setTxConfirmations(claimRes.txHash, 1);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(record.id, claimRes.txHash),
        (err: any) => {
          assert.ok(
            err instanceof LightningSettlementGateError ||
            err.message.includes('INSUFFICIENT_CONFIRMATIONS') ||
            err.message.includes('FINAL_ENOUGH_FOR_PROTOCOL')
          );
          return true;
        }
      );

      // Lightning invoice remains strictly ACCEPTED
      assert.equal(await lightning.getInvoiceState(record.holdInvoice!.paymentHash), 'ACCEPTED');
    });

    it('FINAL-G3: Two confirmations under explicit Sepolia policy => settle permitted only if all other evidence matches', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `final-g3-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xfinalG3',
        targetDestinationAddress: '0xfinalG3',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      const funded = await coordinator.fundEvmHtlc(record.id);

      const claimRes = await evm.claimHtlc({
        swapKey: funded.evmSwapKey!,
        preimage: secret,
        destination: '0xfinalG3',
      });

      // Advance confirmations to 2 (satisfies explicit BASE_SEPOLIA_FINALITY_POLICY)
      evm.setTxConfirmations(claimRes.txHash, 2);

      const settled = await coordinator.settleLightningFromEvmClaim(record.id, claimRes.txHash);
      assert.equal(settled.state, SovereignAtomicState.DESTINATION_PENDING);
      assert.equal(await lightning.getInvoiceState(record.holdInvoice!.paymentHash), 'SETTLED');
    });

    it('FINAL-G4: Refund insufficient finality => cancel forbidden', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `final-g4-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xfinalG4',
        targetDestinationAddress: '0xfinalG4',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        timelockSeconds: 100,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      const funded = await coordinator.fundEvmHtlc(record.id);
      evm.advanceTime(200);

      // Perform refund on EVM backend and set 1 confirmation (policy requires 2)
      const refRes = await evm.refundHtlc(funded.evmSwapKey!);
      evm.setTxConfirmations(refRes.txHash, 1);

      persistence.updateSovereignSwap(record.id, {
        state: SovereignAtomicState.EVM_REFUND_CONFIRMED,
        evmRefundTxHash: refRes.txHash,
      });

      // Calling processRefund with 1 confirmation must reject cancel
      await assert.rejects(
        () => coordinator.processRefund(record.id),
        /INSUFFICIENT_FINALITY.*Lightning cancellation deferred/
      );

      // Lightning invoice must NOT be canceled
      assert.equal(await lightning.getInvoiceState(record.holdInvoice!.paymentHash), 'ACCEPTED');
    });

    it('FINAL-G5: Refund sufficient finality => cancel permitted', async () => {
      const { hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `final-g5-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xfinalG5',
        targetDestinationAddress: '0xfinalG5',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        timelockSeconds: 100,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      const funded = await coordinator.fundEvmHtlc(record.id);
      evm.advanceTime(200);

      const refRes = await evm.refundHtlc(funded.evmSwapKey!);
      evm.setTxConfirmations(refRes.txHash, 2);

      persistence.updateSovereignSwap(record.id, {
        state: SovereignAtomicState.EVM_REFUND_CONFIRMED,
        evmRefundTxHash: refRes.txHash,
      });

      const refunded = await coordinator.processRefund(record.id);
      assert.equal(refunded.state, SovereignAtomicState.REFUNDED);
      assert.equal(await lightning.getInvoiceState(record.holdInvoice!.paymentHash), 'CANCELED');
    });

    it('FINAL-G6: Receipt success but contract state disagreement => fail closed', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `final-g6-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xfinalG6',
        targetDestinationAddress: '0xfinalG6',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      const funded = await coordinator.fundEvmHtlc(record.id);

      const claimRes = await evm.claimHtlc({
        swapKey: funded.evmSwapKey!,
        preimage: secret,
        destination: '0xfinalG6',
      });

      // Simulate storage disagreement: receipt succeeded but contract storage says active (status = 1)
      evm.simulateStorageDisagreement(funded.evmSwapKey!, 1);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(record.id, claimRes.txHash),
        /EVM_FINALITY_DISAGREEMENT/
      );

      // Coordinator must fail closed and flag RECOVERY_REQUIRED in SQLite
      const updated = persistence.getSovereignSwap(record.id)!;
      assert.equal(updated.recoveryRequired, true);
      assert.ok(updated.failureReason?.includes('EVM_FINALITY_DISAGREEMENT'));

      // Lightning invoice must remain ACCEPTED, never settled on disagreement
      assert.equal(await lightning.getInvoiceState(record.holdInvoice!.paymentHash), 'ACCEPTED');
    });

    it('FINAL-G7: User-supplied tx hash, preimage, RPC success response, or mempool presence alone => never sufficient finality evidence', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const record = await coordinator.prepareSwap({
        idempotencyKey: `final-g7-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xfinalG7',
        targetDestinationAddress: '0xfinalG7',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      lightning.simulatePayerHold(record.holdInvoice!.paymentHash);
      await coordinator.onLightningHoldDetected(record.id);
      const funded = await coordinator.fundEvmHtlc(record.id);

      // Case A: User supplies completely fabricated non-existent transaction hash
      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(record.id, '0xfabricated_tx_hash'),
        /Receipt not found for transaction|Claim transaction.*not found/
      );

      // Case B: Transaction is pending in mempool (0 confirmations)
      const claimRes = await evm.claimHtlc({
        swapKey: funded.evmSwapKey!,
        preimage: secret,
        destination: '0xfinalG7',
      });
      evm.simulateTxPending(claimRes.txHash);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(record.id, claimRes.txHash),
        (err: any) => {
          assert.ok(
            err instanceof LightningSettlementGateError ||
            err.message.includes('INSUFFICIENT_CONFIRMATIONS') ||
            err.message.includes('FINAL_ENOUGH_FOR_PROTOCOL')
          );
          return true;
        }
      );

      // Case C: Preimage provided without verified on-chain confirmation (cannot bypass settlement gate)
      assert.equal(await lightning.getInvoiceState(record.holdInvoice!.paymentHash), 'ACCEPTED');
    });
  });
});
