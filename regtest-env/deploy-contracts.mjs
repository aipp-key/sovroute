/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Local Devnet Contract Deployer (Phase 3)
 *
 * Deploys HtlcErc20 and MockSettlementToken to local Hardhat devnet (31337).
 * Enforces P0 network guard and verifies contract bytecode before writing deployment config.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import {
  EvmNetworkGuard,
  ACCEPTED_LOCAL_DEVNET_CHAIN_ID,
} from '../src/atomic/evm/evm-guard.ts';

const rootDir = process.cwd();
const dataDir = join(rootDir, 'regtest-env', 'data');
const artifactsDir = join(rootDir, 'artifacts', 'contracts');

// Standard Hardhat dev account 0 (Operator/Deployer)
const OPERATOR_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CLIENT_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Hardhat account 1

async function main() {
  console.log('======================================================');
  console.log('DEPLOYING LOCAL EVM HTLC CONTRACTS (DEVNET CHAIN 31337)');
  console.log('======================================================');

  const publicClient = createPublicClient({
    chain: hardhat,
    transport: http('http://127.0.0.1:8545'),
  });

  const chainId = await publicClient.getChainId();
  console.log(`Connected to local RPC chain ID: ${chainId}`);

  // P0 Guard
  EvmNetworkGuard.assertSafeLocalNetwork(chainId);

  const operatorAccount = privateKeyToAccount(OPERATOR_PRIVATE_KEY);
  const walletClient = createWalletClient({
    account: operatorAccount,
    chain: hardhat,
    transport: http('http://127.0.0.1:8545'),
  });

  // 1. Deploy MockSettlementToken
  const tokenArtifact = JSON.parse(
    readFileSync(
      join(artifactsDir, 'MockSettlementToken.sol', 'MockSettlementToken.json'),
      'utf8'
    )
  );

  console.log('Deploying MockSettlementToken (MST)...');
  const tokenTxHash = await walletClient.deployContract({
    abi: tokenArtifact.abi,
    bytecode: tokenArtifact.bytecode,
  });

  const tokenReceipt = await publicClient.waitForTransactionReceipt({ hash: tokenTxHash });
  const tokenAddress = tokenReceipt.contractAddress;
  console.log(`MockSettlementToken deployed at: ${tokenAddress}`);

  // 2. Deploy HtlcErc20
  const htlcArtifact = JSON.parse(
    readFileSync(
      join(artifactsDir, 'HtlcErc20.sol', 'HtlcErc20.json'),
      'utf8'
    )
  );

  console.log('Deploying HtlcErc20...');
  const htlcTxHash = await walletClient.deployContract({
    abi: htlcArtifact.abi,
    bytecode: htlcArtifact.bytecode,
  });

  const htlcReceipt = await publicClient.waitForTransactionReceipt({ hash: htlcTxHash });
  const htlcAddress = htlcReceipt.contractAddress;
  console.log(`HtlcErc20 deployed at: ${htlcAddress}`);

  // 3. Verify deployed bytecode matches pinned hash
  const deployedBytecode = await publicClient.getBytecode({ address: htlcAddress });
  EvmNetworkGuard.assertContractBytecode(deployedBytecode);
  console.log('Bytecode verification PASSED: matches pinned SHA-256 implementation.');

  // 4. Fund client with test tokens
  console.log('Minting initial test tokens to client account...');
  const mintTxHash = await walletClient.writeContract({
    address: tokenAddress,
    abi: tokenArtifact.abi,
    functionName: 'mint',
    args: [CLIENT_ADDRESS, 50_000n * 10n ** 6n], // 50,000 MST
  });
  await publicClient.waitForTransactionReceipt({ hash: mintTxHash });

  // 5. Save deployment configuration
  mkdirSync(dataDir, { recursive: true });
  const deploymentInfo = {
    chainId,
    deployedAt: new Date().toISOString(),
    operatorAddress: operatorAccount.address,
    clientAddress: CLIENT_ADDRESS,
    htlcAddress,
    tokenAddress,
  };

  const configPath = join(dataDir, 'evm-deployment.json');
  writeFileSync(configPath, JSON.stringify(deploymentInfo, null, 2), 'utf8');
  console.log(`Deployment metadata saved to: ${configPath}`);
  console.log('======================================================');
  console.log('LOCAL EVM HTLC DEPLOYMENT COMPLETE');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('DEPLOYMENT_FAILED:', err);
  process.exit(1);
});
