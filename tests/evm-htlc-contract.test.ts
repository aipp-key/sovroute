/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 3: Real EVM HTLC Contract Security Suite
 *
 * Direct contract-level security tests verifying EVM-SEC-1..18 on HtlcErc20.sol.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { EvmNetworkGuard } from '../src/atomic/evm/evm-guard.ts';

const rootDir = process.cwd();
const artifactsDir = join(rootDir, 'artifacts', 'contracts');

// Standard Hardhat dev accounts
const OPERATOR_KEY: Hex =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Account 0
const CLIENT_KEY: Hex =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // Account 1
const REFUND_KEY: Hex =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // Account 2 (0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC)
const ATTACKER_KEY: Hex =
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'; // Account 3

describe('PHASE 3 — REAL EVM HTLC CONTRACT SECURITY SUITE', () => {
  let publicClient: PublicClient;
  let operatorWallet: WalletClient;
  let clientWallet: WalletClient;
  let refundWallet: WalletClient;
  let attackerWallet: WalletClient;

  let clientAddr: `0x${string}`;
  let refundAddr: `0x${string}`;
  let attackerAddr: `0x${string}`;

  let htlcAddress: `0x${string}`;
  let tokenAddress: `0x${string}`;

  let htlcAbi: any;
  let tokenAbi: any;
  let globalSnapshotId: string;

  before(async () => {
    publicClient = createPublicClient({
      chain: hardhat,
      transport: http('http://127.0.0.1:8545'),
    });

    const chainId = await publicClient.getChainId();
    EvmNetworkGuard.assertSafeLocalNetwork(chainId);

    const opAccount = privateKeyToAccount(OPERATOR_KEY);
    const clAccount = privateKeyToAccount(CLIENT_KEY);
    const refAccount = privateKeyToAccount(REFUND_KEY);
    const attAccount = privateKeyToAccount(ATTACKER_KEY);

    clientAddr = clAccount.address;
    refundAddr = refAccount.address;
    attackerAddr = attAccount.address;

    operatorWallet = createWalletClient({ account: opAccount, chain: hardhat, transport: http('http://127.0.0.1:8545') });
    clientWallet = createWalletClient({ account: clAccount, chain: hardhat, transport: http('http://127.0.0.1:8545') });
    refundWallet = createWalletClient({ account: refAccount, chain: hardhat, transport: http('http://127.0.0.1:8545') });
    attackerWallet = createWalletClient({ account: attAccount, chain: hardhat, transport: http('http://127.0.0.1:8545') });

    const deployment = JSON.parse(
      readFileSync(join(rootDir, 'regtest-env', 'data', 'evm-deployment.json'), 'utf8')
    );
    htlcAddress = deployment.htlcAddress;
    tokenAddress = deployment.tokenAddress;

    const htlcArtifact = JSON.parse(
      readFileSync(join(artifactsDir, 'HtlcErc20.sol', 'HtlcErc20.json'), 'utf8')
    );
    const tokenArtifact = JSON.parse(
      readFileSync(join(artifactsDir, 'MockSettlementToken.sol', 'MockSettlementToken.json'), 'utf8')
    );
    htlcAbi = htlcArtifact.abi;
    tokenAbi = tokenArtifact.abi;
    globalSnapshotId = (await publicClient.transport.request({ method: 'evm_snapshot', params: [] })) as string;
  });

  after(async () => {
    await publicClient.transport.request({ method: 'evm_revert', params: [globalSnapshotId] });
  });

  function extractHtlcId(receipt: any): `0x${string}` {
    const log = receipt.logs.find(
      (l: any) => l.address.toLowerCase() === htlcAddress.toLowerCase()
    );
    return log.topics[1] as `0x${string}`;
  }

  async function getTimestamp(): Promise<number> {
    const block = await publicClient.getBlock();
    return Number(block.timestamp);
  }

  async function increaseTime(seconds: number): Promise<void> {
    await publicClient.transport.request({ method: 'evm_increaseTime', params: [seconds] });
    await publicClient.transport.request({ method: 'evm_mine', params: [] });
  }

  it('1. Correct hashlock claim succeeds (EVM-SEC-6)', async () => {
    const preimage = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}` as `0x${string}`;
    const amount = 1_000_000n; // 1 MST
    const timelock = BigInt((await getTimestamp()) + 3600);

    // Approve
    const appTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'approve',
      args: [htlcAddress, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });

    // Fund
    const fundTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'fund',
      args: [hashLock, amount, tokenAddress, clientAddr, refundAddr, timelock],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });

    // Get htlcId from event
    const log = receipt.logs.find((l: any) => l.address.toLowerCase() === htlcAddress.toLowerCase());
    const htlcId = log!.topics[1] as `0x${string}`;

    // Initial client balance
    const initBal = (await publicClient.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [clientAddr],
    })) as bigint;

    // Claim using correct preimage
    const preimageHex = `0x${preimage.toString('hex')}` as `0x${string}`;
    const claimTx = await clientWallet.writeContract({
      account: clientWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'claim',
      args: [htlcId, preimageHex],
    });
    await publicClient.waitForTransactionReceipt({ hash: claimTx });

    // Client balance increased
    const endBal = (await publicClient.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [clientAddr],
    })) as bigint;
    assert.equal(endBal - initBal, amount);

    // Contract status is CLAIMED (2)
    const stored: any = await publicClient.readContract({
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'getHtlc',
      args: [htlcId],
    });
    assert.equal(stored.status, 2);
  });

  it('2. Wrong preimage fails (EVM-SEC-7)', async () => {
    const preimage = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}` as `0x${string}`;
    const amount = 500_000n;
    const timelock = BigInt((await getTimestamp()) + 3600);

    const appTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'approve',
      args: [htlcAddress, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });

    const fundTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'fund',
      args: [hashLock, amount, tokenAddress, clientAddr, refundAddr, timelock],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
    const htlcId = extractHtlcId(receipt);

    // Attempt claim with invalid preimage
    const wrongPreimageHex = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
    await assert.rejects(
      async () => {
        await clientWallet.writeContract({
          account: clientWallet.account!,
          chain: hardhat,
          address: htlcAddress,
          abi: htlcAbi,
          functionName: 'claim',
          args: [htlcId, wrongPreimageHex],
        });
      },
      /INVALID_PREIMAGE/
    );
  });

  it('3. Zero amount fails', async () => {
    const hashLock = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
    const timelock = BigInt((await getTimestamp()) + 3600);

    await assert.rejects(
      async () => {
        await operatorWallet.writeContract({
          account: operatorWallet.account!,
          chain: hardhat,
          address: htlcAddress,
          abi: htlcAbi,
          functionName: 'fund',
          args: [hashLock, 0n, tokenAddress, clientAddr, refundAddr, timelock],
        });
      },
      /ZERO_AMOUNT/
    );
  });

  it('4. Zero hashlock fails', async () => {
    const zeroHash = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;
    const timelock = BigInt((await getTimestamp()) + 3600);

    await assert.rejects(
      async () => {
        await operatorWallet.writeContract({
          account: operatorWallet.account!,
          chain: hardhat,
          address: htlcAddress,
          abi: htlcAbi,
          functionName: 'fund',
          args: [zeroHash, 100_000n, tokenAddress, clientAddr, refundAddr, timelock],
        });
      },
      /ZERO_HASHLOCK/
    );
  });

  it('5. Duplicate HTLC identity fails (EVM-SEC-1)', async () => {
    const hashLock = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
    const amount = 200_000n;
    const timelock = BigInt((await getTimestamp()) + 5000);

    const appTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'approve',
      args: [htlcAddress, amount * 2n],
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });

    // First fund succeeds
    const fundTx1 = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'fund',
      args: [hashLock, amount, tokenAddress, clientAddr, refundAddr, timelock],
    });
    await publicClient.waitForTransactionReceipt({ hash: fundTx1 });

    // Second fund with exact same params reverts with HTLC_ALREADY_EXISTS
    await assert.rejects(
      async () => {
        await operatorWallet.writeContract({
          account: operatorWallet.account!,
          chain: hardhat,
          address: htlcAddress,
          abi: htlcAbi,
          functionName: 'fund',
          args: [hashLock, amount, tokenAddress, clientAddr, refundAddr, timelock],
        });
      },
      /HTLC_ALREADY_EXISTS/
    );
  });

  it('6. Refund before timelock fails (EVM-SEC-8)', async () => {
    const hashLock = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
    const amount = 300_000n;
    const timelock = BigInt((await getTimestamp()) + 10000); // 10,000s in future

    const appTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'approve',
      args: [htlcAddress, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });

    const fundTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'fund',
      args: [hashLock, amount, tokenAddress, clientAddr, refundAddr, timelock],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
    const htlcId = extractHtlcId(receipt);

    // Attempt refund prematurely
    await assert.rejects(
      async () => {
        await refundWallet.writeContract({
          account: refundWallet.account!,
          chain: hardhat,
          address: htlcAddress,
          abi: htlcAbi,
          functionName: 'refund',
          args: [htlcId],
        });
      },
      /TIMELOCK_NOT_EXPIRED/
    );
  });

  it('7. Refund after timelock succeeds (EVM-SEC-8)', async () => {
    const hashLock = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
    const amount = 400_000n;
    const timelock = BigInt((await getTimestamp()) + 100);

    const appTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'approve',
      args: [htlcAddress, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });

    const fundTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'fund',
      args: [hashLock, amount, tokenAddress, clientAddr, refundAddr, timelock],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
    const htlcId = extractHtlcId(receipt);

    // Advance time past timelock
    await increaseTime(200);

    const initRefBal = (await publicClient.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [refundAddr],
    })) as bigint;

    // Refund
    const refTx = await refundWallet.writeContract({
      account: refundWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'refund',
      args: [htlcId],
    });
    await publicClient.waitForTransactionReceipt({ hash: refTx });

    const endRefBal = (await publicClient.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [refundAddr],
    })) as bigint;
    assert.equal(endRefBal - initRefBal, amount);

    // Status is REFUNDED (3)
    const stored: any = await publicClient.readContract({
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'getHtlc',
      args: [htlcId],
    });
    assert.equal(stored.status, 3);
  });

  it('8. Claim after refund fails (Mutual Exclusion - EVM-SEC-9)', async () => {
    const preimage = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}` as `0x${string}`;
    const amount = 250_000n;
    const timelock = BigInt((await getTimestamp()) + 50);

    const appTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'approve',
      args: [htlcAddress, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });

    const fundTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'fund',
      args: [hashLock, amount, tokenAddress, clientAddr, refundAddr, timelock],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
    const htlcId = extractHtlcId(receipt);

    // Fast-forward and refund
    await increaseTime(100);
    const refTx = await refundWallet.writeContract({
      account: refundWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'refund',
      args: [htlcId],
    });
    await publicClient.waitForTransactionReceipt({ hash: refTx });

    // Now attempt claim with correct preimage -> Must revert with NOT_LOCKED
    const preimageHex = `0x${preimage.toString('hex')}` as `0x${string}`;
    await assert.rejects(
      async () => {
        await clientWallet.writeContract({
          account: clientWallet.account!,
          chain: hardhat,
          address: htlcAddress,
          abi: htlcAbi,
          functionName: 'claim',
          args: [htlcId, preimageHex],
        });
      },
      /NOT_LOCKED/
    );
  });

  it('9. Refund after claim fails (Mutual Exclusion - EVM-SEC-9)', async () => {
    const preimage = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}` as `0x${string}`;
    const amount = 250_000n;
    const timelock = BigInt((await getTimestamp()) + 100);

    const appTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'approve',
      args: [htlcAddress, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });

    const fundTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'fund',
      args: [hashLock, amount, tokenAddress, clientAddr, refundAddr, timelock],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
    const htlcId = extractHtlcId(receipt);

    // Claim
    const preimageHex = `0x${preimage.toString('hex')}` as `0x${string}`;
    const claimTx = await clientWallet.writeContract({
      account: clientWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'claim',
      args: [htlcId, preimageHex],
    });
    await publicClient.waitForTransactionReceipt({ hash: claimTx });

    // Advance time past timelock
    await increaseTime(200);

    // Attempt refund -> Must revert with NOT_LOCKED
    await assert.rejects(
      async () => {
        await refundWallet.writeContract({
          account: refundWallet.account!,
          chain: hardhat,
          address: htlcAddress,
          abi: htlcAbi,
          functionName: 'refund',
          args: [htlcId],
        });
      },
      /NOT_LOCKED/
    );
  });

  it('10. Double claim fails (EVM-SEC-10)', async () => {
    const preimage = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}` as `0x${string}`;
    const amount = 150_000n;
    const timelock = BigInt((await getTimestamp()) + 1000);

    const appTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'approve',
      args: [htlcAddress, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });

    const fundTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'fund',
      args: [hashLock, amount, tokenAddress, clientAddr, refundAddr, timelock],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
    const htlcId = extractHtlcId(receipt);

    const preimageHex = `0x${preimage.toString('hex')}` as `0x${string}`;
    const claimTx = await clientWallet.writeContract({
      account: clientWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'claim',
      args: [htlcId, preimageHex],
    });
    await publicClient.waitForTransactionReceipt({ hash: claimTx });

    // Second claim must revert
    await assert.rejects(
      async () => {
        await clientWallet.writeContract({
          account: clientWallet.account!,
          chain: hardhat,
          address: htlcAddress,
          abi: htlcAbi,
          functionName: 'claim',
          args: [htlcId, preimageHex],
        });
      },
      /NOT_LOCKED/
    );
  });

  it('11. Double refund fails (EVM-SEC-11)', async () => {
    const hashLock = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
    const amount = 180_000n;
    const timelock = BigInt((await getTimestamp()) + 50);

    const appTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'approve',
      args: [htlcAddress, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });

    const fundTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'fund',
      args: [hashLock, amount, tokenAddress, clientAddr, refundAddr, timelock],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
    const htlcId = extractHtlcId(receipt);

    await increaseTime(100);

    const refTx = await refundWallet.writeContract({
      account: refundWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'refund',
      args: [htlcId],
    });
    await publicClient.waitForTransactionReceipt({ hash: refTx });

    // Second refund must revert
    await assert.rejects(
      async () => {
        await refundWallet.writeContract({
          account: refundWallet.account!,
          chain: hardhat,
          address: htlcAddress,
          abi: htlcAbi,
          functionName: 'refund',
          args: [htlcId],
        });
      },
      /NOT_LOCKED/
    );
  });

  it('12. Front-runner claim cannot steal tokens (EVM-SEC-3)', async () => {
    // If an attacker observes the preimage in the mempool and front-runs the claim tx,
    // the tokens MUST still be delivered to clientAddr, NOT the attacker!
    const preimage = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}` as `0x${string}`;
    const amount = 350_000n;
    const timelock = BigInt((await getTimestamp()) + 1000);

    const appTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'approve',
      args: [htlcAddress, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });

    const fundTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'fund',
      args: [hashLock, amount, tokenAddress, clientAddr, refundAddr, timelock],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
    const htlcId = extractHtlcId(receipt);

    const initClientBal = (await publicClient.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [clientAddr],
    })) as bigint;

    const initAttackerBal = (await publicClient.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [attackerAddr],
    })) as bigint;

    // Attacker submits the claim transaction with the intercepted preimage
    const preimageHex = `0x${preimage.toString('hex')}` as `0x${string}`;
    const attackTx = await attackerWallet.writeContract({
      account: attackerWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'claim',
      args: [htlcId, preimageHex],
    });
    await publicClient.waitForTransactionReceipt({ hash: attackTx });

    // Attacker gained 0 tokens!
    const endAttackerBal = (await publicClient.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [attackerAddr],
    })) as bigint;
    assert.equal(endAttackerBal, initAttackerBal);

    // Client received the tokens!
    const endClientBal = (await publicClient.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [clientAddr],
    })) as bigint;
    assert.equal(endClientBal - initClientBal, amount);
  });

  it('13. Immutability: Storage fields cannot be mutated', async () => {
    const preimage = randomBytes(32);
    const hashLock = `0x${createHash('sha256').update(preimage).digest('hex')}` as `0x${string}`;
    const amount = 500_000n;
    const timelock = BigInt((await getTimestamp()) + 500);

    const appTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'approve',
      args: [htlcAddress, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });

    const fundTx = await operatorWallet.writeContract({
      account: operatorWallet.account!,
      chain: hardhat,
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'fund',
      args: [hashLock, amount, tokenAddress, clientAddr, refundAddr, timelock],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
    const htlcId = extractHtlcId(receipt);

    const stored: any = await publicClient.readContract({
      address: htlcAddress,
      abi: htlcAbi,
      functionName: 'getHtlc',
      args: [htlcId],
    });

    assert.equal(stored.hashLock.toLowerCase(), hashLock.toLowerCase());
    assert.equal(stored.amount, amount);
    assert.equal(stored.token.toLowerCase(), tokenAddress.toLowerCase());
    assert.equal(stored.claimAddress.toLowerCase(), clientAddr.toLowerCase());
    assert.equal(stored.refundAddress.toLowerCase(), refundAddr.toLowerCase());
    assert.equal(stored.timelock, timelock);
  });

  it('14. Zero admin seizure path exists (EVM-SEC-17)', () => {
    const fnNames = htlcAbi.filter((x: any) => x.type === 'function').map((x: any) => x.name);
    assert.equal(fnNames.includes('owner'), false);
    assert.equal(fnNames.includes('emergencyWithdraw'), false);
    assert.equal(fnNames.includes('pause'), false);
    assert.equal(fnNames.includes('upgradeTo'), false);
    assert.equal(fnNames.includes('transferOwnership'), false);
    assert.equal(fnNames.includes('sweep'), false);
  });
});
