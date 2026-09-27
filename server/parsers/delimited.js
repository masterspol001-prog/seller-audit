'use strict';

// RFC 4180-style parser that tolerates quoted fields, embedded delimiters and
// embedded newlines. Returns an array of string arrays, preserving row order.
function parseDelimited(text, delimiter = '\t') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let sawField = false;
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      sawField = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field); field = ''; sawField = true;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      rows.push(row); row = []; sawField = false;
      continue;
    }
    if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = []; sawField = false;
      continue;
    }
    field += ch;
    sawField = true;
  }

  if (sawField || field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  // Drop fully empty trailing rows caused by trailing newlines.
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

function toObjects(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = r[i] ?? '';
    return obj;
  });
}

module.exports = { parseDelimited, toObjects };
