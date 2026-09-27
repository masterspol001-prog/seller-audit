'use strict';

function detectEncoding(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: 'utf-8', bom: true };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return { encoding: 'utf-16le', bom: true };
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return { encoding: 'utf-16be', bom: true };

  // Heuristic: if the bytes are valid UTF-8 with no replacement characters, treat as UTF-8.
  const sample = buffer.subarray(0, Math.min(buffer.length, 65536)).toString('utf8');
  if (!sample.includes('\uFFFD')) return { encoding: 'utf-8', bom: false };

  // Otherwise assume Windows-1252 (latin1 is a close superset for report data).
  return { encoding: 'windows-1252', bom: false };
}

function decodeBuffer(buffer, encoding) {
  switch (encoding) {
    case 'utf-16le':
      return stripBom(buffer.toString('utf16le'));
    case 'utf-16be': {
      const swapped = Buffer.from(buffer);
      if (swapped.length % 2 === 1) return stripBom(swapped.toString('utf8'));
      for (let i = 0; i + 1 < swapped.length; i += 2) {
        const t = swapped[i];
        swapped[i] = swapped[i + 1];
        swapped[i + 1] = t;
      }
      return stripBom(swapped.toString('utf16le'));
    }
    default:
      return stripBom(buffer.toString(encoding === 'windows-1252' ? 'latin1' : 'utf8'));
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const CANDIDATES = ['\t', ',', ';', '|'];

// Picks the delimiter that produces the most consistent column count across the
// first lines of the file. Falls back to tab (Amazon settlement default).
function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length).slice(0, 25);
  if (!lines.length) return '\t';

  let best = { delimiter: '\t', score: -1 };
  for (const delim of CANDIDATES) {
    const counts = lines.map((line) => countOutsideQuotes(line, delim));
    const nonZero = counts.filter((c) => c > 0);
    if (!nonZero.length) continue;
    const first = nonZero[0];
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = first * 2 + consistent * 10;
    if (score > best.score) best = { delimiter: delim, score };
  }
  return best.delimiter;
}

function countOutsideQuotes(line, delim) {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delim && !inQuotes) count += 1;
  }
  return count;
}

module.exports = { detectEncoding, decodeBuffer, detectDelimiter, stripBom, CANDIDATES };
