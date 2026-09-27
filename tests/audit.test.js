'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runAudit } = require('../server/audit/engine');
const { auditCsv, findingsByRule, DETAIL_HEADER, detailRow } = require('./helpers');

test('a consistent file produces no data-backed findings', () => {
  const { findings } = auditCsv(DETAIL_HEADER, [
    detailRow({ type: 'Order', total: 31.99, order: '111-1', itemCode: 'I1', sku: 'SKU-A', qty: 2, price: 39.98, fee: -5.99, promo: -2.00 }),
  ], { cogs: new Map([['SKU-A', 5]]) });
  const real = findings.filter((f) => f.category !== 'data_gap');
  assert.deepEqual(real, []);
});

test('R001 flags a row whose amounts do not match its own total', () => {
  const { findings } = auditCsv(DETAIL_HEADER, [
    detailRow({ type: 'Order', total: 100, order: '111-1', itemCode: 'I1', sku: 'SKU-A', qty: 1, price: 39.98, fee: -5.99 }),
    detailRow({ type: 'Order', total: 200, order: '111-2', itemCode: 'I2', sku: 'SKU-B', qty: 1, price: 210, fee: -10 }),
  ]);
  const r1 = findingsByRule(findings, 'R001');
  assert.equal(r1.length, 1);
  assert.equal(r1[0].confidence, 'high');
  assert.ok(r1[0].evidence.sourceRows.length >= 1);
});

test('R002 reconciles settlement rows against a repeated stated total', () => {
  const { findings } = auditCsv(DETAIL_HEADER, [
    detailRow({ type: 'Order', total: 999, order: '111-1', itemCode: 'I1', sku: 'SKU-A', qty: 1, price: 39.98, fee: -5.99 }),
    detailRow({ type: 'Order', total: 999, order: '111-2', itemCode: 'I2', sku: 'SKU-B', qty: 1, price: 11.99, fee: -2 }),
  ]);
  const r2 = findingsByRule(findings, 'R002');
  assert.equal(r2.length, 1);
  assert.equal(r2[0].category, 'reconciliation');
});

test('R003 flags identical-looking duplicate transactions as review items only', () => {
  const { findings } = auditCsv(DETAIL_HEADER, [
    detailRow({ type: 'Order', order: '111-9', itemCode: 'I9', sku: 'SKU-D', qty: 1, price: 19.99, fee: -2.99 }),
    detailRow({ type: 'Order', order: '111-9', itemCode: 'I9', sku: 'SKU-D', qty: 1, price: 19.99, fee: -2.99 }),
  ]);
  const r3 = findingsByRule(findings, 'R003');
  assert.equal(r3.length, 1);
  assert.equal(r3[0].recoverable, false);
  assert.equal(r3[0].confidence, 'medium');
});

test('R004 flags a sale with no fee row, at low confidence', () => {
  const { findings } = auditCsv(DETAIL_HEADER, [
    detailRow({ type: 'Order', order: '111-6', itemCode: 'I6', sku: 'SKU-NOFEE', qty: 1, price: 14.99 }),
  ]);
  const r4 = findingsByRule(findings, 'R004');
  assert.equal(r4.length, 1);
  assert.equal(r4[0].confidence, 'low');
});

test('R005 flags a referral fee that is an implausibly high share of the sale', () => {
  const { findings } = auditCsv(DETAIL_HEADER, [
    detailRow({ type: 'Order', order: '111-10', itemCode: 'I10', sku: 'SKU-BAD', qty: 1, price: 10, fee: -6.5, promo: -4 }),
  ]);
  const r5 = findingsByRule(findings, 'R005');
  assert.ok(r5.some((f) => f.title.includes('Referral fee looks higher')));
  assert.equal(r5[0].potential, true);
});

test('R006 flags a refund whose order is absent from the file', () => {
  const { findings } = auditCsv(DETAIL_HEADER, [
    detailRow({ type: 'Refund', order: '111-8', itemCode: 'I8', sku: 'SKU-B', qty: 1, price: -24.99, fee: 3.75 }),
  ], { cogs: new Map([['SKU-B', 1]]) });
  const r6 = findingsByRule(findings, 'R006');
  assert.equal(r6.length, 1);
  assert.equal(r6[0].orderId, '111-8');
});

test('R007 flags a negative inventory adjustment for manual review', () => {
  const { findings } = auditCsv(DETAIL_HEADER, [
    detailRow({ type: 'Inventory Adjustment', other: -12.75 }),
  ]);
  const r7 = findingsByRule(findings, 'R007');
  assert.equal(r7.length, 1);
  assert.equal(r7[0].recoverable, false);
  assert.equal(r7[0].potential, true);
});

test('R008 flags a storage fee far above the file median', () => {
  const header = ['settlement-id', 'total-amount', 'currency', 'transaction-type', 'posted-date', 'sku', 'other-fee-amount'];
  const rows = [
    ['S1', '', 'USD', 'FBA Storage Fee', '2026-08-10', 'SKU-A', '-0.40'],
    ['S1', '', 'USD', 'FBA Storage Fee', '2026-08-10', 'SKU-B', '-0.50'],
    ['S1', '', 'USD', 'FBA Storage Fee', '2026-08-10', 'SKU-C', '-0.60'],
    ['S1', '', 'USD', 'FBA Storage Fee', '2026-08-10', 'SKU-D', '-8.90'],
  ];
  const { findings } = auditCsv(header, rows);
  const r8 = findingsByRule(findings, 'R008');
  assert.equal(r8.length, 1);
  assert.equal(r8[0].amount, 8.9);
});

test('R008 declines to conclude when there are too few storage rows', () => {
  const header = ['settlement-id', 'total-amount', 'currency', 'transaction-type', 'posted-date', 'sku', 'other-fee-amount'];
  const { findings } = auditCsv(header, [
    ['S1', '', 'USD', 'FBA Storage Fee', '2026-08-10', 'SKU-A', '-0.40'],
  ]);
  const r8 = findingsByRule(findings, 'R008');
  assert.equal(r8.length, 1);
  assert.equal(r8[0].confidence, 'insufficient');
});

test('R012 reports a loss-making SKU at low confidence without COGS and high with it', () => {
  const rows = [detailRow({ type: 'Order', order: '111-10', itemCode: 'I10', sku: 'SKU-BAD', qty: 1, price: 10, fee: -6.5, promo: -4 })];
  const low = findingsByRule(auditCsv(DETAIL_HEADER, rows).findings, 'R012');
  assert.equal(low.length, 1);
  assert.equal(low[0].confidence, 'low');

  const high = findingsByRule(auditCsv(DETAIL_HEADER, rows, { cogs: new Map([['SKU-BAD', 0]]) }).findings, 'R012');
  assert.equal(high.length, 1);
  assert.equal(high[0].confidence, 'high');
});

test('R011 flags a settlement that mixes currencies', () => {
  const header = ['settlement-id', 'total-amount', 'currency', 'transaction-type', 'posted-date', 'sku', 'price-amount'];
  const rows = [
    ['S1', '', 'USD', 'Order', '2026-08-01', 'SKU-A', '10'],
    ['S1', '', 'EUR', 'Order', '2026-08-02', 'SKU-B', '20'],
  ];
  const { findings } = auditCsv(header, rows);
  const r11 = findingsByRule(findings, 'R011');
  assert.equal(r11.length, 1);
  assert.equal(r11[0].severity, 'high');
});

test('data gaps are reported as insufficient evidence, never as findings', () => {
  const empty = runAudit({ transactions: [] });
  assert.equal(findingsByRule(empty.findings, 'R900').length, 1);

  const noSettlement = auditCsv(['transaction-type', 'price-amount', 'sku'], [['Order', '10', 'SKU-A']]);
  assert.equal(findingsByRule(noSettlement.findings, 'R901').length, 1);

  const noAmounts = auditCsv(['settlement-id', 'transaction-type', 'sku'], [['S1', 'Order', 'SKU-A']]);
  assert.equal(findingsByRule(noAmounts.findings, 'R902').length, 1);

  const noType = auditCsv(['settlement-id', 'price-amount', 'sku'], [['S1', '10', 'SKU-A']]);
  assert.equal(findingsByRule(noType.findings, 'R903').length, 1);

  const noSku = auditCsv(['settlement-id', 'transaction-type', 'price-amount'], [['S1', 'Order', '10']]);
  assert.equal(findingsByRule(noSku.findings, 'R904').length, 1);
});

test('missing COGS is surfaced and limits profitability confidence', () => {
  const { findings, summary } = auditCsv(DETAIL_HEADER, [
    detailRow({ type: 'Order', order: '111-1', itemCode: 'I1', sku: 'SKU-A', qty: 1, price: 20, fee: -3 }),
  ]);
  assert.equal(findingsByRule(findings, 'R905').length, 1);
  assert.ok(summary.limitations.some((l) => /COGS/.test(l)));
  assert.equal(summary.profitability[0].cogsKnown, false);
});

test('every data-backed finding keeps traceable source rows', () => {
  const { findings } = auditCsv(DETAIL_HEADER, [
    detailRow({ type: 'Order', total: 999, order: '111-1', itemCode: 'I1', sku: 'SKU-A', qty: 1, price: 39.98, fee: -5.99 }),
    detailRow({ type: 'Refund', order: '111-8', itemCode: 'I8', sku: 'SKU-B', qty: 1, price: -24.99, fee: 3.75 }),
    detailRow({ type: 'Inventory Adjustment', other: -12.75 }),
  ]);
  for (const f of findings) {
    if (f.category === 'data_gap') continue;
    assert.ok(Array.isArray(f.evidence.sourceRows) && f.evidence.sourceRows.length >= 1, `${f.ruleId} lacks source rows`);
    assert.ok(['critical', 'high', 'medium', 'low', 'info'].includes(f.severity));
    assert.ok(['high', 'medium', 'low', 'insufficient'].includes(f.confidence));
  }
});
