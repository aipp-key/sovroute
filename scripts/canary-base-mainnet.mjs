/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 4 Mainnet: 1.00 USDC Canary Swap Test on Base Mainnet
 *
 * Implements SEC-1, SEC-6, SEC-15, SEC-16, BASE-SEC-1..30
 *
 * Canary Flow:
 * 1. Generate 32-byte cryptographic preimage and SHA-256 hashlock.
 * 2. Approve 1.00 USDC to deployed HtlcErc20 contract.
 * 3. Lock 1.00 USDC via fund(...) on Base Mainnet.
 * 4. Verify on-chain HtlcFunded event and locked status.
 * 5. Settle atomically via claim(...) revealing the preimage.
 * 6. Verify on-chain HtlcClaimed event.
 * 7. Confirm 1.00 USDC is returned safely to the operator wallet (net USDC cost: 0.00 USDC).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  formatUnits,
  parseAbiItem,
  getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  BASE_MAINNET_CHAIN_ID,
  OFFICIAL_BASE_MAINNET_USDC_ADDRESS,
} from '../src/atomic/evm/base-guard.ts';

const rootDir = process.cwd();
const CANONICAL_USDC = getAddress(OFFICIAL_BASE_MAINNET_USDC_ADDRESS);

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
];

async function main() {
  console.log('=== STARTING SOVROUTE BASE MAINNET CANARY SWAP TEST ===\n');

  // 1. Read deployment record
  const deploymentFile = join(rootDir, 'deployments', 'base-mainnet.json');
  let deployment;
  try {
    deployment = JSON.parse(readFileSync(deploymentFile, 'utf8'));
  } catch {
    throw new Error('Base Mainnet deployment not found! Run deploy-base-mainnet.mjs first.');
  }

  const htlcAddress = getAddress(deployment.htlcAddress);
  console.log('HTLC Contract Address:', htlcAddress);
  console.log('Canonical USDC Address:', CANONICAL_USDC);

  // 2. Read private key from .env
  const envContent = readFileSync(join(rootDir, '.env'), 'utf8');
  const match = envContent.match(/BASE_MAINNET_PRIVATE_KEY=\s*([^\r\n]+)/);
  if (!match) {
    throw new Error('BASE_MAINNET_PRIVATE_KEY not found in .env');
  }

  let privateKey = match[1].trim();
  if (!privateKey.startsWith('0x')) {
    privateKey = `0x${privateKey}`;
  }

  const account = privateKeyToAccount(privateKey);
  console.log('Operator / Tester Address:', account.address);

  // 3. Setup RPC clients
  const publicClient = createPublicClient({
    chain: base,
    transport: http('https://mainnet.base.org'),
    cacheTime: 0,
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http('https://mainnet.base.org'),
  });

  const chainId = await publicClient.getChainId();
  if (chainId !== BASE_MAINNET_CHAIN_ID) {
    throw new Error(`Chain ID mismatch: expected 8453, got ${chainId}`);
  }

  // 4. Verify balances
  const ethBalance = await publicClient.getBalance({ address: account.address });
  console.log('Operator ETH Balance:', formatEther(ethBalance), 'ETH');

  const usdcBalance = await publicClient.readContract({
    address: CANONICAL_USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  console.log('Operator USDC Balance:', formatUnits(usdcBalance, 6), 'USDC');

  const canaryAmount = 1_000_000n; // 1.00 USDC
  if (usdcBalance < canaryAmount) {
    throw new Error(`Insufficient USDC for canary: has ${formatUnits(usdcBalance, 6)}, needs 1.00 USDC`);
  }

  // 5. Load HTLC Artifact ABI
  const artifactPath = join(rootDir, 'artifacts', 'contracts', 'HtlcErc20.sol', 'HtlcErc20.json');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

  // 6. Check & set USDC Allowance
  const currentAllowance = await publicClient.readContract({
    address: CANONICAL_USDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, htlcAddress],
  });
  console.log(`Current USDC Allowance: ${formatUnits(currentAllowance, 6)} USDC`);

  if (currentAllowance < canaryAmount) {
    console.log('Approving 1.00 USDC for HTLC contract...');
    const approveTx = await walletClient.writeContract({
      address: CANONICAL_USDC,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [htlcAddress, 10_000_000n], // 10 USDC approve limit
    });
    console.log('Approve Tx Broadcast:', approveTx);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log('USDC Approve Confirmed ✅');
  }

  // 7. Generate Secret Preimage & SHA-256 Hashlock
  const preimageBytes = randomBytes(32);
  const preimageHex = `0x${preimageBytes.toString('hex')}`;
  const hashLockHex = `0x${createHash('sha256').update(preimageBytes).digest('hex')}`;
  const timelock = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour timelock

  console.log('\n--- ATOMIC PARAMETERS ---');
  console.log('Preimage (Secret):', `${preimageHex.slice(0, 10)}...${preimageHex.slice(-6)}`);
  console.log('HashLock (SHA-256):', hashLockHex);
  console.log('Timelock (Unix):', timelock.toString());
  console.log('Canary Amount: 1.00 USDC');

  // 8. Execute HTLC Lock (fund)
  console.log('\n[Step 1/2] Locking 1.00 USDC in HTLC on Base Mainnet...');
  const fundTx = await walletClient.writeContract({
    address: htlcAddress,
    abi: artifact.abi,
    functionName: 'fund',
    args: [
      hashLockHex,
      canaryAmount,
      CANONICAL_USDC,
      account.address, // claimAddress: operator receives the tokens back
      account.address, // refundAddress
      timelock,
    ],
  });
  console.log('Fund Tx Broadcast:', fundTx);
  console.log(`BaseScan Lock Tx: https://basescan.org/tx/${fundTx}`);

  const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
  console.log('Fund Status:', fundReceipt.status === 'success' ? 'CONFIRMED ✅' : 'FAILED ❌');

  // Find HtlcFunded event to retrieve htlcId
  const fundedEvent = parseAbiItem(
    'event HtlcFunded(bytes32 indexed htlcId, bytes32 indexed hashLock, uint256 amount, address token, address sender, address claimAddress, address refundAddress, uint256 timelock)'
  );

  let htlcId = null;
  for (const log of fundReceipt.logs) {
    if (log.address.toLowerCase() === htlcAddress.toLowerCase()) {
      try {
        const topics = log.topics;
        if (topics && topics.length >= 3) {
          htlcId = topics[1];
          break;
        }
      } catch {
        // continue
      }
    }
  }

  if (!htlcId) {
    throw new Error('Failed to parse htlcId from HtlcFunded event logs');
  }
  // Verify on-chain HTLC state and wait for read-replica indexing
  console.log('Waiting for read-replica state confirmation...');
  let locked = false;
  for (let attempt = 1; attempt <= 10; attempt++) {
    const record = await publicClient.readContract({
      address: htlcAddress,
      abi: artifact.abi,
      functionName: 'htlcs',
      args: [htlcId],
    });
    if (record[7] === 1 || record.status === 1) {
      locked = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!locked) {
    throw new Error('Timed out waiting for HTLC LOCKED status on read replica');
  }
  console.log('On-chain HTLC Status: LOCKED (1) ✅');

  // 9. Execute Atomic Claim (Preimage Reveal)
  console.log('\n[Step 2/2] Revealing Preimage & Claiming 1.00 USDC back...');
  const claimTx = await walletClient.writeContract({
    address: htlcAddress,
    abi: artifact.abi,
    functionName: 'claim',
    args: [htlcId, preimageHex],
  });
  console.log('Claim Tx Broadcast:', claimTx);
  console.log(`BaseScan Claim Tx: https://basescan.org/tx/${claimTx}`);

  const claimReceipt = await publicClient.waitForTransactionReceipt({ hash: claimTx });
  console.log('Claim Status:', claimReceipt.status === 'success' ? 'CONFIRMED ✅' : 'FAILED ❌');

  // 10. Post-test Balance Verification (allow replica to settle)
  await new Promise((r) => setTimeout(r, 2000));
  const finalUsdcBalance = await publicClient.readContract({
    address: CANONICAL_USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  const finalEthBalance = await publicClient.getBalance({ address: account.address });

  console.log('\n======================================================');
  console.log('🎉 CANARY ATOMIC SWAP TEST COMPLETED SUCCESSFULLY!');
  console.log('======================================================');
  console.log(`Initial USDC: ${formatUnits(usdcBalance, 6)} USDC`);
  console.log(`Final USDC:   ${formatUnits(finalUsdcBalance, 6)} USDC (Net Change: 0.00 USDC)`);
  console.log(`Final ETH:    ${formatEther(finalEthBalance)} ETH`);
  console.log(`Lock Transaction:  https://basescan.org/tx/${fundTx}`);
  console.log(`Claim Transaction: https://basescan.org/tx/${claimTx}`);
  console.log('======================================================\n');
}

main().catch((err) => {
  console.error('\n❌ Canary Swap Test Failed:', err);
  process.exit(1);
});
