'use strict';

const { makeFinding, evidenceFor, insufficientEvidence } = require('./findings');
const { round2 } = require('../parsers/amazon');

const DEFAULTS = {
  amountTolerance: 0.01,
  referralMaxPct: 0.45,
  feeRatioMaxPct: 0.6,
  storageAnomalyMultiplier: 3,
  minStorageRowsForAnomaly: 3,
};

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function fmt(n) {
  if (n === null || n === undefined) return 'n/a';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Explicit `total-amount` values can mean either a row total or a settlement
// total. We only cross-foot a row when its total is unique within the
// settlement; repeated totals are treated as settlement-level.
function partitionTotals(transactions) {
  const rowScoped = new Map();
  const settlementTotals = new Map();
  const withSettlement = transactions.filter((t) => t.settlementId);
  for (const [sid, rows] of groupBy(withSettlement, (t) => t.settlementId)) {
    const counts = new Map();
    for (const r of rows) {
      if (r.explicitTotal !== null && r.explicitTotal !== undefined) {
        counts.set(r.explicitTotal, (counts.get(r.explicitTotal) || 0) + 1);
      }
    }
    for (const r of rows) {
      if (r.explicitTotal !== null && counts.get(r.explicitTotal) === 1) {
        rowScoped.set(r.sourceRow, r.explicitTotal);
      }
    }
    let best = null; let bestCount = 0;
    for (const [value, count] of counts) {
      if (count > bestCount) { best = value; bestCount = count; }
    }
    if (best !== null && (bestCount > 1 || rows.length === 1)) settlementTotals.set(sid, best);
  }
  return { rowScoped, settlementTotals };
}

/* R001 — internal cross-foot: sum of amount columns vs the row's own total. */
function ruleRowTotalMismatch(ctx) {
  const out = [];
  const { rowScoped } = ctx.totals;
  for (const t of ctx.transactions) {
    if (!rowScoped.has(t.sourceRow)) continue;
    const expected = rowScoped.get(t.sourceRow);
    if (t.amount === null) continue;
    const diff = round2(t.amount - expected);
    if (Math.abs(diff) <= ctx.opts.amountTolerance) continue;
    out.push(makeFinding('R001', {
      category: 'reconciliation',
      severity: Math.abs(diff) >= 5 ? 'high' : 'medium',
      confidence: 'high',
      title: 'Report row is internally inconsistent',
      detail: `Row ${t.sourceRow} lists transaction amounts summing to ${fmt(t.amount)}, but the row's own total says ${fmt(expected)} (difference ${fmt(diff)}). This is a defect in the report data itself, not a claim about money owed.`,
      amount: Math.abs(diff),
      currency: t.currency || ctx.currency,
      orderId: t.orderId || null,
      sku: t.sku || null,
      evidence: evidenceFor([t], 'Amount columns vs the row total column'),
    }));
  }
  return out;
}

/* R002 — settlement rows vs the settlement-level total stated in the file. */
function ruleSettlementReconciliation(ctx) {
  const out = [];
  const { settlementTotals } = ctx.totals;
  for (const [sid, expected] of settlementTotals) {
    const rows = ctx.transactions.filter((t) => t.settlementId === sid);
    const computed = round2(rows.reduce((s, t) => s + (t.amount || 0), 0));
    const diff = round2(computed - expected);
    if (Math.abs(diff) <= ctx.opts.amountTolerance) continue;
    out.push(makeFinding('R002', {
      category: 'reconciliation',
      severity: 'medium',
      confidence: 'high',
      title: 'Settlement rows do not add up to the stated total',
      detail: `Settlement ${sid}: the transaction rows sum to ${fmt(computed)} while the file states ${fmt(expected)} (difference ${fmt(diff)}). Confirm the file was not truncated or filtered before upload. This is a data-integrity flag, not proof of a recoverable amount.`,
      amount: Math.abs(diff),
      currency: rows[0]?.currency || ctx.currency,
      potential: diff < 0,
      evidence: evidenceFor(rows.slice(0, 3), `Settlement ${sid} rows vs stated total`, { extra: { settlementId: sid, computed, stated: expected } }),
    }));
  }
  return out;
}

/* R003 — repeated identical transactions (possible double charge / double credit). */
function ruleDuplicateTransactions(ctx) {
  const out = [];
  const interesting = ctx.transactions.filter((t) =>
    ['order', 'refund', 'fee', 'reimbursement'].includes(t.category) && (t.amount || 0) !== 0);
  const keyOf = (t) => [t.settlementId, t.orderId, t.orderItemCode, t.sku, t.transactionType, t.postedDate, t.amount].join('|');
  for (const [, rows] of groupBy(interesting, keyOf)) {
    if (rows.length < 2) continue;
    const first = rows[0];
    const isCharge = (first.amount || 0) < 0;
    out.push(makeFinding('R003', {
      category: isCharge ? 'fee_audit' : 'reconciliation',
      severity: Math.abs(first.amount) >= 5 ? 'high' : 'medium',
      confidence: 'medium',
      title: isCharge ? 'Possible duplicate charge' : 'Possible duplicate credit',
      detail: `${rows.length} rows share the same settlement, order, SKU, type, date and amount (${fmt(first.amount)}). Amazon can legitimately split identical lines, so this needs manual confirmation before it is treated as an overcharge.`,
      amount: Math.abs(first.amount),
      currency: first.currency || ctx.currency,
      orderId: first.orderId || null,
      sku: first.sku || null,
      recoverable: false,
      potential: isCharge,
      evidence: evidenceFor(rows, 'Rows with an identical natural key'),
    }));
  }
  return out;
}

/* R004 — marketplace referral fee missing for a sale within this file. */
function ruleReferralFeeMissing(ctx) {
  const out = [];
  const feeItems = new Set();
  for (const t of ctx.transactions) {
    if (t.category === 'fee' && t.orderItemCode) feeItems.add(t.orderItemCode);
    if (t.category === 'fee' && t.orderId) feeItems.add(`order:${t.orderId}`);
  }
  for (const t of ctx.transactions) {
    if (t.category !== 'order' || !(t.priceAmount > 0)) continue;
    if (t.itemRelatedFeeAmount !== null && t.itemRelatedFeeAmount !== 0) continue;
    if (t.orderItemCode && feeItems.has(t.orderItemCode)) continue;
    if (t.orderId && feeItems.has(`order:${t.orderId}`)) continue;
    out.push(makeFinding('R004', {
      category: 'fee_audit',
      severity: 'low',
      confidence: 'low',
      title: 'No marketplace fee row found for this sale',
      detail: `Sale row ${t.sourceRow} has product charges of ${fmt(t.priceAmount)} but no referral fee is recorded in this file. Fees are often charged in a later settlement, so this is only a prompt to check — not a missing-fee claim.`,
      amount: null,
      currency: t.currency || ctx.currency,
      orderId: t.orderId || null,
      sku: t.sku || null,
      evidence: evidenceFor([t], 'Sale row without a matching fee row in this file'),
    }));
  }
  return out.slice(0, 50);
}

/* R005 — referral fee ratio outside a sane band, or a positive "fee". */
function ruleReferralFeeAnomaly(ctx) {
  const out = [];
  const byItem = groupBy(ctx.transactions.filter((t) => t.category === 'order' && (t.priceAmount || 0) > 0 && t.orderItemCode),
    (t) => t.orderItemCode);
  for (const [itemCode, orders] of byItem) {
    const price = orders.reduce((s, t) => s + (t.priceAmount || 0) + (t.promotionAmount || 0), 0);
    const onOrderRow = orders.reduce((s, t) => s + (t.itemRelatedFeeAmount !== null && t.itemRelatedFeeAmount !== undefined
      ? t.itemRelatedFeeAmount
      : (t.referralFee || 0) + (t.fbaFee || 0)), 0);
    const fees = ctx.transactions.filter((t) => t.orderItemCode === itemCode && t.category === 'fee');
    const referral = round2(onOrderRow + fees.reduce((s, t) => s + (t.itemRelatedFeeAmount || 0), 0));
    if (price <= 0 || referral === 0) continue;
    const ratio = Math.abs(referral) / price;
    if (ratio > ctx.opts.referralMaxPct) {
      out.push(makeFinding('R005', {
        category: 'fee_audit',
        severity: ratio > ctx.opts.referralMaxPct * 1.5 ? 'high' : 'medium',
        confidence: 'medium',
        title: 'Referral fee looks higher than expected',
        detail: `Order item ${itemCode}: referral-type fees total ${fmt(referral)} against ${fmt(price)} of product charges (${(ratio * 100).toFixed(1)}%). Common referral rates top out near ${(ctx.opts.referralMaxPct * 100).toFixed(0)}%, but category rates vary — verify against your fee schedule before claiming.`,
        amount: Math.abs(referral),
        currency: orders[0].currency || ctx.currency,
        orderId: orders[0].orderId || null,
        sku: orders[0].sku || null,
        potential: referral < 0,
        evidence: evidenceFor([...orders, ...fees].slice(0, 4), `Order item ${itemCode} sales and fees`),
      }));
    }
  }
  const positiveFees = ctx.transactions.filter((t) => t.category === 'fee' && (t.amount || 0) > 0);
  for (const t of positiveFees.slice(0, 25)) {
    out.push(makeFinding('R005', {
      category: 'fee_audit',
      severity: 'low',
      confidence: 'medium',
      title: 'Positive amount recorded on a fee row',
      detail: `Fee row ${t.sourceRow} has a positive amount of ${fmt(t.amount)}. This is usually a fee adjustment or reversal, but it should reconcile to a matching fee.`,
      amount: t.amount,
      currency: t.currency || ctx.currency,
      orderId: t.orderId || null,
      sku: t.sku || null,
      evidence: evidenceFor([t], 'Positive fee row'),
    }));
  }
  return out;
}

/* R006 — refunds whose order is not present in the file. */
function ruleRefundWithoutOrder(ctx) {
  const out = [];
  const orderIds = new Set(ctx.transactions.filter((t) => t.category === 'order' && t.orderId).map((t) => t.orderId));
  const refunds = ctx.transactions.filter((t) => t.category === 'refund' && t.orderId && !orderIds.has(t.orderId));
  for (const t of refunds.slice(0, 50)) {
    out.push(makeFinding('R006', {
      category: 'reconciliation',
      severity: 'low',
      confidence: 'low',
      title: 'Refund for an order not in this file',
      detail: `Refund row ${t.sourceRow} (${fmt(t.amount)}) references order ${t.orderId}, which has no sale row here. The sale was likely in an earlier settlement; confirm on the order before treating it as anything.`,
      amount: Math.abs(t.amount || 0),
      currency: t.currency || ctx.currency,
      orderId: t.orderId,
      sku: t.sku || null,
      evidence: evidenceFor([t], 'Refund with no matching sale row in this file'),
    }));
  }
  return out;
}

/* R007 — inventory deductions that are commonly reimbursable, flagged for review. */
function ruleReimbursementReview(ctx) {
  const out = [];
  const candidates = ctx.transactions.filter((t) =>
    t.category === 'reimbursement' && (t.amount || 0) < 0);
  for (const t of candidates.slice(0, 50)) {
    out.push(makeFinding('R007', {
      category: 'reimbursement',
      severity: Math.abs(t.amount) >= 10 ? 'medium' : 'low',
      confidence: 'medium',
      title: 'Inventory deduction that may be reimbursable',
      detail: `Row ${t.sourceRow} records ${fmt(t.amount)} of "${t.transactionType}". Amazon reimburses some lost, damaged or misplaced inventory, but eligibility depends on the event and your policy. Verify it against the inventory event before claiming.`,
      amount: Math.abs(t.amount),
      currency: t.currency || ctx.currency,
      orderId: t.orderId || null,
      sku: t.sku || null,
      recoverable: false,
      potential: true,
      evidence: evidenceFor([t], 'Inventory adjustment / damage / lost transaction'),
    }));
  }
  return out;
}

/* R008 — FBA storage fee outliers, only when enough rows exist. */
function ruleStorageFeeAnomaly(ctx) {
  const out = [];
  const storage = ctx.transactions.filter((t) =>
    t.category === 'fee' && /\bstorage\b/.test(t.searchText) && !/long-?term|aged/.test(t.searchText));
  if (storage.length === 0) return out;
  if (storage.length < ctx.opts.minStorageRowsForAnomaly) {
    return [insufficientEvidence('R008', {
      category: 'storage',
      title: 'Not enough storage-fee rows to detect outliers',
      detail: `Only ${storage.length} storage-fee row(s) were found. Detecting a storage anomaly needs several periods or SKUs, so this file cannot support a conclusion.`,
      evidence: evidenceFor(storage, 'Storage-fee rows present in this file'),
    })];
  }
  const amounts = storage.map((t) => Math.abs(t.amount || 0)).sort((a, b) => a - b);
  const mid = Math.floor(amounts.length / 2);
  const median = amounts.length % 2 === 1 ? amounts[mid] : round2((amounts[mid - 1] + amounts[mid]) / 2);
  const threshold = median * ctx.opts.storageAnomalyMultiplier;
  for (const t of storage) {
    if (median > 0 && Math.abs(t.amount || 0) > threshold) {
      out.push(makeFinding('R008', {
        category: 'storage',
        severity: 'medium',
        confidence: 'low',
        title: 'Storage fee much higher than the rest',
        detail: `Row ${t.sourceRow} storage fee is ${fmt(Math.abs(t.amount))} versus a median of ${fmt(median)} in this file. Long-term or aged inventory surcharges can explain this, so review the SKU's age profile first.`,
        amount: Math.abs(t.amount),
        currency: t.currency || ctx.currency,
        sku: t.sku || null,
        potential: true,
        evidence: evidenceFor([t], `Storage fee vs median ${fmt(median)}`),
      }));
    }
  }
  return out;
}

/* R009 — removal transactions with missing or zero quantity. */
function ruleRemovalDiscrepancy(ctx) {
  const out = [];
  const removals = ctx.transactions.filter((t) => /\bremoval\b/.test(t.searchText));
  if (!removals.length) return out;
  for (const t of removals) {
    if (t.quantity !== null && t.quantity <= 0) {
      out.push(makeFinding('R009', {
        category: 'removal',
        severity: 'low',
        confidence: 'low',
        title: 'Removal transaction with a non-positive quantity',
        detail: `Row ${t.sourceRow} is a removal transaction with quantity ${t.quantity}. Confirm the number of units removed matches what you requested.`,
        amount: t.amount,
        currency: t.currency || ctx.currency,
        sku: t.sku || null,
        evidence: evidenceFor([t], 'Removal row with non-positive quantity'),
      }));
    }
  }
  return out.slice(0, 25);
}

/* R010 — aged-inventory / long-term storage mentions, informational. */
function ruleAgedInventory(ctx) {
  const out = [];
  const rows = ctx.transactions.filter((t) => /aged|long-term|long term/.test(t.searchText) && (t.amount || 0) !== 0);
  for (const t of rows.slice(0, 25)) {
    out.push(makeFinding('R010', {
      category: 'storage',
      severity: 'low',
      confidence: 'low',
      title: 'Aged / long-term inventory charge',
      detail: `Row ${t.sourceRow} appears to be an aged or long-term inventory charge of ${fmt(t.amount)}. These are usually valid; check whether the inventory age is correct before disputing.`,
      amount: Math.abs(t.amount || 0),
      currency: t.currency || ctx.currency,
      sku: t.sku || null,
      evidence: evidenceFor([t], 'Aged / long-term inventory keyword match'),
    }));
  }
  return out;
}

/* R011 — more than one currency inside a settlement makes totals meaningless. */
function ruleCurrencyMismatch(ctx) {
  const out = [];
  for (const [sid, rows] of groupBy(ctx.transactions.filter((t) => t.settlementId), (t) => t.settlementId)) {
    const currencies = new Set(rows.map((t) => t.currency).filter(Boolean));
    if (currencies.size > 1) {
      out.push(makeFinding('R011', {
        category: 'data_quality',
        severity: 'high',
        confidence: 'high',
        title: 'Multiple currencies in one settlement',
        detail: `Settlement ${sid} contains ${currencies.size} currencies (${[...currencies].join(', ')}). Totals cannot be summed across currencies, so all amounts for this settlement are shown per row only.`,
        amount: null,
        currency: null,
        potential: false,
        evidence: evidenceFor(rows.slice(0, 3), 'Rows with differing currencies'),
      }));
    }
  }
  return out;
}

/* R012 — loss-making SKUs, confidence depends on whether COGS is known. */
function ruleProfitability(ctx) {
  const out = [];
  const orderRows = ctx.transactions.filter((t) => t.category === 'order' && t.sku);
  const bySku = groupBy(orderRows, (t) => t.sku);
  for (const [sku, rows] of bySku) {
    const revenue = round2(rows.reduce((s, t) => s + (t.priceAmount || 0) + (t.promotionAmount || 0), 0));
    if (revenue <= 0) continue;
    const fees = round2(-rows.reduce((s, t) => s + (t.feeTotal || 0), 0));
    const units = rows.reduce((s, t) => s + (t.quantity && t.quantity > 0 ? t.quantity : 1), 0);
    const cogsKnown = ctx.cogs.has(sku);
    const cogs = cogsKnown ? round2(ctx.cogs.get(sku) * units) : null;
    const profit = round2(revenue - fees - (cogs || 0));
    if (profit < 0) {
      out.push(makeFinding('R012', {
        category: 'profitability',
        severity: 'medium',
        confidence: cogsKnown ? 'high' : 'low',
        title: `SKU ${sku} sold at a loss`,
        detail: `Revenue ${fmt(revenue)} minus fees ${fmt(fees)}${cogsKnown ? ` minus COGS ${fmt(cogs)}` : ''} = ${fmt(profit)} across ${units} unit(s).${cogsKnown ? '' : ' No COGS is set for this SKU, so this figure ignores product cost — add COGS for a true margin.'}`,
        amount: Math.abs(profit),
        currency: rows[0].currency || ctx.currency,
        sku,
        evidence: evidenceFor(rows.slice(0, 3), `Per-SKU profit for ${sku}`, { extra: { revenue, fees, cogs, profit, units, cogsKnown } }),
      }));
    }
  }
  return out.sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 50);
}

module.exports = {
  DEFAULTS,
  partitionTotals,
  ruleRowTotalMismatch,
  ruleSettlementReconciliation,
  ruleDuplicateTransactions,
  ruleReferralFeeMissing,
  ruleReferralFeeAnomaly,
  ruleRefundWithoutOrder,
  ruleReimbursementReview,
  ruleStorageFeeAnomaly,
  ruleRemovalDiscrepancy,
  ruleAgedInventory,
  ruleCurrencyMismatch,
  ruleProfitability,
  groupBy,
  fmt,
};
