/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Fault-Injectable LND Transport Wrapper
 *
 * Enables deterministic fault simulation (network drops, timeouts, ambiguity)
 * without monkey-patching production code.
 */

import type { ILndClient } from './lnd-client.ts';
import type {
  LndGetInfoResponse,
  LndAddHoldInvoiceResponse,
  LndInvoice,
} from './lnd-types.ts';

export type FaultType = 'DROP_RESPONSE' | 'TIMEOUT' | 'ERROR';

export interface InjectedFault {
  type: FaultType;
  operation: 'addHoldInvoice' | 'settleInvoice' | 'cancelInvoice' | 'lookupInvoice' | 'all';
  error?: Error;
}

export class FaultInjectableLndClient implements ILndClient {
  private readonly underlying: ILndClient;
  private pendingFaults: InjectedFault[] = [];

  constructor(underlying: ILndClient) {
    this.underlying = underlying;
  }

  public injectFault(fault: InjectedFault): void {
    this.pendingFaults.push(fault);
  }

  public clearFaults(): void {
    this.pendingFaults = [];
  }

  async getInfo(): Promise<LndGetInfoResponse> {
    return this.underlying.getInfo();
  }

  async addHoldInvoice(
    hashHex: string,
    amountSats: bigint,
    cltvBlocks: number,
    memo?: string
  ): Promise<LndAddHoldInvoiceResponse> {
    const fault = this.takeFault('addHoldInvoice');
    if (fault) {
      if (fault.type === 'TIMEOUT') {
        throw new Error('Injected RPC Timeout on AddHoldInvoice');
      }
      if (fault.type === 'DROP_RESPONSE') {
        // Execute underlying call so LND actually creates invoice, but drop the response to client!
        await this.underlying.addHoldInvoice(hashHex, amountSats, cltvBlocks, memo);
        throw new Error('Injected Socket Drop on AddHoldInvoice Response');
      }
      if (fault.type === 'ERROR') {
        throw fault.error ?? new Error('Injected Error on AddHoldInvoice');
      }
    }
    return this.underlying.addHoldInvoice(hashHex, amountSats, cltvBlocks, memo);
  }

  async lookupInvoice(paymentHashHex: string): Promise<LndInvoice> {
    const fault = this.takeFault('lookupInvoice');
    if (fault) {
      if (fault.type === 'TIMEOUT') throw new Error('Injected Timeout on LookupInvoice');
      if (fault.type === 'ERROR') throw fault.error ?? new Error('Injected Error on LookupInvoice');
    }
    return this.underlying.lookupInvoice(paymentHashHex);
  }

  async settleInvoice(preimageHex: string): Promise<void> {
    const fault = this.takeFault('settleInvoice');
    if (fault) {
      if (fault.type === 'TIMEOUT') {
        throw new Error('Injected RPC Timeout on SettleInvoice');
      }
      if (fault.type === 'DROP_RESPONSE') {
        // Execute underlying settle so LND marks settled, but drop the response to client!
        await this.underlying.settleInvoice(preimageHex);
        throw new Error('Injected Socket Drop on SettleInvoice Response');
      }
      if (fault.type === 'ERROR') {
        throw fault.error ?? new Error('Injected Error on SettleInvoice');
      }
    }
    return this.underlying.settleInvoice(preimageHex);
  }

  async cancelInvoice(paymentHashHex: string): Promise<void> {
    const fault = this.takeFault('cancelInvoice');
    if (fault) {
      if (fault.type === 'TIMEOUT') {
        throw new Error('Injected RPC Timeout on CancelInvoice');
      }
      if (fault.type === 'DROP_RESPONSE') {
        await this.underlying.cancelInvoice(paymentHashHex);
        throw new Error('Injected Socket Drop on CancelInvoice Response');
      }
      if (fault.type === 'ERROR') {
        throw fault.error ?? new Error('Injected Error on CancelInvoice');
      }
    }
    return this.underlying.cancelInvoice(paymentHashHex);
  }

  private takeFault(operation: string): InjectedFault | undefined {
    const index = this.pendingFaults.findIndex(
      (f) => f.operation === operation || f.operation === 'all'
    );
    if (index !== -1) {
      const [fault] = this.pendingFaults.splice(index, 1);
      return fault;
    }
    return undefined;
  }
}
