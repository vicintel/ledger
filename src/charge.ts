/**
 * A paid order, split the way Myshoplet actually splits one.
 *
 * Paystack's charge is passed through at what they really took — it is a cost,
 * never revenue — and the seller's share is not spendable until it clears.
 */

import { kobo, type Kobo } from './money.ts';
import { transaction, type Transaction } from './ledger.ts';

export type Charge = {
  reference: string;   // the gateway's reference; the idempotency key
  storeId: string;
  gross: Kobo;         // what the buyer paid
  platformFee: Kobo;   // ours
  gatewayFee: Kobo;    // Paystack's, at actual cost
};

export function chargeTransaction(c: Charge): Transaction {
  const sellerShare = kobo(c.gross - c.platformFee - c.gatewayFee);
  if (sellerShare < 0) {
    throw new Error(`fees exceed the payment on ${c.reference}`);
  }
  return transaction(c.reference, 'order.paid', [
    { account: 'cash.paystack', amount: c.gross },
    { account: `seller.pending:${c.storeId}`, amount: kobo(-sellerShare) },
    { account: 'platform.revenue', amount: kobo(-c.platformFee) },
    { account: 'gateway.expense', amount: kobo(-c.gatewayFee) },
  ]);
}
