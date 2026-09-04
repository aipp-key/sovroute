/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Phase 4: Deploy HtlcErc20.sol to Base Sepolia (Chain ID 84532)
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
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  BaseNetworkGuard,
  BASE_SEPOLIA_CHAIN_ID,
  OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
} from '../src/atomic/evm/base-guard.ts';
import {
  PINNED_HTLC_BYTECODE_RAW_SHA256,
  LEGACY_HTLC_BYTECODE_HEX_STRING_SHA256,
} from '../src/atomic/evm/evm-guard.ts';

const rootDir = process.cwd();
const dataDir = join(rootDir, 'regtest-env', 'data');
const operatorFile = join(dataDir, 'base-sepolia-operator.json');

async function main() {
  console.log('=== DEPLOYING HTLCERC20 TO BASE SEPOLIA ===');

  const operatorData = JSON.parse(readFileSync(operatorFile, 'utf8'));
  const account = privateKeyToAccount(operatorData.privateKey);
  console.log('Deployer / Operator Address:', account.address);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http('https://sepolia.base.org'),
    cacheTime: 0,
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http('https://sepolia.base.org'),
  });

  // 1. Guard check: Network must be Base Sepolia (84532)
  const chainId = await publicClient.getChainId();
  console.log('Connected Chain ID:', chainId);
  BaseNetworkGuard.assertBaseSepoliaNetwork(chainId);

  // 2. Check balance
  const balance = await publicClient.getBalance({ address: account.address });
  console.log('Deployer ETH Balance (wei):', balance.toString());
  if (balance === 0n) {
    throw new Error('TESTNET_FUNDING_REQUIRED: Deployer has 0 Base Sepolia ETH');
  }

  // 3. Load contract artifact
  const artifactPath = join(rootDir, 'artifacts', 'contracts', 'HtlcErc20.sol', 'HtlcErc20.json');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

  // 4. Verify local compiled runtime bytecode hash matches pinned raw hash
  const cleanHex = artifact.deployedBytecode.replace(/^0x/i, '');
  const localDeployedBytecodeRawHash = createHash('sha256')
    .update(Buffer.from(cleanHex, 'hex'))
    .digest('hex');
  console.log('Local Deployed Bytecode Raw SHA-256:', localDeployedBytecodeRawHash);
  if (localDeployedBytecodeRawHash.toLowerCase() !== PINNED_HTLC_BYTECODE_RAW_SHA256.toLowerCase()) {
    throw new Error('Local compiled bytecode does not match pinned raw implementation hash!');
  }

  // 5. Deploy contract
  console.log('Broadcasting deployment transaction...');
  const deployHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
  });
  console.log('Deployment Tx Hash:', deployHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  console.log('Receipt status:', receipt.status);
  console.log('Contract Address:', receipt.contractAddress);
  console.log('Block Number:', receipt.blockNumber.toString());

  if (!receipt.contractAddress) {
    throw new Error('Deployment receipt missing contract address');
  }

  // 6. Post-deployment runtime bytecode verification
  console.log('Verifying on-chain runtime bytecode via eth_getCode...');
  const onChainCode = await publicClient.getBytecode({ address: receipt.contractAddress });
  BaseNetworkGuard.assertContractBytecode(onChainCode ?? '0x');
  console.log('Bytecode verification PASSED: 100% match with pinned implementation hash!');

  // 7. Save deployment metadata
  const deploymentRecord = {
    protocolVersion: '4.0.0',
    chainId: BASE_SEPOLIA_CHAIN_ID,
    network: 'base-sepolia',
    htlcAddress: receipt.contractAddress,
    tokenAddress: OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
    operatorAddress: account.address,
    deploymentTxHash: receipt.transactionHash,
    deploymentBlock: Number(receipt.blockNumber),
    runtimeBytecodeSha256Raw: PINNED_HTLC_BYTECODE_RAW_SHA256,
    legacyHexBytecodeHash: LEGACY_HTLC_BYTECODE_HEX_STRING_SHA256,
    solcVersion: '0.8.28',
    solcCommit: '0.8.28+commit.7893614a',
    optimizerEnabled: true,
    optimizerRuns: 200,
    evmVersion: 'paris',
    sourceSha256: '738496dd9b2364f7d042e7347d1b6913973534784594ca3b85f94c848085626d',
    deployedAt: new Date().toISOString(),
  };

  const outFile = join(dataDir, 'base-sepolia-deployment.json');
  writeFileSync(outFile, JSON.stringify(deploymentRecord, null, 2));
  console.log('Saved deployment record to:', outFile);
  console.log('=== BASE SEPOLIA DEPLOYMENT SUCCESSFUL ===');
}

main().catch((err) => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
