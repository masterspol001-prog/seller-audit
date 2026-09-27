'use strict';

const fs = require('fs');
const path = require('path');
const { parseFile } = require('../server/parsers/parseFile');
const amazon = require('../server/parsers/amazon');
const { runAudit } = require('../server/audit/engine');

const SAMPLE = path.join(__dirname, '..', 'data', 'sample', 'settlement-sample.csv');

// Builds a CSV from a header + row arrays and runs the full pipeline.
function auditCsv(header, rows, options = {}) {
  const lines = [header.join(',')].concat(rows.map((r) => r.map(csvCell).join(',')));
  const buffer = Buffer.from(lines.join('\r\n'), 'utf8');
  const parsed = parseFile({ buffer, filename: 'test.csv' });
  const { map, unmapped, mappedCount } = amazon.buildColumnMap(parsed.columns);
  const transactions = parsed.rows.map((r, i) => amazon.normalizeTransaction(r, map, i + 2));
  const { findings, summary } = runAudit({
    transactions,
    columns: parsed.columns,
    columnMap: { map, unmapped, mappedCount },
    reportKind: amazon.detectReportKind(map),
    cogs: options.cogs || new Map(),
    options: options.options,
  });
  return { findings, summary, transactions };
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function findingsByRule(findings, ruleId) {
  return findings.filter((f) => f.ruleId === ruleId);
}

const DETAIL_HEADER = [
  'settlement-id', 'settlement-start-date', 'settlement-end-date', 'deposit-date', 'total-amount',
  'currency', 'transaction-type', 'order-id', 'shipment-id', 'marketplace-name', 'posted-date',
  'order-item-code', 'sku', 'quantity-purchased', 'price-amount', 'item-related-fee-amount',
  'promotion-amount', 'other-amount',
];

// positions in DETAIL_HEADER
// 0 settlement,1 start,2 end,3 deposit,4 total,5 currency,6 type,7 order,8 ship,9 market,
// 10 posted,11 itemCode,12 sku,13 qty,14 price,15 fee,16 promo,17 other

function detailRow({
  settlement = 'S1', total = '', type, order = '', ship = '', itemCode = '', sku = '',
  qty = '', price = '', fee = '', promo = '', other = '', posted = '2026-08-02',
}) {
  return [settlement, '2026-07-01', '2026-07-31', '2026-08-12', total, 'USD', type, order, ship,
    'Amazon.com', posted, itemCode, sku, qty, price, fee, promo, other];
}

module.exports = { SAMPLE, auditCsv, findingsByRule, DETAIL_HEADER, detailRow, csvCell };
