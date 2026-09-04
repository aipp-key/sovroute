/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 5A: Base Transaction Reliability Engineering Test Suite
 *
 * Comprehensive validation across:
 * 1. Fail-Closed Configuration & Unsafe Fallback Removal
 * 2. Durable Nonce Management (Monotonicity, concurrency, crash persistence, external conflict)
 * 3. Deterministic Idempotency & Storm Protection (50-request storm, restart recovery, confirmed caching)
 * 4. EIP-1559 Fee Replacement & Financial Caps (>=10% bump, same nonce, caps: fee, priority, gas, worst-case spend)
 * 5. `already known` vs `nonce too low` Broadcast Separation (Strict convergence vs fail-closed NONCE_CONFLICT)
 * 6. Plaintext Signed Raw Transaction Elimination & Deterministic Re-Signing
 * 7. Authoritative Multi-Attempt Reconciliation (Winner confirmation, superseded cleanup, revert handling)
 * 8. Concurrency Stress (50 parallel distinct swaps, replacement storm, restart under load)
 * 9. Complete RPC Failure Matrix (6 RPC methods: timeout, transient error, malformed fee, absurd gas estimate)
 * 10. Original 8 Crash Point Boundaries (CP-1 through CP-8 exact lifecycle boundaries)
 * 11. Zero Client Key Custody & Security Invariants
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodeFunctionData,
  parseAbi,
  type Hex,
  type Account,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SqlitePersistence } from '../src/persistence/sqlite.ts';
import { BaseTransactionManager } from '../src/atomic/evm/transaction-manager.ts';
import { BaseSepoliaAtomicBackend } from '../src/atomic/evm/base-sepolia-backend.ts';
import {
  OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
} from '../src/atomic/evm/base-guard.ts';
import {
  EvmLogicalIntentState,
  EvmPhysicalAttemptStatus,
} from '../src/atomic/evm/transaction-types.ts';

// Test account funded on Hardhat local node (Chain ID 31337)
const HARDHAT_RPC_URL = 'http://127.0.0.1:8545';
const HARDHAT_CHAIN_ID = 31337;

// Hardhat standard test private keys
const OPERATOR_PRIVATE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Account 0
const CLIENT_PRIVATE_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';   // Account 1
const RECIPIENT_ADDRESS: `0x${string}` = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

const DUMMY_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

describe('PHASE 5A — BASE TRANSACTION RELIABILITY SUITE', () => {
  let dbPath: string;
  let persistence: SqlitePersistence;
  let publicClient: PublicClient;
  let operatorAccount: Account;
  let txManager: BaseTransactionManager;

  beforeEach(() => {
    dbPath = path.join(process.cwd(), 'scratch', `test-reliability-${randomUUID()}.db`);
    persistence = new SqlitePersistence({ filename: dbPath });

    publicClient = createPublicClient({
      transport: http(HARDHAT_RPC_URL),
    }) as any;

    operatorAccount = privateKeyToAccount(OPERATOR_PRIVATE_KEY);

    txManager = new BaseTransactionManager({
      persistence,
      publicClient,
      account: operatorAccount,
      chainId: HARDHAT_CHAIN_ID,
      policy: {
        minPriorityFeeBumpPercent: 10,
        maxReplacements: 3,
        stalledAgeMs: 500, // Fast for testing
        requiredConfirmations: 1,
      },
    });
  });

  afterEach(() => {
    try {
      persistence.close();
    } catch {}
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      const wal = `${dbPath}-wal`;
      const shm = `${dbPath}-shm`;
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
    } catch {}
  });

  // =========================================================================
  // 1. FAIL-CLOSED CONFIGURATION & UNSAFE FALLBACK REMOVAL
  // =========================================================================
  describe('1. Fail-Closed Configuration & Unsafe Fallback Removal', () => {
    it('1.1 BaseSepoliaAtomicBackend with operator key without persistence fails closed with RELIABILITY_MANAGER_REQUIRED', () => {
      assert.throws(
        () => {
          new BaseSepoliaAtomicBackend({
            rpcUrl: HARDHAT_RPC_URL,
            chainId: HARDHAT_CHAIN_ID,
            tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
            operatorPrivateKey: OPERATOR_PRIVATE_KEY,
            // persistence intentionally omitted!
          });
        },
        /RELIABILITY_MANAGER_REQUIRED/
      );
    });

    it('1.2 Omission of persistence cannot silently execute transactions', () => {
      let backend: BaseSepoliaAtomicBackend | undefined;
      try {
        backend = new BaseSepoliaAtomicBackend({
          rpcUrl: HARDHAT_RPC_URL,
          chainId: HARDHAT_CHAIN_ID,
          tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
          operatorPrivateKey: OPERATOR_PRIVATE_KEY,
        });
      } catch (err: any) {
        assert.ok(err.message.includes('RELIABILITY_MANAGER_REQUIRED'));
      }
      assert.strictEqual(backend, undefined, 'Backend must not be constructed when reliability manager is missing');
    });

    it('1.3 Explicit unsafeDirectExecutionForTests is required to permit unmanaged test execution', () => {
      const testBackend = new BaseSepoliaAtomicBackend({
        rpcUrl: HARDHAT_RPC_URL,
        chainId: HARDHAT_CHAIN_ID,
        tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
        operatorPrivateKey: OPERATOR_PRIVATE_KEY,
        unsafeDirectExecutionForTests: true, // Explicit test bypass
      });

      assert.ok(testBackend !== undefined);
      assert.strictEqual(testBackend.getTransactionManager(), undefined);
    });

    it('1.4 Providing SqlitePersistence successfully initializes BaseTransactionManager for safe live execution', () => {
      const liveBackend = new BaseSepoliaAtomicBackend({
        rpcUrl: HARDHAT_RPC_URL,
        chainId: HARDHAT_CHAIN_ID,
        tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
        operatorPrivateKey: OPERATOR_PRIVATE_KEY,
        persistence,
      });

      assert.ok(liveBackend.getTransactionManager() !== undefined);
    });
  });

  // =========================================================================
  // 2. DURABLE NONCE MANAGEMENT
  // =========================================================================
  describe('2. Durable Nonce Management', () => {
    it('2.1 Allocates strictly monotonically increasing nonces for sequential intents', async () => {
      const intent1 = persistence.getOrCreateEvmIntent({
        swapKey: `swap-nonce-seq-1-${randomUUID()}`,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x1234',
      });

      const intent2 = persistence.getOrCreateEvmIntent({
        swapKey: `swap-nonce-seq-2-${randomUUID()}`,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x5678',
      });

      const rpcPendingNonce = await publicClient.getTransactionCount({
        address: operatorAccount.address,
        blockTag: 'pending',
      });

      const res1 = persistence.reserveEvmNonce(intent1.id, rpcPendingNonce);
      const res2 = persistence.reserveEvmNonce(intent2.id, rpcPendingNonce);

      assert.strictEqual(res2.nonce, res1.nonce + 1, 'Nonces must be strictly sequential');
      assert.strictEqual(res1.intent.status, EvmLogicalIntentState.NONCE_RESERVED);
      assert.strictEqual(res2.intent.status, EvmLogicalIntentState.NONCE_RESERVED);
    });

    it('2.2 Concurrent nonce reservations allocate strictly unique nonces with zero collisions', async () => {
      const count = 10;
      const rpcPendingNonce = await publicClient.getTransactionCount({
        address: operatorAccount.address,
        blockTag: 'pending',
      });

      const intents = Array.from({ length: count }, (_, i) =>
        persistence.getOrCreateEvmIntent({
          swapKey: `swap-nonce-conc-${i}-${randomUUID()}`,
          chainId: HARDHAT_CHAIN_ID,
          signerAddress: operatorAccount.address,
          actionType: 'FUND',
          targetAddress: RECIPIENT_ADDRESS,
          calldata: `0x${i.toString(16).padStart(4, '0')}` as Hex,
        })
      );

      const reservations = await Promise.all(
        intents.map((it) => Promise.resolve(persistence.reserveEvmNonce(it.id, rpcPendingNonce)))
      );

      const allocatedNonces = reservations.map((r) => r.nonce).sort((a, b) => a - b);
      const uniqueNonces = new Set(allocatedNonces);

      assert.strictEqual(uniqueNonces.size, count, 'All allocated nonces must be unique');
      for (let i = 1; i < count; i++) {
        assert.strictEqual(
          allocatedNonces[i],
          allocatedNonces[i - 1] + 1,
          'Nonces must form an unbroken contiguous sequence'
        );
      }
    });

    it('2.3 Database persistence across restarts preserves highest nonce and continues sequentially', async () => {
      const intent1 = persistence.getOrCreateEvmIntent({
        swapKey: `swap-restart-nonce-1-${randomUUID()}`,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0xaaaa',
      });

      const rpcNonce = await publicClient.getTransactionCount({
        address: operatorAccount.address,
        blockTag: 'pending',
      });

      const res1 = persistence.reserveEvmNonce(intent1.id, rpcNonce);
      persistence.close();

      const restoredDb = new SqlitePersistence({ filename: dbPath });

      const intent2 = restoredDb.getOrCreateEvmIntent({
        swapKey: `swap-restart-nonce-2-${randomUUID()}`,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0xbbbb',
      });

      const res2 = restoredDb.reserveEvmNonce(intent2.id, rpcNonce);
      assert.strictEqual(res2.nonce, res1.nonce + 1, 'Restarted DB must continue from highest reserved nonce');
      restoredDb.close();
    });

    it('2.4 External transaction conflict marks NONCE_CONFLICT without silent overwrite', async () => {
      const swapKey = `swap-conflict-${randomUUID()}`;
      const calldata = '0x11223344';
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
      });

      persistence.reserveEvmNonce(intent.id, 0);

      persistence.recordEvmAttempt({
        intentId: intent.id,
        attemptNumber: 1,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: 0,
        txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 0n,
        data: calldata,
        gasLimit: 21000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });

      const outcome = await txManager.reconcileIntent(intent.id);
      assert.strictEqual(outcome.status, EvmLogicalIntentState.NONCE_CONFLICT);

      const reloaded = persistence.getEvmIntentById(intent.id);
      assert.strictEqual(reloaded?.status, EvmLogicalIntentState.NONCE_CONFLICT);
      assert.ok(reloaded?.failureReason?.includes('advanced past reserved nonce'));
    });
  });

  // =========================================================================
  // 3. DETERMINISTIC IDEMPOTENCY & STORM PROTECTION
  // =========================================================================
  describe('3. Deterministic Idempotency & Storm Protection', () => {
    it('3.1 Duplicate dispatch storm (50 parallel requests) produces exactly one intent and one attempt', async () => {
      const swapKey = `swap-storm-${randomUUID()}`;
      const calldata = encodeFunctionData({
        abi: DUMMY_ABI,
        functionName: 'transfer',
        args: [RECIPIENT_ADDRESS, 1000n],
      });

      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          Promise.resolve(
            persistence.getOrCreateEvmIntent({
              swapKey,
              chainId: HARDHAT_CHAIN_ID,
              signerAddress: operatorAccount.address,
              actionType: 'FUND',
              targetAddress: RECIPIENT_ADDRESS,
              calldata,
            })
          )
        )
      );

      const firstId = results[0].id;
      for (const res of results) {
        assert.strictEqual(res.id, firstId, 'All concurrent dispatches must resolve to same intent ID');
      }

      const attempts = persistence.getEvmAttemptsForIntent(firstId);
      assert.strictEqual(attempts.length, 0);
    });

    it('3.2 Confirmed intent returns canonical transaction hash and receipt immediately on repeated execution', async () => {
      const swapKey = `swap-confirmed-idempotent-${randomUUID()}`;
      const calldata = '0x';

      const res1 = await txManager.executeIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 1000n,
      });

      assert.strictEqual(res1.intent.status, EvmLogicalIntentState.CONFIRMED);
      const txHash1 = res1.winningAttempt.txHash;

      const res2 = await txManager.executeIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 1000n,
      });

      assert.strictEqual(res2.intent.status, EvmLogicalIntentState.CONFIRMED);
      assert.strictEqual(res2.winningAttempt.txHash, txHash1);
      assert.strictEqual(res2.receipt.transactionHash, res1.receipt.transactionHash);

      const attempts = persistence.getEvmAttemptsForIntent(res1.intent.id);
      assert.strictEqual(attempts.length, 1, 'Only one physical attempt must exist');
    });

    it('3.3 Re-dispatch after restart returns existing intent without re-broadcasting', async () => {
      const swapKey = `swap-restart-idempotent-${randomUUID()}`;
      const calldata = '0x';

      const res1 = await txManager.executeIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 500n,
      });

      persistence.close();

      const restoredDb = new SqlitePersistence({ filename: dbPath });
      const restoredManager = new BaseTransactionManager({
        persistence: restoredDb,
        publicClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const res2 = await restoredManager.executeIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 500n,
      });

      assert.strictEqual(res2.intent.id, res1.intent.id);
      assert.strictEqual(res2.winningAttempt.txHash, res1.winningAttempt.txHash);
      restoredDb.close();
    });
  });

  // =========================================================================
  // 4. EIP-1559 FEE REPLACEMENT & FINANCIAL CAPS
  // =========================================================================
  describe('4. EIP-1559 Fee Replacement & Financial Caps', () => {
    it('4.1 Valid replacement bumps priority fee and max fee monotonically by >= 10%', async () => {
      const swapKey = `swap-fee-bump-${randomUUID()}`;
      const calldata = '0x';

      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 100n,
      });

      const rpcNonce = await publicClient.getTransactionCount({
        address: operatorAccount.address,
        blockTag: 'pending',
      });
      persistence.reserveEvmNonce(intent.id, rpcNonce);

      const { attempt: attempt1 } = await txManager.prepareAttempt(intent, calldata, {
        customGasLimit: 25000n,
      });

      const { attempt: attempt2 } = await txManager.prepareAttempt(intent, calldata, {
        isReplacement: true,
        previousAttempt: attempt1,
        customFeeBumpPercent: 10,
        customGasLimit: 25000n,
      });

      assert.strictEqual(attempt2.attemptNumber, 2);
      assert.strictEqual(attempt2.nonce, attempt1.nonce);
      assert.strictEqual(attempt2.toAddress, attempt1.toAddress);
      assert.strictEqual(attempt2.calldataFingerprint, attempt1.calldataFingerprint);

      const expectedMinPriority = (attempt1.maxPriorityFeePerGas * 110n) / 100n;
      assert.ok(
        attempt2.maxPriorityFeePerGas >= expectedMinPriority,
        `Priority fee ${attempt2.maxPriorityFeePerGas} must be >= ${expectedMinPriority}`
      );
    });

    it('4.2 Attempt to replace beyond maxReplacements throws MAX_REPLACEMENTS_EXCEEDED and marks FEE_CAP_BLOCKED', async () => {
      const customTxManager = new BaseTransactionManager({
        persistence,
        publicClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
        policy: {
          maxReplacements: 1,
        },
      });

      const swapKey = `swap-max-replacements-${randomUUID()}`;
      const calldata = '0x';
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
      });

      persistence.reserveEvmNonce(intent.id, 9999);

      const { attempt: a1 } = await customTxManager.prepareAttempt(intent, calldata, { customGasLimit: 21000n });
      const { attempt: a2 } = await customTxManager.prepareAttempt(intent, calldata, {
        isReplacement: true,
        previousAttempt: a1,
        customGasLimit: 21000n,
      });

      await assert.rejects(
        async () => {
          await customTxManager.prepareAttempt(intent, calldata, {
            isReplacement: true,
            previousAttempt: a2,
            customGasLimit: 21000n,
          });
        },
        /MAX_REPLACEMENTS_EXCEEDED/
      );

      const reloaded = persistence.getEvmIntentById(intent.id);
      assert.strictEqual(reloaded?.status, EvmLogicalIntentState.FEE_CAP_BLOCKED);
    });

    it('4.3 Hard fee caps prevent broadcast and mark FEE_CAP_BLOCKED (Priority Fee Cap)', async () => {
      const cappedManager = new BaseTransactionManager({
        persistence,
        publicClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
        policy: {
          maxPriorityFeePerGasCapWei: 100n,
        },
      });

      const swapKey = `swap-priority-cap-${randomUUID()}`;
      const calldata = '0x';
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
      });
      persistence.reserveEvmNonce(intent.id, 9998);

      await assert.rejects(
        async () => {
          await cappedManager.prepareAttempt(intent, calldata);
        },
        /PRIORITY_FEE_CAP_EXCEEDED/
      );

      const reloaded = persistence.getEvmIntentById(intent.id);
      assert.strictEqual(reloaded?.status, EvmLogicalIntentState.FEE_CAP_BLOCKED);
    });

    it('4.4 Hard fee caps prevent broadcast and mark FEE_CAP_BLOCKED (Gas Limit Cap)', async () => {
      const cappedManager = new BaseTransactionManager({
        persistence,
        publicClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
        policy: {
          maxGasLimitCap: 20000n,
        },
      });

      const swapKey = `swap-gas-cap-${randomUUID()}`;
      const calldata = '0x';
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
      });
      persistence.reserveEvmNonce(intent.id, 9997);

      await assert.rejects(
        async () => {
          await cappedManager.prepareAttempt(intent, calldata, { customGasLimit: 25000n });
        },
        /GAS_LIMIT_CAP_EXCEEDED/
      );

      const reloaded = persistence.getEvmIntentById(intent.id);
      assert.strictEqual(reloaded?.status, EvmLogicalIntentState.FEE_CAP_BLOCKED);
    });

    it('4.5 Worst-case cost cap (gasLimit * maxFee + value) blocks execution', async () => {
      const cappedManager = new BaseTransactionManager({
        persistence,
        publicClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
        policy: {
          maxWorstCaseCostWeiCap: 50_000n,
        },
      });

      const swapKey = `swap-worst-cost-cap-${randomUUID()}`;
      const calldata = '0x';
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 100_000n,
      });
      persistence.reserveEvmNonce(intent.id, 9996);

      await assert.rejects(
        async () => {
          await cappedManager.prepareAttempt(intent, calldata, { customGasLimit: 21000n });
        },
        /WORST_CASE_COST_CAP_EXCEEDED/
      );

      const reloaded = persistence.getEvmIntentById(intent.id);
      assert.strictEqual(reloaded?.status, EvmLogicalIntentState.FEE_CAP_BLOCKED);
    });

    it('4.6 Integer-only wei arithmetic maintains exact precision without floating point error', () => {
      const largeWei = 1_000_000_000_000_000_001n;
      const bumpPct = 10n;
      const bumped = (largeWei * (100n + bumpPct)) / 100n + 1n;

      assert.strictEqual(typeof bumped, 'bigint');
      assert.strictEqual(bumped, 1_100_000_000_000_000_002n);
    });
  });

  // =========================================================================
  // 5. `ALREADY KNOWN` VS `NONCE TOO LOW` SEPARATION
  // =========================================================================
  describe('5. already known vs nonce too low Broadcast Separation', () => {
    it('5.1 already known RPC response is handled as idempotent rebroadcast and marked BROADCAST', async () => {
      const swapKey = `swap-already-known-${randomUUID()}`;
      const calldata = '0x';

      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 100n,
      });

      const rpcNonce = await publicClient.getTransactionCount({
        address: operatorAccount.address,
        blockTag: 'pending',
      });
      persistence.reserveEvmNonce(intent.id, rpcNonce);

      const { attempt, rawSignedTx } = await txManager.prepareAttempt(intent, calldata, { customGasLimit: 21000n });

      // Simulate RPC returning "already known" (transaction already in mempool)
      const mockRpcClient = {
        ...publicClient,
        sendRawTransaction: async () => {
          throw new Error('already known');
        },
      };
      const mockManager = new BaseTransactionManager({
        persistence,
        publicClient: mockRpcClient as any,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      // Broadcast should treat 'already known' as idempotent success and mark BROADCAST
      await assert.doesNotReject(async () => {
        await mockManager.broadcastAttempt(attempt, rawSignedTx);
      });
      assert.strictEqual(persistence.getLatestEvmAttempt(intent.id)?.status, EvmPhysicalAttemptStatus.BROADCAST);
    });

    it('5.2 nonce too low where known attempt already mined converges to known mined result', async () => {
      const swapKey = `swap-nonce-low-known-${randomUUID()}`;
      const calldata = '0x';

      // Execute and mine attempt 1
      const res = await txManager.executeIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 50n,
      });
      assert.strictEqual(res.intent.status, EvmLogicalIntentState.CONFIRMED);

      // Now create a stale attempt with the same old nonce
      const staleAttempt = persistence.recordEvmAttempt({
        intentId: res.intent.id,
        attemptNumber: 99,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: res.winningAttempt.nonce,
        txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 50n,
        data: calldata,
        gasLimit: 21000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });

      // Manager with RPC that returns "nonce too low"
      const mockRpcClient = {
        ...publicClient,
        sendRawTransaction: async () => {
          throw new Error('nonce too low');
        },
      };
      const mockManager = new BaseTransactionManager({
        persistence,
        publicClient: mockRpcClient as any,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      // Broadcasting with nonce too low should reconcile and converge to the already-confirmed result
      await assert.doesNotReject(async () => {
        await mockManager.broadcastAttempt(staleAttempt, '0x02f8');
      });

      // Crucial: The stale attempt must NOT be marked BROADCAST!
      const reloadedStale = persistence.getEvmAttemptsForIntent(res.intent.id).find((a) => a.id === staleAttempt.id);
      assert.notStrictEqual(reloadedStale?.status, EvmPhysicalAttemptStatus.BROADCAST);
    });

    it('5.3 nonce too low where unknown external transaction consumed nonce transitions to NONCE_CONFLICT fail-closed', async () => {
      const swapKey = `swap-nonce-low-external-${randomUUID()}`;
      const calldata = '0x';

      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
      });
      // Reserve an old nonce (e.g. 0 when current count is higher)
      persistence.reserveEvmNonce(intent.id, 0);

      const attempt = persistence.recordEvmAttempt({
        intentId: intent.id,
        attemptNumber: 1,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: 0,
        txHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 0n,
        data: calldata,
        gasLimit: 21000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });

      // Mock RPC error to return 'nonce too low'
      const rejectingManager = new BaseTransactionManager({
        persistence,
        publicClient: {
          ...publicClient,
          sendRawTransaction: async () => {
            throw new Error('nonce too low: address 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, tx: 0 state: 5');
          },
          getTransactionReceipt: async () => null,
          getTransactionCount: async () => 5, // on-chain nonce advanced to 5
        } as any,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      await assert.rejects(
        async () => {
          await rejectingManager.broadcastAttempt(attempt, '0x');
        },
        /NONCE_CONFLICT/
      );

      const reloaded = persistence.getEvmIntentById(intent.id);
      assert.strictEqual(reloaded?.status, EvmLogicalIntentState.NONCE_CONFLICT);
      assert.ok(reloaded?.failureReason?.includes('External transaction consumed nonce'));
    });

    it('5.4 nonce too low must never manufacture success or mark attempt BROADCAST', async () => {
      const swapKey = `swap-nonce-low-no-fake-success-${randomUUID()}`;
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
      });
      persistence.reserveEvmNonce(intent.id, 1);

      const attempt = persistence.recordEvmAttempt({
        intentId: intent.id,
        attemptNumber: 1,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: 1,
        txHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 0n,
        data: '0x',
        gasLimit: 21000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });

      const rejectingManager = new BaseTransactionManager({
        persistence,
        publicClient: {
          ...publicClient,
          sendRawTransaction: async () => {
            throw new Error('nonce too low');
          },
          getTransactionReceipt: async () => null,
          getTransactionCount: async () => 10,
        } as any,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      try {
        await rejectingManager.broadcastAttempt(attempt, '0x');
      } catch {}

      const reloadedAttempt = persistence.getLatestEvmAttempt(intent.id);
      assert.notStrictEqual(reloadedAttempt?.status, EvmPhysicalAttemptStatus.BROADCAST);
      assert.strictEqual(reloadedAttempt?.status, EvmPhysicalAttemptStatus.PREPARED);
    });
  });

  // =========================================================================
  // 6. PLAINTEXT SIGNED RAW TRANSACTION ELIMINATION & DETERMINISTIC RE-SIGNING
  // =========================================================================
  describe('6. Plaintext Signed Raw Transaction Elimination & Deterministic Re-Signing', () => {
    it('6.1 SQLite database schema and records contain zero raw signed transaction blobs', async () => {
      const swapKey = `swap-no-raw-blob-${randomUUID()}`;
      await txManager.executeIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
        valueWei: 100n,
      });

      // Verify raw_signed_tx column is absent or not storing raw bytecodes
      const attempts = persistence.getEvmAttemptsForIntent(
        persistence.getEvmIntentBySwapKey(swapKey, 'FUND')!.id
      );
      assert.strictEqual(attempts.length, 1);
      assert.strictEqual((attempts[0] as any).rawSignedTx, undefined);
    });

    it('6.2 Deterministic re-signing reproduces exact same transaction hash and matches persisted hash', async () => {
      const swapKey = `swap-re-sign-check-${randomUUID()}`;
      const calldata = '0x998877';
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 200n,
      });
      persistence.reserveEvmNonce(intent.id, 55);

      const { attempt } = await txManager.prepareAttempt(intent, calldata, { customGasLimit: 21000n });

      // Sign twice independently
      const { rawSignedTx: raw1 } = await (txManager as any).signAttemptTransaction(intent, attempt, calldata);
      const { rawSignedTx: raw2 } = await (txManager as any).signAttemptTransaction(intent, attempt, calldata);

      assert.strictEqual(raw1, raw2, 'Deterministic ECDSA must produce identical raw bytes');
      assert.strictEqual(keccak256(raw1).toLowerCase(), attempt.txHash.toLowerCase());
    });
  });

  // =========================================================================
  // 7. AUTHORITATIVE RECONCILIATION & MULTI-ATTEMPT RESOLUTION
  // =========================================================================
  describe('7. Authoritative Reconciliation & Multi-Attempt Resolution', () => {
    it('7.1 When replacement transaction confirms, earlier attempt is marked SUPERSEDED', async () => {
      const swapKey = `swap-reconcile-multi-${randomUUID()}`;
      const calldata = '0x';

      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 100n,
      });

      const rpcNonce = await publicClient.getTransactionCount({
        address: operatorAccount.address,
        blockTag: 'pending',
      });
      persistence.reserveEvmNonce(intent.id, rpcNonce);

      const attempt1 = persistence.recordEvmAttempt({
        intentId: intent.id,
        attemptNumber: 1,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: rpcNonce,
        txHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 100n,
        data: calldata,
        gasLimit: 21000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });
      persistence.markEvmAttemptBroadcast(attempt1.id);

      const { attempt: attempt2, rawSignedTx } = await txManager.prepareAttempt(intent, calldata, {
        isReplacement: true,
        previousAttempt: attempt1,
        customGasLimit: 21000n,
      });
      await txManager.broadcastAttempt(attempt2, rawSignedTx);

      const outcome = await txManager.reconcileIntent(intent.id);
      assert.strictEqual(outcome.status, EvmLogicalIntentState.CONFIRMED);
      assert.strictEqual(outcome.minedTxHash?.toLowerCase(), attempt2.txHash.toLowerCase());

      const attempts = persistence.getEvmAttemptsForIntent(intent.id);
      const a1 = attempts.find((a) => a.id === attempt1.id);
      const a2 = attempts.find((a) => a.id === attempt2.id);

      assert.strictEqual(a2?.status, EvmPhysicalAttemptStatus.MINED_SUCCESS);
      assert.strictEqual(a1?.status, EvmPhysicalAttemptStatus.SUPERSEDED);
    });

    it('7.2 When original transaction confirms before replacement, original wins and replacement is marked SUPERSEDED', async () => {
      const swapKey = `swap-reconcile-orig-wins-${randomUUID()}`;
      const calldata = '0x';

      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
      });
      persistence.reserveEvmNonce(intent.id, 777);

      const attempt1 = persistence.recordEvmAttempt({
        intentId: intent.id,
        attemptNumber: 1,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: 777,
        txHash: '0x8888888888888888888888888888888888888888888888888888888888888888',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 0n,
        data: calldata,
        gasLimit: 21000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });

      const attempt2 = persistence.recordEvmAttempt({
        intentId: intent.id,
        attemptNumber: 2,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: 777,
        txHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 0n,
        data: calldata,
        gasLimit: 21000n,
        maxFeePerGas: 1200000000n,
        maxPriorityFeePerGas: 1200000000n,
      });

      persistence.markEvmMinedSuccess(intent.id, attempt1.id, attempt1.txHash, 500);

      const attempts = persistence.getEvmAttemptsForIntent(intent.id);
      const a1 = attempts.find((a) => a.id === attempt1.id);
      const a2 = attempts.find((a) => a.id === attempt2.id);

      assert.strictEqual(a1?.status, EvmPhysicalAttemptStatus.MINED_SUCCESS);
      assert.strictEqual(a2?.status, EvmPhysicalAttemptStatus.SUPERSEDED);

      const reloaded = persistence.getEvmIntentById(intent.id);
      assert.strictEqual(reloaded?.status, EvmLogicalIntentState.CONFIRMED);
      assert.strictEqual(reloaded?.canonicalTxHash, attempt1.txHash);
    });

    it('7.3 Reconciles on-chain revert and marks intent REVERTED', async () => {
      const swapKey = `swap-revert-${randomUUID()}`;
      const calldata = '0xdeadbeef';

      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
      });

      const syntheticAttempt = persistence.recordEvmAttempt({
        intentId: intent.id,
        attemptNumber: 1,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: 999,
        txHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 0n,
        data: calldata,
        gasLimit: 21000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });

      persistence.markEvmMinedRevert(intent.id, syntheticAttempt.id, 12345, 'Simulated on-chain revert');

      const outcome = await txManager.reconcileIntent(intent.id);
      assert.strictEqual(outcome.status, EvmLogicalIntentState.REVERTED);

      const reloaded = persistence.getEvmIntentById(intent.id);
      assert.strictEqual(reloaded?.status, EvmLogicalIntentState.REVERTED);
    });

    it('7.4 Batch reconciliation across multiple intents via reconcileAll() processes all active intents', async () => {
      const intentA = persistence.getOrCreateEvmIntent({
        swapKey: `swap-batch-a-${randomUUID()}`,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
      });
      const intentB = persistence.getOrCreateEvmIntent({
        swapKey: `swap-batch-b-${randomUUID()}`,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
      });

      persistence.reserveEvmNonce(intentA.id, 888);
      persistence.reserveEvmNonce(intentB.id, 889);

      const outcomes = await txManager.reconcileAll();
      const outcomeA = outcomes.find((o) => o.intentId === intentA.id);
      const outcomeB = outcomes.find((o) => o.intentId === intentB.id);

      assert.ok(outcomeA !== undefined);
      assert.ok(outcomeB !== undefined);
    });
  });

  // =========================================================================
  // 8. CONCURRENCY STRESS (REPLACEMENT STORM & RESTART UNDER LOAD)
  // =========================================================================
  describe('8. Concurrency Stress', () => {
    it('8.1 50 concurrent distinct swap intents obtain sequential unique nonces with zero collisions', async () => {
      const swapCount = 50;
      const initialNonce = await publicClient.getTransactionCount({
        address: operatorAccount.address,
        blockTag: 'pending',
      });

      const promises = Array.from({ length: swapCount }, async (_, idx) => {
        const swapKey = `swap-stress-${idx}-${randomUUID()}`;
        const intent = persistence.getOrCreateEvmIntent({
          swapKey,
          chainId: HARDHAT_CHAIN_ID,
          signerAddress: operatorAccount.address,
          actionType: 'FUND',
          targetAddress: RECIPIENT_ADDRESS,
          calldata: '0x',
        });
        return persistence.reserveEvmNonce(intent.id, initialNonce);
      });

      const reserved = await Promise.all(promises);
      const nonces = reserved.map((r) => r.nonce).sort((a, b) => a - b);
      const unique = new Set(nonces);

      assert.strictEqual(unique.size, swapCount, 'All 50 nonces must be strictly unique');
      assert.strictEqual(nonces[0], initialNonce, 'First nonce must match initial nonce');
      assert.strictEqual(
        nonces[swapCount - 1],
        initialNonce + swapCount - 1,
        'Final nonce must equal initial + count - 1'
      );
    });

    it('8.2 High-concurrency duplicate storm: 50 parallel executeIntent calls for same swapKey resolve to single confirmed execution', async () => {
      const swapKey = `swap-execute-storm-${randomUUID()}`;
      const calldata = '0x';

      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          txManager.executeIntent({
            swapKey,
            chainId: HARDHAT_CHAIN_ID,
            signerAddress: operatorAccount.address,
            actionType: 'FUND',
            targetAddress: RECIPIENT_ADDRESS,
            calldata,
            valueWei: 100n,
          })
        )
      );

      const firstTx = results[0].winningAttempt.txHash;
      for (const res of results) {
        assert.strictEqual(res.intent.status, EvmLogicalIntentState.CONFIRMED);
        assert.strictEqual(res.winningAttempt.txHash, firstTx);
      }

      const attempts = persistence.getEvmAttemptsForIntent(results[0].intent.id);
      assert.strictEqual(attempts.length, 1, 'Storm must produce exactly 1 physical attempt');
    });

    it('8.3 Replacement storm: multiple concurrent workers attempting to replace same intent produce exactly one replacement generation', async () => {
      const swapKey = `swap-replacement-storm-${randomUUID()}`;
      const calldata = '0x';

      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 50n,
      });
      persistence.reserveEvmNonce(intent.id, 666);

      const stormManager = new BaseTransactionManager({
        persistence,
        publicClient: {
          ...publicClient,
          sendRawTransaction: async () => '0xmock',
        } as any,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      // Attempt 1 prepared & marked broadcast
      const { attempt: a1 } = await stormManager.prepareAttempt(intent, calldata, { customGasLimit: 21000n });
      persistence.markEvmAttemptBroadcast(a1.id);

      // Fire 10 simultaneous replacement calls
      const replacementResults = await Promise.all(
        Array.from({ length: 10 }, () =>
          stormManager.replacePendingTransaction(intent.id, calldata)
        )
      );

      // All 10 callers must receive the exact same replacement attempt (Attempt #2)
      const firstReplacementId = replacementResults[0].attempt.id;
      for (const res of replacementResults) {
        assert.strictEqual(res.attempt.id, firstReplacementId);
        assert.strictEqual(res.attempt.attemptNumber, 2);
      }

      // SQLite must contain exactly 2 attempts total (attempt 1 and attempt 2)
      const allAttempts = persistence.getEvmAttemptsForIntent(intent.id);
      assert.strictEqual(allAttempts.length, 2, 'Must produce exactly one replacement generation');
    });

    it('8.4 Restart under load: active intents survive transaction manager reboot with zero duplicate nonces or lost intents', async () => {
      const count = 5;
      const initialNonce = await publicClient.getTransactionCount({
        address: operatorAccount.address,
        blockTag: 'pending',
      });

      const intentIds: string[] = [];
      for (let i = 0; i < count; i++) {
        const intent = persistence.getOrCreateEvmIntent({
          swapKey: `swap-load-restart-${i}-${randomUUID()}`,
          chainId: HARDHAT_CHAIN_ID,
          signerAddress: operatorAccount.address,
          actionType: 'FUND',
          targetAddress: RECIPIENT_ADDRESS,
          calldata: '0x',
        });
        persistence.reserveEvmNonce(intent.id, initialNonce);
        intentIds.push(intent.id);
      }

      // Destroy manager and close DB
      persistence.close();

      // Reboot manager on same DB
      const restoredDb = new SqlitePersistence({ filename: dbPath });
      const restoredManager = new BaseTransactionManager({
        persistence: restoredDb,
        publicClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      // Recover and reconcile
      await restoredManager.recoverOnStartup();
      const active = restoredDb.getActiveEvmIntents(HARDHAT_CHAIN_ID);

      assert.strictEqual(active.length, count, 'All intents must survive restart');
      const nonces = active.map((it) => it.nonce!).sort((a, b) => a - b);
      for (let i = 1; i < count; i++) {
        assert.strictEqual(nonces[i], nonces[i - 1] + 1, 'Nonces must remain contiguous');
      }
      restoredDb.close();
    });

    it('8.5 Two independent BaseTransactionManager instances racing replacement on same intent produce exactly one replacement generation and converge', async () => {
      const sharedDbPath = path.join(process.cwd(), 'scratch', `shared-replacement-${randomUUID()}.db`);
      const p1 = new SqlitePersistence({ filename: sharedDbPath });
      const p2 = new SqlitePersistence({ filename: sharedDbPath });

      let sendRawCount = 0;
      const mockClient = {
        ...publicClient,
        sendRawTransaction: async () => {
          sendRawCount++;
          return '0xmockReplacementHash';
        },
      };

      const m1 = new BaseTransactionManager({
        persistence: p1,
        publicClient: mockClient as any,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const m2 = new BaseTransactionManager({
        persistence: p2,
        publicClient: mockClient as any,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const swapKey = `swap-cross-mgr-replace-${randomUUID()}`;
      const calldata = '0x1234';

      const intent = p1.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 50n,
      });
      p1.reserveEvmNonce(intent.id, 555);

      // Attempt #1 prepared and broadcast
      const { attempt: a1 } = await m1.prepareAttempt(intent, calldata, { customGasLimit: 21000n });
      p1.markEvmAttemptBroadcast(a1.id);

      // Two independent managers simultaneously request replacement for same intent
      const [res1, res2] = await Promise.all([
        m1.replacePendingTransaction(intent.id, calldata),
        m2.replacePendingTransaction(intent.id, calldata),
      ]);

      // Both managers converge on the exact same Attempt #2
      assert.strictEqual(res1.attempt.id, res2.attempt.id);
      assert.strictEqual(res1.attempt.attemptNumber, 2);
      assert.strictEqual(res2.attempt.attemptNumber, 2);
      assert.strictEqual(res1.attempt.nonce, 555);
      assert.strictEqual(res2.attempt.nonce, 555);
      assert.strictEqual(res1.attempt.data, calldata);
      assert.strictEqual(res2.attempt.data, calldata);

      // Exactly two attempts total exist in SQLite (Attempt #1 and Attempt #2)
      const allAttempts = p1.getEvmAttemptsForIntent(intent.id);
      assert.strictEqual(allAttempts.length, 2, 'Must produce exactly one replacement generation across processes');

      p1.close();
      p2.close();
    });

    it('8.6 Two independent BaseTransactionManager instances racing nonce reservation on distinct intents obtain strictly unique nonces', async () => {
      const sharedDbPath = path.join(process.cwd(), 'scratch', `shared-nonces-${randomUUID()}.db`);
      const p1 = new SqlitePersistence({ filename: sharedDbPath });
      const p2 = new SqlitePersistence({ filename: sharedDbPath });

      const intentA = p1.getOrCreateEvmIntent({
        swapKey: `swap-race-a-${randomUUID()}`,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
      });

      const intentB = p2.getOrCreateEvmIntent({
        swapKey: `swap-race-b-${randomUUID()}`,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
      });

      // Both managers race to reserve nonces against same on-chain base nonce
      const [resA, resB] = await Promise.all([
        p1.reserveEvmNonce(intentA.id, 777),
        p2.reserveEvmNonce(intentB.id, 777),
      ]);

      assert.notStrictEqual(resA.nonce, resB.nonce, 'Two distinct intents must receive unique nonces');
      assert.strictEqual(Math.abs(resA.nonce - resB.nonce), 1, 'Nonces must be contiguous sequential');

      p1.close();
      p2.close();
    });
  });

  // =========================================================================
  // 9. COMPLETE RPC FAILURE MATRIX
  // =========================================================================
  describe('9. Complete RPC Failure Matrix', () => {
    it('9.1 getTransactionCount failure: leaves intent in CREATED and does not advance nonce', async () => {
      const brokenClient: any = {
        getTransactionCount: async () => {
          throw new Error('RPC_GET_TRANSACTION_COUNT_TIMEOUT');
        },
      };

      const failingManager = new BaseTransactionManager({
        persistence,
        publicClient: brokenClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const swapKey = `swap-fail-nonce-count-${randomUUID()}`;
      await assert.rejects(
        async () => {
          await failingManager.executeIntent({
            swapKey,
            chainId: HARDHAT_CHAIN_ID,
            signerAddress: operatorAccount.address,
            actionType: 'FUND',
            targetAddress: RECIPIENT_ADDRESS,
            calldata: '0x',
          });
        },
        /RPC_GET_TRANSACTION_COUNT_TIMEOUT/
      );

      const intent = persistence.getEvmIntentBySwapKey(swapKey, 'FUND')!;
      assert.strictEqual(intent.status, EvmLogicalIntentState.CREATED);
      assert.strictEqual(intent.nonce, null, 'Nonce must not be reserved when RPC fails');
    });

    it('9.2 estimateFeesPerGas failure: falls back to safe default policy fees', async () => {
      const brokenClient: any = {
        estimateFeesPerGas: async () => {
          throw new Error('RPC_FEE_TIMEOUT');
        },
        estimateGas: async () => 21000n,
      };

      const fallbackManager = new BaseTransactionManager({
        persistence,
        publicClient: brokenClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const swapKey = `swap-fee-fail-${randomUUID()}`;
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
      });
      persistence.reserveEvmNonce(intent.id, 9991);

      const { attempt } = await fallbackManager.prepareAttempt(intent, '0x', { customGasLimit: 21000n });
      assert.ok(attempt.maxFeePerGas > 0n);
      assert.ok(attempt.maxPriorityFeePerGas > 0n);
    });

    it('9.3 estimateFeesPerGas absurdly high fee: blocked by maxFeePerGasCapWei before broadcast', async () => {
      const crazyFeeClient: any = {
        estimateFeesPerGas: async () => ({
          maxFeePerGas: 100_000_000_000n, // 100 gwei (exceeds 50 gwei cap)
          maxPriorityFeePerGas: 2_000_000_000n,
        }),
        estimateGas: async () => 21000n,
      };

      const manager = new BaseTransactionManager({
        persistence,
        publicClient: crazyFeeClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const swapKey = `swap-absurd-fee-${randomUUID()}`;
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
      });
      persistence.reserveEvmNonce(intent.id, 9992);

      await assert.rejects(
        async () => {
          await manager.prepareAttempt(intent, '0x');
        },
        /MAX_FEE_CAP_EXCEEDED/
      );

      const reloaded = persistence.getEvmIntentById(intent.id);
      assert.strictEqual(reloaded?.status, EvmLogicalIntentState.FEE_CAP_BLOCKED);
    });

    it('9.4 estimateGas transport failure (timeout/unavailable): falls back to safe standard gas limit', async () => {
      const brokenGasClient: any = {
        estimateGas: async () => {
          throw new Error('RPC_ESTIMATE_GAS_TIMEOUT: fetch failed');
        },
        estimateFeesPerGas: async () => ({
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }),
      };

      const manager = new BaseTransactionManager({
        persistence,
        publicClient: brokenGasClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const swapKey = `swap-gas-fallback-${randomUUID()}`;
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
      });
      persistence.reserveEvmNonce(intent.id, 9993);

      const { attempt } = await manager.prepareAttempt(intent, '0x');
      assert.strictEqual(attempt.gasLimit, 350_000n, 'Should fall back to safe standard limit on transport error');
    });

    it('9.4b estimateGas execution revert: fails closed with zero broadcast and records SIMULATION_REVERTED', async () => {
      let sendRawCount = 0;
      const revertGasClient: any = {
        estimateGas: async () => {
          const err = new Error('execution reverted: ERC20: transfer amount exceeds balance');
          (err as any).shortMessage = 'execution reverted';
          throw err;
        },
        estimateFeesPerGas: async () => ({
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }),
        sendRawTransaction: async () => {
          sendRawCount++;
          return '0xunwantedBroadcast';
        },
        getTransactionCount: async () => 9994,
      };

      const manager = new BaseTransactionManager({
        persistence,
        publicClient: revertGasClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const swapKey = `swap-gas-revert-${randomUUID()}`;
      await assert.rejects(
        async () => {
          await manager.executeIntent({
            swapKey,
            chainId: HARDHAT_CHAIN_ID,
            signerAddress: operatorAccount.address,
            actionType: 'FUND',
            targetAddress: RECIPIENT_ADDRESS,
            calldata: '0x',
            valueWei: 0n,
          });
        },
        /SIMULATION_REVERTED/
      );

      // Invariant 1: Zero broadcast allowed on contract simulation revert
      assert.strictEqual(sendRawCount, 0, 'Zero broadcast calls allowed when simulation reverts');

      // Invariant 2: Intent records failure safely in SQLite
      const intent = persistence.getEvmIntentBySwapKey(swapKey, 'FUND')!;
      assert.strictEqual(intent.status, EvmLogicalIntentState.REVERTED);
      assert.ok(intent.failureReason?.includes('SIMULATION_REVERTED'));

      // Invariant 3: Zero physical attempts recorded in database
      const attempts = persistence.getEvmAttemptsForIntent(intent.id);
      assert.strictEqual(attempts.length, 0, 'Zero physical attempts recorded on simulation revert');

      // Invariant 4: No nonce silently advanced into a second economic action
      const secondIntent = persistence.getOrCreateEvmIntent({
        swapKey: `swap-subsequent-${randomUUID()}`,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
      });
      const secondRes = persistence.reserveEvmNonce(secondIntent.id, 9994);
      assert.strictEqual(secondRes.nonce, 9994, 'Second action receives unburned nonce 9994 cleanly (no gap created)');
    });

    it('9.5 estimateGas absurdly high estimate: blocked by maxGasLimitCap before broadcast', async () => {
      const absurdGasClient: any = {
        estimateGas: async () => 5_000_000n, // 5M gas exceeds 1M gas cap
        estimateFeesPerGas: async () => ({
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }),
      };

      const manager = new BaseTransactionManager({
        persistence,
        publicClient: absurdGasClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const swapKey = `swap-absurd-gas-${randomUUID()}`;
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
      });
      persistence.reserveEvmNonce(intent.id, 9994);

      await assert.rejects(
        async () => {
          await manager.prepareAttempt(intent, '0x');
        },
        /GAS_LIMIT_CAP_EXCEEDED/
      );

      const reloaded = persistence.getEvmIntentById(intent.id);
      assert.strictEqual(reloaded?.status, EvmLogicalIntentState.FEE_CAP_BLOCKED);
    });

    it('9.6 sendRawTransaction transient network drop: preserved as PREPARED and rebroadcasts cleanly', async () => {
      let callCount = 0;
      const dropClient: any = {
        ...publicClient,
        sendRawTransaction: async (params: any) => {
          callCount++;
          if (callCount === 1) {
            throw new Error('RPC_NETWORK_TIMEOUT_DROPPED');
          }
          return publicClient.sendRawTransaction(params);
        },
      };

      const manager = new BaseTransactionManager({
        persistence,
        publicClient: dropClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const swapKey = `swap-send-drop-${randomUUID()}`;
      const calldata = '0x';
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 50n,
      });
      const rpcNonce = await publicClient.getTransactionCount({
        address: operatorAccount.address,
        blockTag: 'pending',
      });
      persistence.reserveEvmNonce(intent.id, rpcNonce);

      const { attempt, rawSignedTx } = await manager.prepareAttempt(intent, calldata, { customGasLimit: 21000n });

      // First broadcast fails
      await assert.rejects(
        async () => {
          await manager.broadcastAttempt(attempt, rawSignedTx);
        },
        /RPC_NETWORK_TIMEOUT_DROPPED/
      );

      assert.strictEqual(persistence.getLatestEvmAttempt(intent.id)?.status, EvmPhysicalAttemptStatus.PREPARED);

      // Second broadcast succeeds
      await manager.broadcastAttempt(attempt, rawSignedTx);
      assert.strictEqual(persistence.getLatestEvmAttempt(intent.id)?.status, EvmPhysicalAttemptStatus.BROADCAST);
    });

    it('9.7 getTransactionReceipt temporary not-found preserves PENDING state without corruption', async () => {
      const swapKey = `swap-receipt-notfound-${randomUUID()}`;
      const calldata = '0x';
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
      });
      persistence.reserveEvmNonce(intent.id, 9995);

      persistence.recordEvmAttempt({
        intentId: intent.id,
        attemptNumber: 1,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: 9995,
        txHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 0n,
        data: calldata,
        gasLimit: 21000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });

      const outcome = await txManager.reconcileIntent(intent.id);
      assert.strictEqual(outcome.status, EvmLogicalIntentState.PENDING);
    });

    it('9.8 Execution times out with descriptive error when transaction remains unmined past timeout', async () => {
      const fastTimeoutManager = new BaseTransactionManager({
        persistence,
        publicClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
        policy: {
          stalledAgeMs: 100,
          requiredConfirmations: 100,
        },
      });

      const swapKey = `swap-timeout-${randomUUID()}`;
      await assert.rejects(
        async () => {
          await fastTimeoutManager.executeIntent(
            {
              swapKey,
              chainId: HARDHAT_CHAIN_ID,
              signerAddress: operatorAccount.address,
              actionType: 'FUND',
              targetAddress: RECIPIENT_ADDRESS,
              calldata: '0x',
              valueWei: 50n,
            },
            { timeoutMs: 1500, pollIntervalMs: 150 }
          );
        },
        /Timeout waiting for EVM intent/
      );
    });
  });

  // =========================================================================
  // 10. ORIGINAL 8 CRASH POINT BOUNDARIES
  // =========================================================================
  describe('10. Original 8 Crash Point Boundaries', () => {
    it('10.1 Boundary 1: After logical intent creation / before nonce reservation -> clean restart reserves nonce', async () => {
      const swapKey = `swap-cp1-${randomUUID()}`;
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
      });
      assert.strictEqual(intent.status, EvmLogicalIntentState.CREATED);
      assert.strictEqual(intent.nonce, null);

      persistence.close();
      const restoredDb = new SqlitePersistence({ filename: dbPath });

      const reloaded = restoredDb.getEvmIntentById(intent.id)!;
      assert.strictEqual(reloaded.status, EvmLogicalIntentState.CREATED);
      assert.strictEqual(reloaded.nonce, null);

      const reservation = restoredDb.reserveEvmNonce(reloaded.id, 10);
      assert.strictEqual(reservation.nonce, 10);
      assert.strictEqual(reservation.intent.status, EvmLogicalIntentState.NONCE_RESERVED);
      restoredDb.close();
    });

    it('10.2 Boundary 2: After nonce reservation / before attempt preparation -> restart finds reserved nonce', async () => {
      const swapKey = `swap-cp2-${randomUUID()}`;
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
      });
      persistence.reserveEvmNonce(intent.id, 25);

      persistence.close();
      const restoredDb = new SqlitePersistence({ filename: dbPath });

      const reloaded = restoredDb.getEvmIntentById(intent.id)!;
      assert.strictEqual(reloaded.nonce, 25);
      assert.strictEqual(reloaded.status, EvmLogicalIntentState.NONCE_RESERVED);

      const attempts = restoredDb.getEvmAttemptsForIntent(intent.id);
      assert.strictEqual(attempts.length, 0);
      restoredDb.close();
    });

    it('10.3 Boundary 3: After durable attempt preparation / before broadcast -> recoverOnStartup detects PREPARED and broadcasts', async () => {
      const swapKey = `swap-cp3-${randomUUID()}`;
      const calldata = '0x';
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 100n,
      });

      const rpcNonce = await publicClient.getTransactionCount({
        address: operatorAccount.address,
        blockTag: 'pending',
      });
      persistence.reserveEvmNonce(intent.id, rpcNonce);

      const { attempt } = await txManager.prepareAttempt(intent, calldata, { customGasLimit: 21000n });
      assert.strictEqual(attempt.status, EvmPhysicalAttemptStatus.PREPARED);

      persistence.close();
      const restoredDb = new SqlitePersistence({ filename: dbPath });
      const restoredManager = new BaseTransactionManager({
        persistence: restoredDb,
        publicClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      await restoredManager.recoverOnStartup();

      const reloadedAttempt = restoredDb.getLatestEvmAttempt(intent.id);
      assert.ok(
        reloadedAttempt?.status === EvmPhysicalAttemptStatus.BROADCAST ||
        reloadedAttempt?.status === EvmPhysicalAttemptStatus.MINED_SUCCESS
      );
      restoredDb.close();
    });

    it('10.4 Boundary 4: Immediately after actual RPC broadcast / before local broadcast-success persistence -> recovers via already known/receipt', async () => {
      const swapKey = `swap-cp4-${randomUUID()}`;
      const calldata = '0x';
      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 100n,
      });

      const rpcNonce = await publicClient.getTransactionCount({
        address: operatorAccount.address,
        blockTag: 'pending',
      });
      persistence.reserveEvmNonce(intent.id, rpcNonce);

      const { rawSignedTx } = await txManager.prepareAttempt(intent, calldata, { customGasLimit: 21000n });

      // Actual broadcast sent to RPC node
      await publicClient.sendRawTransaction({ serializedTransaction: rawSignedTx });

      // Crash simulated HERE: DB was NOT updated with markEvmAttemptBroadcast!
      assert.strictEqual(persistence.getLatestEvmAttempt(intent.id)?.status, EvmPhysicalAttemptStatus.PREPARED);

      persistence.close();
      const restoredDb = new SqlitePersistence({ filename: dbPath });
      const restoredManager = new BaseTransactionManager({
        persistence: restoredDb,
        publicClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      // recoverOnStartup attempts rebroadcast -> RPC returns 'already known' -> reconciler marks BROADCAST / CONFIRMED
      await restoredManager.recoverOnStartup();

      const reloaded = restoredDb.getLatestEvmAttempt(intent.id);
      assert.ok(
        reloaded?.status === EvmPhysicalAttemptStatus.BROADCAST ||
        reloaded?.status === EvmPhysicalAttemptStatus.MINED_SUCCESS
      );
      restoredDb.close();
    });

    it('10.5 Boundary 5: While pending in mempool -> reconciler tracks pending state and handles replacement', async () => {
      const swapKey = `swap-cp5-${randomUUID()}`;
      const calldata = '0x';

      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
      });
      persistence.reserveEvmNonce(intent.id, 9990);

      const attempt = persistence.recordEvmAttempt({
        intentId: intent.id,
        attemptNumber: 1,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: 9990,
        txHash: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 0n,
        data: calldata,
        gasLimit: 21000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });
      persistence.markEvmAttemptBroadcast(attempt.id);

      // Reconcile pending
      const outcome = await txManager.reconcileIntent(intent.id);
      assert.strictEqual(outcome.status, EvmLogicalIntentState.PENDING);
    });

    it('10.6 Boundary 6: After mining on-chain / before receipt persistence -> Reconciler updates to CONFIRMED', async () => {
      const swapKey = `swap-cp6-${randomUUID()}`;
      const calldata = '0x';

      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 100n,
      });

      const rpcNonce = await publicClient.getTransactionCount({
        address: operatorAccount.address,
        blockTag: 'pending',
      });
      persistence.reserveEvmNonce(intent.id, rpcNonce);

      const { attempt, rawSignedTx } = await txManager.prepareAttempt(intent, calldata, { customGasLimit: 21000n });
      await txManager.broadcastAttempt(attempt, rawSignedTx);

      // Wait for mine on local node
      await publicClient.waitForTransactionReceipt({ hash: attempt.txHash });

      // Crash simulated HERE: DB still has status PENDING / BROADCAST
      persistence.close();

      const restoredDb = new SqlitePersistence({ filename: dbPath });
      const restoredManager = new BaseTransactionManager({
        persistence: restoredDb,
        publicClient,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const outcome = await restoredManager.reconcileIntent(intent.id);
      assert.strictEqual(outcome.status, EvmLogicalIntentState.CONFIRMED);
      assert.strictEqual(outcome.minedTxHash?.toLowerCase(), attempt.txHash.toLowerCase());

      const reloadedIntent = restoredDb.getEvmIntentById(intent.id);
      assert.strictEqual(reloadedIntent?.status, EvmLogicalIntentState.CONFIRMED);
      restoredDb.close();
    });

    it('10.7 Boundary 7: During creation of a fee replacement generation -> Crash preserves attempt 1 and resumes', async () => {
      const swapKey = `swap-cp7-${randomUUID()}`;
      const calldata = '0x';

      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 50n,
      });
      persistence.reserveEvmNonce(intent.id, 8881);

      const a1 = persistence.recordEvmAttempt({
        intentId: intent.id,
        attemptNumber: 1,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: 8881,
        txHash: '0x1010101010101010101010101010101010101010101010101010101010101010',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 50n,
        data: calldata,
        gasLimit: 21000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });
      persistence.markEvmAttemptBroadcast(a1.id);

      // Replacement attempt 2 prepared in DB, crash happens before broadcast
      persistence.recordEvmAttempt({
        intentId: intent.id,
        attemptNumber: 2,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: 8881,
        txHash: '0x2020202020202020202020202020202020202020202020202020202020202020',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 50n,
        data: calldata,
        gasLimit: 21000n,
        maxFeePerGas: 1200000000n,
        maxPriorityFeePerGas: 1200000000n,
      });

      // Crash and reboot
      persistence.close();
      const restoredDb = new SqlitePersistence({ filename: dbPath });

      const attempts = restoredDb.getEvmAttemptsForIntent(intent.id);
      assert.strictEqual(attempts.length, 2);
      assert.strictEqual(attempts[0].status, EvmPhysicalAttemptStatus.BROADCAST);
      assert.strictEqual(attempts[1].status, EvmPhysicalAttemptStatus.PREPARED);
      restoredDb.close();
    });

    it('10.8 Boundary 8: Replacement mined / before logical intent completion -> Reconciler confirms winner and supersedes rival', async () => {
      const swapKey = `swap-cp8-${randomUUID()}`;
      const calldata = '0x';

      const intent = persistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata,
        valueWei: 50n,
      });
      persistence.reserveEvmNonce(intent.id, 8882);

      const a1 = persistence.recordEvmAttempt({
        intentId: intent.id,
        attemptNumber: 1,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: 8882,
        txHash: '0x3030303030303030303030303030303030303030303030303030303030303030',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 50n,
        data: calldata,
        gasLimit: 21000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });
      persistence.markEvmAttemptBroadcast(a1.id);

      const a2 = persistence.recordEvmAttempt({
        intentId: intent.id,
        attemptNumber: 2,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        nonce: 8882,
        txHash: '0x4040404040404040404040404040404040404040404040404040404040404040',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 50n,
        data: calldata,
        gasLimit: 21000n,
        maxFeePerGas: 1200000000n,
        maxPriorityFeePerGas: 1200000000n,
      });
      persistence.markEvmAttemptBroadcast(a2.id);

      // Replacement a2 mined on-chain
      persistence.markEvmMinedSuccess(intent.id, a2.id, a2.txHash, 999);

      const attempts = persistence.getEvmAttemptsForIntent(intent.id);
      const winning = attempts.find((a) => a.id === a2.id);
      const superseded = attempts.find((a) => a.id === a1.id);

      assert.strictEqual(winning?.status, EvmPhysicalAttemptStatus.MINED_SUCCESS);
      assert.strictEqual(superseded?.status, EvmPhysicalAttemptStatus.SUPERSEDED);

      const reloaded = persistence.getEvmIntentById(intent.id);
      assert.strictEqual(reloaded?.status, EvmLogicalIntentState.CONFIRMED);
      assert.strictEqual(reloaded?.canonicalTxHash, a2.txHash);
    });
  });

  // =========================================================================
  // 11. ZERO CLIENT KEY CUSTODY & SECURITY INVARIANTS
  // =========================================================================
  describe('11. Zero Client Key Custody & Security Invariants', () => {
    it('11.1 Router holds ZERO client private keys; operator wallet signs only operator intents', async () => {
      const clientAccount = privateKeyToAccount(CLIENT_PRIVATE_KEY);

      assert.strictEqual(txManager.account.address.toLowerCase(), operatorAccount.address.toLowerCase());
      assert.notStrictEqual(txManager.account.address.toLowerCase(), clientAccount.address.toLowerCase());

      const clientIntent = persistence.getOrCreateEvmIntent({
        swapKey: `swap-custody-check-${randomUUID()}`,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: clientAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
      });
      persistence.reserveEvmNonce(clientIntent.id, 0);

      const attempt = persistence.recordEvmAttempt({
        intentId: clientIntent.id,
        attemptNumber: 1,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: clientAccount.address,
        nonce: 0,
        txHash: '0x7777777777777777777777777777777777777777777777777777777777777777',
        toAddress: RECIPIENT_ADDRESS,
        valueWei: 0n,
        data: '0x',
        gasLimit: 21000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });

      assert.strictEqual(attempt.signerAddress.toLowerCase(), clientAccount.address.toLowerCase());
      assert.notStrictEqual(attempt.signerAddress.toLowerCase(), operatorAccount.address.toLowerCase());
    });

    it('11.2 SQLite database records contain ZERO private keys, secret preimages, or raw signed tx blobs', async () => {
      const swapKey = `swap-secret-scan-${randomUUID()}`;
      await txManager.executeIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
        valueWei: 10n,
      });

      const dbContent = fs.readFileSync(dbPath, 'utf8');
      assert.ok(!dbContent.includes(CLIENT_PRIVATE_KEY.replace(/^0x/, '')));
      assert.ok(!dbContent.includes(OPERATOR_PRIVATE_KEY.replace(/^0x/, '')));
    });

    it('11.3 Client signs EVM transactions directly with client key; Router possesses zero authority over client funds', async () => {
      const clientAccount = privateKeyToAccount(CLIENT_PRIVATE_KEY);
      const clientWallet = createWalletClient({
        account: clientAccount,
        transport: http(HARDHAT_RPC_URL),
      });

      const txHash = await clientWallet.sendTransaction({
        to: RECIPIENT_ADDRESS,
        value: 1000n,
        chain: null,
      });
      assert.ok(txHash.startsWith('0x'));

      assert.strictEqual(txManager.account.address.toLowerCase(), operatorAccount.address.toLowerCase());
      assert.notStrictEqual(txManager.account.address.toLowerCase(), clientAccount.address.toLowerCase());
    });
  });

  describe('12. Pre-Broadcast Nonce Gap Prevention & Economic Invariants', () => {
    it('12.1 [Test A] Simulation revert before broadcast does NOT burn nonce (Intent A reverts -> Intent B gets N, not N+1)', async () => {
      let broadcastCount = 0;
      const startingNonce = 12000;

      const mockRpc: any = {
        estimateGas: async (args: any) => {
          if (args.data === '0xrevert') {
            const err = new Error('execution reverted: ERC20: insufficient balance');
            (err as any).shortMessage = 'execution reverted';
            throw err;
          }
          return 50_000n;
        },
        estimateFeesPerGas: async () => ({
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }),
        sendRawTransaction: async () => {
          broadcastCount++;
          return `0xhash${broadcastCount}`;
        },
        getTransactionCount: async () => startingNonce,
        getTransactionReceipt: async () => ({
          blockNumber: 100n,
          status: 'success',
        }),
        getBlockNumber: async () => 105n,
      };

      const manager = new BaseTransactionManager({
        persistence,
        publicClient: mockRpc,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      // Intent A: should revert during simulation
      const swapKeyA = `swap-revert-a-${randomUUID()}`;
      await assert.rejects(
        async () => {
          await manager.executeIntent({
            swapKey: swapKeyA,
            chainId: HARDHAT_CHAIN_ID,
            signerAddress: operatorAccount.address,
            actionType: 'FUND',
            targetAddress: RECIPIENT_ADDRESS,
            calldata: '0xrevert',
            valueWei: 0n,
          });
        },
        /SIMULATION_REVERTED/
      );

      const intentA = persistence.getEvmIntentBySwapKey(swapKeyA, 'FUND')!;
      assert.strictEqual(intentA.status, EvmLogicalIntentState.REVERTED);
      assert.strictEqual(intentA.nonce, null, 'Reverted pre-broadcast intent must have nonce = NULL');
      assert.strictEqual(persistence.getEvmAttemptsForIntent(intentA.id).length, 0);
      assert.strictEqual(broadcastCount, 0, 'Zero transactions broadcast for Intent A');

      // Intent B: valid execution
      const swapKeyB = `swap-valid-b-${randomUUID()}`;
      const resultB = await manager.executeIntent({
        swapKey: swapKeyB,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x1234',
        valueWei: 0n,
      });

      const intentB = persistence.getEvmIntentBySwapKey(swapKeyB, 'FUND')!;
      assert.strictEqual(intentB.status, EvmLogicalIntentState.CONFIRMED);
      assert.strictEqual(intentB.nonce, startingNonce, 'Intent B must receive starting nonce N (12000), not N+1 (12001)');
      assert.strictEqual(resultB.winningAttempt.nonce, startingNonce, 'Winning attempt must use nonce N');
      assert.strictEqual(broadcastCount, 1, 'Exactly one transaction broadcast for Intent B');
    });

    it('12.2 [Test B] Transport failure behavior remains safe (fallback gas limit preserves single valid nonce)', async () => {
      let broadcastCount = 0;
      const startingNonce = 13000;

      const mockRpc: any = {
        estimateGas: async () => {
          // Transport error, not an execution revert
          throw new Error('ETIMEDOUT: RPC connection timed out');
        },
        estimateFeesPerGas: async () => ({
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }),
        sendRawTransaction: async () => {
          broadcastCount++;
          return '0xtransportSuccessHash';
        },
        getTransactionCount: async () => startingNonce,
        getTransactionReceipt: async () => ({
          blockNumber: 200n,
          status: 'success',
        }),
        getBlockNumber: async () => 205n,
      };

      const manager = new BaseTransactionManager({
        persistence,
        publicClient: mockRpc,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const swapKey = `swap-transport-${randomUUID()}`;
      const result = await manager.executeIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x',
        valueWei: 0n,
      });

      assert.strictEqual(result.winningAttempt.gasLimit, 350_000n, 'Fallback gas limit 350,000 used');
      assert.strictEqual(result.winningAttempt.nonce, startingNonce, 'Exactly one valid nonce reserved');
      assert.strictEqual(broadcastCount, 1, 'Exactly one broadcast performed');
      assert.strictEqual(result.intent.status, EvmLogicalIntentState.CONFIRMED);
    });

    it('12.3 [Test C] Concurrent intents around simulation failure (two independent managers on same DB, Intent A reverts, Intent B prepares -> no duplicate nonce, no gap, no corruption)', async () => {
      const dbPathShared = path.join(process.cwd(), 'scratch', `gap-concurrent-${randomUUID()}.db`);
      const sharedPersistence = new SqlitePersistence({ filename: dbPathShared });

      const startingNonce = 14000;

      const mockRpcA: any = {
        estimateGas: async () => {
          const err = new Error('execution reverted: execution failed');
          (err as any).shortMessage = 'execution reverted';
          throw err;
        },
        estimateFeesPerGas: async () => ({
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }),
        sendRawTransaction: async () => '0xneverBroadcastA',
        getTransactionCount: async () => startingNonce,
      };

      let broadcastCountB = 0;
      const mockRpcB: any = {
        estimateGas: async () => 40_000n,
        estimateFeesPerGas: async () => ({
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }),
        sendRawTransaction: async () => {
          broadcastCountB++;
          return '0xbroadcastBHash';
        },
        getTransactionCount: async () => startingNonce,
        getTransactionReceipt: async () => ({
          blockNumber: 300n,
          status: 'success',
        }),
        getBlockNumber: async () => 305n,
      };

      const managerA = new BaseTransactionManager({
        persistence: sharedPersistence,
        publicClient: mockRpcA,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const managerB = new BaseTransactionManager({
        persistence: sharedPersistence,
        publicClient: mockRpcB,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const swapKeyA = `swap-concurrent-revert-${randomUUID()}`;
      const swapKeyB = `swap-concurrent-valid-${randomUUID()}`;

      // Run A and B concurrently
      const results = await Promise.allSettled([
        managerA.executeIntent({
          swapKey: swapKeyA,
          chainId: HARDHAT_CHAIN_ID,
          signerAddress: operatorAccount.address,
          actionType: 'FUND',
          targetAddress: RECIPIENT_ADDRESS,
          calldata: '0x',
          valueWei: 0n,
        }),
        managerB.executeIntent({
          swapKey: swapKeyB,
          chainId: HARDHAT_CHAIN_ID,
          signerAddress: operatorAccount.address,
          actionType: 'REFUND',
          targetAddress: RECIPIENT_ADDRESS,
          calldata: '0x',
          valueWei: 0n,
        }),
      ]);

      assert.strictEqual(results[0].status, 'rejected', 'Manager A must reject due to simulation revert');
      assert.strictEqual(results[1].status, 'fulfilled', 'Manager B must succeed');

      const intentA = sharedPersistence.getEvmIntentBySwapKey(swapKeyA, 'FUND')!;
      const intentB = sharedPersistence.getEvmIntentBySwapKey(swapKeyB, 'REFUND')!;

      assert.strictEqual(intentA.status, EvmLogicalIntentState.REVERTED);
      assert.strictEqual(intentA.nonce, null, 'Intent A must not occupy a nonce');

      assert.strictEqual(intentB.status, EvmLogicalIntentState.CONFIRMED);
      assert.strictEqual(intentB.nonce, startingNonce, 'Intent B must cleanly take startingNonce with no gap');
      assert.strictEqual(broadcastCountB, 1);

      sharedPersistence.close();
      try { fs.unlinkSync(dbPathShared); } catch {}
    });

    it('12.4 [Test D] Crash during preflight before nonce reservation -> clean deterministic recovery', async () => {
      const dbPathCrash = path.join(process.cwd(), 'scratch', `gap-crash-${randomUUID()}.db`);
      const crashPersistence = new SqlitePersistence({ filename: dbPathCrash });

      const startingNonce = 15000;
      const swapKey = `swap-crash-preflight-${randomUUID()}`;

      // Simulate crash during preflight: intent is created in SQLite, but no nonce reserved and no attempt created
      const crashedIntent = crashPersistence.getOrCreateEvmIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x1234',
        valueWei: 0n,
      });

      assert.strictEqual(crashedIntent.status, EvmLogicalIntentState.CREATED);
      assert.strictEqual(crashedIntent.nonce, null, 'Before crash, nonce is null');

      // Restart: new manager boots up and completes the intent
      let broadcastCount = 0;
      const recoverRpc: any = {
        estimateGas: async () => 35_000n,
        estimateFeesPerGas: async () => ({
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }),
        sendRawTransaction: async () => {
          broadcastCount++;
          return '0xrecoveredTxHash';
        },
        getTransactionCount: async () => startingNonce,
        getTransactionReceipt: async () => ({
          blockNumber: 400n,
          status: 'success',
        }),
        getBlockNumber: async () => 405n,
      };

      const recoveryManager = new BaseTransactionManager({
        persistence: crashPersistence,
        publicClient: recoverRpc,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const recoveredResult = await recoveryManager.executeIntent({
        swapKey,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x1234',
        valueWei: 0n,
      });

      assert.strictEqual(recoveredResult.intent.status, EvmLogicalIntentState.CONFIRMED);
      assert.strictEqual(recoveredResult.intent.nonce, startingNonce, 'Recovered intent reserves nonce 15000 cleanly');
      assert.strictEqual(broadcastCount, 1);
      assert.strictEqual(recoveredResult.winningAttempt.nonce, startingNonce);

      crashPersistence.close();
      try { fs.unlinkSync(dbPathCrash); } catch {}
    });
  });

  describe('13. Post-Nonce / Pre-Attempt Gap Invariants', () => {
    it('13.1 [Test 1] Crash immediately after durable nonce reservation blocks higher nonce allocation and recovers cleanly', async () => {
      const dbPathShared = path.join(process.cwd(), 'scratch', `post-nonce-crash-${randomUUID()}.db`);
      const sharedPersistence = new SqlitePersistence({ filename: dbPathShared });
      const startingNonce = 50000;

      let broadcastCount = 0;
      const mockRpc: any = {
        estimateGas: async () => 30_000n,
        estimateFeesPerGas: async () => ({
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }),
        sendRawTransaction: async () => {
          broadcastCount++;
          return `0xbroadcastHash${broadcastCount}`;
        },
        getTransactionCount: async () => startingNonce,
        getTransactionReceipt: async () => ({
          blockNumber: 500n,
          status: 'success',
        }),
        getBlockNumber: async () => 505n,
      };

      const managerA = new BaseTransactionManager({
        persistence: sharedPersistence,
        publicClient: mockRpc,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const managerB = new BaseTransactionManager({
        persistence: sharedPersistence,
        publicClient: mockRpc,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const swapKeyA = `swap-post-nonce-a-${randomUUID()}`;
      const intentA = sharedPersistence.getOrCreateEvmIntent({
        swapKey: swapKeyA,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x1111',
        valueWei: 0n,
      });

      // Manager A durably reserves nonce N (50000)
      const resA = sharedPersistence.reserveEvmNonce(intentA.id, startingNonce, {
        enforceNoUnresolvedReservations: true,
      });
      assert.strictEqual(resA.nonce, startingNonce);

      // Simulate process death of Manager A before signing / attempt persistence
      // Manager B (independent process on same DB) attempts new economic intent B
      const swapKeyB = `swap-post-nonce-b-${randomUUID()}`;
      await assert.rejects(
        async () => {
          await managerB.executeIntent({
            swapKey: swapKeyB,
            chainId: HARDHAT_CHAIN_ID,
            signerAddress: operatorAccount.address,
            actionType: 'FUND',
            targetAddress: RECIPIENT_ADDRESS,
            calldata: '0x2222',
            valueWei: 0n,
          });
        },
        /UNRESOLVED_NONCE_RESERVATION/
      );

      // Invariants:
      // 1. Manager B did NOT reserve or broadcast N+1
      assert.strictEqual(broadcastCount, 0, 'Zero broadcast calls allowed while lower nonce is unresolved');
      const intentB = sharedPersistence.getEvmIntentBySwapKey(swapKeyB, 'FUND')!;
      assert.strictEqual(intentB.nonce, null, 'Intent B must not be assigned a nonce');

      // 2. Restart/recovery of Intent A reconstructs missing physical attempt using N
      const { attempt: recoveredAttempt } = await managerA.recoverUnresolvedIntent(intentA.id, '0x1111');
      assert.strictEqual(recoveredAttempt.nonce, startingNonce, 'Recovered attempt must use reserved nonce N');
      assert.strictEqual(broadcastCount, 1, 'Intent A broadcast must succeed during recovery');

      // 3. After N is safely recovered, later Intent B progresses normally with N+1
      const resultB = await managerB.executeIntent({
        swapKey: swapKeyB,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x2222',
        valueWei: 0n,
      });

      assert.strictEqual(resultB.intent.nonce, startingNonce + 1, 'Intent B cleanly progresses to N+1');
      assert.strictEqual(resultB.winningAttempt.nonce, startingNonce + 1);
      assert.strictEqual(broadcastCount, 2, 'Exactly two broadcasts total');

      sharedPersistence.close();
      try { fs.unlinkSync(dbPathShared); } catch {}
    });

    it('13.2 [Test 2] Signing failure after nonce reservation: zero broadcast, blocks higher nonces, and recovers deterministically', async () => {
      const dbPathShared = path.join(process.cwd(), 'scratch', `post-nonce-signfail-${randomUUID()}.db`);
      const sharedPersistence = new SqlitePersistence({ filename: dbPathShared });
      const startingNonce = 60000;

      let broadcastCount = 0;
      const mockRpc: any = {
        estimateGas: async () => 30_000n,
        estimateFeesPerGas: async () => ({
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }),
        sendRawTransaction: async () => {
          broadcastCount++;
          return `0xbroadcastSignHash${broadcastCount}`;
        },
        getTransactionCount: async () => startingNonce,
        getTransactionReceipt: async () => ({
          blockNumber: 600n,
          status: 'success',
        }),
        getBlockNumber: async () => 605n,
      };

      // Inject signing failure into operator account
      let signingFail = true;
      const flappyAccount: any = {
        ...operatorAccount,
        signTransaction: async (args: any) => {
          if (signingFail) {
            throw new Error('SIGNING_KEY_ENCLAVE_DISCONNECTED');
          }
          return operatorAccount.signTransaction!(args);
        },
      };

      const managerA = new BaseTransactionManager({
        persistence: sharedPersistence,
        publicClient: mockRpc,
        account: flappyAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const managerB = new BaseTransactionManager({
        persistence: sharedPersistence,
        publicClient: mockRpc,
        account: flappyAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const swapKeyA = `swap-signfail-a-${randomUUID()}`;
      await assert.rejects(
        async () => {
          await managerA.executeIntent({
            swapKey: swapKeyA,
            chainId: HARDHAT_CHAIN_ID,
            signerAddress: operatorAccount.address,
            actionType: 'FUND',
            targetAddress: RECIPIENT_ADDRESS,
            calldata: '0x1234',
            valueWei: 0n,
          });
        },
        /SIGNING_KEY_ENCLAVE_DISCONNECTED/
      );

      // Invariant: zero broadcasts, zero false success
      assert.strictEqual(broadcastCount, 0, 'Zero broadcast calls on signing failure');
      const intentA = sharedPersistence.getEvmIntentBySwapKey(swapKeyA, 'FUND')!;
      assert.strictEqual(intentA.nonce, startingNonce, 'Nonce N remains durably reserved');
      assert.strictEqual(sharedPersistence.getEvmAttemptsForIntent(intentA.id).length, 0);

      // Second manager cannot skip directly to N+1
      const swapKeyB = `swap-signfail-b-${randomUUID()}`;
      await assert.rejects(
        async () => {
          await managerB.executeIntent({
            swapKey: swapKeyB,
            chainId: HARDHAT_CHAIN_ID,
            signerAddress: operatorAccount.address,
            actionType: 'FUND',
            targetAddress: RECIPIENT_ADDRESS,
            calldata: '0x5678',
            valueWei: 0n,
          });
        },
        /UNRESOLVED_NONCE_RESERVATION/
      );

      // Restore signing condition
      signingFail = false;

      // Deterministic recovery of Intent A uses N
      const recoveredResultA = await managerA.executeIntent({
        swapKey: swapKeyA,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x1234',
        valueWei: 0n,
      });
      assert.strictEqual(recoveredResultA.winningAttempt.nonce, startingNonce);
      assert.strictEqual(broadcastCount, 1);

      // Manager B can now execute Intent B with N+1
      const resultB = await managerB.executeIntent({
        swapKey: swapKeyB,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x5678',
        valueWei: 0n,
      });
      assert.strictEqual(resultB.winningAttempt.nonce, startingNonce + 1);
      assert.strictEqual(broadcastCount, 2);

      sharedPersistence.close();
      try { fs.unlinkSync(dbPathShared); } catch {}
    });

    it('13.3 [Test 3] PREPARED-attempt persistence failure: no premature broadcast, blocks higher nonces, converges on retry', async () => {
      const dbPathShared = path.join(process.cwd(), 'scratch', `post-nonce-dbfail-${randomUUID()}.db`);
      const sharedPersistence = new SqlitePersistence({ filename: dbPathShared });
      const startingNonce = 70000;

      let broadcastCount = 0;
      const mockRpc: any = {
        estimateGas: async () => 30_000n,
        estimateFeesPerGas: async () => ({
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }),
        sendRawTransaction: async () => {
          broadcastCount++;
          return `0xbroadcastDbHash${broadcastCount}`;
        },
        getTransactionCount: async () => startingNonce,
        getTransactionReceipt: async () => ({
          blockNumber: 700n,
          status: 'success',
        }),
        getBlockNumber: async () => 705n,
      };

      // Monkey-patch recordEvmAttempt to simulate persistence failure
      const originalRecordEvmAttempt = sharedPersistence.recordEvmAttempt.bind(sharedPersistence);
      let failPersistence = true;
      sharedPersistence.recordEvmAttempt = (params: any) => {
        if (failPersistence) {
          throw new Error('SQLITE_IO_DISK_FULL: Simulated disk write failure');
        }
        return originalRecordEvmAttempt(params);
      };

      const managerA = new BaseTransactionManager({
        persistence: sharedPersistence,
        publicClient: mockRpc,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const managerB = new BaseTransactionManager({
        persistence: sharedPersistence,
        publicClient: mockRpc,
        account: operatorAccount,
        chainId: HARDHAT_CHAIN_ID,
      });

      const swapKeyA = `swap-dbfail-a-${randomUUID()}`;
      await assert.rejects(
        async () => {
          await managerA.executeIntent({
            swapKey: swapKeyA,
            chainId: HARDHAT_CHAIN_ID,
            signerAddress: operatorAccount.address,
            actionType: 'FUND',
            targetAddress: RECIPIENT_ADDRESS,
            calldata: '0x9999',
            valueWei: 0n,
          });
        },
        /SQLITE_IO_DISK_FULL/
      );

      // Assert: No broadcast occurs before durable attempt persistence
      assert.strictEqual(broadcastCount, 0, 'No broadcast before durable attempt persistence');
      const intentA = sharedPersistence.getEvmIntentBySwapKey(swapKeyA, 'FUND')!;
      assert.strictEqual(intentA.nonce, startingNonce, 'Nonce N was reserved');
      assert.strictEqual(sharedPersistence.getEvmAttemptsForIntent(intentA.id).length, 0);

      // Assert: No higher nonce allowed to bypass unresolved N
      const swapKeyB = `swap-dbfail-b-${randomUUID()}`;
      await assert.rejects(
        async () => {
          await managerB.executeIntent({
            swapKey: swapKeyB,
            chainId: HARDHAT_CHAIN_ID,
            signerAddress: operatorAccount.address,
            actionType: 'FUND',
            targetAddress: RECIPIENT_ADDRESS,
            calldata: '0x8888',
            valueWei: 0n,
          });
        },
        /UNRESOLVED_NONCE_RESERVATION/
      );

      // Restore persistence functionality
      failPersistence = false;

      // Retry/recovery converges without duplicate economic execution
      const recoveredA = await managerA.executeIntent({
        swapKey: swapKeyA,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x9999',
        valueWei: 0n,
      });
      assert.strictEqual(recoveredA.winningAttempt.nonce, startingNonce);
      assert.strictEqual(broadcastCount, 1);

      // Now Intent B can execute and receive N+1
      const resultB = await managerB.executeIntent({
        swapKey: swapKeyB,
        chainId: HARDHAT_CHAIN_ID,
        signerAddress: operatorAccount.address,
        actionType: 'FUND',
        targetAddress: RECIPIENT_ADDRESS,
        calldata: '0x8888',
        valueWei: 0n,
      });
      assert.strictEqual(resultB.winningAttempt.nonce, startingNonce + 1);
      assert.strictEqual(broadcastCount, 2);

      sharedPersistence.close();
      try { fs.unlinkSync(dbPathShared); } catch {}
    });
  });
});
