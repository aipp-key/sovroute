/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Base Sepolia Public Testnet Atomic Backend (Phase 4)
 *
 * Implements IEvmAtomicBackend against public Base Sepolia L2 (Chain ID 84532).
 *
 * Enforces:
 * - P0 Network Safety: Rejects Base Mainnet (8453) and all non-Base Sepolia networks fail-closed.
 * - P0 Token Identity: Strictly pinned to canonical Circle Base Sepolia test USDC (0x036CbD53842c5426634e7929541eC2318f3dCF7e).
 * - Exact Allowance Model: Exact approvals only; no infinite approvals; allowance ambiguity reconciled.
 * - Funding Ambiguity: Inspects deterministic on-chain storage before any dispatch; zero blind duplicates.
 * - Non-Custodial Signer Boundary: Router core possesses ZERO client keys.
 * - Evidence-Gated Preimage Extraction: Router extracts S only after confirmed on-chain claim.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  type WalletClient,
  type Hex,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import type {
  IEvmAtomicBackend,
  EvmHtlcParams,
  EvmHtlcState,
  SecretPreimage,
} from '../types.ts';
import {
  BaseNetworkGuard,
  BASE_SEPOLIA_CHAIN_ID,
  OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS,
} from './base-guard.ts';
import {
  type EvmHtlcFundedEvidence,
  type EvmHtlcClaimedEvidence,
  type EvmHtlcRefundedEvidence,
  type EvmHtlcEvidence,
  LightningSettlementGateError,
} from './evm-types.ts';
import { SqlitePersistence } from '../../persistence/sqlite.ts';
import { BaseTransactionManager } from './transaction-manager.ts';
import type { BaseTransactionPolicy } from './transaction-types.ts';

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
]);

export interface BaseSepoliaBackendConfig {
  rpcUrl?: string;
  chainId?: number;
  htlcAddress?: `0x${string}`;
  tokenAddress?: `0x${string}`;
  operatorPrivateKey?: Hex;
  requiredConfirmations?: number;
  persistence?: SqlitePersistence;
  transactionPolicy?: Partial<BaseTransactionPolicy>;
  /**
   * Unmistakably test-only option.
   * Direct unmanaged wallet execution is strictly prohibited in live/production configurations.
   * If an operator key is provided without SqlitePersistence, initialization fails closed
   * unless this test flag is explicitly set to true.
   */
  unsafeDirectExecutionForTests?: boolean;
}

export class BaseSepoliaAtomicBackend implements IEvmAtomicBackend {
  readonly backendName = 'BaseSepoliaAtomicBackend';
  readonly chainId = BASE_SEPOLIA_CHAIN_ID;

  private publicClient: any;
  private operatorWallet: WalletClient | undefined;
  private operatorAddress: `0x${string}` | undefined;
  private transactionManager: BaseTransactionManager | undefined;
  private unsafeDirectExecutionForTests: boolean = false;

  private htlcAddress: `0x${string}`;
  private tokenAddress: `0x${string}`;
  private requiredConfirmations: number;

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

  constructor(config: BaseSepoliaBackendConfig = {}) {
    const rootDir = process.cwd();
    const rpcUrl = config.rpcUrl ?? 'https://sepolia.base.org';

    this.publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
      cacheTime: 0,
    });

    if (config.operatorPrivateKey) {
      const account = privateKeyToAccount(config.operatorPrivateKey);
      this.operatorAddress = account.address;
      this.operatorWallet = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(rpcUrl),
      });

      if (config.persistence) {
        this.transactionManager = new BaseTransactionManager({
          persistence: config.persistence,
          publicClient: this.publicClient,
          account,
          chainId: config.chainId ?? BASE_SEPOLIA_CHAIN_ID,
          policy: config.transactionPolicy,
        });
      } else {
        // FAIL CLOSED: Silent unmanaged execution is strictly prohibited
        if (config.unsafeDirectExecutionForTests !== true) {
          throw new Error(
            'RELIABILITY_MANAGER_REQUIRED: Live Base execution with operator signer requires SqlitePersistence for Phase 5A reliability guarantees. ' +
            'Silent fallback to unmanaged direct wallet execution is prohibited. ' +
            'To bypass strictly in isolated unit tests, unsafeDirectExecutionForTests must be explicitly set to true.'
          );
        }
        this.unsafeDirectExecutionForTests = true;
      }
    }

    this.requiredConfirmations = config.requiredConfirmations ?? 2;

    // Load compiled contract artifacts
    const artifactsDir = join(rootDir, 'artifacts', 'contracts');
    const htlcArtifact = JSON.parse(
      readFileSync(join(artifactsDir, 'HtlcErc20.sol', 'HtlcErc20.json'), 'utf8')
    );

    this.htlcAbi = htlcArtifact.abi;
    this.tokenAbi = ERC20_ABI;

    this.tokenAddress = (config.tokenAddress ?? OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS) as `0x${string}`;
    this.htlcAddress = (config.htlcAddress ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;
  }

  public getTransactionManager(): BaseTransactionManager | undefined {
    return this.transactionManager;
  }

  public isUnsafeDirectExecutionEnabled(): boolean {
    return this.unsafeDirectExecutionForTests;
  }

  /**
   * Initializes and validates Base network, token, and bytecode safety guards.
   */
  public async ensureGuards(): Promise<void> {
    if (this.initialized) return;

    // 1. Assert Base Sepolia network identity
    const actualChainId = await this.publicClient.getChainId();
    BaseNetworkGuard.assertBaseSepoliaNetwork(actualChainId);

    // 2. Assert canonical Base Sepolia USDC identity
    let decimals: number | undefined;
    try {
      const dec = await this.publicClient.readContract({
        address: this.tokenAddress,
        abi: this.tokenAbi,
        functionName: 'decimals',
        args: [],
      });
      decimals = Number(dec);
    } catch {
      // If token not deployed or mock in test environment
    }
    BaseNetworkGuard.assertCanonicalBaseSepoliaUsdc(this.tokenAddress, decimals);

    // 3. Assert HTLC contract bytecode if address is set
    if (this.htlcAddress !== '0x0000000000000000000000000000000000000000') {
      const bytecode = await this.publicClient.getBytecode({ address: this.htlcAddress });
      BaseNetworkGuard.assertContractBytecode(bytecode ?? '0x');
    }

    this.initialized = true;
  }

  public getHtlcAddress(): `0x${string}` {
    return this.htlcAddress;
  }

  public setHtlcAddress(address: `0x${string}`): void {
    this.htlcAddress = address;
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

  public computeHtlcId(params: {
    hashLock: Hex;
    amountUnits: bigint;
    tokenAddress: string;
    sender: string;
    claimAddress: string;
    refundAddress: string;
    refundLocktime: number;
    chainId: number;
  }): `0x${string}` {
    const encoded = encodeAbiParameters(
      parseAbiParameters('bytes32, uint256, address, address, address, address, uint256, uint256'),
      [
        params.hashLock,
        params.amountUnits,
        params.tokenAddress as `0x${string}`,
        params.sender as `0x${string}`,
        params.claimAddress as `0x${string}`,
        params.refundAddress as `0x${string}`,
        BigInt(params.refundLocktime),
        BigInt(params.chainId),
      ]
    );
    return keccak256(encoded);
  }

  /**
   * 1. Funds an EVM HTLC on Base Sepolia.
   * Enforces exact allowance and funding ambiguity reconciliation.
   */
  async fundHtlc(
    params: EvmHtlcParams
  ): Promise<{ txHash: string; blockNumber: number; htlcId: string }> {
    await this.ensureGuards();

    if (!this.operatorWallet || !this.operatorAddress) {
      throw new Error('OPERATOR_SIGNER_REQUIRED: Operator wallet not configured on BaseSepoliaAtomicBackend');
    }

    const actionKey = `fund:${params.swapKey}`;
    const existingAction = this.durableActions.get(actionKey);
    if (existingAction && existingAction.status === 'MINED') {
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: existingAction.txHash as `0x${string}`,
      });
      const htlcId = this.swapKeyToHtlcId.get(params.swapKey) ?? ('0x' as `0x${string}`);
      return { txHash: receipt.transactionHash, blockNumber: Number(receipt.blockNumber), htlcId };
    }

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

    // Compute deterministic htlcId
    const htlcId = this.computeHtlcId({
      hashLock,
      amountUnits: params.amountUnits,
      tokenAddress: token,
      sender: this.operatorAddress,
      claimAddress: claimAddr,
      refundAddress: refundAddr,
      refundLocktime: params.refundLocktime,
      chainId: this.chainId,
    });

    // AMBIGUITY RECONCILIATION: Check if already funded on-chain
    try {
      const existingHtlc: any = await this.publicClient.readContract({
        address: this.htlcAddress,
        abi: this.htlcAbi,
        functionName: 'getHtlc',
        args: [htlcId],
      });
      if (existingHtlc && existingHtlc.status === 1) {
        this.swapKeyToHtlcId.set(params.swapKey, htlcId);
        this.htlcIdToSwapKey.set(htlcId, params.swapKey);
        return { txHash: '0x_reconciled_existing_funding', blockNumber: 0, htlcId };
      }
    } catch {
      // Not yet funded
    }

    // Check balance for gas and tokens
    const ethBalance = await this.publicClient.getBalance({ address: this.operatorAddress });
    if (ethBalance === 0n) {
      throw new Error(
        `TESTNET_FUNDING_REQUIRED: Operator wallet ${this.operatorAddress} has 0 Base Sepolia ETH for gas.`
      );
    }

    const usdcBalance = (await this.publicClient.readContract({
      address: token,
      abi: this.tokenAbi,
      functionName: 'balanceOf',
      args: [this.operatorAddress],
    })) as bigint;
    if (usdcBalance < params.amountUnits) {
      throw new Error(
        `TESTNET_FUNDING_REQUIRED: Operator wallet ${this.operatorAddress} has insufficient Base Sepolia test USDC ` +
        `(balance: ${usdcBalance}, required: ${params.amountUnits}).`
      );
    }

    // EXACT ALLOWANCE CHECK: Reconcile before approving
    const currentAllowance = (await this.publicClient.readContract({
      address: token,
      abi: this.tokenAbi,
      functionName: 'allowance',
      args: [this.operatorAddress, this.htlcAddress],
    })) as bigint;

    if (currentAllowance < params.amountUnits) {
      if (this.transactionManager) {
        const approveData = encodeFunctionData({
          abi: this.tokenAbi,
          functionName: 'approve',
          args: [this.htlcAddress, params.amountUnits],
        });
        await this.transactionManager.executeIntent({
          swapKey: `approve:${params.swapKey}:${Date.now()}`,
          actionType: 'APPROVE',
          chainId: this.chainId,
          signerAddress: this.operatorAddress,
          targetAddress: token,
          calldata: approveData,
          valueWei: 0n,
        });
      } else {
        if (!this.unsafeDirectExecutionForTests) {
          throw new Error(
            'RELIABILITY_MANAGER_REQUIRED: Unmanaged direct wallet execution is forbidden unless unsafeDirectExecutionForTests is enabled.'
          );
        }
        // Approve EXACT amount only (no infinite approval)
        const approveTx = await this.operatorWallet.writeContract({
          account: this.operatorWallet.account!,
          chain: baseSepolia,
          address: token,
          abi: this.tokenAbi,
          functionName: 'approve',
          args: [this.htlcAddress, params.amountUnits],
        });
        await this.publicClient.waitForTransactionReceipt({ hash: approveTx });
      }

      // Ensure allowance is confirmed across public RPC load-balancer replicas
      for (let i = 0; i < 10; i++) {
        const al = (await this.publicClient.readContract({
          address: token,
          abi: this.tokenAbi,
          functionName: 'allowance',
          args: [this.operatorAddress, this.htlcAddress],
        })) as bigint;
        if (al >= params.amountUnits) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    this.durableActions.set(actionKey, { status: 'PENDING' });

    let receipt: any;
    if (this.transactionManager) {
      const fundData = encodeFunctionData({
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
      const result = await this.transactionManager.executeIntent({
        swapKey: params.swapKey,
        actionType: 'FUND',
        chainId: this.chainId,
        signerAddress: this.operatorAddress,
        targetAddress: this.htlcAddress,
        calldata: fundData,
        valueWei: 0n,
      });
      receipt = result.receipt;
    } else {
      if (!this.unsafeDirectExecutionForTests) {
        throw new Error(
          'RELIABILITY_MANAGER_REQUIRED: Unmanaged direct wallet execution is forbidden unless unsafeDirectExecutionForTests is enabled.'
        );
      }
      // Execute fund
      const fundTx = await this.operatorWallet.writeContract({
        account: this.operatorWallet.account!,
        chain: baseSepolia,
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

      receipt = await this.publicClient.waitForTransactionReceipt({ hash: fundTx });
    }
    const blockNumber = Number(receipt.blockNumber);
    let blockTimestamp = Math.floor(Date.now() / 1000);
    try {
      const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
      blockTimestamp = Number(block.timestamp);
    } catch {
      // Replica lag fallback
    }

    // Extract canonical htlcId from HtlcFunded event log
    const fundedLog = receipt.logs.find(
      (l: any) =>
        l.address.toLowerCase() === this.htlcAddress.toLowerCase() &&
        l.topics[0]?.toLowerCase() === '0x60bbdfe6cdbca189ae6be408012ffcf9b15dc857e5c5120412b73ee6bf3f7099'
    );
    const canonicalHtlcId = (fundedLog?.topics[1] ?? htlcId) as `0x${string}`;

    // Verify storage status == LOCKED (1) across public RPC load-balancer replicas
    let storedHtlc: any;
    for (let i = 0; i < 10; i++) {
      try {
        storedHtlc = await this.publicClient.readContract({
          address: this.htlcAddress,
          abi: this.htlcAbi,
          functionName: 'getHtlc',
          args: [canonicalHtlcId],
        });
        if (storedHtlc && storedHtlc.status === 1) break;
      } catch {
        // Replica lag
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!storedHtlc || storedHtlc.status !== 1) {
      throw new Error(`STORAGE_VERIFICATION_FAILED: Expected LOCKED (1), got ${storedHtlc?.status}`);
    }

    this.swapKeyToHtlcId.set(params.swapKey, canonicalHtlcId);
    this.htlcIdToSwapKey.set(canonicalHtlcId, params.swapKey);

    const evidence: EvmHtlcFundedEvidence = {
      evidenceType: 'EVM_HTLC_FUNDED',
      chainId: this.chainId,
      contractAddress: this.htlcAddress,
      htlcId: canonicalHtlcId,
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

    const htlcId = this.swapKeyToHtlcId.get(swapKey);
    if (!htlcId) {
      return {
        swapKey,
        funded: false,
        completed: false,
        refunded: false,
        balance: 0n,
        timelock: 0,
        blockTimestamp: await this.getBlockTimestamp(),
      };
    }

    const storedHtlc: any = await this.publicClient.readContract({
      address: this.htlcAddress,
      abi: this.htlcAbi,
      functionName: 'getHtlc',
      args: [htlcId],
    });

    const status = storedHtlc.status;
    const funded = status === 1 || status === 2 || status === 3;
    const completed = status === 2;
    const refunded = status === 3;
    const balance = status === 1 ? storedHtlc.amount : 0n;
    const blockTimestamp = await this.getBlockTimestamp();

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
   * Router core possesses ZERO client keys.
   */
  async claimHtlc(_params: {
    swapKey: string;
    preimage: SecretPreimage;
    destination: string;
    signature?: string;
    dexCalldata?: string;
  }): Promise<{ txHash: string; blockNumber: number; success: boolean }> {
    throw new Error(
      'ROUTER_DOES_NOT_OWN_CLIENT_SIGNER: Sovereign clients must submit claim transactions directly to Base Sepolia. Use extractAndVerifyClaimEvidence to verify confirmed on-chain claims.'
    );
  }

  /**
   * P0 LIGHTNING SETTLEMENT GATE:
   * Extracts and cryptographically verifies claim evidence from confirmed on-chain state on Base Sepolia.
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
        `Claim transaction ${txHash} not found on Base Sepolia`
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
    const currentBlock = BigInt(await this.publicClient.getBlockNumber());
    const receiptBlock = BigInt(receipt.blockNumber);
    const confirmations = currentBlock >= receiptBlock
      ? Number(currentBlock - receiptBlock + 1n)
      : 1;
    const requiredConf = params.requiredConfirmations ?? this.requiredConfirmations;
    if (confirmations < requiredConf) {
      throw new LightningSettlementGateError(
        `Claim transaction has ${confirmations} confirmations, required: ${requiredConf}`
      );
    }

    // 4. Find HtlcClaimed event on HTLC contract
    const log = receipt.logs.find(
      (l: any) =>
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
    let stored: any;
    for (let i = 0; i < 10; i++) {
      try {
        stored = await this.publicClient.readContract({
          address: this.htlcAddress,
          abi: this.htlcAbi,
          functionName: 'getHtlc',
          args: [params.expectedHtlcId as Hex],
        });
        if (stored && stored.status === 2) break;
      } catch {
        // Replica lag
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!stored || stored.status !== 2) {
      throw new LightningSettlementGateError(
        `Authoritative HTLC status is ${stored?.status}, required 2 (CLAIMED)`
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

    let blockTimestamp = Math.floor(Date.now() / 1000);
    try {
      const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
      blockTimestamp = Number(block.timestamp);
    } catch {
      // Replica lag fallback
    }

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
      blockTimestamp,
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

    if (!this.operatorWallet || !this.operatorAddress) {
      throw new Error('OPERATOR_SIGNER_REQUIRED: Operator wallet not configured on BaseSepoliaAtomicBackend');
    }

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
      return { txHash: '0x_already_refunded', blockNumber: 0, refunded: true };
    }

    if (storedHtlc.status === 2) {
      throw new Error(
        `MUTUAL_EXCLUSION_VIOLATION: HTLC ${htlcId} has already been claimed`
      );
    }

    if (storedHtlc.status !== 1) {
      throw new Error(`INVALID_STATE: HTLC ${htlcId} is not in LOCKED status`);
    }

    const currentTimestamp = await this.getBlockTimestamp();
    const locktime = Number(storedHtlc.timelock);
    if (currentTimestamp < locktime) {
      throw new Error(
        `PREMATURE_REFUND_DENIED: Timelock ${locktime} is not expired (current: ${currentTimestamp})`
      );
    }

    this.durableActions.set(actionKey, { status: 'PENDING' });

    let receipt: any;
    if (this.transactionManager) {
      const refundData = encodeFunctionData({
        abi: this.htlcAbi,
        functionName: 'refund',
        args: [htlcId],
      });
      const result = await this.transactionManager.executeIntent({
        swapKey: swapKey,
        actionType: 'REFUND',
        chainId: this.chainId,
        signerAddress: this.operatorAddress,
        targetAddress: this.htlcAddress,
        calldata: refundData,
        valueWei: 0n,
      });
      receipt = result.receipt;
    } else {
      if (!this.unsafeDirectExecutionForTests) {
        throw new Error(
          'RELIABILITY_MANAGER_REQUIRED: Unmanaged direct wallet execution is forbidden unless unsafeDirectExecutionForTests is enabled.'
        );
      }
      const refundTx = await this.operatorWallet.writeContract({
        account: this.operatorWallet.account!,
        chain: baseSepolia,
        address: this.htlcAddress,
        abi: this.htlcAbi,
        functionName: 'refund',
        args: [htlcId],
      });

      receipt = await this.publicClient.waitForTransactionReceipt({ hash: refundTx });
    }
    const blockNumber = Number(receipt.blockNumber);
    const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const blockTimestamp = Number(block.timestamp);

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

  async getBlockTimestamp(): Promise<number> {
    const block = await this.publicClient.getBlock();
    return Number(block.timestamp);
  }
}
