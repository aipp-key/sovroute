/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 4 Mainnet: Deploy HtlcErc20.sol to Base Mainnet (Chain ID 8453)
 *
 * Implements SEC-1, SEC-7, SEC-15, SEC-16, BASE-SEC-1..30
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  BASE_MAINNET_CHAIN_ID,
  OFFICIAL_BASE_MAINNET_USDC_ADDRESS,
  PINNED_HTLC_BYTECODE_RAW_SHA256,
  LEGACY_HTLC_BYTECODE_HEX_STRING_SHA256,
} from '../src/atomic/evm/base-guard.ts';

const rootDir = process.cwd();

async function main() {
  console.log('=== DEPLOYING HTLCERC20 TO BASE MAINNET ===');

  // 1. Read private key from .env
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
  console.log('Deployer / Operator Address:', account.address);

  // 2. Setup RPC clients
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

  // 3. Verify Chain ID is strictly Base Mainnet (8453)
  const chainId = await publicClient.getChainId();
  console.log('Connected Chain ID:', chainId);
  if (chainId !== BASE_MAINNET_CHAIN_ID) {
    throw new Error(`Chain ID mismatch: expected ${BASE_MAINNET_CHAIN_ID} (Base Mainnet), got ${chainId}`);
  }

  // 4. Verify Deployer ETH Balance
  const balance = await publicClient.getBalance({ address: account.address });
  console.log('Deployer ETH Balance:', formatEther(balance), 'ETH');
  if (balance === 0n) {
    throw new Error('DEPLOYMENT_HALTED: Deployer has 0 ETH on Base Mainnet');
  }

  // 5. Load contract artifact
  const artifactPath = join(rootDir, 'artifacts', 'contracts', 'HtlcErc20.sol', 'HtlcErc20.json');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

  // 6. Verify local compiled runtime bytecode hash matches pinned raw hash
  const cleanHex = artifact.deployedBytecode.replace(/^0x/i, '');
  const localDeployedBytecodeRawHash = createHash('sha256')
    .update(Buffer.from(cleanHex, 'hex'))
    .digest('hex');
  console.log('Local Deployed Bytecode Raw SHA-256:', localDeployedBytecodeRawHash);
  if (localDeployedBytecodeRawHash.toLowerCase() !== PINNED_HTLC_BYTECODE_RAW_SHA256.toLowerCase()) {
    throw new Error('Local compiled bytecode does not match pinned raw implementation hash!');
  }
  console.log('Cryptographic Bytecode Pre-Check: 100% MATCH');

  // 7. Estimate Gas
  const deployGas = await publicClient.estimateGas({
    account: account.address,
    data: artifact.bytecode,
  });
  const gasPrice = await publicClient.getGasPrice();
  const estimatedCost = deployGas * gasPrice;
  console.log(`Estimated Deploy Gas: ${deployGas.toString()} units`);
  console.log(`Estimated Cost: ${formatEther(estimatedCost)} ETH`);

  if (balance < estimatedCost) {
    throw new Error(`Insufficient funds: Balance (${formatEther(balance)} ETH) < Estimated Cost (${formatEther(estimatedCost)} ETH)`);
  }

  // 8. Broadcast deployment transaction
  console.log('Broadcasting deployment transaction to Base Mainnet...');
  const deployHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
  });
  console.log('Deployment Tx Hash:', deployHash);
  console.log('Awaiting confirmation...');

  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  console.log('Receipt Status:', receipt.status === 'success' ? 'SUCCESS (1)' : 'REVERTED (0)');
  console.log('Deployed Contract Address:', receipt.contractAddress);
  console.log('Block Number:', receipt.blockNumber.toString());
  console.log('Gas Used:', receipt.gasUsed.toString());

  if (!receipt.contractAddress) {
    throw new Error('Deployment receipt missing contract address');
  }

  // 9. Post-deployment runtime bytecode verification
  console.log('Verifying on-chain runtime bytecode via eth_getCode...');
  let onChainCode = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    onChainCode = await publicClient.getBytecode({ address: receipt.contractAddress });
    if (onChainCode && onChainCode !== '0x') {
      break;
    }
    console.log(`Waiting for node bytecode indexing (attempt ${attempt}/10)...`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  if (!onChainCode || onChainCode === '0x') {
    throw new Error('No on-chain bytecode found at deployed address after timeout!');
  }

  const cleanOnChain = onChainCode.replace(/^0x/i, '');
  const onChainRawHash = createHash('sha256')
    .update(Buffer.from(cleanOnChain, 'hex'))
    .digest('hex');
  console.log('On-chain Runtime Bytecode Raw SHA-256:', onChainRawHash);

  if (onChainRawHash.toLowerCase() !== PINNED_HTLC_BYTECODE_RAW_SHA256.toLowerCase()) {
    throw new Error(`On-chain bytecode mismatch! Got: ${onChainRawHash}`);
  }
  console.log('On-chain Verification: PASSED (Bytecode matches pinned implementation hash)');

  // 10. Save deployment record
  const deploymentRecord = {
    name: 'Base Mainnet Sovereign Core HTLC Deployment',
    description: 'Official production deployment identity for HtlcErc20 on Base Mainnet (Chain ID 8453).',
    architectureVersion: 'V4 Sovereign Core',
    protocolVersion: '4.0.0',
    status: 'CANONICAL_MAINNET_LIVE',
    route: 'Lightning BTC -> Base HTLC -> native Circle USDC on Base',
    network: 'base-mainnet',
    networkName: 'Base Mainnet',
    chainId: BASE_MAINNET_CHAIN_ID,
    contractName: 'HtlcErc20',
    htlcAddress: getAddress(receipt.contractAddress),
    contractAddress: getAddress(receipt.contractAddress),
    tokenSymbol: 'USDC',
    tokenName: 'USD Coin',
    tokenAddress: OFFICIAL_BASE_MAINNET_USDC_ADDRESS,
    usdcAddress: OFFICIAL_BASE_MAINNET_USDC_ADDRESS,
    officialCircleUsdcAddress: OFFICIAL_BASE_MAINNET_USDC_ADDRESS,
    tokenDecimals: 6,
    operatorAddress: account.address,
    deployerAddress: account.address,
    deploymentTxHash: receipt.transactionHash,
    deploymentBlock: Number(receipt.blockNumber),
    gasUsed: receipt.gasUsed.toString(),
    runtimeBytecodeSha256Raw: PINNED_HTLC_BYTECODE_RAW_SHA256,
    legacyHexBytecodeHash: LEGACY_HTLC_BYTECODE_HEX_STRING_SHA256,
    solcVersion: '0.8.28',
    solcCommit: '0.8.28+commit.7893614a',
    optimizerEnabled: true,
    optimizerRuns: 200,
    evmVersion: 'paris',
    sourceSha256: '738496dd9b2364f7d042e7347d1b6913973534784594ca3b85f94c848085626d',
    deployedAt: new Date().toISOString(),
    explorerUrl: `https://basescan.org/address/${receipt.contractAddress}`,
    txExplorerUrl: `https://basescan.org/tx/${receipt.transactionHash}`,
  };

  const outFile = join(rootDir, 'deployments', 'base-mainnet.json');
  writeFileSync(outFile, JSON.stringify(deploymentRecord, null, 2));
  console.log('Saved deployment record to:', outFile);
  console.log(`\n🎉 BASE MAINNET DEPLOYMENT SUCCESSFUL!`);
  console.log(`Basescan Explorer: https://basescan.org/address/${receipt.contractAddress}`);
  console.log(`Transaction: https://basescan.org/tx/${receipt.transactionHash}\n`);
}

main().catch((err) => {
  console.error('\n❌ Base Mainnet Deployment Failed:', err);
  process.exit(1);
});
