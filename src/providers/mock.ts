import { randomUUID } from 'node:crypto';
import {
  type IExecutionProvider,
  type NormalizedIntent,
  type NormalizedQuote,
  type CreateExecutionRequest,
  type ProviderExecutionResult,
  type NormalizedProviderStatus,
  ProviderNormalizedStatus,
  type ProviderCapabilities,
  type RefundResult,
  ExecutionClass,
} from '../domain/types.ts';

export type MockFailureMode =
  | 'NONE'
  | 'FAIL_QUOTE'
  | 'REJECT_CREATE'
  | 'TIMEOUT_ON_CREATE'
  | 'STALL_SETTLEMENT'
  | 'EXPIRE_ZERO_DEPOSIT'
  | 'FAIL_STATUS_RECOVERY'
  | 'RETURN_REFUNDED'
  | 'CHAIN_DISAGREEMENT'
  | 'WRONG_RECIPIENT'
  | 'WRONG_AMOUNT'
  | 'WRONG_TOKEN'
  | 'SOURCE_DEPOSIT_ONLY'
  | 'REFUND_WITHOUT_EVIDENCE';

export class MockProvider implements IExecutionProvider {
  public readonly id = 'mock_provider';
  public readonly name = 'Mock Deterministic Test Provider';

  public supportsStrongIdempotency = false; // By default mirrors real providers (SideShift/FixedFloat)

  private activeOrders: Map<
    string,
    {
      request: CreateExecutionRequest;
      status: ProviderNormalizedStatus;
      depositTxId: string | null;
      settleTxId: string | null;
      settleAmountActualAtomic: string | null;
      failureReason: string | null;
    }
  > = new Map();

  public failureMode: MockFailureMode = 'NONE';
  public createExecutionCallCount = 0;
  public getStatusCallCount = 0;

  public executionClass: ExecutionClass = ExecutionClass.PASSIVE_DEPOSIT;

  public async capabilities(): Promise<ProviderCapabilities> {
    return {
      supportedPairs: [
        {
          sourceAsset: 'BTC',
          sourceNetwork: 'bitcoin',
          targetAsset: 'USDC',
          targetNetwork: 'base',
          minAmountAtomic: '3000',
          maxAmountAtomic: '50000000',
        },
        {
          sourceAsset: 'BTC',
          sourceNetwork: 'lightning',
          targetAsset: 'USDC',
          targetNetwork: 'base',
          minAmountAtomic: '1000',
          maxAmountAtomic: '10000000',
        },
      ],
      executionClass: this.executionClass,
      supportsLightning: true,
      supportsRefunds: true,
      supportsStrongIdempotency: this.supportsStrongIdempotency,
    };
  }

  public async getQuote(intent: NormalizedIntent): Promise<NormalizedQuote> {
    if (this.failureMode === 'FAIL_QUOTE') {
      throw new Error('MockProvider: Provider quote service temporarily unavailable (503)');
    }

    const sourceAmount = BigInt(intent.sourceAmountAtomic);
    const settleAmount = (sourceAmount * 750n * 99n) / 100n;

    return {
      quoteId: `mock_quote_${randomUUID().slice(0, 8)}`,
      providerId: this.id,
      sourceAsset: intent.sourceAsset,
      sourceNetwork: intent.sourceNetwork,
      targetAsset: intent.targetAsset,
      targetNetwork: intent.targetNetwork,
      depositAmountAtomic: intent.sourceAmountAtomic,
      settleAmountAtomic: settleAmount.toString(),
      rate: '75000.00',
      networkFeeEstimatedAtomic: '500000',
      minDepositAtomic: '1000',
      maxDepositAtomic: '50000000',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  public async createExecution(
    request: CreateExecutionRequest
  ): Promise<ProviderExecutionResult> {
    this.createExecutionCallCount++;

    if (this.failureMode === 'REJECT_CREATE') {
      throw new Error('MockProvider: 400 Bad Request - Invalid destination address');
    }

    if (this.failureMode === 'TIMEOUT_ON_CREATE') {
      // Order created internally on provider server, but response dropped
      const providerExecutionId = `mock_order_${randomUUID().slice(0, 8)}`;
      this.activeOrders.set(providerExecutionId, {
        request,
        status: ProviderNormalizedStatus.WAITING_FOR_DEPOSIT,
        depositTxId: null,
        settleTxId: null,
        settleAmountActualAtomic: null,
        failureReason: null,
      });
      throw new Error('MockProvider: Network timeout: ETIMEDOUT awaiting response header');
    }

    const providerExecutionId = `mock_order_${randomUUID().slice(0, 8)}`;
    const depositAddress =
      request.intent.sourceNetwork === 'lightning'
        ? `lnbc${request.intent.sourceAmountAtomic}n1mockinvoice...`
        : `bc1qmockdepositaddress${randomUUID().slice(0, 10)}`;

    this.activeOrders.set(providerExecutionId, {
      request,
      status: ProviderNormalizedStatus.WAITING_FOR_DEPOSIT,
      depositTxId: null,
      settleTxId: null,
      settleAmountActualAtomic: null,
      failureReason: null,
    });

    return {
      providerExecutionId,
      depositAddress,
      depositAmountAtomic: request.intent.sourceAmountAtomic,
      settleAddress: request.intent.destinationAddress,
      status: 'WAITING_FOR_DEPOSIT',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      rawResponse: { orderId: providerExecutionId, created: true },
    };
  }

  public async getStatus(
    providerExecutionId: string
  ): Promise<NormalizedProviderStatus> {
    this.getStatusCallCount++;

    if (this.failureMode === 'FAIL_STATUS_RECOVERY') {
      throw new Error('MockProvider: 500 Internal Server Error - Gateway Timeout');
    }

    const order = this.activeOrders.get(providerExecutionId);
    if (!order) {
      return {
        status: ProviderNormalizedStatus.UNKNOWN,
        depositTxId: null,
        settleTxId: null,
        settleAmountActualAtomic: null,
        failureReason: 'Order not found with provider',
        raw: {},
      };
    }

    if (this.failureMode === 'EXPIRE_ZERO_DEPOSIT') {
      order.status = ProviderNormalizedStatus.EXPIRED;
      return {
        status: ProviderNormalizedStatus.EXPIRED,
        depositTxId: null,
        settleTxId: null,
        settleAmountActualAtomic: null,
        failureReason: 'Deposit window expired with zero deposit received',
        raw: { orderId: providerExecutionId, reason: 'zero_deposit_timeout' },
      };
    }

    if (this.failureMode === 'RETURN_REFUNDED') {
      order.status = ProviderNormalizedStatus.REFUNDED;
      return {
        status: ProviderNormalizedStatus.REFUNDED,
        depositTxId: 'btc_deposit_tx_123',
        settleTxId: 'btc_refund_tx_999',
        settleAmountActualAtomic: null,
        failureReason: 'Slippage exceeded threshold, funds refunded to caller',
        raw: { orderId: providerExecutionId, refunded: true },
      };
    }

    if (this.failureMode === 'REFUND_WITHOUT_EVIDENCE') {
      // Provider claims refunded, but provides NO refund tx hash or evidence!
      order.status = ProviderNormalizedStatus.REFUNDED;
      return {
        status: ProviderNormalizedStatus.REFUNDED,
        depositTxId: 'btc_deposit_tx_123',
        settleTxId: null, // Missing refund evidence!
        settleAmountActualAtomic: null,
        failureReason: 'Provider claimed refund without tx hash',
        raw: { orderId: providerExecutionId },
      };
    }

    if (this.failureMode === 'CHAIN_DISAGREEMENT') {
      return {
        status: ProviderNormalizedStatus.COMPLETED,
        depositTxId: 'btc_deposit_tx_123',
        settleTxId: '0xfake_or_reverted_tx_hash',
        settleAmountActualAtomic: order.request.quote.settleAmountAtomic,
        failureReason: null,
        raw: { orderId: providerExecutionId, status: 'completed' },
      };
    }

    if (this.failureMode === 'WRONG_RECIPIENT') {
      return {
        status: ProviderNormalizedStatus.COMPLETED,
        depositTxId: 'btc_deposit_tx_123',
        settleTxId: '0xwrong_recipient_tx_hash',
        settleAmountActualAtomic: order.request.quote.settleAmountAtomic,
        failureReason: null,
        raw: { orderId: providerExecutionId, status: 'completed' },
      };
    }

    if (this.failureMode === 'WRONG_AMOUNT') {
      return {
        status: ProviderNormalizedStatus.COMPLETED,
        depositTxId: 'btc_deposit_tx_123',
        settleTxId: '0xwrong_amount_tx_hash',
        settleAmountActualAtomic: '100', // Severe underpayment!
        failureReason: null,
        raw: { orderId: providerExecutionId, status: 'completed' },
      };
    }

    if (this.failureMode === 'WRONG_TOKEN') {
      return {
        status: ProviderNormalizedStatus.COMPLETED,
        depositTxId: 'btc_deposit_tx_123',
        settleTxId: '0xwrong_token_tx_hash',
        settleAmountActualAtomic: order.request.quote.settleAmountAtomic,
        failureReason: null,
        raw: { orderId: providerExecutionId, status: 'completed' },
      };
    }

    if (this.failureMode === 'SOURCE_DEPOSIT_ONLY') {
      return {
        status: ProviderNormalizedStatus.DEPOSIT_RECEIVED,
        depositTxId: 'btc_deposit_tx_123',
        settleTxId: null,
        settleAmountActualAtomic: null,
        failureReason: null,
        raw: { orderId: providerExecutionId, status: 'pending' },
      };
    }

    if (this.failureMode === 'STALL_SETTLEMENT') {
      return {
        status: ProviderNormalizedStatus.SETTLING,
        depositTxId: 'btc_deposit_tx_123',
        settleTxId: null,
        settleAmountActualAtomic: null,
        failureReason: null,
        raw: { orderId: providerExecutionId, status: 'settling' },
      };
    }

    return {
      status: order.status,
      depositTxId: order.depositTxId,
      settleTxId: order.settleTxId,
      settleAmountActualAtomic: order.settleAmountActualAtomic,
      failureReason: order.failureReason,
      raw: { orderId: providerExecutionId, status: order.status },
    };
  }

  public simulateExternalDeposit(providerExecutionId: string, depositTxId = 'btc_dep_tx_1'): void {
    const order = this.activeOrders.get(providerExecutionId);
    if (order) {
      order.status = ProviderNormalizedStatus.PROCESSING;
      order.depositTxId = depositTxId;
    }
  }

  public simulateExternalSettlement(
    providerExecutionId: string,
    settleTxId = '0xvalid_base_tx_receipt_status_1'
  ): void {
    const order = this.activeOrders.get(providerExecutionId);
    if (order) {
      order.status = ProviderNormalizedStatus.COMPLETED;
      order.settleTxId = settleTxId;
      order.settleAmountActualAtomic = order.request.quote.settleAmountAtomic;
    }
  }

  public async requestRefund(
    providerExecutionId: string,
    _refundAddress: string
  ): Promise<RefundResult> {
    const order = this.activeOrders.get(providerExecutionId);
    if (!order) {
      return { success: false, reason: 'Order not found' };
    }
    order.status = ProviderNormalizedStatus.REFUNDED;
    return { success: true, refundTxId: 'btc_refund_tx_888' };
  }
}
