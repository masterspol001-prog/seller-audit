'use strict';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'insufficient'];

function makeFinding(ruleId, {
  category,
  severity = 'medium',
  confidence = 'medium',
  title,
  detail,
  marketplace = null,
  sku = null,
  orderId = null,
  amount = null,
  currency = null,
  recoverable = false,
  potential = false,
  evidence = {},
}) {
  return {
    ruleId,
    category,
    severity,
    confidence,
    title,
    detail,
    marketplace,
    sku,
    orderId,
    amount,
    currency,
    recoverable,
    potential,
    evidence,
  };
}

// Builds a traceable evidence object: the exact source rows that produced the
// finding, plus a capped sample of the raw row content.
function evidenceFor(transactions, note, { limit = 3, extra = {} } = {}) {
  const list = Array.isArray(transactions) ? transactions : [transactions];
  return {
    note,
    rowCount: list.length,
    sourceRows: list.map((t) => t.sourceRow),
    sample: list.slice(0, limit).map((t) => ({
      sourceRow: t.sourceRow,
      orderId: t.orderId || undefined,
      sku: t.sku || undefined,
      transactionType: t.transactionType || undefined,
      amount: t.amount,
      raw: t.raw,
    })),
    ...extra,
  };
}

function insufficientEvidence(ruleId, { category = 'data_gap', title, detail, evidence = {} }) {
  return makeFinding(ruleId, {
    category,
    severity: 'info',
    confidence: 'insufficient',
    title,
    detail,
    evidence,
  });
}

module.exports = { makeFinding, evidenceFor, insufficientEvidence, SEVERITY_RANK, CONFIDENCE_LEVELS };
