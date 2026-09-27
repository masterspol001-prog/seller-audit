'use strict';

// Recovery state machine.
//
// A detected discrepancy is NEVER presented as money Amazon has paid. It moves
// through explicit states, each transition carrying a timestamp, actor, the
// previous state, the new state and optional evidence. Only CASH_CONFIRMED value
// is written to the value ledger as money actually received.

const db = require('./db');
const plans = require('./plans');
const { AppError } = require('./lib/errors');

const STATES = [
  'POTENTIAL', 'EVIDENCE_READY', 'SELLER_REVIEW', 'CLAIM_SUBMITTED',
  'AMAZON_CONFIRMED', 'CASH_CONFIRMED', 'CLOSED',
  'REJECTED', 'DISPUTED', 'EXPIRED', 'UNVERIFIED',
];

// Which transitions are allowed. Anything not listed here is rejected.
const ALLOWED = {
  POTENTIAL: ['EVIDENCE_READY', 'SELLER_REVIEW', 'CLAIM_SUBMITTED', 'CASH_CONFIRMED', 'DISPUTED', 'REJECTED', 'EXPIRED', 'UNVERIFIED', 'CLOSED'],
  EVIDENCE_READY: ['SELLER_REVIEW', 'CLAIM_SUBMITTED', 'CASH_CONFIRMED', 'DISPUTED', 'REJECTED', 'EXPIRED', 'UNVERIFIED', 'CLOSED'],
  SELLER_REVIEW: ['EVIDENCE_READY', 'CLAIM_SUBMITTED', 'CASH_CONFIRMED', 'REJECTED', 'DISPUTED', 'EXPIRED', 'CLOSED'],
  CLAIM_SUBMITTED: ['AMAZON_CONFIRMED', 'CASH_CONFIRMED', 'REJECTED', 'DISPUTED', 'EXPIRED', 'UNVERIFIED', 'CLOSED'],
  AMAZON_CONFIRMED: ['CASH_CONFIRMED', 'DISPUTED', 'REJECTED', 'CLOSED'],
  CASH_CONFIRMED: ['CLOSED', 'DISPUTED'],
  REJECTED: ['SELLER_REVIEW', 'DISPUTED', 'CLOSED'],
  DISPUTED: ['SELLER_REVIEW', 'CLAIM_SUBMITTED', 'REJECTED', 'CLOSED'],
  EXPIRED: ['SELLER_REVIEW', 'CLOSED'],
  UNVERIFIED: ['EVIDENCE_READY', 'SELLER_REVIEW', 'CLOSED'],
  CLOSED: [],
};

const ACTORS = ['seller', 'system', 'admin', 'amazon'];

const LABELS = {
  POTENTIAL: { label: 'Potential value', blurb: 'Possible Amazon discrepancy detected.' },
  EVIDENCE_READY: { label: 'Evidence ready', blurb: 'Evidence package prepared for review.' },
  SELLER_REVIEW: { label: 'Seller review', blurb: 'You are checking this before acting.' },
  CLAIM_SUBMITTED: { label: 'Claim submitted', blurb: 'Submitted to Amazon; awaiting their response.' },
  AMAZON_CONFIRMED: { label: 'Amazon confirmed', blurb: 'Amazon confirmation recorded.' },
  CASH_CONFIRMED: { label: 'Cash confirmed', blurb: 'Seller confirmed the money was actually received.' },
  CLOSED: { label: 'Closed', blurb: 'No further action needed.' },
  REJECTED: { label: 'Rejected', blurb: 'Reviewed and dismissed; not a real discrepancy.' },
  DISPUTED: { label: 'Disputed', blurb: 'Outcome is being disputed.' },
  EXPIRED: { label: 'Expired', blurb: 'Amazon claim window has passed.' },
  UNVERIFIED: { label: 'Unverified', blurb: 'Could not be verified with the available data.' },
};

const BUCKET = {
  POTENTIAL: 'potential',
  EVIDENCE_READY: 'potential',
  SELLER_REVIEW: 'potential',
  UNVERIFIED: 'potential',
  CLAIM_SUBMITTED: 'submitted',
  AMAZON_CONFIRMED: 'amazonConfirmed',
  CASH_CONFIRMED: 'cashConfirmed',
  CLOSED: 'closed',
  REJECTED: 'rejected',
  DISPUTED: 'rejected',
  EXPIRED: 'rejected',
};

function isState(s) { return STATES.includes(s); }
function canTransition(from, to) { return isState(to) && (ALLOWED[from] || []).includes(to); }

// The next best action for a finding, given its state. Always returns something.
function nextAction(finding) {
  switch (finding.recovery_state) {
    case 'POTENTIAL':
      return { action: 'prepare_evidence', label: 'Prepare evidence package' };
    case 'EVIDENCE_READY':
      return { action: 'review', label: 'Review evidence and decide' };
    case 'SELLER_REVIEW':
      return { action: 'submit', label: 'Submit claim to Amazon' };
    case 'CLAIM_SUBMITTED':
      return { action: 'record_amazon', label: 'Record Amazon response' };
    case 'AMAZON_CONFIRMED':
      return { action: 'confirm_cash', label: 'Confirm cash received' };
    case 'CASH_CONFIRMED':
      return { action: 'close', label: 'Close finding' };
    case 'REJECTED':
    case 'DISPUTED':
    case 'EXPIRED':
    case 'UNVERIFIED':
      return { action: 'reopen', label: 'Reopen or close finding' };
    default:
      return { action: 'none', label: 'No action required' };
  }
}

function legacyStatus(state) {
  if (state === 'CLOSED' || state === 'CASH_CONFIRMED') return 'resolved';
  if (state === 'REJECTED' || state === 'DISPUTED' || state === 'EXPIRED') return 'dismissed';
  return 'open';
}

function ledgerForCash(finding, workspaceId, actor, note) {
  if (!finding.amount || finding.amount <= 0) return null;
  const existing = db.get('SELECT id FROM value_ledger WHERE finding_id = ?', [finding.id]);
  if (existing) return null;
  return db.addLedger({
    workspaceId,
    entryDate: db.now(),
    type: 'recovery',
    amount: finding.amount,
    currency: finding.currency,
    findingId: finding.id,
    auditId: finding.audit_id,
    note: note || `Cash confirmed (${actor})`,
  });
}

// Applies one validated transition, records the event and, on cash confirmation,
// posts to the value ledger exactly once.
function transition({ workspaceId, findingId, toState, actor = 'seller', source = null, note = '', evidenceRef = null, caseRef, skipLedger = false }) {
  const finding = db.getFindingForWorkspace(findingId, workspaceId);
  if (!finding) throw new AppError(404, 'not_found', 'Finding not found');
  if (!isState(toState)) throw new AppError(400, 'bad_request', `Unknown recovery state "${toState}"`);
  if (!ACTORS.includes(actor)) throw new AppError(400, 'bad_request', `Unknown actor "${actor}"`);
  const fromState = finding.recovery_state || 'POTENTIAL';
  if (fromState !== toState && !canTransition(fromState, toState)) {
    throw new AppError(409, 'invalid_transition', `Cannot move a finding from ${fromState} to ${toState}.`);
  }

  const fields = {
    recovery_state: toState,
    status: legacyStatus(toState),
    next_action: nextAction({ recovery_state: toState }).action,
  };
  if (caseRef !== undefined) fields.case_ref = caseRef;
  const updated = db.updateFindingRecovery(findingId, finding.audit_id, fields);

  const event = db.insertFindingEvent({
    findingId, workspaceId, fromState, toState, actor, source, note, evidenceRef,
  });

  let ledger = null;
  if (toState === 'CASH_CONFIRMED' && !skipLedger) ledger = ledgerForCash(finding, workspaceId, actor, note);

  // Queue the relevant lifecycle nudge. Loaded lazily to keep module load order simple.
  try {
    const retention = require('./retention');
    if (toState === 'EVIDENCE_READY') {
      retention.onEvidenceReady({ workspaceId, title: finding.title, findingId: finding.id });
    } else if (toState === 'CLAIM_SUBMITTED') {
      retention.onAmazonResponseReminder({ workspaceId, title: finding.title, findingId: finding.id });
    } else if (toState === 'AMAZON_CONFIRMED') {
      retention.onCashConfirmationReminder({ workspaceId, title: finding.title, findingId: finding.id });
    }
  } catch { /* notifications must never break a transition */ }

  return { finding: updated, event, ledger, nextAction: nextAction(updated) };
}

// Aggregated, clearly separated value buckets for a workspace.
function valueSummary(workspaceId) {
  const rows = db.recoveryBuckets(workspaceId);
  const totals = { potential: 0, submitted: 0, amazonConfirmed: 0, cashConfirmed: 0, closed: 0, rejected: 0 };
  const counts = { ...totals };
  let currency = null;
  for (const r of rows) {
    const bucket = BUCKET[r.state] || 'potential';
    counts[bucket] += r.count;
    // Cash-confirmed value comes from the value ledger (money actually received),
    // not from the finding's estimated amount, so ROI is never inflated.
    if (bucket === 'cashConfirmed') continue;
    totals[bucket] = Math.round((totals[bucket] + (r.amount || 0)) * 100) / 100;
  }
  totals.cashConfirmed = db.ledgerTotals(workspaceId).recovered;
  const lastCurrency = db.get(
    'SELECT f.currency FROM findings f JOIN audits a ON a.id = f.audit_id WHERE a.workspace_id = ? AND f.currency IS NOT NULL ORDER BY f.created_at DESC LIMIT 1',
    [workspaceId],
  );
  currency = lastCurrency ? lastCurrency.currency : null;

  const openIssues = counts.potential + counts.submitted + counts.amazonConfirmed;
  const closedIssues = counts.cashConfirmed + counts.closed + counts.rejected;
  return {
    currencies: currency,
    potentialValue: totals.potential,
    submittedValue: totals.submitted,
    amazonConfirmedValue: totals.amazonConfirmed,
    cashConfirmedValue: totals.cashConfirmed,
    closedValue: totals.closed,
    rejectedValue: totals.rejected,
    totalCustomerValue: totals.cashConfirmed,
    counts,
    openIssues,
    closedIssues,
    byState: rows,
  };
}

const ONBOARDING_STEPS = [
  { key: 'account_created', label: 'Account created' },
  { key: 'settlement_uploaded', label: 'First settlement uploaded' },
  { key: 'audit_completed', label: 'Audit completed' },
  { key: 'issue_found', label: 'First issue found' },
  { key: 'evidence_reviewed', label: 'Evidence reviewed' },
  { key: 'action_completed', label: 'First action completed' },
];

// Onboarding progress derived only from real product activity.
function onboardingStatus(workspaceId) {
  const audits = db.get(
    'SELECT COUNT(*) AS n FROM audits WHERE workspace_id = ?',
    [workspaceId],
  ).n;
  const completed = db.get(
    "SELECT COUNT(*) AS n FROM audits WHERE workspace_id = ? AND status = 'completed'",
    [workspaceId],
  ).n;
  const findings = db.get(
    "SELECT COUNT(*) AS n FROM findings f JOIN audits a ON a.id = f.audit_id WHERE a.workspace_id = ?",
    [workspaceId],
  ).n;
  const advanced = db.get(
    "SELECT COUNT(*) AS n FROM findings f JOIN audits a ON a.id = f.audit_id WHERE a.workspace_id = ? AND f.recovery_state != 'POTENTIAL'",
    [workspaceId],
  ).n;
  const sellerActions = db.get(
    "SELECT COUNT(*) AS n FROM finding_events WHERE workspace_id = ? AND actor = 'seller' AND from_state IS NOT NULL",
    [workspaceId],
  ).n;

  const done = {
    account_created: true,
    settlement_uploaded: audits > 0,
    audit_completed: completed > 0,
    issue_found: findings > 0,
    evidence_reviewed: advanced > 0,
    action_completed: sellerActions > 0,
  };
  const steps = ONBOARDING_STEPS.map((s) => ({ ...s, done: !!done[s.key] }));
  const next = steps.find((s) => !s.done) || null;
  return {
    steps,
    completed: steps.filter((s) => s.done).length,
    total: steps.length,
    nextStep: next,
    complete: !next,
  };
}

// Factual activity signals for lifecycle messaging (no arbitrary scoring).
function healthSignals(workspaceId) {
  const settlements = db.get(
    "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM audits WHERE workspace_id = ? AND status = 'completed'",
    [workspaceId],
  );
  const findings = db.get(
    'SELECT COUNT(*) AS n FROM findings f JOIN audits a ON a.id = f.audit_id WHERE a.workspace_id = ?',
    [workspaceId],
  ).n;
  const resolved = db.get(
    "SELECT COUNT(*) AS n FROM findings f JOIN audits a ON a.id = f.audit_id WHERE a.workspace_id = ? AND f.recovery_state IN ('CASH_CONFIRMED','CLOSED')",
    [workspaceId],
  ).n;
  const value = valueSummary(workspaceId);
  const ent = plans.getEntitlements(workspaceId);
  const last = settlements.last || null;
  return {
    settlementsProcessed: settlements.n,
    findingsDiscovered: findings,
    findingsResolved: resolved,
    valueConfirmed: value.cashConfirmedValue,
    lastSettlementAt: last,
    daysSinceLastActivity: last ? Math.floor((Date.now() - last) / 86400000) : null,
    unresolvedFindings: value.openIssues,
    plan: ent.plan.id,
    onboarding: onboardingStatus(workspaceId),
  };
}

module.exports = {
  STATES, ALLOWED, ACTORS, LABELS, BUCKET,
  isState, canTransition, transition, nextAction, valueSummary,
  onboardingStatus, healthSignals,
};
