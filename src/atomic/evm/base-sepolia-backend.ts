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
  ChainCapacityObservation,
  IChainCapacityProvider,
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

const TEST_PUBLIC_CLIENT = Symbol('BASE_SEPOLIA_TEST_PUBLIC_CLIENT');
type InternalBaseSepoliaBackendConfig = BaseSepoliaBackendConfig & {
  [TEST_PUBLIC_CLIENT]?: any;
};

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
  finalityPolicy?: { policyTag: string; requiredConfirmations: number };
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

export class BaseSepoliaAtomicBackend implements IEvmAtomicBackend, IChainCapacityProvider {
  readonly backendName = 'BaseSepoliaAtomicBackend';
  readonly chainId: number;
  public readonly finalityPolicy: { policyTag: string; requiredConfirmations: number };

  private publicClient: any;
  private operatorWallet: WalletClient | undefined;
  private operatorAddress: `0x${string}` | undefined;
  private transactionManager: BaseTransactionManager | undefined;
  private unsafeDirectExecutionForTests: boolean = false;
  private persistence: SqlitePersistence | undefined;

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

  /** Test-only transport seam; production configuration and object construction remain unchanged. */
  public static createForTesting(
    config: BaseSepoliaBackendConfig,
    publicClient: any
  ): BaseSepoliaAtomicBackend {
    return new BaseSepoliaAtomicBackend({
      ...config,
      [TEST_PUBLIC_CLIENT]: publicClient,
    } as InternalBaseSepoliaBackendConfig);
  }

  constructor(config: BaseSepoliaBackendConfig = {}) {
    const rootDir = process.cwd();
    const rpcUrl = config.rpcUrl ?? 'https://sepolia.base.org';
    this.persistence = config.persistence;
    this.chainId = config.chainId ?? BASE_SEPOLIA_CHAIN_ID;
    const configuredFinality = config.finalityPolicy ?? {
      policyTag: 'BASE_SEPOLIA_TEST_POLICY',
      requiredConfirmations: config.requiredConfirmations ?? 2,
    };
    if (
      config.requiredConfirmations !== undefined &&
      config.requiredConfirmations !== configuredFinality.requiredConfirmations
    ) {
      throw new Error('FINALITY_POLICY_MISMATCH: Backend confirmation settings disagree');
    }
    if (
      config.transactionPolicy?.requiredConfirmations !== undefined &&
      config.transactionPolicy.requiredConfirmations !== configuredFinality.requiredConfirmations
    ) {
      throw new Error('FINALITY_POLICY_MISMATCH: Transaction manager confirmation settings disagree');
    }
    this.requiredConfirmations = configuredFinality.requiredConfirmations;
    this.finalityPolicy = { ...configuredFinality };

    const internalConfig = config as InternalBaseSepoliaBackendConfig;
    this.publicClient = internalConfig[TEST_PUBLIC_CLIENT] ?? createPublicClient({
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
          chainId: this.chainId,
          policy: {
            ...config.transactionPolicy,
            requiredConfirmations: this.requiredConfirmations,
          },
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

    // Load compiled contract artifacts
    const artifactsDir = join(rootDir, 'artifacts', 'contracts');
    const htlcArtifact = JSON.parse(
      readFileSync(join(artifactsDir, 'HtlcErc20.sol', 'HtlcErc20.json'), 'utf8')
    );

    this.htlcAbi = htlcArtifact.abi;
    this.tokenAbi = ERC20_ABI;

    this.tokenAddress = (config.tokenAddress ?? OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS) as `0x${string}`;
    this.htlcAddress = (config.htlcAddress ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

    // Rehydrate durable bindings from persistence if available
    this.rehydrateBindings();
  }

  public getTransactionManager(): BaseTransactionManager | undefined {
    return this.transactionManager;
  }

  public getRequiredConfirmations(): number {
    return this.requiredConfirmations;
  }

  public getPersistence(): SqlitePersistence | undefined {
    return this.persistence;
  }

  public isUnsafeDirectExecutionEnabled(): boolean {
    return this.unsafeDirectExecutionForTests;
  }

  public rehydrateBindings(): number {
    if (!this.persistence) return 0;
    try {
      const bindings = this.persistence.listSovereignSwapsWithEvmBindings();
      let count = 0;
      for (const b of bindings) {
        this.swapKeyToHtlcId.set(b.evmSwapKey, b.evmHtlcId as `0x${string}`);
        this.htlcIdToSwapKey.set(b.evmHtlcId as `0x${string}`, b.evmSwapKey);
        count++;
      }
      return count;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`BINDING_REHYDRATION_FAILED: ${detail}`);
    }
  }

  public async observeWalletCapacity(tokenAddress: string): Promise<ChainCapacityObservation> {
    await this.ensureGuards();
    const token = tokenAddress.toLowerCase() as `0x${string}`;
    const operator = this.operatorAddress;
    if (!operator) {
      throw new Error('NO_OPERATOR_ADDRESS: Operator wallet is not configured');
    }

    const latestBlock = await this.publicClient.getBlockNumber();
    const latestBlockNumber = Number(latestBlock);

    // 1. Observe latest balance
    const walletBalanceLatest = (await this.publicClient.readContract({
      address: token,
      abi: this.tokenAbi,
      functionName: 'balanceOf',
      args: [operator],
      blockTag: 'latest',
    })) as bigint;

    // 2. Observe finalized / safe balance
    const finalizedBlockNumber = Math.max(0, latestBlockNumber - this.requiredConfirmations);
    let walletBalanceFinalized: bigint;

    try {
      walletBalanceFinalized = (await this.publicClient.readContract({
        address: token,
        abi: this.tokenAbi,
        functionName: 'balanceOf',
        args: [operator],
        blockTag: 'finalized',
      })) as bigint;
    } catch {
      try {
        walletBalanceFinalized = (await this.publicClient.readContract({
          address: token,
          abi: this.tokenAbi,
          functionName: 'balanceOf',
          args: [operator],
          blockNumber: BigInt(finalizedBlockNumber),
        })) as bigint;
      } catch (historicalErr: any) {
        throw new Error(
          `FINALITY_OBSERVATION_FAILED: Failed to read finalized balance from RPC at blockTag finalized and historical block ${finalizedBlockNumber}: ${historicalErr.message}`
        );
      }
    }

    const safeWalletCapacity =
      walletBalanceLatest < walletBalanceFinalized
        ? walletBalanceLatest
        : walletBalanceFinalized;

    let blockHash: string | undefined;
    try {
      const block = await this.publicClient.getBlock({ blockNumber: latestBlock });
      blockHash = block.hash;
    } catch {}

    return {
      tokenAddress: token,
      chainId: this.chainId,
      operatorAddress: operator,
      walletBalanceLatest,
      walletBalanceFinalized,
      safeWalletCapacity,
      latestBlockNumber,
      finalizedBlockNumber,
      blockHash,
      observedAt: new Date(),
    };
  }

  public async verifyChainAndToken(
    expectedChainId: number,
    tokenAddress: string
  ): Promise<{ valid: boolean; reason?: string }> {
    try {
      const chainId = await this.publicClient.getChainId();
      if (chainId !== expectedChainId) {
        return {
          valid: false,
          reason: `WRONG_CHAIN_ID: expected ${expectedChainId}, got ${chainId}`,
        };
      }

      const token = tokenAddress.toLowerCase() as `0x${string}`;
      if (token !== OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS.toLowerCase()) {
        return {
          valid: false,
          reason: `TOKEN_CONTRACT_MISMATCH: Token ${tokenAddress} is not canonical Base Sepolia USDC ${OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS}`,
        };
      }

      const code = await this.publicClient.getCode({ address: token });
      if (!code || code === '0x') {
        return {
          valid: false,
          reason: `TOKEN_CONTRACT_NOT_FOUND: No bytecode at token address ${tokenAddress}`,
        };
      }

      const decimals = await this.publicClient.readContract({
        address: token,
        abi: this.tokenAbi,
        functionName: 'decimals',
        args: [],
      });

      if (Number(decimals) !== 6) {
        return {
          valid: false,
          reason: `INVALID_TOKEN_DECIMALS: Expected 6 decimals for canonical USDC, got ${decimals}`,
        };
      }

      return { valid: true };
    } catch (err: any) {
      return {
        valid: false,
        reason: `CHAIN_TOKEN_VERIFICATION_FAILED: ${err.message}`,
      };
    }
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
    const dec = await this.publicClient.readContract({
      address: this.tokenAddress,
      abi: this.tokenAbi,
      functionName: 'decimals',
      args: [],
    });
    const decimals = Number(dec);
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
      const existingStatus = typeof existingHtlc?.status === 'bigint'
        ? Number(existingHtlc.status)
        : existingHtlc?.status;
      if (existingStatus === 1) {
        this.swapKeyToHtlcId.set(params.swapKey, htlcId);
        this.htlcIdToSwapKey.set(htlcId, params.swapKey);
        return { txHash: '0x_reconciled_existing_funding', blockNumber: 0, htlcId };
      }
      if (existingStatus !== 0) {
        throw new Error(
          `HTLC_EXISTENCE_UNKNOWN: Unexpected or terminal existing HTLC status ${String(existingStatus)}; refusing funding dispatch`
        );
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `HTLC_EXISTENCE_UNKNOWN: Pre-funding contract observation failed; refusing duplicate financial dispatch (${detail})`
      );
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

    let htlcId = this.swapKeyToHtlcId.get(swapKey);
    if (!htlcId && this.persistence) {
      const swap = this.persistence.getSovereignSwapBySwapKey(swapKey);
      if (swap && swap.evmHtlcId) {
        htlcId = swap.evmHtlcId as `0x${string}`;
        this.swapKeyToHtlcId.set(swapKey, htlcId);
        this.htlcIdToSwapKey.set(htlcId, swapKey);
      } else if (swap) {
        const fundIntent = this.persistence.getEvmIntentBySwapKey(swapKey, 'FUND');
        if (!fundIntent || this.persistence.getEvmAttemptsForIntent(fundIntent.id).length === 0) {
          // Durable pre-broadcast journal proves no financial dispatch occurred.
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
        if (!this.operatorAddress || !swap.refundLocktime || !swap.tokenAddress || !swap.refundAddress) {
          throw new Error(
            `HTLC_BINDING_UNKNOWN: FUND attempt exists for ${swapKey}, but deterministic HTLC inputs are incomplete`
          );
        }
        htlcId = this.computeHtlcId({
          hashLock: swap.hashLock as Hex,
          amountUnits: swap.expectedUsdcAmount,
          tokenAddress: swap.tokenAddress,
          sender: this.operatorAddress,
          claimAddress: swap.claimingAddress,
          refundAddress: swap.refundAddress,
          refundLocktime: swap.refundLocktime,
          chainId: this.chainId,
        });
        this.swapKeyToHtlcId.set(swapKey, htlcId);
        this.htlcIdToSwapKey.set(htlcId, swapKey);
      }
    }

    if (!htlcId) {
      throw new Error(`HTLC_BINDING_UNKNOWN: Cannot authoritatively derive HTLC identity for ${swapKey}`);
    }

    const storedHtlc: any = await this.publicClient.readContract({
      address: this.htlcAddress,
      abi: this.htlcAbi,
      functionName: 'getHtlc',
      args: [htlcId],
    });

    const status = typeof storedHtlc?.status === 'bigint'
      ? Number(storedHtlc.status)
      : storedHtlc?.status;
    if (typeof status !== 'number' || !Number.isInteger(status) || ![0, 1, 2, 3].includes(status)) {
      throw new Error(`HTLC_STATE_UNKNOWN: Malformed contract status ${String(storedHtlc?.status)}`);
    }
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

  public async getContractHtlcState(htlcId: string): Promise<{ status: number; amount: bigint } | null> {
    await this.ensureGuards();
    try {
      const storedHtlc: any = await this.publicClient.readContract({
        address: this.htlcAddress,
        abi: this.htlcAbi,
        functionName: 'getHtlc',
        args: [htlcId as `0x${string}`],
      });
      if (!storedHtlc) return null;
      return {
        status: Number(storedHtlc.status),
        amount: BigInt(storedHtlc.amount ?? 0),
      };
    } catch (err) {
      throw new Error(`GET_CONTRACT_HTLC_STATE_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
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
