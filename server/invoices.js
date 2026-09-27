'use strict';

// GST invoices for Indian customers.
//
// Prices are customer-facing (tax-inclusive): the amount the seller pays is the
// amount on the invoice. When the operator has configured their own GSTIN the
// invoice is issued as a tax invoice and the GST is split out (CGST+SGST for an
// intra-state sale, IGST otherwise). Without a seller GSTIN we issue a clearly
// labelled receipt and never invent a tax number.

const { config } = require('./config');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Indian financial year label for a date, e.g. 2026-09 -> "2026-27".
function financialYear(date = new Date()) {
  const y = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? y : y - 1; // April = month 3
  const endYY = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endYY}`;
}

// Splits a tax-inclusive total into subtotal + GST components.
function splitTax({ total, ratePercent = 0, sellerStateCode = null, buyerStateCode = null }) {
  const rate = Number(ratePercent) || 0;
  const isTax = rate > 0;
  const subtotal = isTax ? round2((Number(total) * 100) / (100 + rate)) : round2(Number(total));
  const tax = round2(Number(total) - subtotal);
  const sameState = !!sellerStateCode && !!buyerStateCode && String(sellerStateCode) === String(buyerStateCode);
  const interState = isTax && !sameState;
  return {
    subtotal,
    tax,
    rate,
    interState,
    cgst: isTax && !interState ? round2(tax / 2) : 0,
    sgst: isTax && !interState ? round2(tax / 2) : 0,
    igst: isTax && interState ? tax : 0,
  };
}

function isTaxInvoice() {
  return !!config.gst.gstin;
}

function nextInvoiceNumber(date = new Date()) {
  const seq = require('./db').nextCounter(`invoice:${financialYear(date)}`);
  const prefix = config.gst.invoicePrefix || 'SP';
  return `${prefix}/${financialYear(date)}/${String(seq).padStart(6, '0')}`;
}

// Builds and persists an invoice for a paid checkout. `total` is the amount the
// customer paid (tax-inclusive).
function issueInvoice({
  workspace, user, payment = null, plan = null, kind = 'plan', total, currency = 'INR', description = null,
}) {
  const rate = isTaxInvoice() ? config.gst.defaultRatePercent : 0;
  const tax = splitTax({
    total,
    ratePercent: rate,
    sellerStateCode: config.gst.stateCode,
    buyerStateCode: workspace.billing_state_code,
  });
  const invoice = require('./db').createInvoice({
    number: nextInvoiceNumber(),
    workspaceId: workspace.id,
    paymentId: payment ? payment.id : null,
    plan,
    kind,
    customerName: workspace.legal_name || (user ? user.name : null) || workspace.name,
    customerEmail: user ? user.email : null,
    customerGstin: workspace.gstin || null,
    customerState: workspace.billing_state || null,
    customerStateCode: workspace.billing_state_code || null,
    sellerName: config.gst.legalName,
    sellerGstin: config.gst.gstin,
    sellerState: config.gst.state,
    sellerStateCode: config.gst.stateCode,
    placeOfSupply: workspace.billing_state || config.gst.state || null,
    currency,
    subtotal: tax.subtotal,
    taxRate: tax.rate,
    cgst: tax.cgst,
    sgst: tax.sgst,
    igst: tax.igst,
    total: round2(total),
    isTaxInvoice: isTaxInvoice(),
    line: [{ description: description || `SettleProof ${plan || kind}`, amount: round2(total), sac: config.gst.sacCode }],
  });
  return invoice;
}

function money(n, currency = 'INR') {
  return `${currency === 'INR' ? 'Rs ' : ''}${Number(n).toFixed(2)}`;
}

// Standalone printable invoice document (also used as the email/attachment body).
function invoiceHtml(inv) {
  const title = inv.is_tax_invoice ? 'Tax Invoice' : 'Payment Receipt';
  const taxRows = inv.is_tax_invoice
    ? `
      <tr><td>Taxable value</td><td class="r">${money(inv.subtotal, inv.currency)}</td></tr>
      ${inv.igst ? `<tr><td>IGST @ ${inv.tax_rate}%</td><td class="r">${money(inv.igst, inv.currency)}</td></tr>` : ''}
      ${inv.cgst ? `<tr><td>CGST @ ${inv.tax_rate / 2}%</td><td class="r">${money(inv.cgst, inv.currency)}</td></tr>` : ''}
      ${inv.sgst ? `<tr><td>SGST @ ${inv.tax_rate / 2}%</td><td class="r">${money(inv.sgst, inv.currency)}</td></tr>` : ''}
    `
    : '<tr><td>Tax</td><td class="r">Not applicable</td></tr>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} ${inv.number}</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;color:#111;max-width:720px;margin:40px auto;padding:0 20px}
  h1{font-size:20px;margin:0 0 4px} .muted{color:#666;font-size:13px}
  table{width:100%;border-collapse:collapse;margin-top:18px;font-size:14px}
  th,td{padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:left} .r{text-align:right}
  .total td{font-weight:700;border-top:2px solid #111;border-bottom:none}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}
  .box{border:1px solid #e5e5e5;border-radius:8px;padding:12px}
  .label{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#888}
</style></head><body>
  <h1>${config.gst.legalName || 'SettleProof'}</h1>
  <div class="muted">${config.gst.addressLine || ''}${config.gst.city ? ', ' + config.gst.city : ''}${config.gst.state ? ', ' + config.gst.state : ''}${config.gst.pincode ? ' - ' + config.gst.pincode : ''}</div>
  <div class="muted">${config.gst.gstin ? 'GSTIN: ' + config.gst.gstin : 'GSTIN not configured'}</div>
  <h1 style="margin-top:24px">${title}</h1>
  <div class="muted">${inv.number} &middot; ${new Date(inv.issued_at).toLocaleDateString('en-IN')}</div>
  <div class="grid">
    <div class="box"><div class="label">Billed to</div>
      <div>${inv.customer_name || ''}</div>
      <div class="muted">${inv.customer_email || ''}</div>
      ${inv.customer_gstin ? `<div class="muted">GSTIN: ${inv.customer_gstin}</div>` : ''}
    </div>
    <div class="box"><div class="label">Place of supply</div>
      <div>${inv.place_of_supply || 'Not specified'}</div>
      <div class="muted">SAC ${config.gst.sacCode}</div>
    </div>
  </div>
  <table>
    <thead><tr><th>Description</th><th class="r">Amount</th></tr></thead>
    <tbody>
      <tr><td>${(inv.line && inv.line[0] && inv.line[0].description) || 'SettleProof subscription'}</td><td class="r">${money(inv.total, inv.currency)}</td></tr>
      ${taxRows}
      <tr class="total"><td>Total paid</td><td class="r">${money(inv.total, inv.currency)}</td></tr>
    </tbody>
  </table>
  ${inv.is_tax_invoice ? '' : '<p class="muted">This is a receipt. No GST tax invoice was issued because the operator has not configured a GSTIN.</p>'}
  <p class="muted">Computer-generated document. Amounts are tax-inclusive.</p>
</body></html>`;
}

module.exports = { round2, financialYear, splitTax, isTaxInvoice, nextInvoiceNumber, issueInvoice, invoiceHtml };
