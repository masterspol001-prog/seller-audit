'use strict';

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => escapeCell(c.label || c.key)).join(',');
  const lines = rows.map((row) => columns.map((c) => escapeCell(typeof c.value === 'function' ? c.value(row) : row[c.key])).join(','));
  return [header, ...lines].join('\r\n');
}

function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from('\uFEFF' + csv, 'utf8'));
}

module.exports = { toCsv, sendCsv, escapeCell };
