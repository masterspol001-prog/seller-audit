'use strict';

// Amazon settlement report column mapping and normalization.
// All monetary values are kept as signed numbers; fees are normally negative.
// Every normalized transaction keeps `sourceRow` (1-based sheet/line reference)
// so findings can be traced back to the exact source row.

function normalizeHeaderToken(header) {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const HEADER_ALIASES = {
  settlementId: ['settlement-id', 'settlementid', 'settlement'],
  settlementStartDate: ['settlement-start-date', 'settlement-start'],
  settlementEndDate: ['settlement-end-date', 'settlement-end'],
  depositDate: ['deposit-date', 'depositdate'],
  totalAmount: ['total-amount', 'totalamount', 'total'],
  currency: ['currency', 'currency-code', 'currencycode'],
  transactionType: ['transaction-type', 'transactiontype', 'type'],
  orderId: ['order-id', 'orderid', 'amazon-order-id'],
  merchantOrderId: ['merchant-order-id', 'merchantorderid'],
  adjustmentId: ['adjustment-id', 'adjustmentid'],
  shipmentId: ['shipment-id', 'shipmentid'],
  marketplace: ['marketplace-name', 'marketplace', 'marketplacename'],
  fulfillmentId: ['fulfillment-id', 'fulfillment', 'fulfilment'],
  postedDate: ['posted-date', 'posted-date-time', 'posteddate', 'posted-date-time-utc'],
  orderItemCode: ['order-item-code', 'orderitemcode'],
  merchantOrderItemId: ['merchant-order-item-id', 'merchantorderitemid'],
  merchantAdjustmentItemId: ['merchant-adjustment-item-id', 'merchantadjustmentitemid'],
  sku: ['sku', 'seller-sku', 'merchant-sku', 'msku'],
  asin: ['asin'],
  quantity: ['quantity-purchased', 'quantity', 'quantitypurchased'],
  priceType: ['price-type', 'pricetype'],
  priceAmount: ['price-amount', 'product-charges', 'productcharges', 'sales', 'item-price'],
  itemRelatedFeeType: ['item-related-fee-type', 'itemrelatedfeetype'],
  itemRelatedFeeAmount: ['item-related-fee-amount', 'item-related-fees', 'itemrelatedfeeamount'],
  miscFeeAmount: ['misc-fee-amount', 'misc-fee', 'miscfeeamount'],
  otherFeeAmount: ['other-fee-amount', 'otherfeeamount'],
  otherFeeReason: ['other-fee-reason-description', 'otherfeereasondescription'],
  promotionId: ['promotion-id', 'promotionid'],
  promotionAmount: ['promotion-amount', 'promotionamount'],
  directPaymentType: ['direct-payment-type', 'directpaymenttype'],
  directPaymentAmount: ['direct-payment-amount', 'directpaymentamount'],
  otherAmount: ['other-amount', 'otheramount'],
  referralFee: ['referral-fee', 'referralfee'],
  fbaFee: ['fba-fees', 'fba-fee', 'fulfillment-fee', 'fulfillmentfee'],
  researchFee: ['research-fee'],
  variableClosingFee: ['variable-closing-fee', 'variableclosingfee'],
  productName: ['product-name', 'title', 'item-name', 'productname'],
};

// Columns that represent money on a detail settlement row.
const AMOUNT_FIELDS = [
  'priceAmount', 'itemRelatedFeeAmount', 'miscFeeAmount', 'otherFeeAmount',
  'promotionAmount', 'directPaymentAmount', 'otherAmount',
];

const FEE_FIELDS = ['itemRelatedFeeAmount', 'miscFeeAmount', 'otherFeeAmount', 'referralFee', 'fbaFee'];

function buildColumnMap(columns) {
  const tokens = columns.map(normalizeHeaderToken);
  const map = {};
  const used = new Set();
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const idx = tokens.findIndex((t, i) => t === alias && !used.has(i));
      if (idx !== -1) {
        map[canonical] = idx;
        used.add(idx);
        break;
      }
    }
  }
  const unmapped = columns.filter((_, i) => !used.has(i));
  return { map, unmapped, mappedCount: Object.keys(map).length };
}

function parseAmount(raw) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  // Strip currency symbols, letters and spaces but keep digits, separators and minus.
  s = s.replace(/[^0-9.,\-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot && /,\d{1,2}$/.test(s)) {
    // European style 1.234,56
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function parseInteger(raw) {
  const n = parseAmount(raw);
  return n === null ? null : Math.round(n);
}

function parseDate(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const mm = String(m[1]).padStart(2, '0');
    const dd = String(m[2]).padStart(2, '0');
    return `${m[3]}-${mm}-${dd}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function classify(transactionType) {
  const t = String(transactionType || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (!t) return 'unknown';
  if (t.includes('refund')) return 'refund';
  if (t.includes('reimburs') || t.includes('inventory adjustment') || t.includes('warehouse damage') || t === 'lost' || t.includes('lost')) return 'reimbursement';
  if (t.includes('removal')) return 'removal';
  if (t.includes('service fee') || t.includes('servicefee') || t.includes('fee')) return 'fee';
  if (t.includes('adjustment')) return 'adjustment';
  if (t.includes('order')) return 'order';
  if (t.includes('transfer') || t.includes('deposit')) return 'transfer';
  if (t.includes('debt') || t.includes('collect')) return 'debt';
  return 'other';
}

function detectReportKind(map) {
  const hasTx = map.transactionType !== undefined;
  const hasAmounts = AMOUNT_FIELDS.some((f) => map[f] !== undefined);
  if (hasTx && hasAmounts) return 'settlement_detail';
  if (hasTx) return 'transaction_list';
  if (map.totalAmount !== undefined && map.settlementId !== undefined) return 'settlement_summary';
  return 'unknown';
}

function cell(row, map, field) {
  const idx = map[field];
  return idx === undefined ? '' : row[idx];
}

function numberCell(row, map, field) {
  return parseAmount(cell(row, map, field));
}

function normalizeTransaction(row, map, sourceRow) {
  const settlementId = String(cell(row, map, 'settlementId') || '').trim();
  const transactionType = String(cell(row, map, 'transactionType') || '').trim();
  const amounts = {};
  let amountSum = 0;
  let amountFieldsPresent = 0;
  for (const f of AMOUNT_FIELDS) {
    const v = numberCell(row, map, f);
    amounts[f] = v;
    if (v !== null) { amountSum += v; amountFieldsPresent += 1; }
  }
  const explicitTotal = numberCell(row, map, 'totalAmount');
  const amount = amountFieldsPresent > 0 ? round2(amountSum) : explicitTotal;

  const fees = FEE_FIELDS.reduce((sum, f) => sum + (numberCell(row, map, f) || 0), 0);

  return {
    sourceRow,
    settlementId,
    transactionType,
    category: classify(transactionType),
    orderId: String(cell(row, map, 'orderId') || '').trim(),
    merchantOrderId: String(cell(row, map, 'merchantOrderId') || '').trim(),
    adjustmentId: String(cell(row, map, 'adjustmentId') || '').trim(),
    shipmentId: String(cell(row, map, 'shipmentId') || '').trim(),
    sku: String(cell(row, map, 'sku') || '').trim(),
    asin: String(cell(row, map, 'asin') || '').trim(),
    orderItemCode: String(cell(row, map, 'orderItemCode') || '').trim(),
    marketplace: String(cell(row, map, 'marketplace') || '').trim(),
    fulfillment: String(cell(row, map, 'fulfillmentId') || '').trim(),
    quantity: parseInteger(cell(row, map, 'quantity')),
    currency: String(cell(row, map, 'currency') || '').trim(),
    postedDate: parseDate(cell(row, map, 'postedDate')),
    priceAmount: amounts.priceAmount ?? null,
    promotionAmount: amounts.promotionAmount ?? null,
    itemRelatedFeeAmount: amounts.itemRelatedFeeAmount ?? null,
    miscFeeAmount: amounts.miscFeeAmount ?? null,
    otherFeeAmount: amounts.otherFeeAmount ?? null,
    directPaymentAmount: amounts.directPaymentAmount ?? null,
    otherAmount: amounts.otherAmount ?? null,
    referralFee: numberCell(row, map, 'referralFee'),
    fbaFee: numberCell(row, map, 'fbaFee'),
    feeTotal: round2(fees),
    amount,
    explicitTotal,
    settlementStartDate: parseDate(cell(row, map, 'settlementStartDate')),
    settlementEndDate: parseDate(cell(row, map, 'settlementEndDate')),
    depositDate: parseDate(cell(row, map, 'depositDate')),
    raw: row.map((c) => (c === null || c === undefined ? '' : String(c))),
    // Lowercased concatenation of the whole row, used by keyword-based rules
    // (storage, removal, aged inventory) that Amazon only exposes in free text.
    searchText: row.map((c) => (c === null || c === undefined ? '' : String(c).toLowerCase())).join(' '),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  normalizeHeaderToken,
  buildColumnMap,
  parseAmount,
  parseInteger,
  parseDate,
  classify,
  detectReportKind,
  normalizeTransaction,
  round2,
  AMOUNT_FIELDS,
  FEE_FIELDS,
  HEADER_ALIASES,
};
