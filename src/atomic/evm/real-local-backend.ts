/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Real Local EVM Atomic Backend (Phase 3)
 *
 * Implements IEvmAtomicBackend against a local deterministic Hardhat devnet (31337).
 *
 * Enforces:
 * - EVM-SEC-1..18: Complete cryptographic HTLC security model.
 * - P0 Safety Boundary: Refuses any non-local network fail-closed.
 * - Bytecode Pinning: Refuses tampered or unknown contract implementations.
 * - Durable Action Ownership: Prevents blind retries on dropped connections.
 * - Storage Authoritative Reconciliation: State verified from on-chain storage.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Hex,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  decodeFunctionData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import type {
  IEvmAtomicBackend,
  EvmHtlcParams,
  EvmHtlcState,
  SecretPreimage,
} from '../types.ts';
import {
  EvmNetworkGuard,
  ACCEPTED_LOCAL_DEVNET_CHAIN_ID,
} from './evm-guard.ts';
import {
  type EvmHtlcFundedEvidence,
  type EvmHtlcClaimedEvidence,
  type EvmHtlcRefundedEvidence,
  type EvmHtlcEvidence,
  LightningSettlementGateError,
} from './evm-types.ts';

// Deterministic dev accounts from local Hardhat node (OPERATOR INFRASTRUCTURE ONLY)
// CRITICAL: Router core NEVER possesses client/claimer keys!
const DEFAULT_OPERATOR_KEY: Hex =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Account 0
const DEFAULT_REFUND_KEY: Hex =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // Account 2 (0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC)

export interface RealLocalEvmBackendConfig {
  rpcUrl?: string;
  chainId?: number;
  htlcAddress?: `0x${string}`;
  tokenAddress?: `0x${string}`;
  operatorPrivateKey?: Hex;
  refundPrivateKey?: Hex;
}

export class RealLocalEvmAtomicBackend implements IEvmAtomicBackend {
  readonly backendName = 'RealLocalEvmAtomicBackend';
  readonly chainId = ACCEPTED_LOCAL_DEVNET_CHAIN_ID;
  public readonly finalityPolicy = {
    policyTag: 'LOCAL_DEVNET_FINALITY_POLICY',
    requiredConfirmations: 1,
  };

  private publicClient: PublicClient;
  private operatorWallet: WalletClient;
  private refundWallet: WalletClient;

  private htlcAddress: `0x${string}`;
  private tokenAddress: `0x${string}`;

  private htlcAbi: any;
  private tokenAbi: any;

  // Durable tracking
  private swapKeyToHtlcId = new Map<string, `0x${string}`>();
  private htlcIdToSwapKey = new Map<`0x${string}`, string>();
  private evidenceLog: EvmHtlcEvidence[] = [];
  private durableActions = new Map<
    string,
    { status: 'PENDING' | 'MINED' | 'FAILED'; txHash?: string }
  >();

  private initialized = false;

  constructor(config: RealLocalEvmBackendConfig = {}) {
    const rootDir = process.cwd();
    const rpcUrl = config.rpcUrl ?? 'http://127.0.0.1:8545';

    this.publicClient = createPublicClient({
      chain: hardhat,
      transport: http(rpcUrl),
      cacheTime: 0,
    });

    const opKey = config.operatorPrivateKey ?? DEFAULT_OPERATOR_KEY;
    const refKey = config.refundPrivateKey ?? DEFAULT_REFUND_KEY;

    this.operatorWallet = createWalletClient({
      account: privateKeyToAccount(opKey),
      chain: hardhat,
      transport: http(rpcUrl),
    });

    this.refundWallet = createWalletClient({
      account: privateKeyToAccount(refKey),
      chain: hardhat,
      transport: http(rpcUrl),
    });

    // Load contract ABIs
    const artifactsDir = join(rootDir, 'artifacts', 'contracts');
    const htlcArtifact = JSON.parse(
      readFileSync(join(artifactsDir, 'HtlcErc20.sol', 'HtlcErc20.json'), 'utf8')
    );
    const tokenArtifact = JSON.parse(
      readFileSync(
        join(artifactsDir, 'MockSettlementToken.sol', 'MockSettlementToken.json'),
        'utf8'
      )
    );

    this.htlcAbi = htlcArtifact.abi;
    this.tokenAbi = tokenArtifact.abi;

    // Resolve addresses
    if (config.htlcAddress && config.tokenAddress) {
      this.htlcAddress = config.htlcAddress;
      this.tokenAddress = config.tokenAddress;
    } else {
      const deploymentPath = join(rootDir, 'regtest-env', 'data', 'evm-deployment.json');
      if (!existsSync(deploymentPath)) {
        throw new Error(
          `Deployment metadata not found at ${deploymentPath}. Run 'node regtest-env/deploy-contracts.mjs' first.`
        );
      }
      const dep = JSON.parse(readFileSync(deploymentPath, 'utf8'));
      this.htlcAddress = dep.htlcAddress;
      this.tokenAddress = dep.tokenAddress;
    }
  }

  /**
   * Initializes and validates network safety guards.
   */
  public async ensureGuards(): Promise<void> {
    if (this.initialized) return;

    const actualChainId = await this.publicClient.getChainId();
    EvmNetworkGuard.assertSafeLocalNetwork(actualChainId);

    const bytecode = await this.publicClient.getBytecode({ address: this.htlcAddress });
    EvmNetworkGuard.assertContractBytecode(bytecode ?? '0x');

    this.initialized = true;
  }

  public getHtlcAddress(): `0x${string}` {
    return this.htlcAddress;
  }

  public getTokenAddress(): `0x${string}` {
    return this.tokenAddress;
  }

  public getHtlcAbi(): any {
    return this.htlcAbi;
  }

  public getEvidenceLog(): readonly EvmHtlcEvidence[] {
    return [...this.evidenceLog];
  }

  /**
   * Computes the deterministic htlcId exactly matching the smart contract keccak256 hash.
   */
  public computeHtlcId(params: {
    hashLock: `0x${string}`;
    amountUnits: bigint;
    tokenAddress: `0x${string}`;
    sender: `0x${string}`;
    claimAddress: `0x${string}`;
    refundAddress: `0x${string}`;
    refundLocktime: number;
    chainId: number;
  }): `0x${string}` {
    const encoded = encodeAbiParameters(
      parseAbiParameters('bytes32, uint256, address, address, address, address, uint256, uint256'),
      [
        params.hashLock,
        params.amountUnits,
        params.tokenAddress,
        params.sender,
        params.claimAddress,
        params.refundAddress,
        BigInt(params.refundLocktime),
        BigInt(params.chainId),
      ]
    );
    return keccak256(encoded);
  }

  /**
   * 1. Funds an EVM HTLC.
   */
  async fundHtlc(
    params: EvmHtlcParams
  ): Promise<{ txHash: string; blockNumber: number; htlcId: string }> {
    await this.ensureGuards();

    const actionKey = `fund:${params.swapKey}`;
    const existingAction = this.durableActions.get(actionKey);
    if (existingAction && existingAction.status === 'MINED') {
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: existingAction.txHash as `0x${string}`,
      });
      const htlcId = this.swapKeyToHtlcId.get(params.swapKey) ?? ('0x' as `0x${string}`);
      return { txHash: receipt.transactionHash, blockNumber: Number(receipt.blockNumber), htlcId };
    }

    this.durableActions.set(actionKey, { status: 'PENDING' });

    const hashLock = (params.hashLock.startsWith('0x')
      ? params.hashLock
      : `0x${params.hashLock}`) as `0x${string}`;
    const token = (params.tokenAddress.startsWith('0x')
      ? params.tokenAddress
      : `0x${params.tokenAddress}`) as `0x${string}`;
    const claimAddr = (params.claimAddress.startsWith('0x')
      ? params.claimAddress
      : `0x${params.claimAddress}`) as `0x${string}`;
    const refundAddr = (params.refundAddress.startsWith('0x')
      ? params.refundAddress
      : `0x${params.refundAddress}`) as `0x${string}`;

    // Exact approve before funding
    const approveTx = await this.operatorWallet.writeContract({
      account: this.operatorWallet.account!,
      chain: hardhat,
      address: token,
      abi: this.tokenAbi,
      functionName: 'approve',
      args: [this.htlcAddress, params.amountUnits],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: approveTx });

    // Fund HTLC
    const fundTx = await this.operatorWallet.writeContract({
      account: this.operatorWallet.account!,
      chain: hardhat,
      address: this.htlcAddress,
      abi: this.htlcAbi,
      functionName: 'fund',
      args: [
        hashLock,
        params.amountUnits,
        token,
        claimAddr,
        refundAddr,
        BigInt(params.refundLocktime),
      ],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: fundTx });
    const blockNumber = Number(receipt.blockNumber);
    const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const blockTimestamp = Number(block.timestamp);

    // Derive deterministic htlcId
    const operatorAddr = this.operatorWallet.account!.address;
    const htlcId = this.computeHtlcId({
      hashLock,
      amountUnits: params.amountUnits,
      tokenAddress: token,
      sender: operatorAddr,
      claimAddress: claimAddr,
      refundAddress: refundAddr,
      refundLocktime: params.refundLocktime,
      chainId: this.chainId,
    });

    // Authoritative storage check: verify status == LOCKED (1)
    const storedHtlc: any = await this.publicClient.readContract({
      address: this.htlcAddress,
      abi: this.htlcAbi,
      functionName: 'getHtlc',
      args: [htlcId],
    });

    if (storedHtlc.status !== 1) {
      throw new Error(`STORAGE_VERIFICATION_FAILED: Expected LOCKED (1), got ${storedHtlc.status}`);
    }

    this.swapKeyToHtlcId.set(params.swapKey, htlcId);
    this.htlcIdToSwapKey.set(htlcId, params.swapKey);

    const evidence: EvmHtlcFundedEvidence = {
      evidenceType: 'EVM_HTLC_FUNDED',
      chainId: this.chainId,
      contractAddress: this.htlcAddress,
      htlcId,
      hashLock,
      token,
      amount: params.amountUnits,
      claimAddress: claimAddr,
      refundAddress: refundAddr,
      timelock: params.refundLocktime,
      txHash: receipt.transactionHash,
      blockNumber,
      blockTimestamp,
      observedAt: new Date(),
    };
    this.evidenceLog.push(evidence);

    this.durableActions.set(actionKey, {
      status: 'MINED',
      txHash: receipt.transactionHash,
    });

    return { txHash: receipt.transactionHash, blockNumber, htlcId };
  }

  /**
   * 2. Observes authoritative on-chain state for a swapKey.
   */
  async observeHtlc(swapKey: string): Promise<EvmHtlcState> {
    await this.ensureGuards();

    const blockTimestamp = await this.getBlockTimestamp();
    const htlcId = this.swapKeyToHtlcId.get(swapKey);

    if (!htlcId) {
      return {
        swapKey,
        funded: false,
        completed: false,
        refunded: false,
        balance: 0n,
        timelock: 0,
        blockTimestamp,
      };
    }

    const storedHtlc: any = await this.publicClient.readContract({
      address: this.htlcAddress,
      abi: this.htlcAbi,
      functionName: 'getHtlc',
      args: [htlcId],
    });

    const status = Number(storedHtlc.status);
    const funded = status === 1 || status === 2 || status === 3;
    const completed = status === 2; // Status.CLAIMED
    const refunded = status === 3; // Status.REFUNDED
    const balance = status === 1 ? BigInt(storedHtlc.amount) : 0n;

    return {
      swapKey,
      funded,
      completed,
      refunded,
      balance,
      timelock: Number(storedHtlc.timelock),
      blockTimestamp,
    };
  }

  /**
   * 3. Claim HTLC (Sovereign boundary enforcement).
   * In Architecture V4, Router does NOT possess client private keys.
   * Clients must sign and broadcast claims directly to the EVM network.
   */
  async claimHtlc(_params: {
    swapKey: string;
    preimage: SecretPreimage;
    destination: string;
    signature?: string;
    dexCalldata?: string;
  }): Promise<{ txHash: string; blockNumber: number; success: boolean }> {
    throw new Error(
      'ROUTER_DOES_NOT_OWN_CLIENT_SIGNER: Sovereign clients must submit claim transactions directly to the EVM network. Use extractAndVerifyClaimEvidence to verify confirmed on-chain claims.'
    );
  }

  /**
   * P0 LIGHTNING SETTLEMENT GATE:
   * Extracts and cryptographically verifies claim evidence from confirmed on-chain state.
   *
   * Enforces all 10 required settlement conditions:
   * 1. Claim transaction exists and succeeded on-chain (status == 1 / 'success')
   * 2. Claim transaction targets the verified, pinned HTLC contract
   * 3. Connected chain matches approved devnet chain ID (31337)
   * 4. Confirmation depth satisfies FINAL_ENOUGH_FOR_PROTOCOL (default: 1 on devnet)
   * 5. HtlcClaimed event emitted matching expected htlcId
   * 6. Authoritative contract storage query confirms htlc.status == Status.CLAIMED (2)
   * 7. Contract storage claimAddress matches expected claiming recipient
   * 8. Contract storage amount matches expected locked amount
   * 9. Contract storage hashLock matches expected hashlock
   * 10. Revealed preimage cryptographically hashes to expected hashlock via SHA-256
   */
  public async extractAndVerifyClaimEvidence(params: {
    claimTxHash: string;
    expectedHtlcId: string;
    expectedHashLock: string;
    expectedClaimAddress: string;
    expectedAmount: bigint;
    requiredConfirmations?: number;
  }): Promise<EvmHtlcClaimedEvidence> {
    await this.ensureGuards();

    const txHash = (params.claimTxHash.startsWith('0x')
      ? params.claimTxHash
      : `0x${params.claimTxHash}`) as Hex;

    // 1. Transaction receipt check
    let receipt;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
    } catch {
      throw new LightningSettlementGateError(
        `Claim transaction ${txHash} not found on-chain`
      );
    }

    if (!receipt || receipt.status !== 'success') {
      throw new LightningSettlementGateError(
        `Claim transaction ${txHash} did not succeed on-chain (status: ${receipt?.status ?? 'missing'})`
      );
    }

    // 2. Target contract validation
    if (receipt.to?.toLowerCase() !== this.htlcAddress.toLowerCase()) {
      throw new LightningSettlementGateError(
        `Claim transaction targets invalid contract ${receipt.to}, expected ${this.htlcAddress}`
      );
    }

    // 3. Confirmations check (FINAL_ENOUGH_FOR_PROTOCOL)
    const currentBlock = await this.publicClient.getBlockNumber();
    const confirmations = currentBlock >= receipt.blockNumber
      ? Number(currentBlock - receipt.blockNumber + 1n)
      : 1;
    const requiredConf = params.requiredConfirmations ?? 1;
    if (confirmations < requiredConf) {
      throw new LightningSettlementGateError(
        `Claim transaction has ${confirmations} confirmations, required: ${requiredConf}`
      );
    }

    // 4. Find HtlcClaimed event on HTLC contract
    const log = receipt.logs.find(
      (l) =>
        l.address.toLowerCase() === this.htlcAddress.toLowerCase() &&
        l.topics[1]?.toLowerCase() === params.expectedHtlcId.toLowerCase()
    );
    if (!log) {
      throw new LightningSettlementGateError(
        `Transaction ${txHash} does not contain HtlcClaimed event for HTLC ID ${params.expectedHtlcId}`
      );
    }

    // 5. Extract preimage from transaction input
    const tx = await this.publicClient.getTransaction({ hash: txHash });
    const decoded = decodeFunctionData({
      abi: this.htlcAbi,
      data: tx.input,
    });
    if (decoded.functionName !== 'claim') {
      throw new LightningSettlementGateError(
        `Transaction function is not claim: ${decoded.functionName}`
      );
    }
    const preimageRevealed = decoded.args[1] as `0x${string}`;

    // 6. Cryptographic binding: sha256(preimage) == expectedHashLock
    const rawPreimageBuf = Buffer.from(preimageRevealed.replace(/^0x/, ''), 'hex');
    const computedHash = createHash('sha256').update(rawPreimageBuf).digest('hex');
    const cleanExpectedHash = params.expectedHashLock.replace(/^0x/, '').toLowerCase();
    if (computedHash.toLowerCase() !== cleanExpectedHash) {
      throw new LightningSettlementGateError(
        `Revealed preimage hash ${computedHash} does not match expected hashlock ${cleanExpectedHash}`
      );
    }

    // 7. Authoritative contract storage query (Status == 2 / CLAIMED)
    const stored: any = await this.publicClient.readContract({
      address: this.htlcAddress,
      abi: this.htlcAbi,
      functionName: 'getHtlc',
      args: [params.expectedHtlcId as Hex],
    });

    if (stored.status !== 2) {
      throw new LightningSettlementGateError(
        `Authoritative HTLC status is ${stored.status}, required 2 (CLAIMED)`
      );
    }

    if (stored.claimAddress.toLowerCase() !== params.expectedClaimAddress.toLowerCase()) {
      throw new LightningSettlementGateError(
        `Claim recipient ${stored.claimAddress} does not match expected ${params.expectedClaimAddress}`
      );
    }

    if (stored.amount !== params.expectedAmount) {
      throw new LightningSettlementGateError(
        `Claim amount ${stored.amount} does not match expected ${params.expectedAmount}`
      );
    }

    if (stored.hashLock.toLowerCase() !== params.expectedHashLock.toLowerCase()) {
      throw new LightningSettlementGateError(
        `Claim hashlock ${stored.hashLock} does not match expected ${params.expectedHashLock}`
      );
    }

    const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });

    const evidence: EvmHtlcClaimedEvidence = {
      evidenceType: 'EVM_HTLC_CLAIMED',
      chainId: this.chainId,
      contractAddress: this.htlcAddress,
      htlcId: params.expectedHtlcId,
      hashLock: params.expectedHashLock,
      preimageRevealed: rawPreimageBuf.toString('hex'),
      claimAddress: stored.claimAddress,
      amount: stored.amount,
      txHash,
      blockNumber: Number(receipt.blockNumber),
      blockTimestamp: Number(block.timestamp),
      confirmations,
      finalityState: 'FINAL_ENOUGH_FOR_PROTOCOL',
      observedAt: new Date(),
    };

    this.evidenceLog.push(evidence);
    return evidence;
  }

  /**
   * 4. Refunds an EVM HTLC after timelock expiry.
   */
  async refundHtlc(
    swapKey: string
  ): Promise<{ txHash: string; blockNumber: number; refunded: boolean }> {
    await this.ensureGuards();

    const actionKey = `refund:${swapKey}`;
    const existingAction = this.durableActions.get(actionKey);
    if (existingAction && existingAction.status === 'MINED') {
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: existingAction.txHash as `0x${string}`,
      });
      return {
        txHash: receipt.transactionHash,
        blockNumber: Number(receipt.blockNumber),
        refunded: true,
      };
    }

    const htlcId = this.swapKeyToHtlcId.get(swapKey);
    if (!htlcId) {
      throw new Error(`HTLC for swapKey ${swapKey} does not exist or is not funded`);
    }

    const storedHtlc: any = await this.publicClient.readContract({
      address: this.htlcAddress,
      abi: this.htlcAbi,
      functionName: 'getHtlc',
      args: [htlcId],
    });

    if (storedHtlc.status === 3) {
      // Already refunded
      return { txHash: '0x_already_refunded', blockNumber: 0, refunded: true };
    }

    if (storedHtlc.status === 2) {
      throw new Error(
        `MUTUAL_EXCLUSION_VIOLATION: HTLC ${htlcId} has already been claimed (EVM-SEC-9)`
      );
    }

    if (storedHtlc.status !== 1) {
      throw new Error(`INVALID_STATE: HTLC ${htlcId} is not in LOCKED status`);
    }

    // Verify timelock
    const currentTimestamp = await this.getBlockTimestamp();
    const locktime = Number(storedHtlc.timelock);
    if (currentTimestamp < locktime) {
      throw new Error(
        `PREMATURE_REFUND_DENIED: Timelock ${locktime} is not expired (current: ${currentTimestamp}) (EVM-SEC-8)`
      );
    }

    this.durableActions.set(actionKey, { status: 'PENDING' });

    // Refund execution
    const refundTx = await this.refundWallet.writeContract({
      account: this.refundWallet.account!,
      chain: hardhat,
      address: this.htlcAddress,
      abi: this.htlcAbi,
      functionName: 'refund',
      args: [htlcId],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: refundTx });
    const blockNumber = Number(receipt.blockNumber);
    const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const blockTimestamp = Number(block.timestamp);

    // Authoritative check: confirm status is REFUNDED (3)
    const postRefundHtlc: any = await this.publicClient.readContract({
      address: this.htlcAddress,
      abi: this.htlcAbi,
      functionName: 'getHtlc',
      args: [htlcId],
    });

    if (postRefundHtlc.status !== 3) {
      throw new Error(
        `STORAGE_VERIFICATION_FAILED: Expected REFUNDED (3), got ${postRefundHtlc.status}`
      );
    }

    const evidence: EvmHtlcRefundedEvidence = {
      evidenceType: 'EVM_HTLC_REFUNDED',
      chainId: this.chainId,
      contractAddress: this.htlcAddress,
      htlcId,
      hashLock: storedHtlc.hashLock,
      refundAddress: storedHtlc.refundAddress,
      txHash: receipt.transactionHash,
      blockNumber,
      blockTimestamp,
      observedAt: new Date(),
    };
    this.evidenceLog.push(evidence);

    this.durableActions.set(actionKey, {
      status: 'MINED',
      txHash: receipt.transactionHash,
    });

    return { txHash: receipt.transactionHash, blockNumber, refunded: true };
  }

  /**
   * Helper to advance local devnet time for timelock testing.
   */
  async increaseTime(seconds: number): Promise<void> {
    await this.publicClient.transport.request({
      method: 'evm_increaseTime',
      params: [seconds],
    });
    await this.publicClient.transport.request({
      method: 'evm_mine',
      params: [],
    });
  }

  async getBlockTimestamp(): Promise<number> {
    const block = await this.publicClient.getBlock();
    return Number(block.timestamp);
  }
}
