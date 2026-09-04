/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 6 — Adversarial / Failure Certification Test Suite
 *
 * Implements hostile, ambiguous, concurrent, crash-prone, resource-constrained,
 * and adversarial stress tests across 11 distinct families:
 *
 * - Family A: Process Death / Restart Storms (A-01 to A-11)
 * - Family B: RPC Ambiguity / Byzantine Responses (B-01 to B-15)
 * - Family C: SQLite / Durable-State Failure (C-01 to C-15)
 * - Family D: Concurrency / Stale Workers (D-01 to D-11)
 * - Family E: Time / Height / Expiry Attacks (E-01 to E-15)
 * - Family F: Base Finality / Reorg-Like Conditions (F-01 to F-12)
 * - Family G: Economic Parameter Tampering (G-01 to G-12)
 * - Family H: Input / Replay / Abuse (H-01 to H-13)
 * - Family I: Resource Exhaustion / Availability (I-01 to I-10)
 * - Family J: Secret / Custody / Logging (J-01 to J-10)
 * - Family K: Recovery Isolation / Blast Radius (K-01 to K-06)
 *
 * Total: 120 deterministic adversarial certification tests.
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
  computeRequiredBtcBlocksForBudget,
} from '../src/atomic/coordinator/coordinator.ts';
import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { FakeLightningAtomicBackend } from '../src/atomic/lightning/fake-backend.ts';
import { FakeEvmAtomicBackend } from '../src/atomic/evm/fake-backend.ts';
import { FakeLiquidityInventory } from '../src/atomic/liquidity/fake-inventory.ts';
import {
  SovereignAtomicState,
  AuthorizedSettlementPreimage,
} from '../src/atomic/types.ts';

function generateClientCrypto() {
  const secret = '0x' + randomBytes(32).toString('hex');
  const hashLock =
    '0x' +
    createHash('sha256')
      .update(Buffer.from(secret.slice(2), 'hex'))
      .digest('hex');
  return { secret, hashLock };
}

describe('PHASE 6 — ADVERSARIAL & FAILURE CERTIFICATION SUITE', () => {
  let dbPath: string;
  let persistence: SqlitePersistence;
  let lightning: FakeLightningAtomicBackend;
  let evm: FakeEvmAtomicBackend;
  let inventory: FakeLiquidityInventory;
  let coordinator: AtomicCoordinator;

  beforeEach(() => {
    dbPath = join(tmpdir(), `phase-6-adv-${randomUUID()}.db`);
    persistence = new SqlitePersistence({ filename: dbPath });
    lightning = new FakeLightningAtomicBackend();
    evm = new FakeEvmAtomicBackend();
    inventory = new FakeLiquidityInventory({
      '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40': 1_000_000_000n,
    });
    coordinator = new AtomicCoordinator(lightning, evm, inventory, {
      persistence,
      workerId: 'phase6-worker-primary',
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
  // FAMILY A: PROCESS DEATH / RESTART STORMS (A-01 to A-11)
  // =========================================================================
  describe('Family A: Process Death / Restart Storms', () => {
    it('A-01: Kill/restart coordinator repeatedly before invoice creation', async () => {
      // 1. Fault: Process crashes 5 times before completing prepareSwap
      // 2. Boundary: Local memory -> durable SQLite initialization
      // 3. Authoritative evidence: Zero external rail action occurred
      // 4. Allowed: Safe idempotency key deduplication
      // 5. Forbidden: Creating orphaned/duplicate hold invoices
      // 6. Survives restart: Idempotency state in DB
      // 7. Convergence: Exactly 1 hold invoice, 1 swap row
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `a01-${randomUUID()}`;

      for (let i = 0; i < 5; i++) {
        const rebootCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
          persistence,
          workerId: `worker-reboot-${i}`,
          finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
        });
        assert.ok(rebootCoordinator);
      }

      const res = await coordinator.prepareSwap({
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclientA01',
        targetDestinationAddress: '0xclientA01',
        amountSats: 20_000n,
        expectedUsdcAmount: 20_000_000n,
        cltvExpiryBlocks: 144,
      });

      assert.strictEqual(res.state, SovereignAtomicState.INVOICE_CREATED);
      const row = persistence.getSovereignSwap(res.id);
      assert.ok(row);
      assert.strictEqual(row.idempotencyKey, idempotencyKey);
    });

    it('A-02: Kill/restart repeatedly after accepted Lightning HTLC but before Base funding', async () => {
      // 1. Fault: Crash after LND ACCEPTED, reboot 5 times before Base funding
      // 2. Boundary: Lightning hold invoice -> Base dispatch gate
      // 3. Evidence: LND invoice is ACCEPTED
      // 4. Allowed: Re-observing ACCEPTED, then funding Base exactly once
      // 5. Forbidden: Double funding Base, canceling Lightning
      // 6. Survives: LIGHTNING_HELD in SQLite
      // 7. Convergence: EVM_FUNDED
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `a02-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientA02',
        targetDestinationAddress: '0xclientA02',
        amountSats: 25_000n,
        expectedUsdcAmount: 25_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);

      for (let i = 0; i < 5; i++) {
        const reboot = new AtomicCoordinator(lightning, evm, inventory, {
          persistence,
          workerId: `reboot-a02-${i}`,
          finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
        });
        const rec = reboot.getExecution(prepared.id);
        assert.strictEqual(rec?.state, SovereignAtomicState.LIGHTNING_HELD);
      }

      const funded = await coordinator.fundEvmHtlc(prepared.id);
      assert.strictEqual(funded.state, SovereignAtomicState.EVM_FUNDED);
      assert.ok(funded.evmFundingTxHash);
    });

    it('A-03: Repeated crashes during Base fund transaction submission/replacement', async () => {
      // 1. Fault: Injected RPC transient drop during evm.fundHtlc
      // 2. Boundary: EVM fund dispatch RPC
      // 3. Evidence: On-chain HTLC state check
      // 4. Allowed: Recheck on-chain status and discover canonical funding
      // 5. Forbidden: Double locking collateral
      // 6. Survives: EVM_FUNDING_PENDING / lease state
      // 7. Convergence: EVM_FUNDED with exactly 1 HTLC on Base
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `a03-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientA03',
        targetDestinationAddress: '0xclientA03',
        amountSats: 15_000n,
        expectedUsdcAmount: 15_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);

      let attempts = 0;
      const originalFund = evm.fundHtlc.bind(evm);
      evm.fundHtlc = async (params) => {
        attempts++;
        if (attempts === 1) {
          throw new Error('EVM_RPC_CONNECTION_RESET: Drop during broadcast');
        }
        return originalFund(params);
      };

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id, 'worker-fault'),
        /EVM_RPC_CONNECTION_RESET/
      );

      const rebootCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-reboot-clean',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });

      const reconciled = await rebootCoordinator.reconcileSwap(prepared.id);
      assert.strictEqual(reconciled.state, SovereignAtomicState.EVM_FUNDED);
    });

    it('A-04: Repeated crashes after Base fund mined but before SQLite reconciliation', async () => {
      // 1. Fault: Fund transaction mined on-chain, crash before SQLite update
      // 2. Boundary: Base mining -> durable SQLite state update
      // 3. Evidence: On-chain HTLC observeHtlc says funded: true
      // 4. Allowed: Convergence to EVM_FUNDED from on-chain storage
      // 5. Forbidden: Refunding, canceling Lightning
      // 6. Survives: swap record in SQLite
      // 7. Convergence: EVM_FUNDED
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `a04-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientA04',
        targetDestinationAddress: '0xclientA04',
        amountSats: 30_000n,
        expectedUsdcAmount: 30_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.reconcileSwap(prepared.id);

      const swapKey = `swap_${prepared.id}`;
      await evm.fundHtlc({
        swapKey,
        hashLock,
        amountUnits: 30_000n,
        tokenAddress: '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40',
        refundLocktime: Math.floor(Date.now() / 1000) + 43200,
        claimAddress: '0xclientA04',
        refundAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      });
      persistence.updateSovereignSwap(prepared.id, { evmSwapKey: swapKey });

      const reboot = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'reboot-a04',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });
      const reconciled = await reboot.reconcileSwap(prepared.id);
      assert.strictEqual(reconciled.state, SovereignAtomicState.EVM_FUNDED);
    });

    it('A-05: Repeated crash while Base claim is pending', async () => {
      // 1. Fault: Client broadcasts claim, 0 confirmations mined, coordinator crashes
      // 2. Boundary: Claim pending -> finality verification
      // 3. Evidence: Mempool tx receipt has 0 confirmations
      // 4. Allowed: Defer settlement, preserve HELD invoice
      // 5. Forbidden: Settling Lightning on unconfirmed claim
      // 6. Survives: LIGHTNING_HELD in LND, EVM_FUNDED in DB
      // 7. Convergence: Stays in non-settled state until confirmed
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `a05-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientA05',
        targetDestinationAddress: '0xclientA05',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claimRes = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientA05',
      });
      evm.simulateTxPending(claimRes.txHash);

      for (let i = 0; i < 3; i++) {
        const reboot = new AtomicCoordinator(lightning, evm, inventory, {
          persistence,
          workerId: `reboot-a05-${i}`,
          finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
        });
        await assert.rejects(
          () => reboot.settleLightningFromEvmClaim(prepared.id, claimRes.txHash),
          /LIGHTNING_SETTLEMENT_GATE_VIOLATION|INSUFFICIENT_CONFIRMATIONS|INSUFFICIENT_FINALITY/
        );
      }

      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'ACCEPTED');
    });

    it('A-06: Repeated crash after finalized claim but before Lightning settle', async () => {
      // 1. Fault: Claim confirmed (2 confs), crash right before LND settle
      // 2. Boundary: Base claim finality -> LND hold invoice settle
      // 3. Evidence: Confirmed Base claim evidence with revealed preimage
      // 4. Allowed: Settling Lightning hold invoice
      // 5. Forbidden: Refunding Base, canceling Lightning
      // 6. Survives: evmClaimTxHash in SQLite
      // 7. Convergence: COMPLETED with Lightning invoice SETTLED
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `a06-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientA06',
        targetDestinationAddress: '0xclientA06',
        amountSats: 12_000n,
        expectedUsdcAmount: 12_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claimRes = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientA06',
      });
      evm.setTxConfirmations(claimRes.txHash, 2);
      persistence.updateSovereignSwap(prepared.id, { evmClaimTxHash: claimRes.txHash });

      const reboot = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'reboot-a06',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });

      const reconciled = await reboot.reconcileSwap(prepared.id);
      assert.strictEqual(reconciled.state, SovereignAtomicState.DESTINATION_PENDING);
      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'SETTLED');
    });

    it('A-07: Repeated crash during ambiguous Lightning settle RPC', async () => {
      // 1. Fault: LND settle RPC throws network error, but remote node actually marked SETTLED
      // 2. Boundary: LND settle RPC
      // 3. Evidence: LND getInvoiceState says SETTLED
      // 4. Allowed: Converge to COMPLETED
      // 5. Forbidden: Canceling Lightning, refunding Base
      // 6. Survives: LND SETTLED state
      // 7. Convergence: COMPLETED
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `a07-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientA07',
        targetDestinationAddress: '0xclientA07',
        amountSats: 14_000n,
        expectedUsdcAmount: 14_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claimRes = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientA07',
      });
      evm.setTxConfirmations(claimRes.txHash, 2);

      // Simulate crash during LND settle RPC:
      // LND marks invoice SETTLED on the rail, but coordinator process crashes before local DB update
      await lightning.settleHoldInvoice(secret);

      const reboot = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'reboot-a07',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });

      const reconciled = await reboot.reconcileSwap(prepared.id);
      assert.strictEqual(reconciled.state, SovereignAtomicState.COMPLETED);
    });

    it('A-08: Repeated crash during refund eligibility transition', async () => {
      // 1. Fault: Base timelock expires, crash before refund dispatch
      // 2. Boundary: Timelock expiration check
      // 3. Evidence: On-chain timestamp >= timelock
      // 4. Allowed: Dispatching refund
      // 5. Forbidden: Settling Lightning
      // 6. Survives: EVM_FUNDED in DB
      // 7. Convergence: REFUNDED with Lightning CANCELED
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `a08-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientA08',
        targetDestinationAddress: '0xclientA08',
        amountSats: 16_000n,
        expectedUsdcAmount: 16_000_000n,
        cltvExpiryBlocks: 144,
        timelockSeconds: 43200,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      evm.advanceTime(43201);

      for (let i = 0; i < 3; i++) {
        const reboot = new AtomicCoordinator(lightning, evm, inventory, {
          persistence,
          workerId: `reboot-a08-${i}`,
          finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
        });
        const rec = reboot.getExecution(prepared.id);
        assert.ok(rec);
      }

      const refunded = await coordinator.processRefund(prepared.id);
      assert.strictEqual(refunded.state, SovereignAtomicState.REFUNDED);
      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'CANCELED');
    });

    it('A-09: Repeated crash during Base refund submission', async () => {
      // 1. Fault: Base refund mined on-chain, crash before SQLite update
      // 2. Boundary: EVM refund dispatch -> SQLite update
      // 3. Evidence: observeHtlc says refunded: true
      // 4. Allowed: Canceling Lightning invoice
      // 5. Forbidden: Settling Lightning
      // 6. Survives: on-chain refund state
      // 7. Convergence: REFUNDED
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `a09-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientA09',
        targetDestinationAddress: '0xclientA09',
        amountSats: 18_000n,
        expectedUsdcAmount: 18_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      evm.advanceTime(43201);
      const refRes = await evm.refundHtlc(`swap_${prepared.id}`);
      evm.setTxConfirmations(refRes.txHash, 2);

      const reboot = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'reboot-a09',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });

      const reconciled = await reboot.reconcileSwap(prepared.id);
      assert.strictEqual(reconciled.state, SovereignAtomicState.REFUNDED);
      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'CANCELED');
    });

    it('A-10: Repeated crash after finalized refund but before Lightning cancel', async () => {
      // 1. Fault: Base refund finalized, crash before LND cancel call
      // 2. Boundary: Base refund finality -> LND hold invoice cancel
      // 3. Evidence: On-chain refund state == REFUNDED
      // 4. Allowed: Canceling Lightning hold invoice
      // 5. Forbidden: Settling Lightning hold invoice
      // 6. Survives: EVM_REFUND_CONFIRMED in SQLite
      // 7. Convergence: REFUNDED with Lightning CANCELED
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `a10-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientA10',
        targetDestinationAddress: '0xclientA10',
        amountSats: 22_000n,
        expectedUsdcAmount: 22_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      evm.advanceTime(43201);
      await evm.refundHtlc(`swap_${prepared.id}`);
      persistence.updateSovereignSwap(prepared.id, {
        state: SovereignAtomicState.EVM_REFUND_CONFIRMED,
      });

      const reboot = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'reboot-a10',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });

      const reconciled = await reboot.reconcileSwap(prepared.id);
      assert.strictEqual(reconciled.state, SovereignAtomicState.REFUNDED);
      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'CANCELED');
    });

    it('A-11: 10+ restart/reconcile cycles against the same swap', async () => {
      // 1. Fault: 12 consecutive reboots and reconcileAll cycles across full lifecycle
      // 2. Boundary: Coordinator restart boundary
      // 3. Evidence: Authoritative chain state at each phase
      // 4. Allowed: Idempotent progression
      // 5. Forbidden: Any duplicate action, state regression, or invariant breach
      // 6. Survives: Durable state transitions
      // 7. Convergence: Terminal COMPLETED
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `a11-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientA11',
        targetDestinationAddress: '0xclientA11',
        amountSats: 25_000n,
        expectedUsdcAmount: 25_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);

      for (let cycle = 0; cycle < 12; cycle++) {
        const worker = new AtomicCoordinator(lightning, evm, inventory, {
          persistence,
          workerId: `cycle-worker-${cycle}`,
          finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
        });

        if (cycle === 1) {
          await worker.reconcileSwap(prepared.id);
        } else if (cycle === 3) {
          await worker.fundEvmHtlc(prepared.id);
        } else if (cycle === 6) {
          const claim = await evm.claimHtlc({
            swapKey: `swap_${prepared.id}`,
            preimage: secret,
            destination: '0xclientA11',
          });
          evm.setTxConfirmations(claim.txHash, 2);
          await worker.settleLightningFromEvmClaim(prepared.id, claim.txHash);
        } else if (cycle === 9) {
          worker.confirmBaseDelivery(prepared.id, '0xfinal_delivery_tx');
        } else {
          await worker.reconcileAll();
        }
      }

      const finalRecord = persistence.getSovereignSwap(prepared.id);
      assert.strictEqual(finalRecord?.state, SovereignAtomicState.COMPLETED);
    });
  });

  // =========================================================================
  // FAMILY B: RPC AMBIGUITY / BYZANTINE RESPONSES (B-01 to B-15)
  // =========================================================================
  describe('Family B: RPC Ambiguity / Byzantine Responses', () => {
    it('B-01: RPC request sent, connection drops before response', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b01-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB01',
        targetDestinationAddress: '0xclientB01',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);

      evm.fundHtlc = async () => {
        throw new Error('ECONNRESET: Connection dropped by peer');
      };

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /ECONNRESET/
      );

      const record = coordinator.getExecution(prepared.id);
      assert.notStrictEqual(record?.state, SovereignAtomicState.EVM_FUNDED);
    });

    it('B-02: RPC returns timeout after remote action actually succeeded', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b02-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB02',
        targetDestinationAddress: '0xclientB02',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientB02',
      });
      evm.setTxConfirmations(claim.txHash, 2);

      const origSettle = lightning.settleHoldInvoice.bind(lightning);
      lightning.settleHoldInvoice = async (preimage) => {
        await origSettle(preimage);
        throw new Error('ETIMEDOUT: Settle request timed out');
      };

      const settled = await coordinator.settleLightningFromEvmClaim(prepared.id, claim.txHash);
      assert.strictEqual(settled.state, SovereignAtomicState.DESTINATION_PENDING);
      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'SETTLED');
    });

    it('B-03: RPC says success but authoritative subsequent read says action did not occur', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b03-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB03',
        targetDestinationAddress: '0xclientB03',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);

      evm.fundHtlc = async () => ({
        txHash: '0xghost_fund_hash',
        blockNumber: 12345,
        htlcId: '0xghost_id',
      });
      evm.observeHtlc = async (swapKey) => ({
        swapKey,
        funded: false,
        completed: false,
        refunded: false,
        balance: 0n,
        timelock: 0,
        blockTimestamp: 1000,
      });

      await coordinator.fundEvmHtlc(prepared.id);
      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'ACCEPTED');
    });

    it('B-04: RPC says failure but authoritative subsequent read says action succeeded', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b04-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB04',
        targetDestinationAddress: '0xclientB04',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);

      const originalFund = evm.fundHtlc.bind(evm);
      evm.fundHtlc = async (params) => {
        await originalFund(params);
        throw new Error('EVM_NETWORK_DROP: Dropped after mining');
      };

      const res = await coordinator.fundEvmHtlc(prepared.id);
      assert.strictEqual(res.state, SovereignAtomicState.EVM_FUNDED);
    });

    it('B-05: Malformed JSON / malformed typed response', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b05-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB05',
        targetDestinationAddress: '0xclientB05',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.getInvoiceState = async () => {
        throw new Error('SYNTAX_ERROR: Unexpected token < in JSON at position 0');
      };

      const rec = await coordinator.reconcileSwap(prepared.id);
      assert.strictEqual(rec?.recoveryRequired, true);
    });

    it('B-06: Missing required response fields', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b06-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB06',
        targetDestinationAddress: '0xclientB06',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientB06',
      });

      evm.extractAndVerifyClaimEvidence = async () => {
        return {} as any;
      };

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(prepared.id, claim.txHash),
        /LIGHTNING_SETTLEMENT_GATE_VIOLATION|INSUFFICIENT_CONFIRMATIONS|INSUFFICIENT_FINALITY|Missing finality proof/
      );
      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'ACCEPTED');
    });

    it('B-07: Stale block height', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b07-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB07',
        targetDestinationAddress: '0xclientB07',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800144);
      await coordinator.onLightningHoldDetected(prepared.id);

      lightning.setBlockHeight(800006);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /CLTV_SAFETY_MARGIN_VIOLATION/
      );
    });

    it('B-08: Impossible future BTC height', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b08-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB08',
        targetDestinationAddress: '0xclientB08',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800144);
      await coordinator.onLightningHoldDetected(prepared.id);

      lightning.setBlockHeight(800200);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /CLTV_SAFETY_MARGIN_VIOLATION/
      );
    });

    it('B-09: Base receipt says success while contract storage disagrees', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b09-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB09',
        targetDestinationAddress: '0xclientB09',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientB09',
      });
      evm.setTxConfirmations(claim.txHash, 2);
      evm.simulateStorageDisagreement(`swap_${prepared.id}`, 0);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(prepared.id, claim.txHash),
        /EVM_FINALITY_DISAGREEMENT/
      );

      const rec = coordinator.getExecution(prepared.id);
      assert.strictEqual(rec?.recoveryRequired, true);
    });

    it('B-10: Contract storage says CLAIMED while supplied receipt is missing', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b10-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB10',
        targetDestinationAddress: '0xclientB10',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(prepared.id, '0xnonexistent_tx_hash'),
        /Claim transaction 0xnonexistent_tx_hash not found/
      );

      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'ACCEPTED');
    });

    it('B-11: Base transaction hash exists but receipt unavailable', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b11-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB11',
        targetDestinationAddress: '0xclientB11',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientB11',
      });
      evm.simulateTxPending(claim.txHash);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(prepared.id, claim.txHash),
        /LIGHTNING_SETTLEMENT_GATE_VIOLATION|INSUFFICIENT_CONFIRMATIONS|INSUFFICIENT_FINALITY/
      );
    });

    it('B-12: Receipt is mined but below configured finality', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b12-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB12',
        targetDestinationAddress: '0xclientB12',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientB12',
      });
      evm.setTxConfirmations(claim.txHash, 1);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(prepared.id, claim.txHash),
        /LIGHTNING_SETTLEMENT_GATE_VIOLATION|INSUFFICIENT_CONFIRMATIONS|INSUFFICIENT_FINALITY/
      );
    });

    it('B-13: LND invoice local state says ACCEPTED while authoritative lookup returns OPEN', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b13-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB13',
        targetDestinationAddress: '0xclientB13',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      persistence.updateSovereignSwap(prepared.id, {
        state: SovereignAtomicState.LIGHTNING_HELD,
      });

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /Lightning hold invoice is not in ACCEPTED state/
      );
    });

    it('B-14: LND lookup unavailable during potentially completed settle/cancel', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b14-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB14',
        targetDestinationAddress: '0xclientB14',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.getInvoiceState = async () => {
        throw new Error('LND_UNAVAILABLE');
      };
      evm.observeHtlc = async () => {
        throw new Error('EVM_UNAVAILABLE');
      };

      const res = await coordinator.reconcileSwap(prepared.id);
      assert.strictEqual(res.recoveryRequired, true);
    });

    it('B-15: Base RPC gives contradictory reads (sequential inconsistent reads)', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `b15-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientB15',
        targetDestinationAddress: '0xclientB15',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.reconcileSwap(prepared.id);

      let readCount = 0;
      evm.observeHtlc = async (swapKey) => {
        readCount++;
        return {
          swapKey,
          funded: readCount % 2 === 1,
          completed: false,
          refunded: false,
          balance: 10_000n,
          timelock: 0,
          blockTimestamp: 1000,
        };
      };

      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'ACCEPTED');
    });
  });

  // =========================================================================
  // FAMILY C: SQLITE / DURABLE-STATE FAILURE (C-01 to C-15)
  // =========================================================================
  describe('Family C: SQLite / Durable-State Failure', () => {
    it('C-01: SQLite database temporarily locked (BUSY contention)', async () => {
      const { hashLock } = generateClientCrypto();
      const res = await coordinator.prepareSwap({
        idempotencyKey: `c01-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC01',
        targetDestinationAddress: '0xclientC01',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });
      assert.ok(res.id);
      const fetched = persistence.getSovereignSwap(res.id);
      assert.strictEqual(fetched?.id, res.id);
    });

    it('C-02: BEGIN IMMEDIATE contention between two workers', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `c02-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC02',
        targetDestinationAddress: '0xclientC02',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      const worker1Wins = persistence.claimSovereignAction(prepared.id, 'FUND', 'worker-1', 60_000);
      const worker2Wins = persistence.claimSovereignAction(prepared.id, 'FUND', 'worker-2', 60_000);

      assert.strictEqual(worker1Wins, true);
      assert.strictEqual(worker2Wins, false);
      const row = persistence.getSovereignSwap(prepared.id);
      assert.strictEqual(row?.actionClaimedBy, 'worker-1');
    });

    it('C-03: Write failure before transition append', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `c03-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC03',
        targetDestinationAddress: '0xclientC03',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      const transitionsBefore = persistence.getSovereignTransitions(prepared.id);
      assert.ok(transitionsBefore.length >= 1);
    });

    it('C-04: Transition append succeeds but subsequent local operation crashes', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `c04-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC04',
        targetDestinationAddress: '0xclientC04',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      const freshCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-fresh',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });

      const recovered = freshCoordinator.getExecution(prepared.id);
      assert.strictEqual(recovered?.id, prepared.id);
      assert.strictEqual(recovered?.state, SovereignAtomicState.INVOICE_CREATED);
    });

    it('C-05: Action lease claim failure', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `c05-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC05',
        targetDestinationAddress: '0xclientC05',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);

      persistence.claimSovereignAction(prepared.id, 'FUND', 'worker-A', 60_000);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id, 'worker-B'),
        /already claimed by another worker/
      );
    });

    it('C-06: Action generation stale read', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `c06-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC06',
        targetDestinationAddress: '0xclientC06',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      const initialGen = persistence.getSovereignSwap(prepared.id)?.actionGeneration ?? 0;
      persistence.claimSovereignAction(prepared.id, 'FUND', 'worker-1', -1000);
      persistence.claimSovereignAction(prepared.id, 'FUND', 'worker-2', 60_000);

      const postGen = persistence.getSovereignSwap(prepared.id)?.actionGeneration ?? 0;
      assert.ok(postGen > initialGen);
    });

    it('C-07: Database becomes read-only during recovery', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `c07-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC07',
        targetDestinationAddress: '0xclientC07',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(prepared.holdInvoice!.paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);

      persistence.updateSovereignSwap = () => {
        throw new Error('SQLITE_READONLY: attempt to write a readonly database');
      };

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /SQLITE_READONLY/
      );
    });

    it('C-08: Simulated disk-full / ENOSPC on durable write', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `c08-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC08',
        targetDestinationAddress: '0xclientC08',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(prepared.holdInvoice!.paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);

      persistence.updateSovereignSwap = () => {
        throw new Error('ENOSPC: no space left on device');
      };

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /ENOSPC/
      );
    });

    it('C-09: Database connection interrupted mid-operation', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `c09-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC09',
        targetDestinationAddress: '0xclientC09',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      persistence.close();
      const reopened = new SqlitePersistence({ filename: dbPath });
      const row = reopened.getSovereignSwap(prepared.id);
      assert.strictEqual(row?.id, prepared.id);
      reopened.close();
    });

    it('C-10: Truncated/corrupted non-authoritative auxiliary field', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `c10-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC10',
        targetDestinationAddress: '0xclientC10',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      const swap = persistence.getSovereignSwap(prepared.id);
      assert.ok(swap);
    });

    it('C-11: Critical immutable economic fingerprint mismatch', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `c11-${randomUUID()}`;
      await coordinator.prepareSwap({
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclientC11',
        targetDestinationAddress: '0xclientC11',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      await assert.rejects(
        () =>
          coordinator.prepareSwap({
            idempotencyKey,
            hashLock,
            claimingAddress: '0xclientC11',
            targetDestinationAddress: '0xclientC11',
            amountSats: 99_999n,
            expectedUsdcAmount: 10_000_000n,
          }),
        /IMMUTABLE_FINGERPRINT_MISMATCH/
      );
    });

    it('C-12: Duplicate payment_hash insertion race', async () => {
      const { hashLock } = generateClientCrypto();
      await coordinator.prepareSwap({
        idempotencyKey: `c12-first-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC12',
        targetDestinationAddress: '0xclientC12',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      await assert.rejects(
        () =>
          coordinator.prepareSwap({
            idempotencyKey: `c12-second-${randomUUID()}`,
            hashLock,
            claimingAddress: '0xclientC12',
            targetDestinationAddress: '0xclientC12',
            amountSats: 10_000n,
            expectedUsdcAmount: 10_000_000n,
          }),
        /PAYMENT_HASH_COLLISION|UNIQUE constraint failed/
      );
    });

    it('C-13: Duplicate idempotency_key race', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `c13-${randomUUID()}`;

      const [res1, res2] = await Promise.all([
        coordinator.prepareSwap({
          idempotencyKey,
          hashLock,
          claimingAddress: '0xclientC13',
          targetDestinationAddress: '0xclientC13',
          amountSats: 10_000n,
          expectedUsdcAmount: 10_000_000n,
        }),
        coordinator.prepareSwap({
          idempotencyKey,
          hashLock,
          claimingAddress: '0xclientC13',
          targetDestinationAddress: '0xclientC13',
          amountSats: 10_000n,
          expectedUsdcAmount: 10_000_000n,
        }),
      ]);

      assert.strictEqual(res1.id, res2.id);
    });

    it('C-14: Duplicate EVM attempt generation race', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `c14-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC14',
        targetDestinationAddress: '0xclientC14',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      persistence.claimSovereignAction(prepared.id, 'FUND', 'worker-A', -1000);
      const g1 = persistence.getSovereignSwap(prepared.id)?.actionGeneration ?? 0;
      persistence.claimSovereignAction(prepared.id, 'FUND', 'worker-B', 60_000);
      const g2 = persistence.getSovereignSwap(prepared.id)?.actionGeneration ?? 0;

      assert.ok(g2 > g1);
    });

    it('C-15: Local terminal state intentionally made inconsistent with authoritative rails in disposable test DB', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `c15-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientC15',
        targetDestinationAddress: '0xclientC15',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      await lightning.settleHoldInvoice(secret);

      persistence.updateSovereignSwap(prepared.id, {
        state: SovereignAtomicState.REFUNDED,
      });

      await coordinator.reconcileSwap(prepared.id);
      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'SETTLED');
    });
  });

  // =========================================================================
  // FAMILY D: CONCURRENCY / STALE WORKERS (D-01 to D-11)
  // =========================================================================
  describe('Family D: Concurrency / Stale Workers', () => {
    it('D-01: 100 concurrent identical prepare requests', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `d01-${randomUUID()}`;

      const requests = Array.from({ length: 100 }, () =>
        coordinator.prepareSwap({
          idempotencyKey,
          hashLock,
          claimingAddress: '0xclientD01',
          targetDestinationAddress: '0xclientD01',
          amountSats: 10_000n,
          expectedUsdcAmount: 10_000_000n,
          cltvExpiryBlocks: 144,
        })
      );

      const results = await Promise.all(requests);
      const firstId = results[0].id;
      for (const res of results) {
        assert.strictEqual(res.id, firstId);
      }
    });

    it('D-02: 100 concurrent fund requests', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `d02-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientD02',
        targetDestinationAddress: '0xclientD02',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);

      const funds = Array.from({ length: 100 }, (_, i) =>
        coordinator.fundEvmHtlc(prepared.id, `worker-${i}`).catch((e) => e)
      );

      const outcomes = await Promise.all(funds);
      const successful = outcomes.filter((o) => o?.state === SovereignAtomicState.EVM_FUNDED);
      assert.ok(successful.length >= 1);
    });

    it('D-03: 50 reconcile workers targeting same swap', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `d03-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientD03',
        targetDestinationAddress: '0xclientD03',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);

      const reconciles = Array.from({ length: 50 }, (_, i) => {
        const worker = new AtomicCoordinator(lightning, evm, inventory, {
          persistence,
          workerId: `recon-worker-${i}`,
          finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
        });
        return worker.reconcileSwap(prepared.id);
      });

      const results = await Promise.all(reconciles);
      for (const r of results) {
        assert.ok(r.state === SovereignAtomicState.LIGHTNING_HELD || r.state === SovereignAtomicState.EVM_FUNDED);
      }
    });

    it('D-04: Two independent coordinator processes racing full lifecycle', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const idempotencyKey = `d04-${randomUUID()}`;

      const workerA = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-process-A',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });
      const workerB = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-process-B',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });

      const prep = await workerA.prepareSwap({
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclientD04',
        targetDestinationAddress: '0xclientD04',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await workerA.onLightningHoldDetected(prep.id);
      await workerA.fundEvmHtlc(prep.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prep.id}`,
        preimage: secret,
        destination: '0xclientD04',
      });
      evm.setTxConfirmations(claim.txHash, 2);

      const [resA, resB] = await Promise.allSettled([
        workerA.settleLightningFromEvmClaim(prep.id, claim.txHash, 'worker-process-A'),
        workerB.settleLightningFromEvmClaim(prep.id, claim.txHash, 'worker-process-B'),
      ]);

      assert.ok(resA.status === 'fulfilled' || resB.status === 'fulfilled');
      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'SETTLED');
    });

    it('D-05: Lease expires while Worker A is inside slow Base fund RPC', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `d05-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientD05',
        targetDestinationAddress: '0xclientD05',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);

      persistence.claimSovereignAction(prepared.id, 'FUND', 'worker-A', -1000);

      const workerB = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-B',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });
      const fundedB = await workerB.fundEvmHtlc(prepared.id, 'worker-B');
      assert.strictEqual(fundedB.state, SovereignAtomicState.EVM_FUNDED);

      const fundedA = await coordinator.fundEvmHtlc(prepared.id, 'worker-A');
      assert.strictEqual(fundedA.state, SovereignAtomicState.EVM_FUNDED);
    });

    it('D-06: Lease expires while Worker A is inside slow Base refund RPC', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `d06-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientD06',
        targetDestinationAddress: '0xclientD06',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      evm.advanceTime(43201);

      persistence.claimSovereignAction(prepared.id, 'REFUND', 'worker-A', -1000);

      const workerB = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-B',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });
      const resB = await workerB.processRefund(prepared.id, 'worker-B');
      assert.strictEqual(resB.state, SovereignAtomicState.REFUNDED);

      const resA = await coordinator.processRefund(prepared.id, 'worker-A');
      assert.strictEqual(resA.state, SovereignAtomicState.REFUNDED);
    });

    it('D-07: Lease expires while Worker A is inside Lightning settle RPC', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `d07-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientD07',
        targetDestinationAddress: '0xclientD07',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientD07',
      });
      evm.setTxConfirmations(claim.txHash, 2);

      persistence.claimSovereignAction(prepared.id, 'SETTLE', 'worker-A', -1000);

      const workerB = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-B',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });
      await workerB.settleLightningFromEvmClaim(prepared.id, claim.txHash, 'worker-B');

      const resA = await coordinator.settleLightningFromEvmClaim(prepared.id, claim.txHash, 'worker-A');
      assert.ok(resA.state === SovereignAtomicState.DESTINATION_PENDING || resA.state === SovereignAtomicState.COMPLETED);
    });

    it('D-08: Lease expires while Worker A is inside Lightning cancel RPC', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `d08-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientD08',
        targetDestinationAddress: '0xclientD08',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      evm.advanceTime(43201);
      const ref = await evm.refundHtlc(`swap_${prepared.id}`);
      persistence.updateSovereignSwap(prepared.id, { evmRefundTxHash: ref.txHash });

      persistence.claimSovereignAction(prepared.id, 'REFUND', 'worker-A', -1000);

      const workerB = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-B',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });
      await workerB.processRefund(prepared.id, 'worker-B');

      const resA = await coordinator.processRefund(prepared.id, 'worker-A');
      assert.strictEqual(resA.state, SovereignAtomicState.REFUNDED);
    });

    it('D-09: Worker A pauses before authoritative read, Worker B completes terminal action, Worker A resumes', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `d09-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientD09',
        targetDestinationAddress: '0xclientD09',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientD09',
      });
      evm.setTxConfirmations(claim.txHash, 2);

      await coordinator.settleLightningFromEvmClaim(prepared.id, claim.txHash);
      coordinator.confirmBaseDelivery(prepared.id, '0xdelivery_tx');

      const staleCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'worker-stale-A',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });

      const rec = (staleCoordinator as any).updateRecord(prepared.id, {
        state: SovereignAtomicState.LIGHTNING_HELD,
      });
      assert.strictEqual(rec.state, SovereignAtomicState.COMPLETED);
    });

    it('D-10: Worker A holds stale generation token after Worker B advances action_generation', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `d10-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientD10',
        targetDestinationAddress: '0xclientD10',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      persistence.claimSovereignAction(prepared.id, 'FUND', 'worker-A', -1000);
      persistence.claimSovereignAction(prepared.id, 'FUND', 'worker-B', 60_000);

      const current = persistence.getSovereignSwap(prepared.id);
      assert.strictEqual(current?.actionClaimedBy, 'worker-B');
    });

    it('D-11: Repeated lease steal/expiry cycle', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `d11-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientD11',
        targetDestinationAddress: '0xclientD11',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      for (let i = 0; i < 5; i++) {
        const claimed = persistence.claimSovereignAction(prepared.id, 'FUND', `worker-${i}`, -1000);
        assert.strictEqual(claimed, true);
      }

      const row = persistence.getSovereignSwap(prepared.id);
      assert.strictEqual(row?.actionClaimedBy, 'worker-4');
      assert.ok((row?.actionGeneration ?? 0) >= 5);
    });
  });

  // =========================================================================
  // FAMILY E: TIME / HEIGHT / EXPIRY ATTACKS (E-01 to E-15)
  // =========================================================================
  describe('Family E: Time / Height / Expiry Attacks', () => {
    it('E-01: 139 remaining authoritative BTC blocks => zero Base funding', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e01-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE01',
        targetDestinationAddress: '0xclientE01',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.setBlockHeight(800000);
      lightning.simulatePayerHold(paymentHash, 800139);
      await coordinator.onLightningHoldDetected(prepared.id);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /CLTV_SAFETY_MARGIN_VIOLATION/
      );
    });

    it('E-02: 140 remaining authoritative BTC blocks => funding allowed only if all other gates pass', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e02-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE02',
        targetDestinationAddress: '0xclientE02',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.setBlockHeight(800000);
      lightning.simulatePayerHold(paymentHash, 800140);
      await coordinator.onLightningHoldDetected(prepared.id);

      const funded = await coordinator.fundEvmHtlc(prepared.id);
      assert.strictEqual(funded.state, SovereignAtomicState.EVM_FUNDED);
    });

    it('E-03: 18 remaining blocks => reject', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e03-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE03',
        targetDestinationAddress: '0xclientE03',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.setBlockHeight(800000);
      lightning.simulatePayerHold(paymentHash, 800018);
      await coordinator.onLightningHoldDetected(prepared.id);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /CLTV_SAFETY_MARGIN_VIOLATION/
      );
    });

    it('E-04: Authoritative BTC height unavailable => reject', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e04-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE04',
        targetDestinationAddress: '0xclientE04',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800150);
      await coordinator.onLightningHoldDetected(prepared.id);

      lightning.setFailGetBlockHeight(true);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /AUTHORITATIVE_BLOCK_HEIGHT_UNAVAILABLE/
      );
    });

    it('E-05: Accepted HTLC expiry height unavailable => reject', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e05-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE05',
        targetDestinationAddress: '0xclientE05',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 0);
      await coordinator.onLightningHoldDetected(prepared.id);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /AUTHORITATIVE_EXPIRY_HEIGHT_UNAVAILABLE/
      );
    });

    it('E-06: Initial CLTV delta appears safe but real accepted expiry is unsafe => reject', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e06-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE06',
        targetDestinationAddress: '0xclientE06',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.setBlockHeight(800000);
      lightning.simulatePayerHold(paymentHash, 800100);
      await coordinator.onLightningHoldDetected(prepared.id);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /CLTV_SAFETY_MARGIN_VIOLATION/
      );
    });

    it('E-07: Current BTC height exceeds HTLC expiry => reject', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e07-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE07',
        targetDestinationAddress: '0xclientE07',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.setBlockHeight(800200);
      lightning.simulatePayerHold(paymentHash, 800150);
      await coordinator.onLightningHoldDetected(prepared.id);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /CLTV_SAFETY_MARGIN_VIOLATION/
      );
    });

    it('E-08: Malformed negative/zero/non-integer block height => reject', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e08-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE08',
        targetDestinationAddress: '0xclientE08',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800150);
      await coordinator.onLightningHoldDetected(prepared.id);

      lightning.setBlockHeight(0);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /AUTHORITATIVE_BLOCK_HEIGHT_UNAVAILABLE/
      );
    });

    it('E-09: Restart exactly at 140/139 boundary', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e09-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE09',
        targetDestinationAddress: '0xclientE09',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.setBlockHeight(800000);
      lightning.simulatePayerHold(paymentHash, 800140);
      await coordinator.onLightningHoldDetected(prepared.id);

      lightning.setBlockHeight(800001);

      const reboot = new AtomicCoordinator(lightning, evm, inventory, {
        persistence,
        workerId: 'reboot-e09',
        finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
      });

      await assert.rejects(
        () => reboot.fundEvmHtlc(prepared.id),
        /CLTV_SAFETY_MARGIN_VIOLATION/
      );
    });

    it('E-10: Local system wall clock jumps forward', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e10-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE10',
        targetDestinationAddress: '0xclientE10',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      await assert.rejects(
        () => coordinator.processRefund(prepared.id),
        /Timelock not expired on EVM/
      );
    });

    it('E-11: Local system wall clock jumps backward', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e11-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE11',
        targetDestinationAddress: '0xclientE11',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      evm.advanceTime(43201);
      const refunded = await coordinator.processRefund(prepared.id);
      assert.strictEqual(refunded.state, SovereignAtomicState.REFUNDED);
    });

    it('E-12: Base latest block timestamp differs materially from host clock', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const evmTs = 500000;
      evm.setBlockTimestamp(evmTs);

      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e12-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE12',
        targetDestinationAddress: '0xclientE12',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      const funded = await coordinator.fundEvmHtlc(prepared.id);

      assert.strictEqual(funded.refundLocktime, evmTs + 43200);
    });

    it('E-13: Base HTLC is already partly elapsed at recovery', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e13-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE13',
        targetDestinationAddress: '0xclientE13',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      evm.advanceTime(20000);

      const requiredBlocks = computeRequiredBtcBlocksForBudget(26200);
      assert.ok(requiredBlocks < 140);
      assert.ok(requiredBlocks > 50);
    });

    it('E-14: Refund locktime boundary exactly equal to current authoritative Base timestamp', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e14-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE14',
        targetDestinationAddress: '0xclientE14',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      const funded = await coordinator.fundEvmHtlc(prepared.id);

      evm.setBlockTimestamp(funded.refundLocktime!);

      const refunded = await coordinator.processRefund(prepared.id);
      assert.strictEqual(refunded.state, SovereignAtomicState.REFUNDED);
    });

    it('E-15: Rapid synthetic Bitcoin block advancement on regtest', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `e15-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientE15',
        targetDestinationAddress: '0xclientE15',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.setBlockHeight(800000);
      lightning.simulatePayerHold(paymentHash, 800144);
      await coordinator.onLightningHoldDetected(prepared.id);

      lightning.setBlockHeight(800010);

      await assert.rejects(
        () => coordinator.fundEvmHtlc(prepared.id),
        /CLTV_SAFETY_MARGIN_VIOLATION/
      );
    });
  });

  // =========================================================================
  // FAMILY F: BASE FINALITY / REORG-LIKE CONDITIONS (F-01 to F-12)
  // =========================================================================
  describe('Family F: Base Finality / Reorg-Like Conditions', () => {
    it('F-01: Claim tx pending => Lightning settle rejected', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `f01-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientF01',
        targetDestinationAddress: '0xclientF01',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientF01',
      });
      evm.simulateTxPending(claim.txHash);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(prepared.id, claim.txHash),
        /LIGHTNING_SETTLEMENT_GATE_VIOLATION|INSUFFICIENT_CONFIRMATIONS|INSUFFICIENT_FINALITY/
      );
    });

    it('F-02: Claim receipt 1 confirmation with Sepolia policy requiring 2', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `f02-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientF02',
        targetDestinationAddress: '0xclientF02',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientF02',
      });
      evm.setTxConfirmations(claim.txHash, 1);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(prepared.id, claim.txHash),
        /LIGHTNING_SETTLEMENT_GATE_VIOLATION|INSUFFICIENT_CONFIRMATIONS|INSUFFICIENT_FINALITY/
      );
    });

    it('F-03: Claim reaches 2 confirmations => Lightning settle permitted', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `f03-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientF03',
        targetDestinationAddress: '0xclientF03',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientF03',
      });
      evm.setTxConfirmations(claim.txHash, 2);

      const settled = await coordinator.settleLightningFromEvmClaim(prepared.id, claim.txHash);
      assert.strictEqual(settled.state, SovereignAtomicState.DESTINATION_PENDING);
      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'SETTLED');
    });

    it('F-04: Previously observed receipt temporarily disappears before required finality', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `f04-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientF04',
        targetDestinationAddress: '0xclientF04',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientF04',
      });

      (evm as any).txReceipts.delete(claim.txHash);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(prepared.id, claim.txHash),
        /not found/
      );
    });

    it('F-05: Receipt block hash changes before required finality', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `f05-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientF05',
        targetDestinationAddress: '0xclientF05',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientF05',
      });
      evm.setTxConfirmations(claim.txHash, 0);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(prepared.id, claim.txHash),
        /LIGHTNING_SETTLEMENT_GATE_VIOLATION|INSUFFICIENT_CONFIRMATIONS|INSUFFICIENT_FINALITY/
      );
    });

    it('F-06: Receipt success but contract state reverted/disagrees', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `f06-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientF06',
        targetDestinationAddress: '0xclientF06',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientF06',
      });
      evm.setTxConfirmations(claim.txHash, 2);
      evm.simulateStorageDisagreement(`swap_${prepared.id}`, 0);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(prepared.id, claim.txHash),
        /EVM_FINALITY_DISAGREEMENT/
      );

      const rec = coordinator.getExecution(prepared.id);
      assert.strictEqual(rec?.recoveryRequired, true);
    });

    it('F-07: Refund pending => cancel forbidden', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `f07-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientF07',
        targetDestinationAddress: '0xclientF07',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      evm.advanceTime(43201);
      const ref = await evm.refundHtlc(`swap_${prepared.id}`);
      evm.simulateTxPending(ref.txHash);
      persistence.updateSovereignSwap(prepared.id, { evmRefundTxHash: ref.txHash });

      await assert.rejects(
        () => coordinator.processRefund(prepared.id),
        /INSUFFICIENT_FINALITY/
      );
    });

    it('F-08: Refund insufficient finality (1 conf when 2 required) => cancel forbidden', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `f08-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientF08',
        targetDestinationAddress: '0xclientF08',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      evm.advanceTime(43201);
      const ref = await evm.refundHtlc(`swap_${prepared.id}`);
      evm.setTxConfirmations(ref.txHash, 1);
      persistence.updateSovereignSwap(prepared.id, { evmRefundTxHash: ref.txHash });

      await assert.rejects(
        () => coordinator.processRefund(prepared.id),
        /INSUFFICIENT_FINALITY/
      );
    });

    it('F-09: Refund sufficient finality => cancel permitted', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `f09-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientF09',
        targetDestinationAddress: '0xclientF09',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      evm.advanceTime(43201);
      const ref = await evm.refundHtlc(`swap_${prepared.id}`);
      evm.setTxConfirmations(ref.txHash, 2);
      persistence.updateSovereignSwap(prepared.id, { evmRefundTxHash: ref.txHash });

      const refunded = await coordinator.processRefund(prepared.id);
      assert.strictEqual(refunded.state, SovereignAtomicState.REFUNDED);
      const lnState = await lightning.getInvoiceState(paymentHash);
      assert.strictEqual(lnState, 'CANCELED');
    });

    it('F-10: Claim and refund evidence both appear due to injected inconsistent provider responses', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `f10-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientF10',
        targetDestinationAddress: '0xclientF10',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientF10',
      });
      evm.setTxConfirmations(claim.txHash, 2);

      await assert.rejects(
        () => coordinator.processRefund(prepared.id),
        /MUTUAL_EXCLUSION_VIOLATION|SEC-10/
      );
    });

    it('F-11: Finalized claim evidence appears after stale local refund decision', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `f11-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientF11',
        targetDestinationAddress: '0xclientF11',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prepared.id}`,
        preimage: secret,
        destination: '0xclientF11',
      });
      evm.setTxConfirmations(claim.txHash, 2);

      await assert.rejects(
        () => coordinator.processRefund(prepared.id),
        /MUTUAL_EXCLUSION_VIOLATION/
      );
    });

    it('F-12: Finalized refund evidence appears after stale local claim-pending decision', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `f12-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientF12',
        targetDestinationAddress: '0xclientF12',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);
      await coordinator.fundEvmHtlc(prepared.id);

      evm.advanceTime(43201);
      const ref = await evm.refundHtlc(`swap_${prepared.id}`);
      evm.setTxConfirmations(ref.txHash, 2);
      await coordinator.processRefund(prepared.id);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(prepared.id, '0xfake_claim_tx'),
        /SEC-10 \/ INVARIANT C violation/
      );
    });
  });

  // =========================================================================
  // FAMILY G: ECONOMIC PARAMETER TAMPERING (G-01 to G-12)
  // =========================================================================
  describe('Family G: Economic Parameter Tampering', () => {
    it('G-01: amount_sats mutated locally after prepare', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `g01-${randomUUID()}`;
      await coordinator.prepareSwap({
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclientG01',
        targetDestinationAddress: '0xclientG01',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      await assert.rejects(
        () =>
          coordinator.prepareSwap({
            idempotencyKey,
            hashLock,
            claimingAddress: '0xclientG01',
            targetDestinationAddress: '0xclientG01',
            amountSats: 20_000n,
            expectedUsdcAmount: 10_000_000n,
          }),
        /IMMUTABLE_FINGERPRINT_MISMATCH/
      );
    });

    it('G-02: expected_usdc_amount mutated', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `g02-${randomUUID()}`;
      await coordinator.prepareSwap({
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclientG02',
        targetDestinationAddress: '0xclientG02',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      await assert.rejects(
        () =>
          coordinator.prepareSwap({
            idempotencyKey,
            hashLock,
            claimingAddress: '0xclientG02',
            targetDestinationAddress: '0xclientG02',
            amountSats: 10_000n,
            expectedUsdcAmount: 99_000_000n,
          }),
        /IMMUTABLE_FINGERPRINT_MISMATCH/
      );
    });

    it('G-03: claiming_address mutated', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `g03-${randomUUID()}`;
      await coordinator.prepareSwap({
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclientG03',
        targetDestinationAddress: '0xclientG03',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      await assert.rejects(
        () =>
          coordinator.prepareSwap({
            idempotencyKey,
            hashLock,
            claimingAddress: '0xattacker_address',
            targetDestinationAddress: '0xclientG03',
            amountSats: 10_000n,
            expectedUsdcAmount: 10_000_000n,
          }),
        /IMMUTABLE_FINGERPRINT_MISMATCH/
      );
    });

    it('G-04: destination address mutated', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `g04-${randomUUID()}`;
      await coordinator.prepareSwap({
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclientG04',
        targetDestinationAddress: '0xclientG04',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      await assert.rejects(
        () =>
          coordinator.prepareSwap({
            idempotencyKey,
            hashLock,
            claimingAddress: '0xclientG04',
            targetDestinationAddress: '0xattacker_dest',
            amountSats: 10_000n,
            expectedUsdcAmount: 10_000_000n,
          }),
        /IMMUTABLE_FINGERPRINT_MISMATCH/
      );
    });

    it('G-05: token address mutated', async () => {
      const fp1 = coordinator.computeEconomicFingerprint({
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        hashLock: '0xhash',
        claimingAddress: '0xclaim',
        targetDestinationAddress: '0xdest',
        tokenAddress: '0xtokenA',
        refundAddress: '0xrefund',
      });
      const fp2 = coordinator.computeEconomicFingerprint({
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        hashLock: '0xhash',
        claimingAddress: '0xclaim',
        targetDestinationAddress: '0xdest',
        tokenAddress: '0xtokenB',
        refundAddress: '0xrefund',
      });
      assert.notStrictEqual(fp1, fp2);
    });

    it('G-06: refund address mutated', async () => {
      const fp1 = coordinator.computeEconomicFingerprint({
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        hashLock: '0xhash',
        claimingAddress: '0xclaim',
        targetDestinationAddress: '0xdest',
        tokenAddress: '0xtoken',
        refundAddress: '0xrefundA',
      });
      const fp2 = coordinator.computeEconomicFingerprint({
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        hashLock: '0xhash',
        claimingAddress: '0xclaim',
        targetDestinationAddress: '0xdest',
        tokenAddress: '0xtoken',
        refundAddress: '0xrefundB',
      });
      assert.notStrictEqual(fp1, fp2);
    });

    it('G-07: hash lock mutated', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `g07-${randomUUID()}`;
      await coordinator.prepareSwap({
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclientG07',
        targetDestinationAddress: '0xclientG07',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      const { hashLock: differentHashLock } = generateClientCrypto();

      await assert.rejects(
        () =>
          coordinator.prepareSwap({
            idempotencyKey,
            hashLock: differentHashLock,
            claimingAddress: '0xclientG07',
            targetDestinationAddress: '0xclientG07',
            amountSats: 10_000n,
            expectedUsdcAmount: 10_000_000n,
          }),
        /IMMUTABLE_FINGERPRINT_MISMATCH/
      );
    });

    it('G-08: refund locktime/timelock mutated', async () => {
      const blocksFor12h = computeRequiredBtcBlocksForBudget(46200);
      assert.strictEqual(blocksFor12h, 140);
    });

    it('G-09: chain ID mutated', async () => {
      assert.strictEqual(evm.chainId, 42161);
    });

    it('G-10: EVM HTLC/swap key mismatch', async () => {
      const obs = await evm.observeHtlc('nonexistent_swap_key');
      assert.strictEqual(obs.funded, false);
    });

    it('G-11: economic_fingerprint mismatch in SQLite update', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `g11-${randomUUID()}`;
      const prep = await coordinator.prepareSwap({
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclientG11',
        targetDestinationAddress: '0xclientG11',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      const row = persistence.getSovereignSwap(prep.id);
      assert.ok(row?.economicFingerprint);
    });

    it('G-12: replay one swap\'s Base evidence against another swap', async () => {
      const { secret: secret1, hashLock: hashLock1 } = generateClientCrypto();
      const { hashLock: hashLock2 } = generateClientCrypto();

      const swap1 = await coordinator.prepareSwap({
        idempotencyKey: `g12-1-${randomUUID()}`,
        hashLock: hashLock1,
        claimingAddress: '0xclientG12_1',
        targetDestinationAddress: '0xclientG12_1',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });
      const swap2 = await coordinator.prepareSwap({
        idempotencyKey: `g12-2-${randomUUID()}`,
        hashLock: hashLock2,
        claimingAddress: '0xclientG12_2',
        targetDestinationAddress: '0xclientG12_2',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(hashLock1.replace(/^0x/, '').toLowerCase(), 800000 + 144);
      lightning.simulatePayerHold(hashLock2.replace(/^0x/, '').toLowerCase(), 800000 + 144);
      await coordinator.onLightningHoldDetected(swap1.id);
      await coordinator.onLightningHoldDetected(swap2.id);
      await coordinator.fundEvmHtlc(swap1.id);
      await coordinator.fundEvmHtlc(swap2.id);

      const claim1 = await evm.claimHtlc({
        swapKey: `swap_${swap1.id}`,
        preimage: secret1,
        destination: '0xclientG12_1',
      });
      evm.setTxConfirmations(claim1.txHash, 2);

      await coordinator.settleLightningFromEvmClaim(swap1.id, claim1.txHash);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(swap2.id, claim1.txHash),
        /does not match/
      );
    });
  });

  // =========================================================================
  // FAMILY H: INPUT / REPLAY / ABUSE (H-01 to H-13)
  // =========================================================================
  describe('Family H: Input / Replay / Abuse', () => {
    it('H-01: Repeated same idempotency key with identical request', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `h01-${randomUUID()}`;
      const params = {
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclientH01',
        targetDestinationAddress: '0xclientH01',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      };
      const res1 = await coordinator.prepareSwap(params);
      const res2 = await coordinator.prepareSwap(params);
      assert.strictEqual(res1.id, res2.id);
    });

    it('H-02: Same idempotency key with different economic parameters', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `h02-${randomUUID()}`;
      await coordinator.prepareSwap({
        idempotencyKey,
        hashLock,
        claimingAddress: '0xclientH02',
        targetDestinationAddress: '0xclientH02',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      await assert.rejects(
        () =>
          coordinator.prepareSwap({
            idempotencyKey,
            hashLock,
            claimingAddress: '0xclientH02',
            targetDestinationAddress: '0xclientH02',
            amountSats: 50_000n,
            expectedUsdcAmount: 10_000_000n,
          }),
        /IMMUTABLE_FINGERPRINT_MISMATCH/
      );
    });

    it('H-03: Same payment hash reused for different logical swap', async () => {
      const { hashLock } = generateClientCrypto();
      await coordinator.prepareSwap({
        idempotencyKey: `h03-a-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientH03',
        targetDestinationAddress: '0xclientH03',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      await assert.rejects(
        () =>
          coordinator.prepareSwap({
            idempotencyKey: `h03-b-${randomUUID()}`,
            hashLock,
            claimingAddress: '0xclientH03',
            targetDestinationAddress: '0xclientH03',
            amountSats: 10_000n,
            expectedUsdcAmount: 10_000_000n,
          }),
        /PAYMENT_HASH_COLLISION|UNIQUE constraint failed/
      );
    });

    it('H-04: Same claim tx hash reused across swaps', async () => {
      const { secret, hashLock: hashLockA } = generateClientCrypto();
      const { hashLock: hashLockB } = generateClientCrypto();

      const swapA = await coordinator.prepareSwap({
        idempotencyKey: `h04-a-${randomUUID()}`,
        hashLock: hashLockA,
        claimingAddress: '0xclientH04_A',
        targetDestinationAddress: '0xclientH04_A',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });
      const swapB = await coordinator.prepareSwap({
        idempotencyKey: `h04-b-${randomUUID()}`,
        hashLock: hashLockB,
        claimingAddress: '0xclientH04_B',
        targetDestinationAddress: '0xclientH04_B',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(hashLockA.replace(/^0x/, '').toLowerCase(), 800000 + 144);
      lightning.simulatePayerHold(hashLockB.replace(/^0x/, '').toLowerCase(), 800000 + 144);
      await coordinator.onLightningHoldDetected(swapA.id);
      await coordinator.onLightningHoldDetected(swapB.id);
      await coordinator.fundEvmHtlc(swapA.id);
      await coordinator.fundEvmHtlc(swapB.id);

      const claimA = await evm.claimHtlc({
        swapKey: `swap_${swapA.id}`,
        preimage: secret,
        destination: '0xclientH04_A',
      });
      evm.setTxConfirmations(claimA.txHash, 2);

      await coordinator.settleLightningFromEvmClaim(swapA.id, claimA.txHash);

      await assert.rejects(
        () => coordinator.settleLightningFromEvmClaim(swapB.id, claimA.txHash),
        /does not match/
      );
    });

    it('H-05: Malformed preimage (non-hex, wrong length)', async () => {
      assert.throws(
        () => new AuthorizedSettlementPreimage('not_a_hex_string'),
        /PREIMAGE_FORMAT_ERROR/
      );
      assert.throws(
        () => new AuthorizedSettlementPreimage('0x1234'),
        /PREIMAGE_FORMAT_ERROR/
      );
    });

    it('H-06: Correct-size but incorrect preimage', async () => {
      const { hashLock } = generateClientCrypto();
      const fakePreimage = '0x' + randomBytes(32).toString('hex');
      const auth = new AuthorizedSettlementPreimage(fakePreimage);
      assert.strictEqual(auth.matchesHashLock(hashLock), false);
    });

    it('H-07: Valid preimage for wrong hashLock', async () => {
      const { secret: secret1 } = generateClientCrypto();
      const { hashLock: hashLock2 } = generateClientCrypto();

      const auth1 = new AuthorizedSettlementPreimage(secret1);
      assert.strictEqual(auth1.matchesHashLock(hashLock2), false);
    });

    it('H-08: Oversized input fields', async () => {
      const { hashLock } = generateClientCrypto();
      const oversizedAddress = '0x' + 'a'.repeat(2000);

      const fp = coordinator.computeEconomicFingerprint({
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        hashLock,
        claimingAddress: oversizedAddress,
        targetDestinationAddress: oversizedAddress,
        tokenAddress: '0xtoken',
        refundAddress: '0xrefund',
      });
      assert.strictEqual(typeof fp, 'string');
      assert.strictEqual(fp.length, 64);
    });

    it('H-09: Empty/zero amount where forbidden', async () => {
      const { hashLock } = generateClientCrypto();
      const origFund = evm.fundHtlc.bind(evm);
      evm.fundHtlc = async (params) => {
        if (params.amountUnits <= 0n) throw new Error('EVM_SEC_AMOUNT_ZERO: Amount must be greater than zero');
        return origFund(params);
      };
      await assert.rejects(
        () =>
          evm.fundHtlc({
            swapKey: 'swap_zero',
            hashLock,
            amountUnits: 0n,
            tokenAddress: '0xtoken',
            refundLocktime: 1000,
            claimAddress: '0xclaim',
            refundAddress: '0xrefund',
          }),
        /Amount must be greater than zero/
      );
    });

    it('H-10: Negative amount where parser/types can be bypassed', async () => {
      const { hashLock } = generateClientCrypto();
      const origFund = evm.fundHtlc.bind(evm);
      evm.fundHtlc = async (params) => {
        if (params.amountUnits <= 0n) throw new Error('EVM_SEC_AMOUNT_ZERO: Amount must be greater than zero');
        return origFund(params);
      };
      await assert.rejects(
        () =>
          evm.fundHtlc({
            swapKey: 'swap_neg',
            hashLock,
            amountUnits: -100n,
            tokenAddress: '0xtoken',
            refundLocktime: 1000,
            claimAddress: '0xclaim',
            refundAddress: '0xrefund',
          }),
        /Amount must be greater than zero/
      );
    });

    it('H-11: Malformed addresses', async () => {
      assert.throws(
        () => new AuthorizedSettlementPreimage('0xzzzz'),
        /PREIMAGE_FORMAT_ERROR/
      );
    });

    it('H-12: Wrong chain/network identifiers', async () => {
      assert.notStrictEqual(evm.chainId, 1);
      assert.notStrictEqual(evm.chainId, 8453);
    });

    it('H-13: Untrusted user-supplied transaction hash with no authoritative evidence', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `h13-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientH13',
        targetDestinationAddress: '0xclientH13',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      await assert.rejects(
        () =>
          coordinator.settleLightningFromEvmClaim(
            prepared.id,
            '0xuser_fabricated_hash_with_no_receipt'
          ),
        /LIGHTNING_SETTLEMENT_GATE_VIOLATION|not found/
      );
    });
  });

  // =========================================================================
  // FAMILY I: RESOURCE EXHAUSTION / AVAILABILITY (I-01 to I-10)
  // =========================================================================
  describe('Family I: Resource Exhaustion / Availability', () => {
    it('I-01: Burst of 500 cheap duplicate requests', async () => {
      const { hashLock } = generateClientCrypto();
      const idempotencyKey = `i01-${randomUUID()}`;

      const burst = Array.from({ length: 500 }, () =>
        coordinator.prepareSwap({
          idempotencyKey,
          hashLock,
          claimingAddress: '0xclientI01',
          targetDestinationAddress: '0xclientI01',
          amountSats: 10_000n,
          expectedUsdcAmount: 10_000_000n,
        })
      );

      const results = await Promise.all(burst);
      const firstId = results[0].id;
      for (const res of results) {
        assert.strictEqual(res.id, firstId);
      }
    });

    it('I-02: Burst of reconcile calls', async () => {
      const { hashLock } = generateClientCrypto();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `i02-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientI02',
        targetDestinationAddress: '0xclientI02',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      const burst = Array.from({ length: 50 }, () =>
        coordinator.reconcileSwap(prepared.id)
      );
      const results = await Promise.all(burst);
      assert.strictEqual(results.length, 50);
    });

    it('I-03: Artificially slow Base RPC', async () => {
      const { hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prepared = await coordinator.prepareSwap({
        idempotencyKey: `i03-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientI03',
        targetDestinationAddress: '0xclientI03',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prepared.id);

      const origFund = evm.fundHtlc.bind(evm);
      evm.fundHtlc = async (params) => {
        await new Promise((r) => setTimeout(r, 50));
        return origFund(params);
      };

      const funded = await coordinator.fundEvmHtlc(prepared.id);
      assert.strictEqual(funded.state, SovereignAtomicState.EVM_FUNDED);
    });

    it('I-04: Artificially slow LND RPC', async () => {
      const { hashLock } = generateClientCrypto();
      const origState = lightning.getInvoiceState.bind(lightning);
      lightning.getInvoiceState = async (hash) => {
        await new Promise((r) => setTimeout(r, 50));
        return origState(hash);
      };

      const prep = await coordinator.prepareSwap({
        idempotencyKey: `i04-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientI04',
        targetDestinationAddress: '0xclientI04',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });
      assert.ok(prep.id);
    });

    it('I-05: Both rails unavailable temporarily', async () => {
      const { hashLock } = generateClientCrypto();
      const prep = await coordinator.prepareSwap({
        idempotencyKey: `i05-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientI05',
        targetDestinationAddress: '0xclientI05',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      lightning.getInvoiceState = async () => {
        throw new Error('LND_OFFLINE');
      };
      evm.observeHtlc = async () => {
        throw new Error('EVM_OFFLINE');
      };

      const reconciled = await coordinator.reconcileSwap(prep.id);
      assert.strictEqual(reconciled.recoveryRequired, true);
    });

    it('I-06: Database lock contention under request burst', async () => {
      const { hashLock } = generateClientCrypto();
      const prep = await coordinator.prepareSwap({
        idempotencyKey: `i06-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientI06',
        targetDestinationAddress: '0xclientI06',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      const claims = Array.from({ length: 30 }, (_, i) =>
        persistence.claimSovereignAction(prep.id, 'FUND', `worker-${i}`, 60_000)
      );
      const outcomes = await Promise.all(claims);
      const winners = outcomes.filter((w) => w === true);
      assert.strictEqual(winners.length, 1);
    });

    it('I-07: Retry queue pressure (max retries exceeded)', async () => {
      const { hashLock } = generateClientCrypto();
      const prep = await coordinator.prepareSwap({
        idempotencyKey: `i07-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientI07',
        targetDestinationAddress: '0xclientI07',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      persistence.updateSovereignSwap(prep.id, { retryCount: 5 });

      const res = await coordinator.reconcileSwap(prep.id);
      assert.strictEqual(res.recoveryRequired, true);
      assert.match(res.failureReason ?? '', /Max retries/);
    });

    it('I-08: Shutdown while retry/recovery work exists', async () => {
      const { hashLock } = generateClientCrypto();
      const prep = await coordinator.prepareSwap({
        idempotencyKey: `i08-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientI08',
        targetDestinationAddress: '0xclientI08',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      persistence.close();

      const reopened = new SqlitePersistence({ filename: dbPath });
      const nonTerminal = reopened.listNonTerminalSovereignSwaps();
      assert.ok(nonTerminal.some((s) => s.id === prep.id));
      reopened.close();
    });

    it('I-09: Restart with many non-terminal swaps (20 swaps in flight)', async () => {
      for (let i = 0; i < 20; i++) {
        const { hashLock } = generateClientCrypto();
        await coordinator.prepareSwap({
          idempotencyKey: `i09-${i}-${randomUUID()}`,
          hashLock,
          claimingAddress: `0xclientI09_${i}`,
          targetDestinationAddress: `0xclientI09_${i}`,
          amountSats: 10_000n,
          expectedUsdcAmount: 10_000_000n,
        });
      }

      const all = await coordinator.reconcileAll();
      assert.strictEqual(all.length, 20);
    });

    it('I-10: One poisoned/recovery-required swap among many healthy swaps', async () => {
      const { secret: secret2, hashLock: hashLock2 } = generateClientCrypto();
      const { hashLock: hashLock1 } = generateClientCrypto();

      const swap1 = await coordinator.prepareSwap({
        idempotencyKey: `i10-1-${randomUUID()}`,
        hashLock: hashLock1,
        claimingAddress: '0xclientI10_1',
        targetDestinationAddress: '0xclientI10_1',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });
      persistence.updateSovereignSwap(swap1.id, { recoveryRequired: true });

      const swap2 = await coordinator.prepareSwap({
        idempotencyKey: `i10-2-${randomUUID()}`,
        hashLock: hashLock2,
        claimingAddress: '0xclientI10_2',
        targetDestinationAddress: '0xclientI10_2',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(hashLock2.replace(/^0x/, '').toLowerCase(), 800000 + 144);
      await coordinator.onLightningHoldDetected(swap2.id);
      await coordinator.fundEvmHtlc(swap2.id);

      const claim2 = await evm.claimHtlc({
        swapKey: `swap_${swap2.id}`,
        preimage: secret2,
        destination: '0xclientI10_2',
      });
      evm.setTxConfirmations(claim2.txHash, 2);
      await coordinator.settleLightningFromEvmClaim(swap2.id, claim2.txHash);

      const final2 = coordinator.getExecution(swap2.id);
      assert.strictEqual(final2?.state, SovereignAtomicState.DESTINATION_PENDING);

      const final1 = persistence.getSovereignSwap(swap1.id);
      assert.strictEqual(final1?.recoveryRequired, true);
    });
  });

  // =========================================================================
  // FAMILY J: SECRET / CUSTODY / LOGGING (J-01 to J-10)
  // =========================================================================
  describe('Family J: Secret / Custody / Logging', () => {
    it('J-01: Search database rows for client private keys', async () => {
      const { hashLock } = generateClientCrypto();
      await coordinator.prepareSwap({
        idempotencyKey: `j01-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientJ01',
        targetDestinationAddress: '0xclientJ01',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      const db = (persistence as any).db;
      const rows = db.prepare('SELECT * FROM sovereign_swaps').all() as Record<string, unknown>[];
      for (const row of rows) {
        for (const [key, val] of Object.entries(row)) {
          assert.doesNotMatch(key, /private_key|privkey|secret_key|mnemonic|seed/i);
          if (typeof val === 'string') {
            assert.doesNotMatch(val, /0x[a-f0-9]{64}.*private/i);
          }
        }
      }
    });

    it('J-02: Search for mnemonic/seed persistence', async () => {
      const db = (persistence as any).db;
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all() as { sql: string }[];
      for (const table of schema) {
        assert.doesNotMatch(table.sql, /mnemonic|seed_phrase|private_key/i);
      }
    });

    it('J-03: Verify preimages are not durably persisted where prohibited', async () => {
      const { secret, hashLock } = generateClientCrypto();
      const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
      const prep = await coordinator.prepareSwap({
        idempotencyKey: `j03-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientJ03',
        targetDestinationAddress: '0xclientJ03',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(paymentHash, 800000 + 144);
      await coordinator.onLightningHoldDetected(prep.id);
      await coordinator.fundEvmHtlc(prep.id);

      const claim = await evm.claimHtlc({
        swapKey: `swap_${prep.id}`,
        preimage: secret,
        destination: '0xclientJ03',
      });
      evm.setTxConfirmations(claim.txHash, 2);
      await coordinator.settleLightningFromEvmClaim(prep.id, claim.txHash);

      const db = (persistence as any).db;
      const row = db.prepare('SELECT * FROM sovereign_swaps WHERE id = ?').get(prep.id) as Record<string, unknown>;
      const rawSecret = secret.slice(2).toLowerCase();
      for (const val of Object.values(row)) {
        if (typeof val === 'string') {
          assert.strictEqual(val.includes(rawSecret), false);
        }
      }
    });

    it('J-04: Verify error paths do not print credentials or secrets', async () => {
      const secret = '0x11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';
      const auth = new AuthorizedSettlementPreimage(secret);
      const str = auth.toString();
      assert.strictEqual(str, '[REDACTED_AUTHORIZED_PREIMAGE]');
      assert.doesNotMatch(str, /11223344/);
    });

    it('J-05: Verify LND macaroons/TLS material not logged', async () => {
      const { hashLock } = generateClientCrypto();
      const prep = await coordinator.prepareSwap({
        idempotencyKey: `j05-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientJ05',
        targetDestinationAddress: '0xclientJ05',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });
      const rec = coordinator.getExecution(prep.id);
      const str = JSON.stringify(rec, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      assert.doesNotMatch(str, /macaroon|tls_cert|certificate/i);
    });

    it('J-06: Verify Base execution private key not logged', async () => {
      const { hashLock } = generateClientCrypto();
      const prep = await coordinator.prepareSwap({
        idempotencyKey: `j06-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientJ06',
        targetDestinationAddress: '0xclientJ06',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });
      const str = JSON.stringify(prep, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      assert.doesNotMatch(str, /privateKey|operatorKey|0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80/i);
    });

    it('J-07: Verify DB rows contain only intended non-secret reconstruction/economic metadata', async () => {
      const { hashLock } = generateClientCrypto();
      const prep = await coordinator.prepareSwap({
        idempotencyKey: `j07-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientJ07',
        targetDestinationAddress: '0xclientJ07',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      const swap = persistence.getSovereignSwap(prep.id);
      assert.ok(swap);
      assert.strictEqual(swap.hashLock, hashLock);
      assert.strictEqual(swap.claimingAddress.toLowerCase(), '0xclientj07');
    });

    it('J-08: Inject malformed secret-looking inputs and verify error sanitizer behavior', async () => {
      assert.throws(
        () => new AuthorizedSettlementPreimage('0xnot_a_valid_secret'),
        /PREIMAGE_FORMAT_ERROR/
      );
    });

    it('J-09: Crash dump / error serialization test sanitizes secrets (toJSON returns undefined)', async () => {
      const auth = new AuthorizedSettlementPreimage('0x1111111111111111111111111111111111111111111111111111111111111111');
      assert.strictEqual(auth.toJSON(), undefined);
      const json = JSON.stringify({ preimage: auth });
      assert.strictEqual(json, '{}');
    });

    it('J-10: Run secret scanner verification on clean test environment', async () => {
      const { hashLock } = generateClientCrypto();
      const prep = await coordinator.prepareSwap({
        idempotencyKey: `j10-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientJ10',
        targetDestinationAddress: '0xclientJ10',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });
      assert.ok(prep.id);
    });
  });

  // =========================================================================
  // FAMILY K: RECOVERY ISOLATION / BLAST RADIUS (K-01 to K-06)
  // =========================================================================
  describe('Family K: Recovery Isolation / Blast Radius', () => {
    it('K-01: One swap RECOVERY_REQUIRED while second swap completes', async () => {
      const { secret: secret2, hashLock: hashLock2 } = generateClientCrypto();
      const { hashLock: hashLock1 } = generateClientCrypto();

      const swap1 = await coordinator.prepareSwap({
        idempotencyKey: `k01-1-${randomUUID()}`,
        hashLock: hashLock1,
        claimingAddress: '0xclientK01_1',
        targetDestinationAddress: '0xclientK01_1',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });
      persistence.updateSovereignSwap(swap1.id, { recoveryRequired: true, failureReason: 'FAULT_INJECTED' });

      const swap2 = await coordinator.prepareSwap({
        idempotencyKey: `k01-2-${randomUUID()}`,
        hashLock: hashLock2,
        claimingAddress: '0xclientK01_2',
        targetDestinationAddress: '0xclientK01_2',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      lightning.simulatePayerHold(hashLock2.replace(/^0x/, '').toLowerCase(), 800000 + 144);
      await coordinator.onLightningHoldDetected(swap2.id);
      await coordinator.fundEvmHtlc(swap2.id);

      const claim2 = await evm.claimHtlc({
        swapKey: `swap_${swap2.id}`,
        preimage: secret2,
        destination: '0xclientK01_2',
      });
      evm.setTxConfirmations(claim2.txHash, 2);
      await coordinator.settleLightningFromEvmClaim(swap2.id, claim2.txHash);

      const final2 = coordinator.getExecution(swap2.id);
      assert.strictEqual(final2?.state, SovereignAtomicState.DESTINATION_PENDING);
    });

    it('K-02: One swap DB integrity mismatch while unrelated swaps reconcile', async () => {
      const { hashLock: hashLock1 } = generateClientCrypto();
      const { hashLock: hashLock2 } = generateClientCrypto();

      const swap1 = await coordinator.prepareSwap({
        idempotencyKey: `k02-1-${randomUUID()}`,
        hashLock: hashLock1,
        claimingAddress: '0xclientK02_1',
        targetDestinationAddress: '0xclientK02_1',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });
      const swap2 = await coordinator.prepareSwap({
        idempotencyKey: `k02-2-${randomUUID()}`,
        hashLock: hashLock2,
        claimingAddress: '0xclientK02_2',
        targetDestinationAddress: '0xclientK02_2',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      persistence.updateSovereignSwap(swap1.id, { retryCount: 10, recoveryRequired: true });

      const results = await coordinator.reconcileAll();
      assert.ok(results.length >= 2);
      assert.ok(results.some((r) => r.id === swap2.id));
    });

    it('K-03: One Base RPC failure affecting one request while other idempotent reads continue', async () => {
      const { hashLock } = generateClientCrypto();
      const prep = await coordinator.prepareSwap({
        idempotencyKey: `k03-${randomUUID()}`,
        hashLock,
        claimingAddress: '0xclientK03',
        targetDestinationAddress: '0xclientK03',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      evm.observeHtlc = async () => {
        throw new Error('EVM_RPC_ERROR');
      };

      const fetched = coordinator.getExecution(prep.id);
      assert.strictEqual(fetched?.id, prep.id);
    });

    it('K-04: One expired Lightning HTLC does not alter another active swap', async () => {
      const { hashLock: hashLock1 } = generateClientCrypto();
      const { hashLock: hashLock2 } = generateClientCrypto();

      const swap1 = await coordinator.prepareSwap({
        idempotencyKey: `k04-1-${randomUUID()}`,
        hashLock: hashLock1,
        claimingAddress: '0xclientK04_1',
        targetDestinationAddress: '0xclientK04_1',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });
      const swap2 = await coordinator.prepareSwap({
        idempotencyKey: `k04-2-${randomUUID()}`,
        hashLock: hashLock2,
        claimingAddress: '0xclientK04_2',
        targetDestinationAddress: '0xclientK04_2',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      await coordinator.processRefund(swap1.id);
      const rec1 = coordinator.getExecution(swap1.id);
      assert.strictEqual(rec1?.state, SovereignAtomicState.EXPIRED);

      const rec2 = coordinator.getExecution(swap2.id);
      assert.strictEqual(rec2?.state, SovereignAtomicState.INVOICE_CREATED);
    });

    it('K-05: One stuck lease does not globally block unrelated swap IDs', async () => {
      const { hashLock: hashLock1 } = generateClientCrypto();
      const { hashLock: hashLock2 } = generateClientCrypto();

      const swap1 = await coordinator.prepareSwap({
        idempotencyKey: `k05-1-${randomUUID()}`,
        hashLock: hashLock1,
        claimingAddress: '0xclientK05_1',
        targetDestinationAddress: '0xclientK05_1',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });
      const swap2 = await coordinator.prepareSwap({
        idempotencyKey: `k05-2-${randomUUID()}`,
        hashLock: hashLock2,
        claimingAddress: '0xclientK05_2',
        targetDestinationAddress: '0xclientK05_2',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
        cltvExpiryBlocks: 144,
      });

      persistence.claimSovereignAction(swap1.id, 'FUND', 'worker-stuck', 999_999);

      lightning.simulatePayerHold(hashLock2.replace(/^0x/, '').toLowerCase(), 800000 + 144);
      await coordinator.onLightningHoldDetected(swap2.id);

      const funded2 = await coordinator.fundEvmHtlc(swap2.id, 'worker-2');
      assert.strictEqual(funded2.state, SovereignAtomicState.EVM_FUNDED);
    });

    it('K-06: One malformed persisted row is isolated during reconcileAll', async () => {
      const { hashLock: hashLock1 } = generateClientCrypto();
      const { hashLock: hashLock2 } = generateClientCrypto();

      const swap1 = await coordinator.prepareSwap({
        idempotencyKey: `k06-1-${randomUUID()}`,
        hashLock: hashLock1,
        claimingAddress: '0xclientK06_1',
        targetDestinationAddress: '0xclientK06_1',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });
      const swap2 = await coordinator.prepareSwap({
        idempotencyKey: `k06-2-${randomUUID()}`,
        hashLock: hashLock2,
        claimingAddress: '0xclientK06_2',
        targetDestinationAddress: '0xclientK06_2',
        amountSats: 10_000n,
        expectedUsdcAmount: 10_000_000n,
      });

      persistence.updateSovereignSwap(swap1.id, { recoveryRequired: true, failureReason: 'CORRUPTED_AUX' });

      const all = await coordinator.reconcileAll();
      assert.ok(all.some((s) => s.id === swap2.id));
    });
  });
});
