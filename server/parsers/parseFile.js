'use strict';

const path = require('path');
const { detectEncoding, decodeBuffer, detectDelimiter } = require('./detect');
const { parseDelimited } = require('./delimited');

const SUPPORTED = ['.txt', '.tsv', '.csv', '.xlsx', '.xls'];

function extensionOf(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

function isSupported(filename) {
  return SUPPORTED.includes(extensionOf(filename));
}

// Parses an uploaded buffer into { columns, rows, meta }.
// rows are string arrays; meta records how the file was interpreted so the
// audit can show the user exactly what was read.
function parseFile({ buffer, filename }) {
  const ext = extensionOf(filename);

  if (ext === '.xlsx' || ext === '.xls') {
    return parseSpreadsheet(buffer, filename);
  }
  if (!isSupported(filename)) {
    throw Object.assign(new Error(`Unsupported file type "${ext || 'unknown'}". Upload a .txt, .tsv, .csv or .xlsx settlement report.`), { status: 400 });
  }

  const { encoding } = detectEncoding(buffer);
  const text = decodeBuffer(buffer, encoding);
  const delimiter = detectDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  if (!rows.length) throw Object.assign(new Error('The uploaded file is empty.'), { status: 400 });

  const columns = rows[0].map((c) => String(c).trim());
  return {
    columns,
    rows: rows.slice(1).map((r) => {
      const copy = r.slice(0, columns.length);
      while (copy.length < columns.length) copy.push('');
      return copy;
    }),
    meta: { encoding, delimiter: delimiter === '\t' ? '\\t' : delimiter, sheet: null, format: ext.replace('.', '') },
  };
}

function parseSpreadsheet(buffer, filename) {
  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch {
    throw Object.assign(new Error('XLSX support is not installed on this server.'), { status: 500 });
  }
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw Object.assign(new Error('The spreadsheet has no sheets.'), { status: 400 });
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (!matrix.length) throw Object.assign(new Error('The spreadsheet is empty.'), { status: 400 });

  const columns = matrix[0].map((c) => String(c).trim());
  return {
    columns,
    rows: matrix.slice(1).map((r) => {
      const copy = r.map((c) => (c === null || c === undefined ? '' : String(c)));
      while (copy.length < columns.length) copy.push('');
      return copy.slice(0, columns.length);
    }),
    meta: { encoding: 'spreadsheet', delimiter: null, sheet: sheetName, format: 'xlsx' },
  };
}

module.exports = { parseFile, isSupported, extensionOf, SUPPORTED };
