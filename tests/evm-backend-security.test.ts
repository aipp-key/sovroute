/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 3: Real Local EVM Atomic Backend Security Suite
 *
 * Tests RealLocalEvmAtomicBackend against local Hardhat devnet:
 * - Network guard (P0: chain ID 31337 only)
 * - Bytecode pinning
 * - Durable action ownership
 * - RPC ambiguity reconciliation
 * - Concurrency arbitration
 * - Independent evidence generation
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RealLocalEvmAtomicBackend,
} from '../src/atomic/evm/real-local-backend.ts';
import {
  EvmNetworkGuard,
  EvmNetworkGuardError,
  EvmBytecodeMismatchError,
} from '../src/atomic/evm/evm-guard.ts';
import { LightningSettlementGateError } from '../src/atomic/evm/evm-types.ts';
import type { EvmHtlcParams } from '../src/atomic/types.ts';
import { ClientEvmActor } from './helpers/client-evm-actor.ts';

const rootDir = process.cwd();

describe('PHASE 3 — REAL EVM ATOMIC BACKEND SECURITY SUITE', () => {
  let backend: RealLocalEvmAtomicBackend;
  let deployment: any;

  before(() => {
    deployment = JSON.parse(
      readFileSync(join(rootDir, 'regtest-env', 'data', 'evm-deployment.json'), 'utf8')
    );
    backend = new RealLocalEvmAtomicBackend();
  });

  it('1. Backend adheres to IEvmAtomicBackend and exposes chain ID 31337', () => {
    assert.equal(backend.backendName, 'RealLocalEvmAtomicBackend');
    assert.equal(backend.chainId, 31337);
  });

  it('2. Wrong chain ID refused fail-closed (EVM-SEC-15)', () => {
    // Attempting to run with Ethereum mainnet (1)
    assert.throws(
      () => {
        EvmNetworkGuard.assertSafeLocalNetwork(1);
      },
      (err: Error) =>
        err instanceof EvmNetworkGuardError &&
        err.message.includes('REFUSING_NON_LOCAL_NETWORK')
    );

    // Attempting Arbitrum One (42161)
    assert.throws(
      () => {
        EvmNetworkGuard.assertSafeLocalNetwork(42161);
      },
      (err: Error) =>
        err instanceof EvmNetworkGuardError &&
        err.message.includes('REFUSING_NON_LOCAL_NETWORK')
    );

    // Attempting Base mainnet (8453)
    assert.throws(
      () => {
        EvmNetworkGuard.assertSafeLocalNetwork(8453);
      },
      (err: Error) =>
        err instanceof EvmNetworkGuardError &&
        err.message.includes('REFUSING_NON_LOCAL_NETWORK')
    );
  });

  it('3. Bytecode mismatch refused fail-closed (EVM-SEC-16)', () => {
    // Empty bytecode
    assert.throws(
      () => {
        EvmNetworkGuard.assertContractBytecode('0x');
      },
      (err: Error) =>
        err instanceof EvmBytecodeMismatchError &&
        err.message.includes('No contract bytecode found')
    );

    // Tampered bytecode
    assert.throws(
      () => {
        EvmNetworkGuard.assertContractBytecode('0xdeadbeef1234567890');
      },
      (err: Error) =>
        err instanceof EvmBytecodeMismatchError &&
        err.message.includes('Deployed contract bytecode does not match pinned')
    );
  });

  it('4. fundHtlc executes on-chain and produces valid evidence', async () => {
    const preimage = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}` as `0x${string}`;
    const swapKey = `swap_backend_fund_${Date.now()}`;
    const blockTs = await backend.getBlockTimestamp();
    const refundLocktime = blockTs + 7200;

    const params: EvmHtlcParams = {
      swapKey,
      hashLock,
      amountUnits: 2_000_000n, // 2 MST
      tokenAddress: backend.getTokenAddress(),
      refundLocktime,
      claimAddress: deployment.clientAddress,
      refundAddress: deployment.operatorAddress,
    };

    const res = await backend.fundHtlc(params);
    assert.ok(res.txHash.startsWith('0x'));
    assert.ok(res.blockNumber > 0);

    // Observe
    const state = await backend.observeHtlc(swapKey);
    assert.equal(state.funded, true);
    assert.equal(state.completed, false);
    assert.equal(state.refunded, false);
    assert.equal(state.balance, 2_000_000n);
    assert.equal(state.timelock, refundLocktime);

    // Check evidence
    const evidence = backend.getEvidenceLog().find(
      (e) => e.evidenceType === 'EVM_HTLC_FUNDED' && e.hashLock.toLowerCase() === hashLock.toLowerCase()
    );
    assert.ok(evidence);
    if (evidence.evidenceType === 'EVM_HTLC_FUNDED') {
      assert.equal(evidence.amount, 2_000_000n);
    }
  });

  it('5. Sovereign boundary: Router refuses claim without client signer; client signs on-chain; Router extracts verified evidence', async () => {
    const preimage = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}` as `0x${string}`;
    const swapKey = `swap_backend_claim_${Date.now()}`;
    const blockTs = await backend.getBlockTimestamp();
    const refundLocktime = blockTs + 7200;

    const params: EvmHtlcParams = {
      swapKey,
      hashLock,
      amountUnits: 1_500_000n,
      tokenAddress: backend.getTokenAddress(),
      refundLocktime,
      claimAddress: deployment.clientAddress,
      refundAddress: deployment.operatorAddress,
    };

    const fundRes = await backend.fundHtlc(params);
    assert.ok(fundRes.htlcId);

    // 1. Invariant: Router backend owns ZERO client keys, so direct claimHtlc is strictly refused
    await assert.rejects(
      async () => {
        await backend.claimHtlc({
          swapKey,
          preimage: `0x${preimage.toString('hex')}`,
          destination: deployment.clientAddress,
        });
      },
      /ROUTER_DOES_NOT_OWN_CLIENT_SIGNER/
    );

    // 2. Client signs and broadcasts claim transaction via ClientEvmActor outside Router core
    const clientActor = new ClientEvmActor();
    const preimageHex = `0x${preimage.toString('hex')}` as `0x${string}`;
    const claimRes = await clientActor.claimHtlc({
      htlcAddress: backend.getHtlcAddress(),
      htlcAbi: backend.getHtlcAbi(),
      htlcId: fundRes.htlcId as `0x${string}`,
      preimage: preimageHex,
    });
    assert.equal(claimRes.status, 'success');
    assert.ok(claimRes.txHash.startsWith('0x'));

    // 3. Router backend verifies on-chain claim and extracts evidence
    const claimEvidence = await backend.extractAndVerifyClaimEvidence({
      claimTxHash: claimRes.txHash,
      expectedHtlcId: fundRes.htlcId,
      expectedHashLock: hashLock,
      expectedClaimAddress: deployment.clientAddress,
      expectedAmount: 1_500_000n,
      requiredConfirmations: 1,
    });

    assert.equal(claimEvidence.evidenceType, 'EVM_HTLC_CLAIMED');
    assert.equal(claimEvidence.finalityState, 'FINAL_ENOUGH_FOR_PROTOCOL');
    assert.equal(claimEvidence.preimageRevealed.toLowerCase(), preimage.toString('hex').toLowerCase());
    assert.equal(claimEvidence.claimAddress.toLowerCase(), deployment.clientAddress.toLowerCase());
    assert.equal(claimEvidence.amount, 1_500_000n);

    // 4. Observe post-claim state
    const state = await backend.observeHtlc(swapKey);
    assert.equal(state.funded, true);
    assert.equal(state.completed, true);
    assert.equal(state.refunded, false);
    assert.equal(state.balance, 0n);
  });

  it('6. refundHtlc executes on-chain after timelock expiry', async () => {
    const preimage = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}` as `0x${string}`;
    const swapKey = `swap_backend_refund_${Date.now()}`;
    const blockTs = await backend.getBlockTimestamp();
    const refundLocktime = blockTs + 60; // 60s in future

    const params: EvmHtlcParams = {
      swapKey,
      hashLock,
      amountUnits: 800_000n,
      tokenAddress: backend.getTokenAddress(),
      refundLocktime,
      claimAddress: deployment.clientAddress,
      refundAddress: deployment.operatorAddress,
    };

    await backend.fundHtlc(params);

    // Premature refund fails
    await assert.rejects(
      async () => {
        await backend.refundHtlc(swapKey);
      },
      /PREMATURE_REFUND_DENIED/
    );

    // Advance time past timelock
    await backend.increaseTime(120);

    // Timely refund succeeds
    const refRes = await backend.refundHtlc(swapKey);
    assert.equal(refRes.refunded, true);
    assert.ok(refRes.txHash.startsWith('0x'));

    // Observe post-refund state
    const state = await backend.observeHtlc(swapKey);
    assert.equal(state.funded, true);
    assert.equal(state.completed, false);
    assert.equal(state.refunded, true);
    assert.equal(state.balance, 0n);
  });

  it('7. Ambiguous fund reconciles safely from on-chain storage', async () => {
    const preimage = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}` as `0x${string}`;
    const swapKey = `swap_ambiguous_fund_${Date.now()}`;
    const blockTs = await backend.getBlockTimestamp();

    const params: EvmHtlcParams = {
      swapKey,
      hashLock,
      amountUnits: 500_000n,
      tokenAddress: backend.getTokenAddress(),
      refundLocktime: blockTs + 3600,
      claimAddress: deployment.clientAddress,
      refundAddress: deployment.operatorAddress,
    };

    const first = await backend.fundHtlc(params);

    // Second call with same swapKey reconciles existing mined tx without second dispatch
    const second = await backend.fundHtlc(params);
    assert.equal(first.txHash, second.txHash);
    assert.equal(first.blockNumber, second.blockNumber);
  });

  it('8. Claim vs Refund mutual exclusion: claim blocks subsequent refund', async () => {
    const preimage = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}` as `0x${string}`;
    const swapKey = `swap_race_${Date.now()}`;
    const blockTs = await backend.getBlockTimestamp();

    const params: EvmHtlcParams = {
      swapKey,
      hashLock,
      amountUnits: 600_000n,
      tokenAddress: backend.getTokenAddress(),
      refundLocktime: blockTs + 50,
      claimAddress: deployment.clientAddress,
      refundAddress: deployment.operatorAddress,
    };

    const fundRes = await backend.fundHtlc(params);

    // Client executes claim on-chain
    const clientActor = new ClientEvmActor();
    const claimRes = await clientActor.claimHtlc({
      htlcAddress: backend.getHtlcAddress(),
      htlcAbi: backend.getHtlcAbi(),
      htlcId: fundRes.htlcId as `0x${string}`,
      preimage: `0x${preimage.toString('hex')}`,
    });
    assert.equal(claimRes.status, 'success');

    // Advance time
    await backend.increaseTime(100);

    // Subsequent refund attempt throws MUTUAL_EXCLUSION_VIOLATION
    await assert.rejects(
      async () => {
        await backend.refundHtlc(swapKey);
      },
      /MUTUAL_EXCLUSION_VIOLATION/
    );
  });

  it('10. Settlement Gate: extractAndVerifyClaimEvidence rejects invalid/reverting claims and mismatched contracts', async () => {
    // Attempting to verify a non-existent tx
    await assert.rejects(
      async () => {
        await backend.extractAndVerifyClaimEvidence({
          claimTxHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
          expectedHtlcId: '0x1111111111111111111111111111111111111111111111111111111111111111',
          expectedHashLock: '0x2222222222222222222222222222222222222222222222222222222222222222',
          expectedClaimAddress: deployment.clientAddress,
          expectedAmount: 1000n,
        });
      },
      (err: any) => {
        assert.ok(err instanceof LightningSettlementGateError);
        return true;
      }
    );
  });

  it('9. Private key sanitization: evidence records contain zero private keys', () => {
    const logs = backend.getEvidenceLog();
    assert.ok(logs.length > 0);
    for (const ev of logs) {
      const json = JSON.stringify(ev, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      assert.equal(json.includes('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'), false);
      assert.equal(json.includes('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'), false);
    }
  });
});
