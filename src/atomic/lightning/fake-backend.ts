/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Deterministic Local Fake Lightning Atomic Backend
 *
 * Implements BOLT11 Hold Invoice semantics in local memory for offline testing.
 * Enforces SEC-10 (claim/settle and cancel/refund mutual exclusion).
 */

import { createHash } from 'node:crypto';
import type {
  ILightningAtomicBackend,
  HoldInvoice,
  HoldInvoiceState,
  HashLock,
  PaymentHash,
  SecretPreimage,
} from '../types.ts';

export class FakeLightningAtomicBackend implements ILightningAtomicBackend {
  readonly backendName = 'FakeLightningAtomicBackend';
  private invoices = new Map<PaymentHash, HoldInvoice>();
  private hashLocks = new Map<PaymentHash, HashLock>();

  async createHoldInvoice(
    hashLock: HashLock,
    amountSats: bigint,
    cltvExpiryBlocks: number,
    _memo?: string
  ): Promise<HoldInvoice> {
    const paymentHash = hashLock.replace(/^0x/, '').toLowerCase();

    if (this.invoices.has(paymentHash)) {
      throw new Error(`Hold invoice with payment hash ${paymentHash} already exists`);
    }

    const invoice: HoldInvoice = {
      paymentHash,
      bolt11: `lnbc${amountSats}n1fake_bolt11_invoice_${paymentHash.slice(0, 16)}`,
      amountSats,
      cltvExpiryBlocks,
      state: 'OPEN',
      createdAt: new Date(),
    };

    this.invoices.set(paymentHash, invoice);
    this.hashLocks.set(paymentHash, hashLock.toLowerCase());
    return invoice;
  }

  async observeHoldInvoice(paymentHash: PaymentHash): Promise<HoldInvoice> {
    const invoice = this.invoices.get(paymentHash.toLowerCase());
    if (!invoice) {
      throw new Error(`Invoice not found for payment hash: ${paymentHash}`);
    }
    return invoice;
  }

  async settleHoldInvoice(
    preimage: SecretPreimage
  ): Promise<{ settled: boolean; settledAt: Date }> {
    const rawPreimage = preimage.startsWith('0x')
      ? Buffer.from(preimage.slice(2), 'hex')
      : Buffer.from(preimage, 'hex');

    const computedHash = createHash('sha256').update(rawPreimage).digest('hex');
    const invoice = this.invoices.get(computedHash);

    if (!invoice) {
      throw new Error(`No invoice found matching preimage hash: ${computedHash}`);
    }

    if (invoice.state === 'CANCELED') {
      throw new Error(`Cannot settle canceled invoice (SEC-10 violation)`);
    }

    if (invoice.state === 'SETTLED') {
      return { settled: true, settledAt: invoice.settledAt! };
    }

    if (invoice.state !== 'ACCEPTED') {
      throw new Error(`Cannot settle invoice in state ${invoice.state}; payment must be HELD first`);
    }

    const settledAt = new Date();
    invoice.state = 'SETTLED';
    invoice.settledAt = settledAt;
    return { settled: true, settledAt };
  }

  async cancelHoldInvoice(
    paymentHash: PaymentHash
  ): Promise<{ canceled: boolean; canceledAt: Date }> {
    const invoice = this.invoices.get(paymentHash.toLowerCase());
    if (!invoice) {
      throw new Error(`Invoice not found: ${paymentHash}`);
    }

    if (invoice.state === 'SETTLED') {
      throw new Error(`Cannot cancel already settled invoice (SEC-10 violation)`);
    }

    if (invoice.state === 'CANCELED') {
      return { canceled: true, canceledAt: invoice.canceledAt! };
    }

    const canceledAt = new Date();
    invoice.state = 'CANCELED';
    invoice.canceledAt = canceledAt;
    return { canceled: true, canceledAt };
  }

  async getInvoiceState(paymentHash: PaymentHash): Promise<HoldInvoiceState> {
    const invoice = await this.observeHoldInvoice(paymentHash);
    return invoice.state;
  }

  // --- Test Simulation Methods ---

  simulatePayerHold(paymentHash: PaymentHash): void {
    const invoice = this.invoices.get(paymentHash.toLowerCase());
    if (!invoice) throw new Error(`Invoice not found: ${paymentHash}`);
    if (invoice.state !== 'OPEN') {
      throw new Error(`Cannot hold payment in state: ${invoice.state}`);
    }
    invoice.state = 'ACCEPTED';
    invoice.acceptedAt = new Date();
  }
}
