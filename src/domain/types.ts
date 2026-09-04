import { z } from 'zod';

/**
 * Edge Trust Classes (Architecture V3)
 * Classifies the trust model of an execution edge.
 */
export const EdgeClass = {
  SELF_CUSTODY_EDGE: 'SELF_CUSTODY_EDGE',       // Router / agent retains custody (e.g. phoenixd splice, local EVM signer)
  ATOMIC_EDGE: 'ATOMIC_EDGE',                   // Cryptographically atomic (e.g. P2P HTLC, submarine swap)
  PROTOCOL_EDGE: 'PROTOCOL_EDGE',               // Intent / solver protocol or decentralized DEX (e.g. Uniswap, Chainflip)
  TRUSTED_PROVIDER_EDGE: 'TRUSTED_PROVIDER_EDGE', // Third-party trusted exchange (e.g. FixedFloat, SideShift)
} as const;

export type EdgeClass = (typeof EdgeClass)[keyof typeof EdgeClass];

/**
 * Capability Status
 * Independent declaration of edge capabilities.
 */
export const CapabilityStatus = {
  SUPPORTED: 'SUPPORTED',
  UNSUPPORTED: 'UNSUPPORTED',
  CONDITIONAL: 'CONDITIONAL',
  UNKNOWN: 'UNKNOWN',
} as const;

export type CapabilityStatus = (typeof CapabilityStatus)[keyof typeof CapabilityStatus];

/**
 * Edge Capabilities Model
 * INVARIANT: Support for one capability MUST NEVER imply support for another!
 */
export interface EdgeCapabilities {
  discover: CapabilityStatus;
  quote: CapabilityStatus;
  prepare: CapabilityStatus;
  execute: CapabilityStatus;
  verify: CapabilityStatus;
  recover: CapabilityStatus;
}

/**
 * Asset Node (Graph Node)
 * Generic representation of an asset/network position.
 */
export interface AssetNode {
  asset: string;        // Normalized uppercase (e.g. 'BTC', 'USDC', 'CBBTC')
  network: string;      // Normalized lowercase (e.g. 'lightning', 'bitcoin', 'base')
  tokenContract?: string | undefined; // Normalized lowercase EVM contract address
}

export function createAssetNode(
  asset: string,
  network: string,
  tokenContract?: string
): AssetNode {
  return {
    asset: asset.trim().toUpperCase(),
    network: network.trim().toLowerCase(),
    tokenContract: tokenContract ? tokenContract.trim().toLowerCase() : undefined,
  };
}

export function areAssetNodesEqual(a: AssetNode, b: AssetNode): boolean {
  if (a.asset.toUpperCase() !== b.asset.toUpperCase()) return false;
  if (a.network.toLowerCase() !== b.network.toLowerCase()) return false;
  const contractA = a.tokenContract ? a.tokenContract.toLowerCase() : undefined;
  const contractB = b.tokenContract ? b.tokenContract.toLowerCase() : undefined;
  return contractA === contractB;
}

export function assetNodeToString(node: AssetNode): string {
  const base = `${node.asset.toUpperCase()}:${node.network.toLowerCase()}`;
  return node.tokenContract ? `${base}:${node.tokenContract.toLowerCase()}` : base;
}

/**
 * Edge Dynamic Runtime Availability
 * Explicitly separated from static capabilities!
 */
export interface EdgeRuntimeAvailability {
  isAvailable: boolean;
  recvEnabled: boolean;
  sendEnabled: boolean;
  isMaintenance: boolean;
  minAmountAtomic: string;
  maxAmountAtomic?: string | undefined;
  estimatedLatencyMs?: number | undefined;
  lastCheckedAt: string;
  reason?: string | undefined;
}

/**
 * Domain Error Codes
 * Provider-independent structured error codes.
 */
export const DomainErrorCode = {
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  ROUTE_UNAVAILABLE: 'ROUTE_UNAVAILABLE',
  PROVIDER_MAINTENANCE: 'PROVIDER_MAINTENANCE',
  AMOUNT_BELOW_MINIMUM: 'AMOUNT_BELOW_MINIMUM',
  AMOUNT_ABOVE_MAXIMUM: 'AMOUNT_ABOVE_MAXIMUM',
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  QUOTE_UNAVAILABLE: 'QUOTE_UNAVAILABLE',
  EXECUTION_AMBIGUOUS: 'EXECUTION_AMBIGUOUS',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  DESTINATION_NOT_VERIFIED: 'DESTINATION_NOT_VERIFIED',
  REFUND_NOT_VERIFIED: 'REFUND_NOT_VERIFIED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
} as const;

export type DomainErrorCode = (typeof DomainErrorCode)[keyof typeof DomainErrorCode];

export class RouterError extends Error {
  public readonly code: DomainErrorCode;
  public readonly metadata: Record<string, unknown> | undefined;

  constructor(
    code: DomainErrorCode,
    message: string,
    metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
    this.metadata = metadata;
  }
}

/**
 * Execution Class
 * PASSIVE_DEPOSIT: createExecution only produces deposit instructions (invoices, addresses).
 *                  Zero funds move until caller separately sends them.
 *                  An ambiguous create timeout before deposit instructions are persisted
 *                  is financially unfunded and safe to abort.
 * ACTIVE_EXECUTION: createExecution triggers asset movement, consumes balances, or signs
 *                   blockchain transactions.
 *                   An ambiguous create CANNOT be marked failed without deterministic proof!
 */
export const ExecutionClass = {
  PASSIVE_DEPOSIT: 'PASSIVE_DEPOSIT',
  ACTIVE_EXECUTION: 'ACTIVE_EXECUTION',
} as const;

export type ExecutionClass = (typeof ExecutionClass)[keyof typeof ExecutionClass];

/**
 * Provider-Independent Route Quote
 * Fully expressed in integer atomic units.
 */
export interface RouteQuote {
  quoteId: string;
  edgeId: string;
  sourceNode: AssetNode;
  destinationNode: AssetNode;
  inputAmountAtomic: string;
  estimatedOutputAmountAtomic: string;
  rate: string;
  networkFeeEstimatedAtomic: string;
  minAmountAtomic: string;
  maxAmountAtomic: string;
  expiresAt: string;
  edgeClass: EdgeClass;
  executionClass: ExecutionClass;
  rawQuote?: Record<string, unknown> | undefined;
}

/**
 * Immutable Execution Plan Snapshot
 * Snapshots quote and route parameters so future provider state changes
 * do not alter an in-flight execution.
 */
export interface ExecutionPlan {
  planId: string;
  edgeId: string;
  routeId: string;
  quoteSnapshot: RouteQuote;
  destinationAddress: string;
  refundAddress: string;
  createdAt: string;
}

/**
 * Provider Request Journal Entry
 * Durable record for auditing outbound provider interactions.
 */
export interface ProviderRequestJournalEntry {
  id: string;
  executionId: string;
  providerId: string;
  operation: string;
  attemptNumber: number;
  requestStartedAt: string;
  requestCompletedAt?: string | undefined;
  providerExecutionId?: string | undefined;
  resultClassification: 'SUCCESS' | 'ERROR' | 'AMBIGUOUS_TIMEOUT' | 'NETWORK_ERROR';
  responsePersisted: boolean;
  errorMessage?: string | undefined;
  createdAt: string;
}

/**
 * Generic Execution Edge Contract (Architecture V3)
 */
export interface IExecutionEdge {
  readonly id: string;
  readonly name: string;
  readonly edgeClass: EdgeClass;
  readonly executionClass: ExecutionClass;
  readonly sourceNode: AssetNode;
  readonly destinationNode: AssetNode;
  readonly edgeCapabilities: EdgeCapabilities;

  supportsRoute(source: AssetNode, destination: AssetNode): boolean;
  getRuntimeAvailability(): Promise<EdgeRuntimeAvailability>;
  getQuote(sourceAmountAtomic: string, destinationAddress?: string): Promise<RouteQuote>;
  createExecution(plan: ExecutionPlan, idempotencyKey: string): Promise<ProviderExecutionResult>;
  getStatus(providerExecutionId: string, orderToken?: string): Promise<NormalizedProviderStatus>;
  requestRefund?(providerExecutionId: string, refundAddress: string, orderToken?: string): Promise<RefundResult>;
}

/**
 * Valid Execution States
 */
export const ExecutionState = {
  CREATED: 'CREATED',
  QUOTING: 'QUOTING',
  QUOTED: 'QUOTED',
  EXECUTION_PENDING: 'EXECUTION_PENDING',
  EXECUTING: 'EXECUTING',
  DEPOSIT_INSTRUCTION_READY: 'DEPOSIT_INSTRUCTION_READY',
  SOURCE_FUNDS_DETECTED: 'SOURCE_FUNDS_DETECTED',
  SOURCE_FUNDS_CONFIRMED: 'SOURCE_FUNDS_CONFIRMED',
  SWAP_IN_PROGRESS: 'SWAP_IN_PROGRESS',
  DESTINATION_TX_DETECTED: 'DESTINATION_TX_DETECTED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  RECOVERING: 'RECOVERING',
  REFUNDED: 'REFUNDED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
} as const;

export type ExecutionState = (typeof ExecutionState)[keyof typeof ExecutionState];

export const TERMINAL_STATES: ReadonlySet<ExecutionState> = new Set([
  ExecutionState.COMPLETED,
  ExecutionState.FAILED,
  ExecutionState.REFUNDED,
  ExecutionState.MANUAL_REVIEW,
]);

export const AMBIGUOUS_STATES: ReadonlySet<ExecutionState> = new Set([
  ExecutionState.EXECUTION_PENDING,
  ExecutionState.EXECUTING,
  ExecutionState.DEPOSIT_INSTRUCTION_READY,
  ExecutionState.SOURCE_FUNDS_DETECTED,
  ExecutionState.SOURCE_FUNDS_CONFIRMED,
  ExecutionState.SWAP_IN_PROGRESS,
  ExecutionState.DESTINATION_TX_DETECTED,
  ExecutionState.RECOVERY_REQUIRED,
  ExecutionState.RECOVERING,
]);

export const SOURCE_FUNDS_MOVED_STATES: ReadonlySet<ExecutionState> = new Set([
  ExecutionState.SOURCE_FUNDS_DETECTED,
  ExecutionState.SOURCE_FUNDS_CONFIRMED,
  ExecutionState.SWAP_IN_PROGRESS,
  ExecutionState.DESTINATION_TX_DETECTED,
  ExecutionState.COMPLETED,
  ExecutionState.REFUNDED,
]);

export const NormalizedIntentSchema = z.object({
  sourceAsset: z.string().min(1),
  sourceNetwork: z.string().min(1),
  targetAsset: z.string().min(1),
  targetNetwork: z.string().min(1),
  sourceAmountAtomic: z.string().regex(/^\d+$/, 'Must be integer atomic units'),
  destinationAddress: z.string().min(1),
  refundAddress: z.string().min(1),
});

export type NormalizedIntent = z.infer<typeof NormalizedIntentSchema>;

export function areIntentsSemanticallyEqual(
  a: NormalizedIntent,
  b: NormalizedIntent
): boolean {
  return (
    a.sourceAsset.toUpperCase() === b.sourceAsset.toUpperCase() &&
    a.sourceNetwork.toLowerCase() === b.sourceNetwork.toLowerCase() &&
    a.targetAsset.toUpperCase() === b.targetAsset.toUpperCase() &&
    a.targetNetwork.toLowerCase() === b.targetNetwork.toLowerCase() &&
    a.sourceAmountAtomic === b.sourceAmountAtomic &&
    a.destinationAddress.toLowerCase() === b.destinationAddress.toLowerCase() &&
    a.refundAddress.toLowerCase() === b.refundAddress.toLowerCase()
  );
}

export const NormalizedQuoteSchema = z.object({
  quoteId: z.string().min(1),
  providerId: z.string().min(1),
  sourceAsset: z.string().min(1),
  sourceNetwork: z.string().min(1),
  targetAsset: z.string().min(1),
  targetNetwork: z.string().min(1),
  depositAmountAtomic: z.string().regex(/^\d+$/),
  settleAmountAtomic: z.string().regex(/^\d+$/),
  rate: z.string(),
  networkFeeEstimatedAtomic: z.string().regex(/^\d+$/),
  minDepositAtomic: z.string().regex(/^\d+$/),
  maxDepositAtomic: z.string().regex(/^\d+$/),
  expiresAt: z.string().datetime(),
  rawQuote: z.record(z.string(), z.unknown()).optional(),
});

export type NormalizedQuote = z.infer<typeof NormalizedQuoteSchema>;

export interface CreateExecutionRequest {
  quoteId: string;
  idempotencyKey: string;
  intent: NormalizedIntent;
  quote: NormalizedQuote;
}

export interface ProviderExecutionResult {
  providerExecutionId: string;
  orderToken?: string | undefined; // Sensitive provider token (e.g. FixedFloat token)
  depositAddress: string; // BTC address or Lightning invoice
  depositAmountAtomic: string;
  settleAddress: string;
  status: string;
  expiresAt?: string | undefined;
  rawResponse: Record<string, unknown>;
}

export const ProviderNormalizedStatus = {
  WAITING_FOR_DEPOSIT: 'WAITING_FOR_DEPOSIT',
  DEPOSIT_RECEIVED: 'DEPOSIT_RECEIVED',
  PROCESSING: 'PROCESSING',
  SETTLING: 'SETTLING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  EXPIRED: 'EXPIRED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ProviderNormalizedStatus =
  (typeof ProviderNormalizedStatus)[keyof typeof ProviderNormalizedStatus];

export interface NormalizedProviderStatus {
  status: ProviderNormalizedStatus;
  depositTxId: string | null;
  settleTxId: string | null;
  settleAmountActualAtomic: string | null;
  failureReason: string | null;
  raw: Record<string, unknown>;
}

export interface RefundResult {
  success: boolean;
  refundTxId?: string | undefined;
  reason?: string | undefined;
}

export interface ProviderCapabilities {
  supportedPairs: Array<{
    sourceAsset: string;
    sourceNetwork: string;
    targetAsset: string;
    targetNetwork: string;
    minAmountAtomic: string;
    maxAmountAtomic: string;
  }>;
  executionClass: ExecutionClass; // PASSIVE_DEPOSIT or ACTIVE_EXECUTION
  supportsLightning: boolean;
  supportsRefunds: boolean;
  supportsStrongIdempotency: boolean;
}

export interface IExecutionProvider {
  readonly id: string;
  readonly name: string;

  capabilities(): Promise<ProviderCapabilities>;
  getQuote(intent: NormalizedIntent): Promise<NormalizedQuote>;
  createExecution(request: CreateExecutionRequest): Promise<ProviderExecutionResult>;
  getStatus(providerExecutionId: string, orderToken?: string): Promise<NormalizedProviderStatus>;
  requestRefund?(providerExecutionId: string, refundAddress: string, orderToken?: string): Promise<RefundResult>;
}

export interface SourceSettlementEvidence {
  network: string;
  asset: string;
  amountAtomic: string;
  depositAddressOrInvoice: string;
  txIdOrPaymentHash: string | null;
  confirmations: number;
  detectedAt: string | null;
  confirmedAt: string | null;
  evidenceSource: 'PROVIDER_STATUS' | 'BITCOIN_RPC' | 'LIGHTNING_NODE';
  rawEvidence: Record<string, unknown>;
}

export interface DestinationSettlementEvidence {
  network: string;
  asset: string;
  amountAtomic: string;
  destinationAddress: string;
  txHash: string | null;
  blockNumber: number | null;
  tokenContract: string | null;
  verifiedOnChain: boolean;
  onChainStatus:
    | 'NOT_FOUND'
    | 'PENDING'
    | 'CONFIRMED'
    | 'REVERTED'
    | 'AMOUNT_MISMATCH'
    | 'WRONG_RECIPIENT'
    | 'WRONG_TOKEN'
    | 'WRONG_NETWORK';
  verifiedAt: string | null;
  evidenceSource: 'BASE_RPC' | 'PROVIDER_CLAIM';
  rawEvidence: Record<string, unknown>;
}

export interface ExecutionRecord {
  id: string;
  idempotencyKey: string;
  state: ExecutionState;
  intent: NormalizedIntent;
  selectedQuote: NormalizedQuote | null;
  plan: ExecutionPlan | null;
  providerId: string | null;
  providerExecutionId: string | null;
  orderToken: string | null; // Sensitive provider token (persisted securely, never logged)
  depositAddress: string | null;
  sourceEvidence: SourceSettlementEvidence | null;
  destinationEvidence: DestinationSettlementEvidence | null;
  sourceFundsMoved: boolean;
  destinationFundsArrived: boolean;
  failureReason: string | null;
  recoveryAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface StateTransitionRecord {
  id: string;
  executionId: string;
  fromState: ExecutionState | null;
  toState: ExecutionState;
  reason: string;
  trigger: 'API' | 'POLLING' | 'RECOVERY_WORKER' | 'RESTART';
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
