'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { parseAmount, parseDate, parseInteger, classify, buildColumnMap, detectReportKind, normalizeTransaction } = require('../server/parsers/amazon');
const { parseDelimited } = require('../server/parsers/delimited');
const { parseFile } = require('../server/parsers/parseFile');
const { SAMPLE } = require('./helpers');

test('parseAmount handles signs, currency symbols and separators', () => {
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('(12.50)'), -12.5);
  assert.equal(parseAmount('-5.99'), -5.99);
  assert.equal(parseAmount('USD 10.00'), 10);
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount('not a number'), null);
});

test('parseInteger rounds numeric strings', () => {
  assert.equal(parseInteger('3'), 3);
  assert.equal(parseInteger('2.6'), 3);
  assert.equal(parseInteger(''), null);
});

test('parseDate normalises common formats', () => {
  assert.equal(parseDate('2026-08-02'), '2026-08-02');
  assert.equal(parseDate('2026-08-02T00:00:00Z'), '2026-08-02');
  assert.equal(parseDate('8/2/2026'), '2026-08-02');
  assert.equal(parseDate(''), null);
});

test('classify maps Amazon transaction types to categories', () => {
  assert.equal(classify('Order'), 'order');
  assert.equal(classify('Refund'), 'refund');
  assert.equal(classify('FBA Storage Fee'), 'fee');
  assert.equal(classify('Service Fee'), 'fee');
  assert.equal(classify('Inventory Adjustment'), 'reimbursement');
  assert.equal(classify('WAREHOUSE_DAMAGE'), 'reimbursement');
  assert.equal(classify('Removal'), 'removal');
  assert.equal(classify('Transfer'), 'transfer');
  assert.equal(classify(''), 'unknown');
});

test('buildColumnMap maps hyphenated Amazon headers and records unmapped ones', () => {
  const columns = ['settlement-id', 'total-amount', 'currency', 'transaction-type', 'sku', 'unknown-col'];
  const { map, unmapped, mappedCount } = buildColumnMap(columns);
  assert.equal(map.settlementId, 0);
  assert.equal(map.totalAmount, 1);
  assert.equal(map.transactionType, 3);
  assert.equal(map.sku, 4);
  assert.deepEqual(unmapped, ['unknown-col']);
  assert.equal(mappedCount, 5);
});

test('detectReportKind identifies a settlement detail report', () => {
  const { map } = buildColumnMap(['settlement-id', 'transaction-type', 'price-amount']);
  assert.equal(detectReportKind(map), 'settlement_detail');
});

test('parseDelimited honours quoted fields, embedded delimiters and newlines', () => {
  const text = 'a,b,c\r\n1,"two, three","line1\nline2"\r\n';
  const rows = parseDelimited(text, ',');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ['1', 'two, three', 'line1\nline2']);
});

test('parseFile reads the bundled sample and maps all columns', () => {
  const buffer = fs.readFileSync(SAMPLE);
  const parsed = parseFile({ buffer, filename: 'settlement-sample.csv' });
  assert.equal(parsed.rows.length, 20);
  assert.equal(parsed.meta.encoding, 'utf-8');
  assert.equal(parsed.meta.delimiter, ',');
  const { unmapped } = buildColumnMap(parsed.columns);
  assert.deepEqual(unmapped, []);
});

test('normalizeTransaction keeps source rows and sums the amount columns', () => {
  const columns = ['settlement-id', 'transaction-type', 'order-id', 'sku', 'quantity-purchased', 'price-amount', 'item-related-fee-amount', 'promotion-amount'];
  const { map } = buildColumnMap(columns);
  const row = ['S1', 'Order', '111-1', 'SKU-A', '2', '39.98', '-5.99', '-2.00'];
  const tx = normalizeTransaction(row, map, 5);
  assert.equal(tx.sourceRow, 5);
  assert.equal(tx.category, 'order');
  assert.equal(tx.sku, 'SKU-A');
  assert.equal(tx.quantity, 2);
  assert.equal(tx.feeTotal, -5.99);
  assert.equal(tx.amount, 31.99);
  assert.ok(tx.raw.length > 0);
});
