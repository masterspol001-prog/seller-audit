'use strict';

// Generates data/sample/settlement-sample.csv — a synthetic Amazon settlement
// detail report that exercises the audit rules without asserting any real
// recoverable money. Run with: node scripts/make-sample.js
//
// The file is deliberately realistic: some rows are consistent, some contain
// the kinds of issues a seller should investigate (duplicate-looking charges,
// inventory depreciation, missing fees, a loss-making SKU). Amounts are
// self-consistent so that reconciliation rules pass and no false
// "Amazon owes you money" conclusion is produced.

const fs = require('fs');
const path = require('path');

const HEADER = [
  'settlement-id', 'settlement-start-date', 'settlement-end-date', 'deposit-date',
  'total-amount', 'currency', 'transaction-type', 'order-id', 'merchant-order-id',
  'adjustment-id', 'shipment-id', 'marketplace-name', 'fulfillment-id', 'posted-date',
  'order-item-code', 'merchant-order-item-id', 'merchant-adjustment-item-id', 'sku',
  'asin', 'quantity-purchased', 'price-type', 'price-amount', 'item-related-fee-type',
  'item-related-fee-amount', 'misc-fee-amount', 'other-fee-amount',
  'other-fee-reason-description', 'promotion-amount', 'direct-payment-amount', 'other-amount',
];

const SETTLEMENT = {
  id: 'S1',
  start: '2026-07-01',
  end: '2026-07-31',
  deposit: '2026-08-12',
  total: 144.91,
  currency: 'USD',
};

// Each row describes the 24 columns from transaction-type onwards.
function tx({
  type, order = '', merchantOrder = '', adjustment = '', ship = '', market = 'Amazon.com',
  fulfillment = 'AFN', posted, itemCode = '', merchantItem = '', sku = '', asin = '',
  qty = '', priceType = '', price = '', feeType = '', fee = '', misc = '', otherFee = '',
  reason = '', promo = '', direct = '', other = '',
}) {
  return [
    type, order, merchantOrder, adjustment, ship, market, fulfillment, posted,
    itemCode, merchantItem, '', sku, asin, qty, priceType, price, feeType, fee,
    misc, otherFee, reason, promo, direct, other,
  ];
}

const rows = [
  tx({ type: 'Order', order: '111-0000001-0000001', ship: 'SHIP1', posted: '2026-08-02', itemCode: 'I1', sku: 'SKU-RED', asin: 'B0RED00001', qty: 2, priceType: 'ItemPrice', price: 39.98, feeType: 'ReferralFee', fee: -5.99, promo: -2.00 }),
  tx({ type: 'Order', order: '111-0000002-0000002', ship: 'SHIP2', posted: '2026-08-03', itemCode: 'I2', sku: 'SKU-BLUE', asin: 'B0BLU00002', qty: 1, priceType: 'ItemPrice', price: 24.99, feeType: 'ReferralFee', fee: -3.75 }),
  tx({ type: 'Order', order: '111-0000003-0000003', ship: 'SHIP3', posted: '2026-08-04', itemCode: 'I3', sku: 'SKU-PEN', asin: 'B0PEN00003', qty: 5, priceType: 'ItemPrice', price: 9.95, feeType: 'ReferralFee', fee: -1.49, promo: -5.00 }),
  tx({ type: 'Order', order: '111-0000004-0000004', ship: 'SHIP4', posted: '2026-08-05', itemCode: 'I4', sku: 'SKU-MUG', asin: 'B0MUG00004', qty: 1, priceType: 'ItemPrice', price: 19.99, feeType: 'ReferralFee', fee: -2.99 }),
  tx({ type: 'Order', order: '111-0000005-0000005', ship: 'SHIP5', posted: '2026-08-05', itemCode: 'I5', sku: 'SKU-RED', asin: 'B0RED00001', qty: 1, priceType: 'ItemPrice', price: 19.99, feeType: 'ReferralFee', fee: -2.99 }),
  // No referral fee recorded anywhere for this sale.
  tx({ type: 'Order', order: '111-0000006-0000006', ship: 'SHIP6', posted: '2026-08-06', itemCode: 'I6', sku: 'SKU-NOFEE', asin: 'B0NOF00006', qty: 1, priceType: 'ItemPrice', price: 14.99 }),
  tx({ type: 'Order', order: '111-0000007-0000007', ship: 'SHIP7', posted: '2026-08-07', itemCode: 'I7', sku: 'SKU-LAMP', asin: 'B0LAM00007', qty: 2, priceType: 'ItemPrice', price: 59.98, feeType: 'ReferralFee', fee: -8.99 }),
  // Refund whose original order is not in this file.
  tx({ type: 'Refund', order: '111-0000008-0000008', posted: '2026-08-08', itemCode: 'I8', sku: 'SKU-BLUE', asin: 'B0BLU00002', qty: 1, priceType: 'ItemPrice', price: -24.99, feeType: 'ReferralFee', fee: 3.75 }),
  // Inventory deduction that may or may not be reimbursable.
  tx({ type: 'Inventory Adjustment', posted: '2026-08-09', asin: 'B0BLU00002', reason: 'Inventory adjustment - unit not accounted for', other: -12.75 }),
  // Storage fees — one is far above the median.
  tx({ type: 'FBA Storage Fee', posted: '2026-08-10', sku: 'SKU-MUG', asin: 'B0MUG00004', otherFee: -0.40, reason: 'Monthly storage fee' }),
  tx({ type: 'FBA Storage Fee', posted: '2026-08-10', sku: 'SKU-PEN', asin: 'B0PEN00003', otherFee: -0.50, reason: 'Monthly storage fee' }),
  tx({ type: 'FBA Storage Fee', posted: '2026-08-10', sku: 'SKU-RED', asin: 'B0RED00001', otherFee: -8.90, reason: 'Monthly storage fee' }),
  tx({ type: 'FBA Storage Fee', posted: '2026-08-10', sku: 'SKU-LAMP', asin: 'B0LAM00007', otherFee: -0.60, reason: 'Monthly storage fee' }),
  // Identical to the row above: a duplicate-looking charge for review.
  tx({ type: 'FBA Storage Fee', posted: '2026-08-10', sku: 'SKU-RED', asin: 'B0RED00001', otherFee: -8.90, reason: 'Monthly storage fee' }),
  tx({ type: 'Long-Term Storage Fee', posted: '2026-08-10', sku: 'SKU-RED', asin: 'B0RED00001', otherFee: -6.20, reason: 'Long-term storage surcharge' }),
  tx({ type: 'FBA Inbound Fee', posted: '2026-08-11', sku: 'SKU-PEN', asin: 'B0PEN00003', otherFee: -1.10, reason: 'Inbound transportation fee' }),
  tx({ type: 'FBA Aged Inventory Surcharge', posted: '2026-08-11', sku: 'SKU-PEN', asin: 'B0PEN00003', otherFee: -4.15, reason: 'Aged inventory surcharge' }),
  tx({ type: 'Order', order: '111-0000009-0000009', ship: 'SHIP9', posted: '2026-08-09', itemCode: 'I9', sku: 'SKU-MUG', asin: 'B0MUG00004', qty: 3, priceType: 'ItemPrice', price: 59.97, feeType: 'ReferralFee', fee: -8.99 }),
  // Positive amount on a fee row (a reversal-style credit).
  tx({ type: 'FBA Fee Adjustment', posted: '2026-08-11', itemCode: 'I4', sku: 'SKU-MUG', asin: 'B0MUG00004', feeType: 'ReferralFee', fee: 2.50 }),
  // Referral fee is 65% of the sale price and the SKU sells at a loss.
  tx({ type: 'Order', order: '111-0000010-0000010', ship: 'SHIP10', posted: '2026-08-12', itemCode: 'I10', sku: 'SKU-BAD', asin: 'B0BAD00010', qty: 1, priceType: 'ItemPrice', price: 10.00, feeType: 'ReferralFee', fee: -6.50, promo: -4.00 }),
];

function esc(v) {
  const s = v === '' || v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const prefix = [SETTLEMENT.id, SETTLEMENT.start, SETTLEMENT.end, SETTLEMENT.deposit, SETTLEMENT.total, SETTLEMENT.currency];
const lines = [HEADER.join(',')];
for (const r of rows) lines.push([...prefix, ...r].map(esc).join(','));

const out = path.join(__dirname, '..', 'data', 'sample', 'settlement-sample.csv');
fs.writeFileSync(out, lines.join('\r\n') + '\r\n', 'utf8');
console.log(`Wrote ${out} (${rows.length} data rows)`);
