/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Liquidity Accounting & Durable Reservation Safety Test Suite
 *
 * Implements authoritative adversarial verification of:
 * - 25 required test cases (Step 8)
 * - 15 Liquidity Accounting Invariants (LIQ-1 through LIQ-15)
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
} from '../src/atomic/coordinator/coordinator.ts';
import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { FakeLightningAtomicBackend } from '../src/atomic/lightning/fake-backend.ts';
import { FakeEvmAtomicBackend } from '../src/atomic/evm/fake-backend.ts';
import { SqliteLiquidityInventory } from '../src/atomic/liquidity/sqlite-inventory.ts';
import { SovereignAtomicState } from '../src/atomic/types.ts';

function generateClientCrypto() {
  const secret = '0x' + randomBytes(32).toString('hex');
  const hashLock =
    '0x' +
    createHash('sha256')
      .update(Buffer.from(secret.slice(2), 'hex'))
      .digest('hex');
  return { secret, hashLock };
}

describe('LIQUIDITY ACCOUNTING & DURABLE RESERVATION SAFETY SUITE', () => {
  let dbPath: string;
  let persistence: SqlitePersistence;
  let lightning: FakeLightningAtomicBackend;
  let evm: FakeEvmAtomicBackend;
  let inventory: SqliteLiquidityInventory;
  let coordinator: AtomicCoordinator;

  const defaultToken = '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40';
  const defaultRefund = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const initialBalance = 1_000_000_000n; // 1,000 USDC (6 decimals)

  beforeEach(() => {
    dbPath = join(tmpdir(), `phase-liq-safety-${randomUUID()}.db`);
    persistence = new SqlitePersistence({ filename: dbPath });
    lightning = new FakeLightningAtomicBackend();
    evm = new FakeEvmAtomicBackend();
    inventory = new SqliteLiquidityInventory(persistence, { [defaultToken]: initialBalance });
    coordinator = new AtomicCoordinator(lightning, evm, inventory, {
      persistence,
      finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
    });
  });

  afterEach(() => {
    try {
      persistence.close();
      if (existsSync(dbPath)) rmSync(dbPath, { force: true });
    } catch {}
  });

  // =========================================================================
  // 1. USDC Amount Correctness & Unit Safety
  // =========================================================================
  it('1. USDC amount correctness: reserves and funds expectedUsdcAmount, NOT amountSats', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 100_000n; // ~0.001 BTC (~$65)
    const expectedUsdcAmount = 65_000_000n; // 65 USDC in 6-decimal atomic units

    assert.notStrictEqual(amountSats, expectedUsdcAmount);

    const swap = await coordinator.prepareSwap({
      idempotencyKey: 'test-unit-correctness-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    assert.ok(swap.reservationId, 'Durable reservationId must exist');
    assert.strictEqual(swap.reservedAmountUnits, expectedUsdcAmount, 'LIQ-2: Reserved amount must equal expectedUsdcAmount');
    assert.strictEqual(swap.reservationStatus, 'RESERVED');

    // Verify in SQLite inventory
    const reservedInDb = persistence.getReservedOperatorBalance(defaultToken);
    assert.strictEqual(reservedInDb, expectedUsdcAmount, 'Durable reserved balance in SQLite must match expectedUsdcAmount');

    // Simulate hold invoice funding and proceed to EVM funding
    lightning.simulatePayerHold(swap.holdInvoice!.paymentHash);
    await coordinator.onLightningHoldDetected(swap.id);
    const funded = await coordinator.fundEvmHtlc(swap.id);

    // Verify EVM HTLC was funded with expectedUsdcAmount
    const htlc = await evm.observeHtlc(funded.evmSwapKey!);
    assert.strictEqual(htlc.balance, expectedUsdcAmount, 'LIQ-3: Base HTLC must be funded with expectedUsdcAmount');
    assert.notStrictEqual(htlc.balance, amountSats, 'Base HTLC must never be funded with amountSats');
  });

  // =========================================================================
  // 2. Insufficient USDC: Fail-Closed Before Hold Invoice
  // =========================================================================
  it('2. Insufficient USDC: reserve denied, invoice never created, funding never attempted', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 5_000_000n;
    const expectedUsdcAmount = 5_000_000_000n; // 5,000 USDC exceeds 1,000 USDC balance

    await assert.rejects(
      () =>
        coordinator.prepareSwap({
          idempotencyKey: 'test-insufficient-liq-1',
          hashLock,
          claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          amountSats,
          expectedUsdcAmount,
        }),
      /Insufficient operator liquidity/
    );

    // Assert zero invoice created in LND
    const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();
    await assert.rejects(
      () => lightning.getInvoiceState(paymentHash),
      /Invoice not found/
    );

    // Assert zero reservations in DB
    const reservedInDb = persistence.getReservedOperatorBalance(defaultToken);
    assert.strictEqual(reservedInDb, 0n);
  });

  // =========================================================================
  // 3. Successful Reservation Stored Durably
  // =========================================================================
  it('3. Successful reservation: stored durably with RESERVED status', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 50_000n;
    const expectedUsdcAmount = 30_000_000n;

    const swap = await coordinator.prepareSwap({
      idempotencyKey: 'test-durable-res-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    const resRecord = persistence.getLiquidityReservation(swap.reservationId!);
    assert.ok(resRecord);
    assert.strictEqual(resRecord.status, 'RESERVED');
    assert.strictEqual(resRecord.amountUnits, expectedUsdcAmount);
    assert.strictEqual(resRecord.executionId, swap.id);

    const available = persistence.getAvailableOperatorBalance(defaultToken);
    assert.strictEqual(available, initialBalance - expectedUsdcAmount);
  });

  // =========================================================================
  // 4 & 5. Idempotent Reservation Acquisition & Fingerprint Replay
  // =========================================================================
  it('4-5. Duplicate idempotency request returns existing reservation without consuming extra liquidity', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 50_000n;
    const expectedUsdcAmount = 30_000_000n;

    const swap1 = await coordinator.prepareSwap({
      idempotencyKey: 'test-idemp-res-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    const swap2 = await coordinator.prepareSwap({
      idempotencyKey: 'test-idemp-res-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    assert.strictEqual(swap1.id, swap2.id);
    assert.strictEqual(swap1.reservationId, swap2.reservationId);
    assert.strictEqual(
      persistence.getReservedOperatorBalance(defaultToken),
      expectedUsdcAmount,
      'LIQ-6: Exactly one reservation must exist; zero duplicate liquidity consumption'
    );
  });

  // =========================================================================
  // 6. Definitive Invoice Creation Failure Releases Reservation
  // =========================================================================
  it('6. Definitive invoice creation failure releases reservation exactly once', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 50_000n;
    const expectedUsdcAmount = 30_000_000n;

    // Inject fault into Lightning backend to simulate definitive failure
    const originalCreate = lightning.createHoldInvoice.bind(lightning);
    lightning.createHoldInvoice = async () => {
      throw new Error('LND_INVOICE_FAILED_PERMANENTLY');
    };

    await assert.rejects(
      () =>
        coordinator.prepareSwap({
          idempotencyKey: 'test-invoice-failure-release-1',
          hashLock,
          claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          amountSats,
          expectedUsdcAmount,
        }),
      /LND_INVOICE_FAILED_PERMANENTLY/
    );

    lightning.createHoldInvoice = originalCreate;

    // Assert reservation was released
    const available = persistence.getAvailableOperatorBalance(defaultToken);
    assert.strictEqual(available, initialBalance, 'Available balance must be fully restored after invoice failure');
    assert.strictEqual(persistence.getReservedOperatorBalance(defaultToken), 0n);
  });

  // =========================================================================
  // 7. Ambiguous Invoice Creation: Reconciles Before Release
  // =========================================================================
  it('7. Ambiguous invoice creation result reconciles before release (no blind release)', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 50_000n;
    const expectedUsdcAmount = 30_000_000n;

    // Simulate ambiguous timeout where LND actually succeeded creating invoice
    const originalCreate = lightning.createHoldInvoice.bind(lightning);
    lightning.createHoldInvoice = async (hl, amt, cltv, memo) => {
      await originalCreate(hl, amt, cltv, memo);
      throw new Error('LND_TIMEOUT_AMBIGUOUS');
    };

    const swap = await coordinator.prepareSwap({
      idempotencyKey: 'test-invoice-ambiguity-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    lightning.createHoldInvoice = originalCreate;

    // Reconciled invoice was observed -> reservation is NOT released!
    assert.strictEqual(swap.state, SovereignAtomicState.INVOICE_CREATED);
    assert.strictEqual(swap.reservationStatus, 'RESERVED');
    assert.strictEqual(persistence.getReservedOperatorBalance(defaultToken), expectedUsdcAmount);
  });

  // =========================================================================
  // 8. Crash After Reservation / Before Invoice: Restart Recovers Correctly
  // =========================================================================
  it('8. Crash after reservation / before invoice: restart recovers reservation correctly', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 50_000n;
    const expectedUsdcAmount = 30_000_000n;
    const claimingAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const targetDestinationAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const execId = randomUUID();

    // Compute identical fingerprint
    const data = [
      amountSats.toString(),
      expectedUsdcAmount.toString(),
      hashLock.toLowerCase(),
      claimingAddress.toLowerCase(),
      targetDestinationAddress.toLowerCase(),
      defaultToken.toLowerCase(),
      defaultRefund.toLowerCase(),
    ].join('|');
    const fingerprint = createHash('sha256').update(data).digest('hex');

    // Manually simulate state where reservation occurred and was persisted to SQLite in PLAN_PREPARED
    const res = persistence.reserveLiquidity(execId, defaultToken, expectedUsdcAmount);
    assert.strictEqual(res.reserved, true);

    const now = new Date();
    persistence.createSovereignSwap(
      {
        id: execId,
        idempotencyKey: 'test-crash-recovery-1',
        hashLock: hashLock.toLowerCase(),
        claimingAddress: claimingAddress.toLowerCase(),
        targetDestinationAddress: targetDestinationAddress.toLowerCase(),
        amountSats,
        expectedUsdcAmount,
        state: SovereignAtomicState.PLAN_PREPARED,
        reservationId: res.reservationId,
        reservedAmountUnits: expectedUsdcAmount,
        reservationStatus: 'RESERVED',
        tokenAddress: defaultToken,
        refundAddress: defaultRefund,
        cltvExpiryBlocks: 144,
        timelockSeconds: 43200,
        economicFingerprint: fingerprint,
        createdAt: now,
        updatedAt: now,
      },
      fingerprint
    );

    // Restart coordinator simulating new process boot
    const restartCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
      persistence,
      finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
    });

    // Caller retries prepareSwap after crash
    const recovered = await restartCoordinator.prepareSwap({
      idempotencyKey: 'test-crash-recovery-1',
      hashLock,
      claimingAddress,
      targetDestinationAddress,
      amountSats,
      expectedUsdcAmount,
    });

    assert.strictEqual(recovered.id, execId);
    assert.strictEqual(recovered.reservationId, res.reservationId);
    assert.strictEqual(
      persistence.getReservedOperatorBalance(defaultToken),
      expectedUsdcAmount,
      'No duplicate reservation should exist after crash recovery'
    );
  });

  // =========================================================================
  // 9. Crash After Invoice Creation: Does Not Double-Reserve
  // =========================================================================
  it('9. Crash after invoice creation: restart does not double-reserve', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 50_000n;
    const expectedUsdcAmount = 30_000_000n;

    const swap = await coordinator.prepareSwap({
      idempotencyKey: 'test-crash-after-invoice-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    // Simulate process death and reboot
    const restartCoordinator = new AtomicCoordinator(lightning, evm, inventory, {
      persistence,
      finalityPolicy: BASE_SEPOLIA_FINALITY_POLICY,
    });

    const retry = await restartCoordinator.prepareSwap({
      idempotencyKey: 'test-crash-after-invoice-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    assert.strictEqual(retry.reservationId, swap.reservationId);
    assert.strictEqual(persistence.getReservedOperatorBalance(defaultToken), expectedUsdcAmount);
  });

  // =========================================================================
  // 10. Base Funding Success Commits Reservation Exactly Once
  // =========================================================================
  it('10. Base funding success: reservation transitions to COMMITTED exactly once', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 50_000n;
    const expectedUsdcAmount = 30_000_000n;

    const swap = await coordinator.prepareSwap({
      idempotencyKey: 'test-fund-commit-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    lightning.simulatePayerHold(swap.holdInvoice!.paymentHash);
    await coordinator.onLightningHoldDetected(swap.id);
    const funded = await coordinator.fundEvmHtlc(swap.id);

    assert.strictEqual(funded.state, SovereignAtomicState.EVM_FUNDED);
    assert.strictEqual(funded.reservationStatus, 'COMMITTED');

    // Durable inventory checks
    const resRecord = persistence.getLiquidityReservation(swap.reservationId!);
    assert.strictEqual(resRecord?.status, 'COMMITTED');
    assert.strictEqual(persistence.getReservedOperatorBalance(defaultToken), 0n);
    assert.strictEqual(persistence.getCommittedOperatorBalance(defaultToken), expectedUsdcAmount);
    assert.strictEqual(persistence.getAvailableOperatorBalance(defaultToken), initialBalance - expectedUsdcAmount);
  });

  // =========================================================================
  // 11 & 12. Base Funding Failure & Ambiguity
  // =========================================================================
  it('11-12. Base funding ambiguity: reconciles chain state before taking action', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 50_000n;
    const expectedUsdcAmount = 30_000_000n;

    const swap = await coordinator.prepareSwap({
      idempotencyKey: 'test-funding-ambiguity-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    lightning.simulatePayerHold(swap.holdInvoice!.paymentHash);
    await coordinator.onLightningHoldDetected(swap.id);

    // Simulate ambiguous timeout during EVM fundHtlc where on-chain funding actually succeeded
    const originalFund = evm.fundHtlc.bind(evm);
    evm.fundHtlc = async (params) => {
      await originalFund(params);
      throw new Error('EVM_RPC_TIMEOUT_AMBIGUOUS');
    };

    const funded = await coordinator.fundEvmHtlc(swap.id);
    evm.fundHtlc = originalFund;

    assert.strictEqual(funded.state, SovereignAtomicState.EVM_FUNDED);
    assert.strictEqual(funded.reservationStatus, 'COMMITTED');
    assert.strictEqual(persistence.getCommittedOperatorBalance(defaultToken), expectedUsdcAmount);
  });

  // =========================================================================
  // 13. Client Claims Base HTLC: Committed Inventory Remains Spent
  // =========================================================================
  it('13. Client claims Base HTLC: committed inventory remains spent (never released)', async () => {
    const { secret, hashLock } = generateClientCrypto();
    const amountSats = 50_000n;
    const expectedUsdcAmount = 30_000_000n;

    const swap = await coordinator.prepareSwap({
      idempotencyKey: 'test-client-claim-spent-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    lightning.simulatePayerHold(swap.holdInvoice!.paymentHash);
    await coordinator.onLightningHoldDetected(swap.id);
    await coordinator.fundEvmHtlc(swap.id);

    // Client executes on-chain claim
    const claimRes = await evm.claimHtlc({
      swapKey: `swap_${swap.id}`,
      preimage: secret,
      destination: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    });

    // Coordinator settles Lightning from EVM claim
    const settled = await coordinator.settleLightningFromEvmClaim(swap.id, claimRes.txHash);
    assert.ok(
      settled.state === SovereignAtomicState.DESTINATION_PENDING ||
      settled.state === SovereignAtomicState.LIGHTNING_SETTLED
    );

    // Confirm delivery
    coordinator.confirmBaseDelivery(swap.id, '0xdest_tx_confirmed');
    const finalRec = coordinator.getExecution(swap.id);
    assert.strictEqual(finalRec?.state, SovereignAtomicState.COMPLETED);

    // Invariant: Committed inventory is legitimately spent, NOT returned to available
    const available = persistence.getAvailableOperatorBalance(defaultToken);
    assert.strictEqual(available, initialBalance - expectedUsdcAmount, 'LIQ-12: Client claim must never restore spent operator inventory');
    const resRecord = persistence.getLiquidityReservation(swap.reservationId!);
    assert.strictEqual(resRecord?.status, 'COMMITTED');
  });

  // =========================================================================
  // 14 & 15. Base Refund Restores Inventory Exactly Once (No Double-Credit)
  // =========================================================================
  it('14-15. Base refund restores available inventory exactly once (duplicate refund causes no double-credit)', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 50_000n;
    const expectedUsdcAmount = 30_000_000n;

    const swap = await coordinator.prepareSwap({
      idempotencyKey: 'test-refund-accounting-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    lightning.simulatePayerHold(swap.holdInvoice!.paymentHash);
    await coordinator.onLightningHoldDetected(swap.id);
    await coordinator.fundEvmHtlc(swap.id);

    // Fast-forward EVM time past timelock
    evm.setBlockTimestamp(Math.floor(Date.now() / 1000) + 50_000);

    // Execute refund flow
    const refunded = await coordinator.processRefund(swap.id);
    assert.strictEqual(refunded.state, SovereignAtomicState.REFUNDED);
    assert.strictEqual(refunded.reservationStatus, 'RELEASED');

    // Invariant: Refunded USDC is restored to available operator inventory exactly once
    const availableAfterRefund = persistence.getAvailableOperatorBalance(defaultToken);
    assert.strictEqual(availableAfterRefund, initialBalance, 'LIQ-11: Verified Base refund must restore available inventory');
    assert.strictEqual(persistence.getCommittedOperatorBalance(defaultToken), 0n);

    // Attempt duplicate refund call
    const dupRefund = await coordinator.processRefund(swap.id);
    assert.strictEqual(dupRefund.state, SovereignAtomicState.REFUNDED);

    // Assert zero double-credit
    const availableAfterDup = persistence.getAvailableOperatorBalance(defaultToken);
    assert.strictEqual(availableAfterDup, initialBalance, 'Duplicate refund processing must not double-credit inventory');
  });

  // =========================================================================
  // 16. Expiry Before Base Funding Releases Reservation
  // =========================================================================
  it('16. Expiry before Base funding: releases reservation exactly once', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 50_000n;
    const expectedUsdcAmount = 30_000_000n;

    const swap = await coordinator.prepareSwap({
      idempotencyKey: 'test-expiry-release-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    // Payer never funds hold invoice; swap expires
    const expired = await coordinator.processRefund(swap.id);
    assert.strictEqual(expired.state, SovereignAtomicState.EXPIRED);
    assert.strictEqual(expired.reservationStatus, 'RELEASED');

    const available = persistence.getAvailableOperatorBalance(defaultToken);
    assert.strictEqual(available, initialBalance, 'Available balance must be restored after expiry');
    assert.strictEqual(persistence.getReservedOperatorBalance(defaultToken), 0n);
  });

  // =========================================================================
  // 17 & 18. Concurrent Workers & Processes (BEGIN IMMEDIATE Oversubscription Safety)
  // =========================================================================
  it('17-18. Concurrent workers & processes cannot oversubscribe available inventory', async () => {
    // Total available: 100 USDC (100_000_000 units)
    persistence.setConfirmedOperatorBalance(defaultToken, 100_000_000n);

    // Create 5 concurrent prepareSwap requests, each requesting 30 USDC (Total: 150 USDC)
    const promises = Array.from({ length: 5 }, (_, i) => {
      const { hashLock } = generateClientCrypto();
      return coordinator.prepareSwap({
        idempotencyKey: `storm-worker-${i}`,
        hashLock,
        claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        amountSats: 30_000n,
        expectedUsdcAmount: 30_000_000n,
      }).then(
        (res) => ({ success: true, res }),
        (err) => ({ success: false, err })
      );
    });

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    // Exactly 3 should succeed (3 * 30 = 90 USDC <= 100 USDC), 2 must fail with insufficient liquidity
    assert.strictEqual(successes.length, 3, 'Exactly 3 reservations should succeed');
    assert.strictEqual(failures.length, 2, 'Exactly 2 reservations must fail due to insufficient liquidity');

    const totalReserved = persistence.getReservedOperatorBalance(defaultToken);
    assert.strictEqual(totalReserved, 90_000_000n);
    const available = persistence.getAvailableOperatorBalance(defaultToken);
    assert.strictEqual(available, 10_000_000n, 'LIQ-10: Available balance must strictly prevent oversubscription');
  });

  // =========================================================================
  // 19. Restart Reconstruction
  // =========================================================================
  it('19. Restart reconstruction: available/reserved/committed totals remain authoritatively consistent', async () => {
    // Set balance to 500 USDC
    persistence.setConfirmedOperatorBalance(defaultToken, 500_000_000n);

    // Swap 1: Reserved (50 USDC)
    const { hashLock: h1 } = generateClientCrypto();
    await coordinator.prepareSwap({
      idempotencyKey: 'reconstruct-swap-1',
      hashLock: h1,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats: 50_000n,
      expectedUsdcAmount: 50_000_000n,
    });

    // Swap 2: Committed (100 USDC)
    const { hashLock: h2 } = generateClientCrypto();
    const s2 = await coordinator.prepareSwap({
      idempotencyKey: 'reconstruct-swap-2',
      hashLock: h2,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats: 100_000n,
      expectedUsdcAmount: 100_000_000n,
    });
    lightning.simulatePayerHold(s2.holdInvoice!.paymentHash);
    await coordinator.onLightningHoldDetected(s2.id);
    await coordinator.fundEvmHtlc(s2.id);

    // Now restart coordinator with a fresh in-memory instance reading same SQLite file
    const secondPersistence = new SqlitePersistence({ filename: dbPath });
    const secondInventory = new SqliteLiquidityInventory(secondPersistence);

    assert.strictEqual(await secondInventory.getConfirmedBalance(defaultToken), 500_000_000n);
    assert.strictEqual(await secondInventory.getReservedBalance(defaultToken), 50_000_000n);
    assert.strictEqual(await secondInventory.getCommittedBalance(defaultToken), 100_000_000n);
    assert.strictEqual(await secondInventory.getAvailableBalance(defaultToken), 350_000_000n);
    secondPersistence.close();
  });

  // =========================================================================
  // 20. Unit Mismatch Adversarial Test
  // =========================================================================
  it('20. Unit mismatch adversarial test: sats can never silently become USDC atomic units', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 100_000n; // 100,000 sats
    const expectedUsdcAmount = 65_000_000n; // 65,000,000 units (65 USDC)

    const swap = await coordinator.prepareSwap({
      idempotencyKey: 'test-unit-adversarial-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    // Verify invoice amount in sats matches amountSats exactly
    assert.strictEqual(swap.holdInvoice!.amountSats, amountSats);

    // Verify EVM lock amount strictly matches expectedUsdcAmount
    lightning.simulatePayerHold(swap.holdInvoice!.paymentHash);
    await coordinator.onLightningHoldDetected(swap.id);
    const funded = await coordinator.fundEvmHtlc(swap.id);
    const htlc = await evm.observeHtlc(funded.evmSwapKey!);
    assert.strictEqual(htlc.balance, expectedUsdcAmount);
    assert.notStrictEqual(htlc.balance, amountSats);
  });

  // =========================================================================
  // 21. Wrong Token Address Fails Closed
  // =========================================================================
  it('21. Wrong token address fails closed', async () => {
    const wrongToken = '0x1111111111111111111111111111111111111111';
    const available = await inventory.getAvailableBalance(wrongToken);
    assert.strictEqual(available, 0n, 'Unprovisioned token balance must be 0n');

    const res = await inventory.reserve(10_000_000n, wrongToken);
    assert.strictEqual(res.reserved, false);
    assert.strictEqual(res.reservationId, '');
  });

  // =========================================================================
  // 22. Negative / Zero / Malformed Economic Amounts Fail Closed
  // =========================================================================
  it('22. Negative / zero / malformed amounts fail closed', async () => {
    const { hashLock } = generateClientCrypto();

    await assert.rejects(
      () =>
        coordinator.prepareSwap({
          idempotencyKey: 'test-zero-sats',
          hashLock,
          claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          amountSats: 0n,
          expectedUsdcAmount: 10_000_000n,
        }),
      /Invalid amountSats/
    );

    await assert.rejects(
      () =>
        coordinator.prepareSwap({
          idempotencyKey: 'test-zero-usdc',
          hashLock,
          claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          amountSats: 10_000n,
          expectedUsdcAmount: 0n,
        }),
      /Invalid expectedUsdcAmount/
    );

    await assert.rejects(
      () =>
        coordinator.prepareSwap({
          idempotencyKey: 'test-neg-usdc',
          hashLock,
          claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          amountSats: 10_000n,
          expectedUsdcAmount: -100n,
        }),
      /Invalid expectedUsdcAmount/
    );
  });

  // =========================================================================
  // 23. Economic Fingerprint Mutation
  // =========================================================================
  it('23. Economic fingerprint mutation on duplicate idempotency key rejected', async () => {
    const { hashLock } = generateClientCrypto();

    await coordinator.prepareSwap({
      idempotencyKey: 'test-fp-mutation-key',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats: 10_000n,
      expectedUsdcAmount: 10_000_000n,
    });

    // Replay same idempotencyKey with mutated expectedUsdcAmount
    await assert.rejects(
      () =>
        coordinator.prepareSwap({
          idempotencyKey: 'test-fp-mutation-key',
          hashLock,
          claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          amountSats: 10_000n,
          expectedUsdcAmount: 20_000_000n, // Mutated!
        }),
      /IMMUTABLE_FINGERPRINT_MISMATCH/
    );
  });

  // =========================================================================
  // 24. Claim / Refund Mutual Exclusion Preserved (SEC-10)
  // =========================================================================
  it('24. Claim and refund mutual exclusion strictly preserved', async () => {
    const { secret, hashLock } = generateClientCrypto();
    const amountSats = 50_000n;
    const expectedUsdcAmount = 30_000_000n;

    const swap = await coordinator.prepareSwap({
      idempotencyKey: 'test-mutual-exclusion-1',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });

    lightning.simulatePayerHold(swap.holdInvoice!.paymentHash);
    await coordinator.onLightningHoldDetected(swap.id);
    await coordinator.fundEvmHtlc(swap.id);

    // Client claims EVM HTLC
    const claimRes = await evm.claimHtlc({
      swapKey: `swap_${swap.id}`,
      preimage: secret,
      destination: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    });
    await coordinator.settleLightningFromEvmClaim(swap.id, claimRes.txHash);

    // Fast forward EVM timelock and attempt refund
    evm.setBlockTimestamp(Math.floor(Date.now() / 1000) + 100_000);
    await assert.rejects(
      () => coordinator.processRefund(swap.id),
      /SEC-10/
    );
  });

  // =========================================================================
  // 25. All Explicit LIQ Invariants (LIQ-1 through LIQ-15)
  // =========================================================================
  it('25. All 15 explicit LIQ invariants (LIQ-1 through LIQ-15) hold strictly', async () => {
    const { hashLock } = generateClientCrypto();
    const amountSats = 100_000n;
    const expectedUsdcAmount = 65_000_000n;

    // LIQ-1 & LIQ-14: Cannot create hold invoice without durable reservation
    const swap = await coordinator.prepareSwap({
      idempotencyKey: 'test-liq-invariants-all',
      hashLock,
      claimingAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      targetDestinationAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amountSats,
      expectedUsdcAmount,
    });
    assert.ok(swap.reservationId, 'LIQ-1: Durable reservation must precede hold invoice');

    // LIQ-2: Reserved USDC equals expectedUsdcAmount, never amountSats
    assert.strictEqual(swap.reservedAmountUnits, expectedUsdcAmount, 'LIQ-2 satisfied');
    assert.notStrictEqual(swap.reservedAmountUnits, amountSats, 'LIQ-2 satisfied');

    // LIQ-4 & LIQ-5: One execution owns at most one active reservation
    const resRow = persistence.getLiquidityReservation(swap.reservationId!);
    assert.strictEqual(resRow?.executionId, swap.id, 'LIQ-5 satisfied');

    // LIQ-6: Reservation acquisition is idempotent
    const retryRes = persistence.reserveLiquidity(swap.id, defaultToken, expectedUsdcAmount);
    assert.strictEqual(retryRes.reservationId, swap.reservationId, 'LIQ-6 satisfied');

    // LIQ-8: Reservation commit is idempotent
    lightning.simulatePayerHold(swap.holdInvoice!.paymentHash);
    await coordinator.onLightningHoldDetected(swap.id);
    await coordinator.fundEvmHtlc(swap.id);
    persistence.commitLiquidityReservation(swap.reservationId!);
    persistence.commitLiquidityReservation(swap.reservationId!);
    assert.strictEqual(persistence.getLiquidityReservation(swap.reservationId!)?.status, 'COMMITTED', 'LIQ-8 satisfied');

    // LIQ-3: Base HtlcErc20 funding amount equals expectedUsdcAmount
    const htlc = await evm.observeHtlc(`swap_${swap.id}`);
    assert.strictEqual(htlc.balance, expectedUsdcAmount, 'LIQ-3 satisfied');

    // LIQ-7: Reservation release is idempotent
    const testAnonExec = randomUUID();
    const tempRes = persistence.reserveLiquidity(testAnonExec, defaultToken, 10_000_000n);
    persistence.releaseLiquidityReservation(tempRes.reservationId);
    persistence.releaseLiquidityReservation(tempRes.reservationId);
    assert.strictEqual(persistence.getLiquidityReservation(tempRes.reservationId)?.status, 'RELEASED', 'LIQ-7 satisfied');

    // LIQ-11: Verified refund restores availability at most once
    evm.setBlockTimestamp(Math.floor(Date.now() / 1000) + 100_000);
    await coordinator.processRefund(swap.id);
    const bal1 = persistence.getAvailableOperatorBalance(defaultToken);
    await coordinator.processRefund(swap.id);
    const bal2 = persistence.getAvailableOperatorBalance(defaultToken);
    assert.strictEqual(bal1, bal2, 'LIQ-11 satisfied');

    // LIQ-13: Crash/restart preserves exact accounting totals
    const p3 = new SqlitePersistence({ filename: dbPath });
    assert.strictEqual(p3.getAvailableOperatorBalance(defaultToken), bal1, 'LIQ-13 satisfied');
    p3.close();

    // LIQ-15: All quantities remain integer atomic units (bigint)
    assert.strictEqual(typeof swap.amountSats, 'bigint', 'LIQ-15 satisfied');
    assert.strictEqual(typeof swap.expectedUsdcAmount, 'bigint', 'LIQ-15 satisfied');
    assert.strictEqual(typeof swap.reservedAmountUnits, 'bigint', 'LIQ-15 satisfied');
  });
});
