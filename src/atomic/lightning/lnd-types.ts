/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Internal LND Protocol Types
 *
 * Encapsulates LND REST/gRPC data formats.
 * INVARIANT: These types MUST NEVER be exposed to domain/core modules!
 */

export interface LndGetInfoResponse {
  version: string;
  commit_hash: string;
  identity_pubkey: string;
  alias: string;
  num_active_channels: number;
  num_peers: number;
  block_height: number;
  block_hash: string;
  synced_to_chain: boolean;
  synced_to_graph: boolean;
  testnet: boolean;
  chains: Array<{
    chain: string;
    network: string; // e.g. "regtest", "mainnet", "testnet"
  }>;
  uris: string[];
}

export interface LndAddHoldInvoiceRequest {
  hash: string; // base64-encoded 32-byte hash
  value: string; // satoshis as string
  value_msat?: string;
  memo?: string;
  cltv_expiry: string; // integer blocks as string
}

export interface LndAddHoldInvoiceResponse {
  payment_request: string; // BOLT11 invoice
  add_index: string;
  payment_error?: string;
}

export type LndInvoiceState = 'OPEN' | 'SETTLED' | 'CANCELED' | 'ACCEPTED';

export interface LndHtlc {
  chan_id: string;
  htlc_index: string;
  amt_msat: string;
  accept_height: number;
  accept_time: string;
  resolve_time: string;
  expiry_height: number;
  state: string; // "ACCEPTED", "SETTLED", "CANCELED"
  custom_records?: Record<string, string>;
  mpp_total_amt_msat?: string;
}

export interface LndInvoice {
  memo: string;
  r_preimage: string; // base64
  r_hash: string; // base64
  value: string;
  value_msat: string;
  settled: boolean;
  creation_date: string;
  settle_date: string;
  payment_request: string;
  description_hash: string;
  expiry: string;
  fallback_addr: string;
  cltv_expiry: string;
  route_hints: unknown[];
  private: boolean;
  add_index: string;
  settle_index: string;
  amt_paid_sat: string;
  amt_paid_msat: string;
  state: LndInvoiceState;
  htlcs: LndHtlc[];
}

export interface LndSettleInvoiceRequest {
  preimage: string; // base64-encoded 32-byte secret
}

export interface LndSettleInvoiceResponse {
  // Empty message on success in invoicesrpc
}

export interface LndCancelInvoiceRequest {
  payment_hash: string; // base64-encoded 32-byte payment hash
}

export interface LndCancelInvoiceResponse {
  // Empty message on success in invoicesrpc
}
