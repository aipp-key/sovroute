/**
 * SovRoute — Sovereign Cross-Rail Settlement Infrastructure
 * On-Chain Watcher & Multi-RPC Failover Test Suite
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  MultiRpcClient,
  AllRpcEndpointsFailedError,
  SettlementHandler,
  ChainWatcher,
  InMemoryBlockTracker,
  type HtlcClaimedEvent,
} from '../src/watcher/index.ts';
import { FakeLightningAtomicBackend } from '../src/atomic/lightning/fake-backend.ts';

describe('FAIL-CLOSED ON-CHAIN WATCHER SUITE (14 TESTS)', () => {
  let fakeLightning: FakeLightningAtomicBackend;
  let settlementHandler: SettlementHandler;

  beforeEach(() => {
    fakeLightning = new FakeLightningAtomicBackend();
    settlementHandler = new SettlementHandler(fakeLightning);
  });

  // --- 1. Multi-RPC Failover & Resiliency ---
  describe('1. Multi-RPC Failover & Health Tracking', () => {
    it('1. Primary RPC succeeds without failover', async () => {
      const client = new MultiRpcClient({
        chainId: 84532,
        rpcUrls: ['https://sepolia.base.org'],
      });

      const blockNumber = await client.getBlockNumber();
      assert.ok(blockNumber > 0n);
      assert.strictEqual(client.getActiveEndpoint(), 'https://sepolia.base.org');
      const statuses = client.getEndpointStatuses();
      assert.strictEqual(statuses[0].status, 'HEALTHY');
      assert.strictEqual(statuses[0].consecutiveFailures, 0);
    });

    it('2. Automatically fails over to secondary RPC when primary is broken', async () => {
      const client = new MultiRpcClient({
        chainId: 84532,
        rpcUrls: ['https://invalid-non-existent-rpc-endpoint.org', 'https://sepolia.base.org'],
        timeoutMs: 1500,
        maxConsecutiveFailures: 1,
      });

      const blockNumber = await client.getBlockNumber();
      assert.ok(blockNumber > 0n);
      assert.strictEqual(client.getActiveEndpoint(), 'https://sepolia.base.org');
      const statuses = client.getEndpointStatuses();
      assert.strictEqual(statuses[0].status, 'DOWN');
      assert.strictEqual(statuses[1].status, 'HEALTHY');
    });

    it('3. Fails closed with AllRpcEndpointsFailedError when all endpoints fail', async () => {
      const client = new MultiRpcClient({
        chainId: 84532,
        rpcUrls: [
          'https://broken-rpc-1.example.org',
          'https://broken-rpc-2.example.org',
        ],
        timeoutMs: 500,
        maxConsecutiveFailures: 1,
      });

      await assert.rejects(
        async () => {
          await client.getBlockNumber();
        },
        (err: any) => {
          assert.ok(err instanceof AllRpcEndpointsFailedError);
          return true;
        }
      );
    });
  });

  // --- 2. Settlement Handler & Idempotency ---
  describe('2. Settlement Handler & Cryptographic Validation', () => {
    it('4. Valid preimage and matching hashlock settles successfully', async () => {
      const preimage = randomBytes(32);
      const preimageHex = `0x${preimage.toString('hex')}`;
      const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}`;

      // Create hold invoice on fake lightning and simulate payer holding funds
      await fakeLightning.createHoldInvoice(hashLock, 1000n, 144);
      fakeLightning.simulatePayerHold(hashLock.slice(2));

      const event: HtlcClaimedEvent = {
        htlcId: '0x1111111111111111111111111111111111111111111111111111111111111111',
        hashLock,
        preimage: preimageHex,
        claimAddress: '0x1353A8c42c0ce3BD4B62b8034baCDf28A1F9A4A9',
        blockNumber: 100n,
        blockHash: '0xabc',
        txHash: '0xdef',
        logIndex: 0,
        confirmations: 5,
      };

      const result = await settlementHandler.handleClaimEvent(event);
      assert.strictEqual(result.outcome, 'SETTLED');
      assert.strictEqual(result.hashLock, hashLock);
      assert.ok(settlementHandler.isSettled(hashLock));

      // Verify Lightning invoice state is SETTLED
      const lnState = await fakeLightning.getInvoiceState(hashLock.slice(2));
      assert.strictEqual(lnState, 'SETTLED');
    });

    it('5. Rejects malformed preimage fail-closed (INVALID_PREIMAGE)', async () => {
      const event: HtlcClaimedEvent = {
        htlcId: '0x1111',
        hashLock: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        preimage: '0x1234', // Only 2 bytes, invalid 32-byte hex
        claimAddress: '0x1353A8c42c0ce3BD4B62b8034baCDf28A1F9A4A9',
        blockNumber: 100n,
        blockHash: '0xabc',
        txHash: '0xdef',
        logIndex: 0,
        confirmations: 5,
      };

      const result = await settlementHandler.handleClaimEvent(event);
      assert.strictEqual(result.outcome, 'INVALID_PREIMAGE');
      assert.ok(result.error?.includes('Malformed preimage format'));
    });

    it('6. Rejects mismatched preimage fail-closed (SHA-256 mismatch)', async () => {
      const preimage1 = randomBytes(32);
      const preimage2 = randomBytes(32);
      const hashLock1 = `0x${createHash('sha256').update(preimage1).digest('hex')}`;
      const wrongPreimageHex = `0x${preimage2.toString('hex')}`;

      const event: HtlcClaimedEvent = {
        htlcId: '0x1111',
        hashLock: hashLock1,
        preimage: wrongPreimageHex,
        claimAddress: '0x1353A8c42c0ce3BD4B62b8034baCDf28A1F9A4A9',
        blockNumber: 100n,
        blockHash: '0xabc',
        txHash: '0xdef',
        logIndex: 0,
        confirmations: 5,
      };

      const result = await settlementHandler.handleClaimEvent(event);
      assert.strictEqual(result.outcome, 'INVALID_PREIMAGE');
      assert.ok(result.error?.includes('Cryptographic mismatch'));
    });

    it('7. Idempotent settlement: duplicate event returns ALREADY_SETTLED without error', async () => {
      const preimage = randomBytes(32);
      const preimageHex = `0x${preimage.toString('hex')}`;
      const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}`;

      await fakeLightning.createHoldInvoice(hashLock, 1000n, 144);
      fakeLightning.simulatePayerHold(hashLock.slice(2));

      const event: HtlcClaimedEvent = {
        htlcId: '0x1111',
        hashLock,
        preimage: preimageHex,
        claimAddress: '0x1353A8c42c0ce3BD4B62b8034baCDf28A1F9A4A9',
        blockNumber: 100n,
        blockHash: '0xabc',
        txHash: '0xdef',
        logIndex: 0,
        confirmations: 5,
      };

      const first = await settlementHandler.handleClaimEvent(event);
      assert.strictEqual(first.outcome, 'SETTLED');

      const second = await settlementHandler.handleClaimEvent(event);
      assert.strictEqual(second.outcome, 'ALREADY_SETTLED');
    });

    it('8. Detects already settled invoice directly from Lightning backend', async () => {
      const preimage = randomBytes(32);
      const preimageHex = `0x${preimage.toString('hex')}`;
      const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}`;

      // Create, hold and settle invoice prior to handler invocation
      await fakeLightning.createHoldInvoice(hashLock, 1000n, 144);
      fakeLightning.simulatePayerHold(hashLock.slice(2));
      await fakeLightning.settleHoldInvoice(preimage.toString('hex'));

      // Fresh handler with empty memory cache
      const freshHandler = new SettlementHandler(fakeLightning);

      const event: HtlcClaimedEvent = {
        htlcId: '0x1111',
        hashLock,
        preimage: preimageHex,
        claimAddress: '0x1353A8c42c0ce3BD4B62b8034baCDf28A1F9A4A9',
        blockNumber: 100n,
        blockHash: '0xabc',
        txHash: '0xdef',
        logIndex: 0,
        confirmations: 5,
      };

      const result = await freshHandler.handleClaimEvent(event);
      assert.strictEqual(result.outcome, 'ALREADY_SETTLED');
    });

    it('9. Fails closed with SETTLEMENT_FAILED_CLOSED when Lightning backend throws', async () => {
      const preimage = randomBytes(32);
      const preimageHex = `0x${preimage.toString('hex')}`;
      const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}`;

      // Create a broken mock backend
      const brokenBackend = {
        backendName: 'BrokenLnd',
        createHoldInvoice: async () => ({} as any),
        observeHoldInvoice: async () => ({} as any),
        settleHoldInvoice: async () => {
          throw new Error('LND_CONNECTION_REFUSED');
        },
        cancelHoldInvoice: async () => ({} as any),
        getInvoiceState: async () => {
          throw new Error('LND_DOWN');
        },
      };

      const handler = new SettlementHandler(brokenBackend as any);

      const event: HtlcClaimedEvent = {
        htlcId: '0x1111',
        hashLock,
        preimage: preimageHex,
        claimAddress: '0x1353A8c42c0ce3BD4B62b8034baCDf28A1F9A4A9',
        blockNumber: 100n,
        blockHash: '0xabc',
        txHash: '0xdef',
        logIndex: 0,
        confirmations: 5,
      };

      const result = await handler.handleClaimEvent(event);
      assert.strictEqual(result.outcome, 'SETTLEMENT_FAILED_CLOSED');
      assert.ok(result.error?.includes('LND_CONNECTION_REFUSED'));
    });
  });

  // --- 3. Chain Watcher Daemon: Reorg, Polling & Catch-up ---
  describe('3. Chain Watcher Engine & Invariants', () => {
    it('10. Reorg & Finality Gate: Ignores blocks within reorg window', async () => {
      const tracker = new InMemoryBlockTracker(100n);
      const watcher = new ChainWatcher(
        {
          rpcUrls: ['https://sepolia.base.org'],
          contractAddress: '0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f',
          chainId: 84532,
          reorgConfirmations: 5,
          startBlock: 100n,
        },
        settlementHandler,
        tracker
      );

      // Mock getBlockNumber to 103n (safeTip is 103 - 5 = 98n)
      (watcher.getMultiRpc() as any).getBlockNumber = async () => 103n;

      const tickResult = await watcher.tick();
      // Safe tip (98) <= lastProcessedBlock (100) -> 0 blocks processed
      assert.strictEqual(tickResult.eventsFound, 0);
      const lastBlock = await tracker.getLastProcessedBlock();
      assert.strictEqual(lastBlock, 100n);
    });

    it('11. Processes confirmed blocks beyond reorg window', async () => {
      const tracker = new InMemoryBlockTracker(100n);
      const watcher = new ChainWatcher(
        {
          rpcUrls: ['https://sepolia.base.org'],
          contractAddress: '0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f',
          chainId: 84532,
          reorgConfirmations: 2,
          startBlock: 100n,
        },
        settlementHandler,
        tracker
      );

      // Mock getBlockNumber to 110n (safeTip is 110 - 2 = 108n)
      (watcher.getMultiRpc() as any).getBlockNumber = async () => 110n;
      (watcher.getMultiRpc() as any).getLogs = async () => [];

      const tickResult = await watcher.tick();
      assert.strictEqual(tickResult.fromBlock, 101n);
      assert.strictEqual(tickResult.toBlock, 108n);
      assert.strictEqual(tickResult.eventsFound, 0);

      const lastBlock = await tracker.getLastProcessedBlock();
      assert.strictEqual(lastBlock, 108n);
    });

    it('12. End-to-end event discovery, settlement, and block advancement', async () => {
      const preimage = randomBytes(32);
      const preimageHex = `0x${preimage.toString('hex')}`;
      const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}`;

      await fakeLightning.createHoldInvoice(hashLock, 1000n, 144);
      fakeLightning.simulatePayerHold(hashLock.slice(2));

      const tracker = new InMemoryBlockTracker(100n);
      const watcher = new ChainWatcher(
        {
          rpcUrls: ['https://sepolia.base.org'],
          contractAddress: '0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f',
          chainId: 84532,
          reorgConfirmations: 2,
          startBlock: 100n,
        },
        settlementHandler,
        tracker
      );

      // Mock RPC returning 1 event in block 105
      (watcher.getMultiRpc() as any).getBlockNumber = async () => 110n;
      (watcher.getMultiRpc() as any).getLogs = async () => [
        {
          address: '0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f',
          blockNumber: 105n,
          blockHash: '0xabc',
          transactionHash: '0xtx1',
          logIndex: 1,
          args: {
            htlcId: '0xhtlc1',
            hashLock,
            preimage: preimageHex,
            claimAddress: '0x1353A8c42c0ce3BD4B62b8034baCDf28A1F9A4A9',
          },
        },
      ];

      const tickResult = await watcher.tick();
      assert.strictEqual(tickResult.eventsFound, 1);
      assert.strictEqual(tickResult.settlements.length, 1);
      assert.strictEqual(tickResult.settlements[0].outcome, 'SETTLED');

      // Verify LND is settled
      const lnState = await fakeLightning.getInvoiceState(hashLock.slice(2));
      assert.strictEqual(lnState, 'SETTLED');

      // Verify tracker advanced to safeTip 108
      const lastBlock = await tracker.getLastProcessedBlock();
      assert.strictEqual(lastBlock, 108n);
    });

    it('13. Fail-Closed Invariant: Does not advance past failed settlement block', async () => {
      const preimage = randomBytes(32);
      const preimageHex = `0x${preimage.toString('hex')}`;
      const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}`;

      // Broken backend that throws on settlement
      const brokenBackend = {
        backendName: 'BrokenLnd',
        settleHoldInvoice: async () => {
          throw new Error('LND_FAIL');
        },
        getInvoiceState: async () => 'OPEN',
      };
      const failingHandler = new SettlementHandler(brokenBackend as any);

      const tracker = new InMemoryBlockTracker(100n);
      const watcher = new ChainWatcher(
        {
          rpcUrls: ['https://sepolia.base.org'],
          contractAddress: '0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f',
          chainId: 84532,
          reorgConfirmations: 2,
          startBlock: 100n,
        },
        failingHandler,
        tracker
      );

      (watcher.getMultiRpc() as any).getBlockNumber = async () => 110n;
      (watcher.getMultiRpc() as any).getLogs = async () => [
        {
          address: '0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f',
          blockNumber: 105n,
          blockHash: '0xabc',
          transactionHash: '0xtx1',
          logIndex: 1,
          args: {
            htlcId: '0xhtlc1',
            hashLock,
            preimage: preimageHex,
            claimAddress: '0x1353A8c42c0ce3BD4B62b8034baCDf28A1F9A4A9',
          },
        },
      ];

      const tickResult = await watcher.tick();
      assert.strictEqual(tickResult.settlements[0].outcome, 'SETTLEMENT_FAILED_CLOSED');

      // Tracker MUST NOT advance to 108n or 105n; it must stay before the failed block (104n)
      const lastBlock = await tracker.getLastProcessedBlock();
      assert.strictEqual(lastBlock, 104n);
    });

    it('14. Catch-up scanning processes multi-chunk block range accurately', async () => {
      const tracker = new InMemoryBlockTracker(100n);
      const watcher = new ChainWatcher(
        {
          rpcUrls: ['https://sepolia.base.org'],
          contractAddress: '0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f',
          chainId: 84532,
          reorgConfirmations: 0,
          maxBlockRange: 10n, // Small chunk to test pagination
          startBlock: 100n,
        },
        settlementHandler,
        tracker
      );

      (watcher.getMultiRpc() as any).getBlockNumber = async () => 135n;

      const queriedRanges: Array<{ from: bigint; to: bigint }> = [];
      (watcher.getMultiRpc() as any).getLogs = async (params: any) => {
        queriedRanges.push({ from: params.fromBlock, to: params.toBlock });
        return [];
      };

      const result = await watcher.catchUp(101n, 135n);
      assert.strictEqual(result.eventsFound, 0);

      // Verify pagination: 101-110, 111-120, 121-130, 131-135
      assert.strictEqual(queriedRanges.length, 4);
      assert.deepStrictEqual(queriedRanges[0], { from: 101n, to: 110n });
      assert.deepStrictEqual(queriedRanges[1], { from: 111n, to: 120n });
      assert.deepStrictEqual(queriedRanges[2], { from: 121n, to: 130n });
      assert.deepStrictEqual(queriedRanges[3], { from: 131n, to: 135n });

      const finalBlock = await tracker.getLastProcessedBlock();
      assert.strictEqual(finalBlock, 135n);
    });
  });
});
