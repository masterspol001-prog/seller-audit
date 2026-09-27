'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db');
const storage = require('../storage');
const logger = require('../lib/logger');
const { processAudit } = require('./processAudit');

// Re-runs audits whose background processing failed, up to each job's
// max_attempts. Processing is idempotent: the job clears prior findings for the
// audit before inserting the new set. Returns the number of jobs retried.
function retryFailedAuditJobs(limit = 20) {
  const jobs = db.listFailedAuditJobs(limit);
  let retried = 0;
  for (const job of jobs) {
    if (job.attempts >= job.max_attempts) continue;
    const audit = db.getAudit(job.audit_id);
    if (!audit) continue;
    const ext = path.extname(audit.file_name || '.csv');
    const filePath = storage.finalPath(job.workspace_id, job.audit_id, ext);
    if (!fs.existsSync(filePath)) {
      db.updateAuditJob(job.audit_id, { status: 'dead', last_error: 'Source file is no longer available' });
      continue;
    }
    db.updateAuditJob(job.audit_id, { status: 'queued' });
    logger.info('audit job retry', { auditId: job.audit_id, attempt: job.attempts + 1 });
    processAudit({ auditId: job.audit_id, workspaceId: job.workspace_id, filePath, originalName: audit.file_name || 'retry.csv' });
    retried += 1;
  }
  return retried;
}

module.exports = { retryFailedAuditJobs };
