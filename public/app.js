'use strict';

/* ------------------------------------------------------------------ *
 * SettleProof front end — no build step, talks to the same-origin API.
 * Design rules encoded here:
 *  - never claim Amazon owes money; findings are review prompts
 *  - every finding shows its confidence and its source rows
 *  - missing data is surfaced as "insufficient evidence", not hidden
 * ------------------------------------------------------------------ */

const SESSION_KEY = 'sp_session_token';
const CSRF_KEY = 'sp_csrf_token';

const state = {
  user: null,
  workspaces: [],
  workspaceId: null,
  csrf: null,
  sessionToken: null,
  auditCache: {},
};

function rememberSession(data) {
  if (data && data.csrf) {
    state.csrf = data.csrf;
    try { sessionStorage.setItem(CSRF_KEY, data.csrf); } catch { /* private mode */ }
  }
  if (data && data.sessionToken) {
    state.sessionToken = data.sessionToken;
    try { sessionStorage.setItem(SESSION_KEY, data.sessionToken); } catch { /* private mode */ }
  }
}

function restoreSession() {
  try {
    if (!state.sessionToken) state.sessionToken = sessionStorage.getItem(SESSION_KEY);
    if (!state.csrf) state.csrf = sessionStorage.getItem(CSRF_KEY);
  } catch { /* private mode */ }
}

function forgetSession() {
  state.sessionToken = null;
  state.csrf = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(CSRF_KEY);
  } catch { /* private mode */ }
}

/* ---------- api ---------- */

function csrfFromCookie() {
  const m = document.cookie.match(/(?:^|;\s*)sp_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function apiReq(method, path, body, isForm) {
  restoreSession();
  const headers = {};
  if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json';
  const csrf = state.csrf || csrfFromCookie();
  if (csrf && !['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = csrf;
  if (state.sessionToken) headers['x-session-token'] = state.sessionToken;

  if (state.workspaceId) headers['x-workspace-id'] = state.workspaceId;
  const res = await fetch('/api' + path, {
    method,
    headers,
    credentials: 'same-origin',
    body: isForm ? body : (body !== undefined ? JSON.stringify(body) : undefined),
  });

  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok || (payload && payload.ok === false)) {
    let message = (payload && payload.error && payload.error.message) || `Request failed (${res.status})`;
    if (res.status === 404 && !(payload && payload.error && payload.error.message)) {
      message = 'API not found (404). This host is not running the SettleProof Node server. After unzip run npm install && npm start, or deploy the zip as a Node app (Railway/Render). Static Vercel without vercel.json will 404.';
    }
    err.status = res.status;
    err.code = payload && payload.error && payload.error.code;
    err.payload = payload;
    throw err;
  }
  return payload ? payload.data : null;
}

const api = {
  get: (p) => apiReq('GET', p),
  post: (p, b) => apiReq('POST', p, b),
  patch: (p, b) => apiReq('PATCH', p, b),
  del: (p) => apiReq('DELETE', p),
  put: (p, b) => apiReq('PUT', p, b),
  upload: (p, form) => apiReq('POST', p, form, true),
};

/* ---------- utils ---------- */

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(n, currency) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : null;
  try {
    return new Intl.NumberFormat('en-US', code
      ? { style: 'currency', currency: code, maximumFractionDigits: 2 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  } catch {
    return Number(n).toFixed(2);
  }
}

function pct(n) { return n === null || n === undefined ? '—' : n.toFixed(1) + '%'; }

function dateTime(ts) {
  if (!ts) return '—';
  try { return new Date(Number(ts)).toLocaleString(); } catch { return '—'; }
}

function bytes(n) {
  if (!n) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function sevBadge(s) { return `<span class="badge ${esc(s)}">${esc(String(s).toUpperCase())}</span>`; }
function confBadge(c) {
  const label = c === 'insufficient' ? 'INSUFFICIENT EVIDENCE' : String(c).toUpperCase() + ' CONFIDENCE';
  return `<span class="badge conf-${esc(c)}">${esc(label)}</span>`;
}
function statusBadge(s) { return `<span class="badge status-${esc(s)}">${esc(String(s).toUpperCase())}</span>`; }

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function toast(message, kind = 'info') {
  const view = document.getElementById('view');
  const box = el(`<div class="alert ${kind}">${esc(message)}</div>`);
  view.prepend(box);
  setTimeout(() => box.remove(), 6000);
}

let routeToken = 0;

/* ---------- shell ---------- */

function currentWorkspace() {
  return state.workspaces.find((w) => w.id === state.workspaceId) || state.workspaces[0] || null;
}

function renderChrome(route) {
  const nav = document.getElementById('nav');
  const actions = document.getElementById('authActions');

  if (state.user) {
    nav.innerHTML = [
      ['#/app', 'Dashboard'],
      ['#/app/upload', 'New audit'],
      ['#/app/history', 'History'],
      ['#/app/findings', 'Findings'],
      ['#/app/cogs', 'Product costs'],
      ['#/app/value', 'Value report'],
      ['#/app/plans', 'Plans'],
    ].map(([href, label]) => `<a href="${href}" class="${route.startsWith(href.replace('#', '')) && href !== '#/app' ? 'active' : (href === '#/app' && route === '/app' ? 'active' : '')}">${esc(label)}</a>`).join('');
    actions.innerHTML = `<span class="muted small nowrap">${esc(state.user.email)}</span>
      <button class="btn small ghost" id="logoutBtn">Sign out</button>`;
    document.getElementById('logoutBtn').addEventListener('click', async () => {
      try { await api.post('/auth/logout'); } catch { /* ignore */ }
      state.user = null; state.workspaces = []; state.workspaceId = null;
      forgetSession();
      location.hash = '#/';
      await boot();
    });
  } else {
    nav.innerHTML = [
      ['#/how', 'How it works'],
      ['#/trust', 'Trust &amp; limitations'],
      ['#/pricing', 'Pricing'],
    ].map(([href, label]) => `<a href="${href}">${label}</a>`).join('');
    actions.innerHTML = `<a class="btn small ghost" href="#/login">Sign in</a>
      <a class="btn small primary" href="#/signup">Start $10</a>`;
  }
}

/* ---------- views: marketing ---------- */

function viewLanding() {
  return `
    <section class="hero">
      <span class="pill">$10 / month · worldwide Amazon sellers</span>
      <h1>Stop guessing. Upload a settlement. See what is actually worth a claim.</h1>
      <p class="lead">Most “refund finder” ads lie. SettleProof does not. It reads your Amazon settlement,
      transaction and inventory reports, then ranks fee errors, duplicate charges and inventory write-offs
      with the exact source rows. If the file cannot prove it, we say <em>insufficient evidence</em> — not
      “you got $100k back”.</p>
      <div class="row mt">
        <a class="btn primary" href="#/signup">Audit a report — $10</a>
        <button class="btn" id="demoBtn">See a live sample first</button>
      </div>
      <p class="muted small mt">Two free audits. Then $10/month unlimited. One-off report also $10. You keep 100% of anything Amazon pays you.</p>
      <div class="trust mt">We never say Amazon owes you money. If the evidence is not in the file, we say so.</div>
    </section>

    <div class="grid c3">
      <div class="stat">
        <div class="k">Price</div>
        <div class="v">$10</div>
        <div class="sub">Monthly unlimited, or one report. No cut of recoveries.</div>
      </div>
      <div class="stat">
        <div class="k">What you get</div>
        <div class="v">Evidence</div>
        <div class="sub">Source rows, confidence, and the next step to take.</div>
      </div>
      <div class="stat">
        <div class="k">What we never do</div>
        <div class="v">Guess</div>
        <div class="sub">No invented refunds. Cash only counts when you confirm it.</div>
      </div>
    </div>

    <div class="grid c3 mt">
      <div class="card">
        <h3>1. Upload a report</h3>
        <p class="muted">Drop in a settlement, transaction or inventory report. CSV, TSV or Excel. No Amazon login required.</p>
      </div>
      <div class="card">
        <h3>2. Get ranked findings</h3>
        <p class="muted">Each finding has severity, confidence, the math, and the exact rows behind it.</p>
      </div>
      <div class="card">
        <h3>3. Claim only what you can defend</h3>
        <p class="muted">Open the evidence, then decide what to raise with Amazon. We do not file claims for you.</p>
      </div>
    </div>

    <div class="card mt">
      <div class="between">
        <div>
          <h3>What we check</h3>
          <p class="muted small">Rules run automatically on every upload. Nothing is asserted that the file does not support.</p>
        </div>
      </div>
      <div class="grid c2 mt-s">
        <ul class="muted small">
          <li>Report rows that do not add up to their own total</li>
          <li>Settlement rows vs the stated settlement total</li>
          <li>Duplicate-looking charges and credits</li>
          <li>Sales with no matching referral fee row</li>
          <li>Referral fees outside the expected band</li>
          <li>Refunds with no matching sale in the file</li>
        </ul>
        <ul class="muted small">
          <li>Inventory deductions that may be reimbursable</li>
          <li>Storage fees far above the file median</li>
          <li>Removals with non-positive quantities</li>
          <li>Aged / long-term inventory charges</li>
          <li>Settlements mixing more than one currency</li>
          <li>SKUs that sold at a loss once fees are applied</li>
        </ul>
      </div>
    </div>
  `;
}

function viewHow() {
  return `
    <section class="hero" style="padding-bottom:10px">
      <h1>How SettleProof works</h1>
      <p class="lead">Three steps: bring a report, read the findings, verify the evidence.</p>
    </section>
    <div class="card steps">
      <div class="step"><div class="n">1</div><div>
        <h3>Upload</h3>
        <p class="muted">We detect the encoding, delimiter and column layout of your file, then normalise it.
        Files are kept only as long as your retention window and are tied to your account.</p>
      </div></div>
      <div class="step"><div class="n">2</div><div>
        <h3>Audit</h3>
        <p class="muted">A set of rules runs against the normalised rows. Each rule only fires when the data
        supports it, and every finding keeps a reference to the source row numbers and the raw row content.</p>
      </div></div>
      <div class="step"><div class="n">3</div><div>
        <h3>Review</h3>
        <p class="muted">Findings are ranked by severity and confidence. Add a status to each one as you work
        through them, and export the list when you open a case with Amazon.</p>
      </div></div>
    </div>
    <div class="card">
      <h3>What makes the numbers trustworthy</h3>
      <p class="muted">Confidence is shown on every finding. High confidence means the file states the fact.
      Medium means the pattern is suggestive but could be legitimate. Low means it is a prompt to check.
      Insufficient evidence means we deliberately decline to draw a conclusion. Product-cost profit is only
      labelled reliable when you have provided COGS for that SKU.</p>
    </div>
  `;
}

function viewTrust() {
  return `
    <section class="hero" style="padding-bottom:10px">
      <h1>Trust &amp; limitations</h1>
      <p class="lead">A tool that overstates its findings is worse than no tool. These are the boundaries.</p>
    </section>
    <div class="card">
      <h3>What SettleProof does not do</h3>
      <ul class="muted">
        <li>It does not tell you that Amazon owes you a specific amount. It tells you what to check.</li>
        <li>It cannot see data that is not in the file you uploaded. Missing data is reported as a gap.</li>
        <li>It does not connect to your Amazon account and makes no external requests on your behalf.</li>
        <li>It does not file claims with Amazon. Decisions and submissions stay with you.</li>
      </ul>
    </div>
    <div class="card">
      <h3>How amounts are shown</h3>
      <p class="muted"><span class="strong">Recoverable</span> is reserved for amounts the file itself proves
      were charged in error. In practice this stays near zero — that is intentional, not a bug.</p>
      <p class="muted"><span class="strong">Flagged for review</span> is the sum of values worth investigating.
      It is not a claim and should never be treated as money owed.</p>
    </div>
    <div class="card">
      <h3>Your data</h3>
      <ul class="muted">
        <li>Uploads are scoped to your workspace and only readable by your session.</li>
        <li>Files are deleted automatically after your retention window (default 30 days).</li>
        <li>You can delete any audit and its file at any time from the audit page.</li>
      </ul>
    </div>
  `;
}

function viewPricing() {
  return `
    <section class="hero" style="padding-bottom:10px">
      <h1>Simple global pricing</h1>
      <p class="lead">$10 to run this as a seller. No cut of recoveries — because we cannot honestly claim them until cash is confirmed.</p>
    </section>
    <div class="grid c3">
      <div class="card">
        <h3>Free</h3>
        <div class="price">$0</div>
        <p class="muted small">Prove it on your own file before you pay.</p>
        <ul class="muted small">
          <li>2 audits per month</li>
          <li>Every finding, unfiltered</li>
          <li>Evidence and source rows</li>
          <li>CSV export · 14-day retention</li>
        </ul>
        <a class="btn primary" href="#/signup">Create account</a>
      </div>
      <div class="card" style="border-color:var(--brand)">
        <h3>Seller</h3>
        <div class="price">$10<span>/mo</span></div>
        <p class="muted small">The offer. Unlimited audits for Amazon sellers worldwide.</p>
        <ul class="muted small">
          <li>Unlimited audits</li>
          <li>Product-cost profit per SKU</li>
          <li>JSON &amp; settlement exports</li>
          <li>365-day retention · 2 seats · priority support</li>
        </ul>
        <a class="btn primary" href="#/signup">Start at $10/mo</a>
      </div>
      <div class="card">
        <h3>Accountant</h3>
        <div class="price">$29<span>/mo</span></div>
        <p class="muted small">For bookkeepers managing several seller accounts.</p>
        <ul class="muted small">
          <li>Everything in Seller</li>
          <li>10 workspaces · 10 seats</li>
          <li>Settlement summary export</li>
          <li>730-day retention · priority support</li>
        </ul>
        <a class="btn" href="#/signup">Start free</a>
      </div>
    </div>
    <div class="card mt">
      <h3>Prefer to pay once?</h3>
      <p class="muted small">A single settlement audit is $10. No subscription, no lock-in, same evidence-first
      findings. We never charge a percentage of your recovery because we cannot verify what Amazon actually pays you.</p>
    </div>
    <p class="muted small mt">Plans billed in USD. Cancel any time. Your data stays exportable.</p>
  `;
}

/* ---------- views: auth ---------- */

function viewAuth(mode) {
  const isSignup = mode === 'signup';
  return `
    <div class="card mt" style="max-width:460px;margin:40px auto 0">
      <h2>${isSignup ? 'Create your account' : 'Sign in'}</h2>
      <p class="muted small">${isSignup ? 'Free to start. No credit card.' : 'Welcome back.'}</p>
      <div id="authError"></div>
      <form id="authForm">
        ${isSignup ? `
          <label for="name">Name</label>
          <input id="name" name="name" autocomplete="name" placeholder="Jane Seller">
        ` : ''}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required minlength="8"
          autocomplete="${isSignup ? 'new-password' : 'current-password'}" placeholder="At least 8 characters">
        <div class="mt">
          <button class="btn primary" type="submit" style="width:100%">${isSignup ? 'Create account' : 'Sign in'}</button>
        </div>
      </form>
      <p class="muted small mt">
        ${isSignup ? 'Already have an account? <a href="#/login">Sign in</a>' : 'New here? <a href="#/signup">Create an account</a>'}
      </p>
      ${isSignup ? '<p class="muted tiny">By creating an account you agree to use the tool only on data you are entitled to process.</p>' : ''}
    </div>
  `;
}

function mountAuth(mode) {
  const form = document.getElementById('authForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const errorBox = document.getElementById('authError');
    errorBox.innerHTML = '';
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Working';
    try {
      const payload = {
        email: form.email.value,
        password: form.password.value,
      };
      if (mode === 'signup') {
        payload.name = form.name.value;
        const ref = new URLSearchParams((location.hash.split('?')[1] || '')).get('ref');
        if (ref) payload.ref = ref;
      }
      const data = await api.post(mode === 'signup' ? '/auth/signup' : '/auth/login', payload);
      rememberSession(data);
      state.user = data.user;
      state.workspaces = data.workspaces || (data.workspace ? [data.workspace] : []);
      state.workspaceId = state.workspaces[0] ? state.workspaces[0].id : null;
      location.hash = '#/app';
      await boot();
    } catch (err) {
      const hint = err.status === 401
        ? 'Incorrect email or password. Use demo@settleproof.app / password123, or create an account.'
        : err.status === 404
          ? err.message
          : err.message;
      errorBox.innerHTML = `<div class="alert error">${esc(hint)}</div>`;
      btn.disabled = false; btn.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    }
  });
}

/* ---------- views: dashboard ---------- */

async function viewDashboard() {
  const ws = currentWorkspace();
  if (!ws) return emptyWorkspaces();
  const d = await api.get(`/workspaces/${ws.id}/dashboard`);
  const t = d.totals;
  return `
    <div class="between mt">
      <div>
        <h1 style="margin-bottom:2px">Dashboard</h1>
        <p class="muted small">${esc(ws.name)}${ws.role ? ' · ' + esc(ws.role) : ''}
        ${d.entitlements ? ' · ' + (d.entitlements.unlimited ? 'unlimited audits' : ((d.entitlements.remainingAudits ?? d.entitlements.remaining) + ' audit(s) left')) : ''}</p>
      </div>
      <div class="row">
        <button class="btn" id="demoAuditBtn">Load sample audit</button>
        <a class="btn primary" href="#/app/upload">New audit</a>
      </div>
    </div>
    ${d.entitlements && !d.entitlements.unlimited && (d.entitlements.remainingAudits ?? d.entitlements.remaining) <= 0 ? `
      <div class="alert warn mt">Free audits used. Pay $10 for one more report, or $10/month unlimited. <a href="#/app/plans">Unlock now</a></div>` : ''}

    <div class="grid c4 mt">
      <div class="stat"><div class="k">Audits</div><div class="v">${t.audits}</div><div class="sub">${t.processing} processing · ${t.failed} failed</div></div>
      <div class="stat"><div class="k">Findings</div><div class="v">${t.findings}</div><div class="sub">across completed audits</div></div>
      <div class="stat"><div class="k">Recoverable</div><div class="v">${money(t.recoverable)}</div><div class="sub">file-proven errors only</div></div>
      <div class="stat"><div class="k">High severity</div><div class="v">${(d.bySeverity.high || 0) + (d.bySeverity.critical || 0)}</div><div class="sub">review first</div></div>
    </div>

    ${d.nextAction ? `
      <div class="card mt next-action">
        <div class="between">
          <div>
            <div class="muted tiny">NEXT ACTION</div>
            <div class="lead" style="margin:4px 0 2px">${esc(d.nextAction.label || d.nextAction.title)}</div>
            <p class="muted small" style="margin:0">Highest-priority open finding: <span class="strong">${esc(d.nextAction.title)}</span> (${esc(d.nextAction.severity || 'info')})</p>
          </div>
          <a class="btn primary" href="#/app/audit/${esc(d.nextAction.auditId)}">Open it</a>
        </div>
      </div>` : ''}

    ${d.value ? `
      <div class="card mt">
        <div class="between">
          <h3 style="margin:0">Recovery pipeline</h3>
          <a class="btn small" href="#/app/value">Value report</a>
        </div>
        <p class="muted small mt-s" style="margin:0">Value only counts as revenue to you when the money was actually received — cash confirmed. Everything before that is still potential.</p>
        <div class="grid c4 mt-s">
          <div class="stat"><div class="k">Potential</div><div class="v">${money(d.value.potentialValue, d.value.currencies)}</div><div class="sub">${d.value.counts.potential || 0} open finding(s)</div></div>
          <div class="stat"><div class="k">Submitted</div><div class="v">${money(d.value.submittedValue, d.value.currencies)}</div><div class="sub">${d.value.counts.submitted || 0} with Amazon</div></div>
          <div class="stat"><div class="k">Amazon confirmed</div><div class="v">${money(d.value.amazonConfirmedValue, d.value.currencies)}</div><div class="sub">${d.value.counts.amazonConfirmed || 0} awaiting cash</div></div>
          <div class="stat"><div class="k">Cash confirmed</div><div class="v">${money(d.value.cashConfirmedValue, d.value.currencies)}</div><div class="sub">${d.value.counts.cashConfirmed || 0} paid to you</div></div>
        </div>
      </div>` : ''}

    ${d.onboarding && !d.onboarding.complete ? `
      <div class="card mt">
        <div class="between">
          <h3 style="margin:0">Getting started</h3>
          <span class="muted small">${d.onboarding.completed} of ${d.onboarding.total}</span>
        </div>
        <div class="progress det mt-s"><i style="width:${Math.round((d.onboarding.completed / d.onboarding.total) * 100)}%"></i></div>
        <ul class="checklist mt-s">
          ${d.onboarding.steps.map((s) => `<li class="${s.done ? 'done' : ''}"><span class="tick">${s.done ? '✓' : '○'}</span> ${esc(s.label)}</li>`).join('')}
        </ul>
        ${d.onboarding.nextStep ? `<p class="muted small" style="margin:0">Next: <span class="strong">${esc(d.onboarding.nextStep.label)}</span></p>` : ''}
      </div>` : ''}

    ${(d.recentActivity && d.recentActivity.length) ? `
      <div class="card mt">
        <h3>Recent activity</h3>
        <ul class="activity">
          ${d.recentActivity.map((e) => `
            <li>
              <span class="badge state-${esc(String(e.to_state || '').toLowerCase())}">${esc((STATE_LABEL[e.to_state] || [e.to_state || ''])[0])}</span>
              <span class="small">${esc(e.title || 'Finding')}</span>
              <span class="muted tiny">${esc(e.actor || 'system')} · ${dateTime(e.created_at)}</span>
            </li>`).join('')}
        </ul>
      </div>` : ''}

    ${d.audits.length ? `
      <div class="card mt">
        <h3>Recent audits</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Status</th><th>Period</th><th>Rows</th><th>Findings</th><th>Created</th></tr></thead>
            <tbody>
              ${d.audits.map((a) => `
                <tr>
                  <td><a href="#/app/audit/${esc(a.id)}">${esc(a.name)}</a></td>
                  <td>${statusText(a.status)}</td>
                  <td class="nowrap small">${esc(a.period_start || '—')} → ${esc(a.period_end || '—')}</td>
                  <td>${a.row_count ?? '—'}</td>
                  <td>${a.findings_count ?? 0}</td>
                  <td class="small muted nowrap">${dateTime(a.created_at)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>` : `
      <div class="card mt">
        <h3>No audits yet</h3>
        <p class="muted">Upload a settlement report to get your first findings, or load the sample to see how it works.</p>
      </div>`}
  `;
}

function statusText(s) {
  if (s === 'completed') return '<span class="badge conf-high">COMPLETED</span>';
  if (s === 'processing') return '<span class="badge low">PROCESSING</span>';
  if (s === 'failed') return '<span class="badge critical">FAILED</span>';
  return `<span class="badge info">${esc(String(s).toUpperCase())}</span>`;
}

function emptyWorkspaces() {
  return `<div class="card mt">
    <h2>No workspace</h2>
    <p class="muted">Something went wrong setting up your workspace.</p>
    <button class="btn primary" id="newWorkspaceBtn">Create a workspace</button>
  </div>`;
}

/* ---------- views: upload ---------- */

function viewUpload() {
  return `
    <h1 class="mt">New audit</h1>
    <p class="muted">Upload an Amazon settlement report, transaction report or inventory report.</p>
    <div class="card">
      <div id="uploadError"></div>
      <div class="drop" id="drop">
        <div class="big">Drop your report here</div>
        <p class="muted small">or click to choose a file — CSV, TSV, TXT or Excel (.xlsx)</p>
        <input type="file" id="fileInput" accept=".csv,.tsv,.txt,.xlsx,.xls" class="hidden">
      </div>
      <div id="fileMeta" class="muted small mt-s"></div>
      <label for="auditName">Audit name (optional)</label>
      <input id="auditName" placeholder="e.g. July 2026 settlement">
      <div class="row mt">
        <button class="btn primary" id="uploadBtn" disabled>Run audit</button>
        <button class="btn" id="demoAuditBtn2">Use sample data instead</button>
      </div>
      <div id="uploadProgress" class="mt hidden">
        <div class="progress"><i></i></div>
        <p class="muted small mt-s" id="progressText">Uploading…</p>
      </div>
    </div>
    <div class="card">
      <h3>Where do I get this file?</h3>
      <p class="muted small">In Seller Central go to Reports → Payments → Settlement reports (or
      Reports → Fulfilment → Inventory reports for inventory data), download the report for the period you
      want to check, and upload it here unchanged.</p>
    </div>
  `;
}

function mountUpload() {
  const drop = document.getElementById('drop');
  const input = document.getElementById('fileInput');
  const meta = document.getElementById('fileMeta');
  const btn = document.getElementById('uploadBtn');
  let file = null;

  const setFile = (f) => {
    file = f;
    btn.disabled = !f;
    meta.textContent = f ? `${f.name} · ${bytes(f.size)}` : '';
  };

  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => setFile(input.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });

  btn.addEventListener('click', () => runUpload(file, document.getElementById('auditName').value));
  const demo2 = document.getElementById('demoAuditBtn2');
  if (demo2) demo2.addEventListener('click', runSampleAudit);
}

async function runUpload(file, name) {
  if (!file) return;
  const ws = currentWorkspace();
  const errBox = document.getElementById('uploadError');
  const prog = document.getElementById('uploadProgress');
  const text = document.getElementById('progressText');
  errBox.innerHTML = '';
  prog.classList.remove('hidden');
  text.textContent = 'Uploading…';
  document.getElementById('uploadBtn').disabled = true;

  const form = new FormData();
  form.append('file', file);
  if (name) form.append('name', name);

  try {
    const data = await api.upload(`/workspaces/${ws.id}/audits`, form);
    if (data.duplicate) {
      text.textContent = 'This exact file was already audited — opening the existing result.';
      location.hash = `#/app/audit/${data.audit.id}`;
      return;
    }
    text.textContent = 'Reading the report…';
    await pollAudit(ws.id, data.audit.id, text);
    location.hash = `#/app/audit/${data.audit.id}`;
  } catch (err) {
    prog.classList.add('hidden');
    document.getElementById('uploadBtn').disabled = false;
    errBox.innerHTML = upgradeCard(err) || `<div class="alert error">${esc(err.message)}</div>`;
  }
}

async function runSampleAudit() {
  const ws = currentWorkspace();
  if (!ws) return;
  try {
    const data = await api.post(`/workspaces/${ws.id}/audits/demo`);
    location.hash = `#/app/audit/${data.audit.id}`;
  } catch (err) {
    const errBox = document.getElementById('uploadError');
    if (errBox) errBox.innerHTML = upgradeCard(err) || `<div class="alert error">${esc(err.message)}</div>`;
    else toast(err.message, 'error');
  }
}

async function pollAudit(wsId, auditId, textEl) {
  for (let i = 0; i < 60; i++) {
    const s = await api.get(`/workspaces/${wsId}/audits/${auditId}/status`);
    if (textEl) textEl.textContent = s.status === 'processing' ? 'Auditing rows…' : 'Done.';
    if (s.status === 'completed') return s;
    if (s.status === 'failed') throw new Error(s.error || 'The audit failed.');
    await new Promise((r) => setTimeout(r, 900));
  }
  throw new Error('Timed out waiting for the audit to finish.');
}

/* ---------- views: history ---------- */

async function viewHistory() {
  const ws = currentWorkspace();
  if (!ws) return emptyWorkspaces();
  const data = await api.get(`/workspaces/${ws.id}/audits?limit=100`);
  if (!data.audits.length) {
    return `<h1 class="mt">History</h1><div class="card"><p class="muted">No audits yet.</p><a class="btn primary" href="#/app/upload">New audit</a></div>`;
  }
  return `
    <h1 class="mt">History</h1>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Status</th><th>Marketplace</th><th>Period</th><th>Rows</th><th>Findings</th><th></th></tr></thead>
        <tbody>
          ${data.audits.map((a) => `
            <tr>
              <td><a href="#/app/audit/${esc(a.id)}">${esc(a.name)}</a><div class="tiny muted">${esc(a.fileName || '')}</div></td>
              <td>${statusText(a.status)}</td>
              <td class="small">${esc(a.marketplace || '—')}</td>
              <td class="small nowrap">${esc(a.periodStart || '—')} → ${esc(a.periodEnd || '—')}</td>
              <td>${a.rowCount ?? '—'}</td>
              <td>${a.findingsCount ?? 0}</td>
              <td><button class="btn small danger" data-del="${esc(a.id)}">Delete</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function mountHistory() {
  document.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Delete this audit and its uploaded file?')) return;
      const ws = currentWorkspace();
      try {
        await api.del(`/workspaces/${ws.id}/audits/${b.dataset.del}`);
        await render();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

/* ---------- views: product costs ---------- */

async function viewCogs() {
  const ws = currentWorkspace();
  if (!ws) return emptyWorkspaces();
  const data = await api.get(`/workspaces/${ws.id}/cogs`);
  const lines = data.cogs.map((c) => `${c.sku},${c.unitCost}`).join('\n');
  return `
    <h1 class="mt">Product costs</h1>
    <p class="muted">Add cost of goods per SKU so profit figures reflect product cost, not just fees.
    Use one <span class="mono">SKU,unit cost</span> pair per line.</p>
    <div class="card">
      <div id="cogsError"></div>
      <label for="cogsText">SKU costs</label>
      <textarea id="cogsText" spellcheck="false" placeholder="SKU-RED,6.50&#10;SKU-MUG,4.00">${esc(lines)}</textarea>
      <div class="row mt">
        <button class="btn primary" id="saveCogs">Save costs</button>
        <span class="muted small" id="cogsCount">${data.cogs.length} SKU(s) with costs</span>
      </div>
    </div>
    <div class="card">
      <h3>Why this matters</h3>
      <p class="muted small">Without COGS we can still flag a SKU that loses money after fees, but we label it
      low confidence. With COGS the profit number becomes reliable for that SKU.</p>
    </div>
  `;
}

function mountCogs() {
  const btn = document.getElementById('saveCogs');
  btn.addEventListener('click', async () => {
    const ws = currentWorkspace();
    const errBox = document.getElementById('cogsError');
    errBox.innerHTML = '';
    const raw = document.getElementById('cogsText').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const entries = [];
    for (const [i, line] of raw.entries()) {
      const parts = line.split(',');
      if (parts.length < 2) {
        errBox.innerHTML = `<div class="alert error">Line ${i + 1} should be "SKU,cost".</div>`;
        return;
      }
      const sku = parts[0].trim();
      const cost = Number(parts.slice(1).join('').trim());
      if (!sku || !Number.isFinite(cost) || cost < 0) {
        errBox.innerHTML = `<div class="alert error">Line ${i + 1} has an invalid SKU or cost.</div>`;
        return;
      }
      entries.push({ sku, unitCost: cost });
    }
    if (!entries.length) {
      errBox.innerHTML = `<div class="alert error">Add at least one SKU,cost line.</div>`;
      return;
    }
    btn.disabled = true;
    try {
      const res = await api.put(`/workspaces/${ws.id}/cogs`, { entries });
      document.getElementById('cogsCount').textContent = `${res.cogs.length} SKU(s) with costs`;
      toast(`Saved costs for ${res.saved} SKU(s). Re-run an audit to apply them.`, 'ok');
    } catch (err) {
      errBox.innerHTML = upgradeCard(err) || `<div class="alert error">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------- views: value report ---------- */

function upgradeCard(err) {
  if (!err || err.status !== 402) return '';
  const d = (err.payload && err.payload.error && err.payload.error.details) || {};
  const monthly = d.price != null ? money(d.price, d.currency || 'USD') : '$10';
  const report = d.reportPrice != null ? money(d.reportPrice, d.currency || 'USD') : '$10';
  return `<div class="alert error">
    <div>${esc(err.message)}</div>
    <div class="row mt-s">
      <a class="btn primary small" href="#/app/plans">Pay ${esc(report)} for one report</a>
      <a class="btn small" href="#/app/plans">Unlimited · ${esc(monthly)}/mo</a>
    </div>
  </div>`;
}

async function viewFindingsList() {
  const ws = currentWorkspace();
  if (!ws) return emptyWorkspaces();
  const d = await api.get(`/workspaces/${ws.id}/findings?limit=200`);
  const findings = d.findings || [];
  state._findings = findings;
  const open = findings.filter((f) => !['CLOSED', 'CASH_CONFIRMED', 'REJECTED', 'EXPIRED'].includes(f.recovery_state)).length;
  const cash = findings.filter((f) => f.recovery_state === 'CASH_CONFIRMED').length;
  return `
    <div class="between mt">
      <div>
        <h1 style="margin-bottom:2px">Findings</h1>
        <p class="muted small">Every issue across all your audits, with its evidence and recovery state. ${open} open · ${cash} cash confirmed.</p>
      </div>
      <a class="btn primary" href="#/app/upload">New audit</a>
    </div>
    ${renderFindings(findings)}
  `;
}

async function viewValue() {
  const ws = currentWorkspace();
  if (!ws) return emptyWorkspaces();
  const v = await api.get(`/workspaces/${ws.id}/value`);
  const t = v.totals;
  const m = v.thisMonth;

  return `
    <div class="between mt">
      <div>
        <h1 style="margin-bottom:2px">Value report</h1>
        <p class="muted small">${esc(ws.name)} · ${esc(v.plan.label)} plan · ${v.remaining === null ? 'unlimited audits' : `${v.used} of ${v.remaining + v.used} audits used this month`}</p>
      </div>
      <a class="btn primary" href="#/app/upload">Upload a settlement</a>
    </div>

    <div class="card mt">
      <p class="lead" style="margin:0">${esc(v.headline)}</p>
      <p class="muted small mt-s">A recovery is only counted here when your own uploaded file contains the reimbursement
      that closes the loop on an earlier finding — never an estimate.</p>
    </div>

    <div class="grid c3 mt">
      <div class="stat"><div class="k">Tracked recoveries</div><div class="v">${money(t.recovered, t.currency)}</div><div class="sub">${t.entries} ledger entr${t.entries === 1 ? 'y' : 'ies'}</div></div>
      <div class="stat"><div class="k">This month</div><div class="v">${money(m.amount, t.currency)}</div><div class="sub">${esc(m.monthName || 'no entries yet')}</div></div>
      <div class="stat"><div class="k">Return on plan</div><div class="v">${m.roi === null ? '—' : m.roi.toFixed(1) + 'x'}</div><div class="sub">${m.planPrice ? `${esc(m.planCurrency || '')} ${m.planPrice}/mo plan` : 'on the free plan'}</div></div>
    </div>

    ${v.resolutions.length ? `
      <div class="card mt">
        <h3>Resolved findings</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Detected</th><th>How</th><th>Amount</th><th>Source</th></tr></thead>
            <tbody>
              ${v.resolutions.map((r) => `
                <tr>
                  <td class="small nowrap">${dateTime(r.detected_at)}</td>
                  <td>${r.kind === 'auto_detected' ? '<span class="badge conf-high">AUTO IN FILE</span>' : '<span class="badge low">SELLER CONFIRMED</span>'}</td>
                  <td>${money(r.recovered_amount, r.currency)}</td>
                  <td class="small muted">${esc(r.detected_source || '—')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>` : `
      <div class="card mt">
        <h3>No recoveries detected yet</h3>
        <p class="muted">Keep uploading each settlement. When a later file reimburses something we flagged,
        it appears here automatically and your value report updates.</p>
      </div>`}

    <div class="card mt">
      <h3>Refer a seller</h3>
      <p class="muted small">Share your code. When someone signs up with it and activates a paid plan,
      you get ${esc(v.referral && v.referral.creditRate ? String(v.referral.creditRate) : 'a')} in account credit.
      You have referred ${v.referral ? v.referral.signedUp || 0 : 0} seller(s), ${v.referral ? v.referral.activated || 0 : 0} activated.</p>
      <div class="row mt-s">
        <input id="refCode" class="mono" value="${esc(v.referralCode)}" readonly>
        <button class="btn" id="copyRef">Copy code</button>
      </div>
      <div class="row mt-s">
        <input id="refLink" class="mono" value="${esc(location.origin)}/#/signup?ref=${esc(v.referralCode)}" readonly>
        <button class="btn" id="copyRefLink">Copy link</button>
      </div>
    </div>
  `;
}

function mountValue() {
  const copy = async (inputId, label) => {
    try {
      await navigator.clipboard.writeText(document.getElementById(inputId).value);
      toast(`${label} copied.`, 'ok');
    } catch { toast('Copy failed — select the text and copy manually.', 'error'); }
  };
  const btn = document.getElementById('copyRef');
  if (btn) btn.addEventListener('click', () => copy('refCode', 'Referral code'));
  const link = document.getElementById('copyRefLink');
  if (link) link.addEventListener('click', () => copy('refLink', 'Referral link'));
}

/* ---------- views: plans & billing ---------- */

async function viewPlans() {
  const ws = currentWorkspace();
  if (!ws) return emptyWorkspaces();
  const [catalog, planState] = await Promise.all([
    api.get('/billing/catalog'),
    api.get(`/workspaces/${ws.id}/value`),
  ]);
  const currentId = planState.plan.id;
  const provider = catalog.provider;

  return `
    <h1 class="mt">Plans</h1>
    <p class="muted">Findings are always free to view. Paid plans add more audits, product costs,
    longer retention and every export format — they never hide an issue from you.</p>

    <div class="card mt-s">
      <p class="muted small" style="margin:0">You are on the <span class="strong">${esc(planState.plan.label)}</span> plan.
      ${planState.remaining === null ? 'Audits are unlimited.' : `${planState.used} of ${planState.used + planState.remaining} free audits used this month.`}
      ${planState.reportCredits ? ` ${planState.reportCredits} prepaid report credit(s) left.` : ''}
      ${provider === 'manual' ? ' Card checkout is not configured yet — in this environment you can complete a test payment so the rest of the product works.' : ' Checkout opens the payment page.'}</p>
    </div>

    <div class="grid ${catalog.plans.length >= 3 ? 'c3' : 'c2'} mt">
      ${catalog.plans.map((p) => `
        <div class="card ${p.id === currentId ? 'featured' : ''}">
          <h3 style="margin-bottom:2px">${esc(p.label)}${p.id === currentId ? ' <span class="badge conf-high">CURRENT</span>' : ''}</h3>
          <p class="lead" style="margin:6px 0">${p.price === 0 ? 'Free' : money(p.price, p.currency) + '<span class="muted small">/mo</span>'}</p>
          <ul class="muted small" style="line-height:1.7;padding-left:18px">
            <li>${p.auditsPerMonth === null ? 'Unlimited audits' : `${p.auditsPerMonth} audits per month`}</li>
            <li>${p.cogs ? 'Product costs &amp; profitability' : 'Fees analysis only'}</li>
            <li>${p.retentionDays}-day file retention</li>
            <li>Exports: ${p.exports.join(', ').toUpperCase()}</li>
            <li>${p.workspaces} workspace(s), ${p.seats} seat(s)</li>
            <li>${esc(p.support)} support</li>
          </ul>
          ${p.id === currentId || p.price === 0 ? '' : `<button class="btn primary" data-plan="${esc(p.id)}">Choose ${esc(p.label)}</button>`}
        </div>`).join('')}
    </div>

    <div class="card mt">
      <h3>One-off report</h3>
      <p class="muted small">Do not want a subscription? Pay once for a single settlement audit:
      ${money(catalog.reportPrice.amount, catalog.reportPrice.currency)}.</p>
      <button class="btn" data-kind="report" data-plan="seller">Buy a single report</button>
    </div>

    <div id="checkoutBox" class="mt"></div>
  `;
}

function mountPlans() {
  const box = document.getElementById('checkoutBox');
  const ws = currentWorkspace();
  document.querySelectorAll('[data-plan],[data-kind]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.kind || 'plan';
      const plan = btn.dataset.plan || 'seller';
      box.innerHTML = '<div class="card"><p class="muted">Starting checkout…</p></div>';
      try {
        const data = await api.post('/billing/checkout', { workspaceId: ws.id, kind, plan });
        if ((data.provider === 'razorpay' || data.provider === 'stripe') && data.url) {
          window.location.href = data.url;
          return;
        }
        box.innerHTML = `<div class="card">
          <h3>Payment</h3>
          <p class="muted small">${esc(data.instructions)}</p>
          <p class="mono small">Reference: ${esc(data.reference)} · Amount: ${money(data.amount, data.currency)}</p>
          ${data.simulate ? `<button class="btn primary mt-s" id="confirmPay" data-payment="${esc(data.paymentId)}">Mark ${money(data.amount, data.currency)} paid (test)</button>
            <p class="muted tiny">Test only. In production this button is gone and Stripe/Razorpay confirms the charge.</p>` : '<p class="muted small">Your access unlocks when payment is confirmed.</p>'}
        </div>`;
        const confirmBtn = document.getElementById('confirmPay');
        if (confirmBtn) {
          confirmBtn.addEventListener('click', async () => {
            confirmBtn.disabled = true;
            try {
              const done = await api.post('/billing/confirm', { workspaceId: ws.id, paymentId: data.paymentId });
              const credits = done.entitlements && done.entitlements.reportCredits;
              box.innerHTML = `<div class="alert ok">Paid. ${done.entitlements && done.entitlements.unlimited ? 'Unlimited audits are on.' : (credits ? credits + ' report credit(s) ready.' : 'Access updated.')} <a href="#/app/upload">Run an audit</a></div>`;
            } catch (err) {
              box.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
            }
          });
        }
      } catch (err) {
        box.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      }
    });
  });
}

/* ---------- views: audit result ---------- */

async function viewAudit(id) {
  const ws = currentWorkspace();
  if (!ws) return emptyWorkspaces();
  const [auditData, findingsData] = await Promise.all([
    api.get(`/workspaces/${ws.id}/audits/${id}`),
    api.get(`/workspaces/${ws.id}/audits/${id}/findings`),
  ]);
  const a = auditData.audit;
  const s = a.summary || {};
  const findings = findingsData.findings || [];

  if (a.status === 'processing') {
    return `<div class="card mt"><h2>Audit in progress</h2><div class="progress mt-s"><i></i></div>
      <p class="muted small mt-s" id="pollText">Reading the file…</p></div>`;
  }
  if (a.status === 'failed') {
    return `<div class="card mt"><h2>Audit failed</h2>
      <div class="alert error">${esc(a.error || 'Unknown error')}</div>
      <a class="btn" href="#/app/upload">Try another file</a></div>`;
  }

  state.auditCache[id] = findings;

  const t = s.totals || {};
  const sev = s.severityCounts || {};
  const cur = s.currency;

  return `
    <div class="between mt">
      <div>
        <h1 style="margin-bottom:2px">${esc(a.name)}</h1>
        <p class="muted small">
          ${esc(a.marketplace || '—')} · ${esc((s.reportKind || 'report').replace(/_/g, ' '))} ·
          ${a.rowCount ?? 0} rows · ${esc(a.encoding || '—')} · ${esc(a.delimiter ? JSON.stringify(a.delimiter).replace(/"/g, '') : '—')}
        </p>
      </div>
      <div class="row">
        <button class="btn small" data-copy="csv">Export findings (CSV)</button>
        <button class="btn small" data-copy="json">Export (JSON)</button>
        <button class="btn small" data-copy="settlements">Settlement summary</button>
        <button class="btn small danger" id="deleteAudit">Delete</button>
      </div>
    </div>

    <div id="exportNotice"></div>
    <div class="alert info mt-s">
      Findings are prompts to review, not claims that Amazon owes you money.
      <span class="strong">Recoverable</span> is only used for amounts the file itself proves were charged in error.
    </div>

    <div class="grid c4">
      <div class="stat"><div class="k">Net settlement</div><div class="v">${money(t.net, cur)}</div><div class="sub">sum of all rows</div></div>
      <div class="stat"><div class="k">Gross sales</div><div class="v">${money(t.grossSales, cur)}</div><div class="sub">product charges</div></div>
      <div class="stat"><div class="k">Fees</div><div class="v">${money(t.fees, cur)}</div><div class="sub">negative = charged</div></div>
      <div class="stat"><div class="k">Refunds</div><div class="v">${money(t.refunds, cur)}</div><div class="sub">${s.counts ? s.counts.refunds : 0} rows</div></div>
    </div>

    <div class="grid c3 mt">
      <div class="stat"><div class="k">Findings</div><div class="v">${findings.length}</div>
        <div class="sub">${sev.critical || 0} critical · ${sev.high || 0} high · ${sev.medium || 0} medium · ${sev.low || 0} low</div></div>
      <div class="stat"><div class="k">Flagged for review</div><div class="v">${money(s.potentialTotal, cur)}</div>
        <div class="sub">not a claim — investigate</div></div>
      <div class="stat"><div class="k">Recoverable</div><div class="v">${money(s.recoverableTotal, cur)}</div>
        <div class="sub">proven by the file only</div></div>
    </div>

    ${renderLimitations(s)}

    ${renderFindings(findings)}

    ${renderProfitability(s)}

    ${renderSettlements(s)}

    <div class="card">
      <h3>Export &amp; bookkeeping</h3>
      <p class="muted small">The settlement summary export lists each settlement with its period, deposit date and
      net amount — the figures you need when posting the payout to your books. Findings export as CSV for a case,
      or JSON for your own tooling.</p>
    </div>
  `;
}

function renderLimitations(s) {
  const limitations = s.limitations || [];
  const dq = s.dataQuality || {};
  const hasContent = limitations.length || (dq.unmappedColumns || []).length || (dq.ruleErrors || []).length;
  if (!hasContent) return '';
  return `
    <div class="card mt">
      <h3>What we could not check</h3>
      <p class="muted small">These are gaps in the data, reported honestly rather than guessed at.</p>
      ${limitations.length ? `<ul class="muted small">${limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${(dq.unmappedColumns || []).length ? `<p class="muted small">Columns we did not use: <span class="mono">${esc(dq.unmappedColumns.join(', '))}</span></p>` : ''}
      ${(dq.ruleErrors || []).length ? `<p class="muted small">Rules that could not run: ${esc((dq.ruleErrors || []).map((e) => e.ruleId).join(', '))}</p>` : ''}
    </div>`;
}

function renderFindings(findings) {
  if (!findings.length) {
    return `<div class="card mt"><h3>No findings</h3>
      <p class="muted">This file passed every rule that applies to it. That is a good result — it means the
      report is internally consistent and we found nothing that needs your attention.</p></div>`;
  }
  const categories = [...new Set(findings.map((f) => f.category))];
  return `
    <div class="card mt">
      <div class="between mb">
        <h3 style="margin:0">Findings</h3>
        <div class="filters">
          <select id="fSeverity"><option value="">All severities</option>${['critical', 'high', 'medium', 'low', 'info'].map((x) => `<option>${x}</option>`).join('')}</select>
          <select id="fConfidence"><option value="">All confidence</option>${['high', 'medium', 'low', 'insufficient'].map((x) => `<option>${x}</option>`).join('')}</select>
          <select id="fCategory"><option value="">All categories</option>${categories.map((c) => `<option value="${esc(c)}">${esc(c.replace(/_/g, ' '))}</option>`).join('')}</select>
          <select id="fStatus"><option value="">Any status</option>${['open', 'confirmed', 'dismissed', 'resolved'].map((x) => `<option>${x}</option>`).join('')}</select>
          <select id="fState"><option value="">Any recovery state</option>${['POTENTIAL', 'EVIDENCE_READY', 'SELLER_REVIEW', 'CLAIM_SUBMITTED', 'AMAZON_CONFIRMED', 'CASH_CONFIRMED', 'CLOSED', 'REJECTED', 'DISPUTED', 'EXPIRED', 'UNVERIFIED'].map((x) => `<option value="${x}">${esc((STATE_LABEL[x] || [x])[0])}</option>`).join('')}</select>
          <input id="fSearch" placeholder="Search SKU, order, text">
        </div>
      </div>
      <div id="findingsList"></div>
    </div>
  `;
}

const STATE_LABEL = {
  POTENTIAL: ['POTENTIAL VALUE', 'Possible Amazon discrepancy detected.'],
  EVIDENCE_READY: ['EVIDENCE READY', 'Evidence package prepared for review.'],
  SELLER_REVIEW: ['IN REVIEW', 'You are checking this before acting.'],
  CLAIM_SUBMITTED: ['SUBMITTED', 'Submitted to Amazon; awaiting their response.'],
  AMAZON_CONFIRMED: ['AMAZON CONFIRMED', 'Amazon confirmation recorded.'],
  CASH_CONFIRMED: ['CASH CONFIRMED', 'Seller confirmed the money was actually received.'],
  CLOSED: ['CLOSED', 'No further action needed.'],
  REJECTED: ['REJECTED', 'Reviewed and dismissed.'],
  DISPUTED: ['DISPUTED', 'Outcome is being disputed.'],
  EXPIRED: ['EXPIRED', 'Amazon claim window has passed.'],
  UNVERIFIED: ['UNVERIFIED', 'Could not be verified with the available data.'],
};

function stateBadge(s) {
  const meta = STATE_LABEL[s] || [String(s || '').toUpperCase(), ''];
  return `<span class="badge state-${esc(String(s).toLowerCase())}" title="${esc(meta[1])}">${esc(meta[0])}</span>`;
}

function nextTransition(f) {
  switch (f.recovery_state) {
    case 'POTENTIAL': return { label: 'Prepare evidence', to: 'EVIDENCE_READY' };
    case 'EVIDENCE_READY': return { label: 'Review evidence', to: 'SELLER_REVIEW' };
    case 'SELLER_REVIEW': return { label: 'Mark submitted', to: 'CLAIM_SUBMITTED', needsCase: true };
    case 'CLAIM_SUBMITTED': return { label: 'Record Amazon response', to: 'AMAZON_CONFIRMED' };
    case 'AMAZON_CONFIRMED': return { label: 'Confirm cash received', to: 'CASH_CONFIRMED' };
    case 'CASH_CONFIRMED': return { label: 'Close finding', to: 'CLOSED' };
    default: return { label: 'Reopen for review', to: 'SELLER_REVIEW' };
  }
}

function findingCard(f) {
  const amt = f.amount !== null && f.amount !== undefined
    ? `<span class="small nowrap">${money(f.amount, f.currency)} <span class="muted tiny">${f.recoverable ? 'recoverable' : 'to review'}</span></span>`
    : '';
  const evidence = f.evidence || {};
  const rows = (evidence.sourceRows || []).join(', ');
  const next = nextTransition(f);
  const states = ['POTENTIAL', 'EVIDENCE_READY', 'SELLER_REVIEW', 'CLAIM_SUBMITTED', 'AMAZON_CONFIRMED', 'CASH_CONFIRMED', 'CLOSED', 'REJECTED', 'DISPUTED', 'EXPIRED', 'UNVERIFIED'];
  return `
    <div class="finding" data-sev="${esc(f.severity)}" data-conf="${esc(f.confidence)}" data-cat="${esc(f.category)}" data-status="${esc(f.status)}" data-state="${esc(f.recovery_state)}"
         data-text="${esc((f.title + ' ' + f.detail + ' ' + (f.sku || '') + ' ' + (f.order_id || '')).toLowerCase())}">
      <div class="finding-head">
        ${sevBadge(f.severity)}
        <div style="flex:1">
          <div class="finding-title">${esc(f.title)}</div>
          <div class="muted tiny mt-s">${esc(f.category.replace(/_/g, ' '))}${f.sku ? ' · ' + esc(f.sku) : ''}${f.order_id ? ' · ' + esc(f.order_id) : ''} · rows ${esc(rows || 'n/a')}</div>
        </div>
        <div style="text-align:right">${confBadge(f.confidence)}${amt ? '<div class="mt-s">' + amt + '</div>' : ''}</div>
        <span class="chev">▾</span>
      </div>
      <div class="finding-body">
        <p>${esc(f.detail)}</p>
        <div class="row mb">
          ${stateBadge(f.recovery_state)}
          ${statusBadge(f.status)}
          ${f.case_ref ? `<span class="muted small">Amazon ref: <span class="mono">${esc(f.case_ref)}</span></span>` : ''}
        </div>
        <div class="explain">
          <div><span class="strong">What happened?</span> <span class="muted small">${esc(f.detail)}</span></div>
          <div><span class="strong">Why does this matter?</span> <span class="muted small">If this charge is wrong, the money is yours to claim. We only mark it recoverable when the file itself proves it.</span></div>
          <div><span class="strong">What evidence do we have?</span> <span class="muted small">${rows ? 'Source rows ' + esc(rows) : 'No source rows recorded.'} ${f.recoverable ? '(file-proven amount)' : '(review item, not a claim)'}</span></div>
          <div><span class="strong">What should you do?</span> <span class="muted small">${esc((STATE_LABEL[f.recovery_state] || ['', ''])[1])} Next: ${esc(next.label)}.</span></div>
        </div>
        ${evidence.calculation ? `<p class="muted small"><span class="strong">How this was calculated:</span> <span class="mono">${esc(evidence.calculation)}</span></p>` : ''}
        ${evidence.note ? `<p class="muted small"><span class="strong">Evidence:</span> ${esc(evidence.note)}</p>` : ''}
        ${rows ? `<p class="muted small"><span class="strong">Source rows:</span> <span class="mono">${esc(rows)}</span></p>` : ''}
        ${(evidence.sample || []).length ? `<details><summary class="muted small">Raw rows (${(evidence.sample || []).length})</summary>
          <pre class="raw">${esc((evidence.sample || []).map((x) => 'row ' + x.sourceRow + ': ' + (x.raw || []).join(' | ')).join('\n'))}</pre></details>` : ''}
        ${evidence.skus ? `<p class="muted small"><span class="strong">SKUs:</span> <span class="mono">${esc(evidence.skus.join(', '))}</span></p>` : ''}
        <details><summary class="muted small">Full evidence record</summary><pre class="raw">${esc(JSON.stringify(evidence, null, 2))}</pre></details>
        <div class="row mt">
          <button class="btn small primary finding-action" data-fid="${esc(f.id)}" data-to="${esc(next.to)}" data-needscase="${next.needsCase ? '1' : ''}">${esc(next.label)}</button>
          <select class="finding-state" data-fid="${esc(f.id)}">
            <option value="">Change state…</option>
            ${states.filter((s) => s !== f.recovery_state).map((s) => `<option value="${s}">${esc((STATE_LABEL[s] || [s])[0])}</option>`).join('')}
          </select>
          <button class="btn small finding-resolve" data-fid="${esc(f.id)}">Cash confirmed…</button>
        </div>
      </div>
    </div>`;
}

function mountFindings(auditId, findings) {
  const list = document.getElementById('findingsList');
  if (!list) return;
  const controls = {
    severity: document.getElementById('fSeverity'),
    confidence: document.getElementById('fConfidence'),
    category: document.getElementById('fCategory'),
    status: document.getElementById('fStatus'),
    state: document.getElementById('fState'),
    search: document.getElementById('fSearch'),
  };

  const draw = () => {
    const sev = controls.severity.value;
    const conf = controls.confidence.value;
    const cat = controls.category.value;
    const st = controls.status.value;
    const rc = controls.state.value;
    const q = controls.search.value.trim().toLowerCase();
    const shown = findings.filter((f) =>
      (!sev || f.severity === sev) &&
      (!conf || f.confidence === conf) &&
      (!cat || f.category === cat) &&
      (!st || f.status === st) &&
      (!rc || f.recovery_state === rc) &&
      (!q || (f.title + ' ' + f.detail + ' ' + (f.sku || '') + ' ' + (f.order_id || '')).toLowerCase().includes(q)));
    list.innerHTML = shown.length
      ? shown.map(findingCard).join('')
      : '<p class="muted small">No findings match these filters.</p>';
    list.querySelectorAll('.finding-head').forEach((h) => h.addEventListener('click', () => h.parentElement.classList.toggle('open')));

    const doTransition = async (fid, to, extra = {}) => {
      const ws = currentWorkspace();
      try {
        const res = await api.post(`/workspaces/${ws.id}/findings/${fid}/transition`, { toState: to, ...extra });
        const f = findings.find((x) => x.id === fid);
        if (f) Object.assign(f, res.finding);
        toast(`Moved to ${(STATE_LABEL[to] || [to])[0]}.`, 'ok');
        draw();
      } catch (err) { toast(err.message, 'error'); }
    };

    list.querySelectorAll('.finding-action').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const extra = {};
      if (btn.dataset.needscase) {
        const caseRef = prompt('Amazon case / reference number (optional):', '') || '';
        if (caseRef) extra.caseRef = caseRef;
      }
      await doTransition(btn.dataset.fid, btn.dataset.to, extra);
    }));

    list.querySelectorAll('.finding-state').forEach((sel) => sel.addEventListener('change', async (e) => {
      e.stopPropagation();
      if (!sel.value) return;
      const note = prompt('Note for the audit trail (optional):', '') || '';
      await doTransition(sel.dataset.fid, sel.value, { note });
      sel.value = '';
    }));

    list.querySelectorAll('.finding-resolve').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const raw = prompt('Amount actually received (leave blank if it was resolved without cash):', '');
      if (raw === null) return;
      const ws = currentWorkspace();
      try {
        const body = { note: 'Seller confirmed' };
        if (raw.trim() !== '') { body.recoveredAmount = Number(raw); if (!Number.isFinite(body.recoveredAmount)) throw new Error('Enter a number.'); }
        await api.post(`/workspaces/${ws.id}/findings/${btn.dataset.fid}/resolve`, body);
        toast('Cash confirmation recorded.', 'ok');
        await render();
      } catch (err) { toast(err.message, 'error'); }
    }));
  };

  Object.values(controls).forEach((c) => c && c.addEventListener('input', draw));
  draw();
}

function renderProfitability(s) {
  const rows = s.profitability || [];
  if (!rows.length) return '';
  const unknown = rows.filter((r) => !r.cogsKnown).length;
  return `
    <div class="card mt">
      <div class="between">
        <h3 style="margin:0">Profitability by SKU</h3>
        <a class="btn small" href="#/app/cogs">Add product costs</a>
      </div>
      <p class="muted small mt-s">Profit is revenue minus fees.${unknown ? ` ${unknown} SKU(s) have no product cost set, so their profit ignores COGS and is not reliable.` : ' All SKUs have product costs.'}</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>SKU</th><th>Units</th><th>Revenue</th><th>Fees</th><th>COGS</th><th>Profit</th><th>Margin</th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td class="mono">${esc(r.sku)}${r.cogsKnown ? '' : ' <span class="badge conf-low">NO COGS</span>'}</td>
                <td>${r.units}</td>
                <td>${money(r.revenue, s.currency)}</td>
                <td>${money(r.fees, s.currency)}</td>
                <td>${r.cogsKnown ? money(r.cogs, s.currency) : '<span class="muted">—</span>'}</td>
                <td class="${r.profit < 0 ? 'strong' : ''}" style="${r.profit < 0 ? 'color:#ffb4b4' : ''}">${money(r.profit, s.currency)}</td>
                <td>${r.cogsKnown ? pct(r.marginPct) : '<span class="muted">n/a</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderSettlements(s) {
  const rows = s.settlements || [];
  if (!rows.length) return '';
  return `
    <div class="card mt">
      <h3>Settlements in this file</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Settlement</th><th>Period</th><th>Deposit</th><th>Currency</th><th>Rows</th><th>Net</th></tr></thead>
          <tbody>
            ${rows.map((x) => `
              <tr>
                <td class="mono">${esc(x.id)}</td>
                <td class="small nowrap">${esc(x.start || '—')} → ${esc(x.end || '—')}</td>
                <td class="small nowrap">${esc(x.deposit || '—')}</td>
                <td>${esc(x.currency || '—')}</td>
                <td>${x.rows}</td>
                <td>${money(x.net, x.currency)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

async function mountAudit(id) {
  const ws = currentWorkspace();
  const findings = state.auditCache[id] || [];
  if (findings.length) mountFindings(id, findings);
  if (document.getElementById('pollText')) {
    setTimeout(() => render(), 1200);
    return;
  }

  document.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', () => { downloadExport(ws.id, id, b.dataset.copy); });
  });
  const del = document.getElementById('deleteAudit');
  if (del) del.addEventListener('click', async () => {
    if (!confirm('Delete this audit and its uploaded file?')) return;
    try {
      await api.del(`/workspaces/${ws.id}/audits/${id}`);
      location.hash = '#/app/history';
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function downloadExport(wsId, auditId, format) {
  const url = `/api/workspaces/${wsId}/audits/${auditId}/export?format=${encodeURIComponent(format)}`;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 402) {
      const payload = await res.json().catch(() => null);
      const err = new Error(payload && payload.error ? payload.error.message : 'That export needs a paid plan.');
      err.status = 402;
      err.payload = payload;
      const box = document.getElementById('exportNotice');
      if (box) box.innerHTML = upgradeCard(err);
      else toast(err.message, 'error');
      return;
    }
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `settleproof-${auditId.slice(0, 8)}.${format === 'csv' ? 'csv' : 'json'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function mountDashboard() {
  const a = document.getElementById('demoAuditBtn');
  if (a) a.addEventListener('click', runSampleAudit);
  const w = document.getElementById('newWorkspaceBtn');
  if (w) w.addEventListener('click', async () => {
    const name = prompt('Workspace name', 'My workspace');
    if (!name) return;
    try {
      const res = await api.post('/workspaces', { name });
      await refreshWorkspaces();
      state.workspaceId = res.workspace.id;
      await render();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ---------- demo ---------- */

async function startDemo() {
  try {
    const data = await api.post('/demo');
    rememberSession(data);
    state.user = data.user;
    state.workspaces = [data.workspace];
    state.workspaceId = data.workspace.id;
    location.hash = `#/app/audit/${data.auditId}`;
    await boot();
  } catch (err) {
    toast(err.message || 'Could not start the demo. Try again in a minute.', 'error');
  }
}

/* ---------- router ---------- */

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  return hash;
}

async function render() {
  const token = ++routeToken;
  const route = parseRoute();
  renderChrome(route);
  const view = document.getElementById('view');

  const finish = (html, mountFn) => {
    if (token !== routeToken) return;
    view.innerHTML = html;
    if (mountFn) mountFn();
  };

  try {
    if (route === '/' || route === '') {
      if (state.user) { location.hash = '#/app'; return; }
      finish(viewLanding(), () => {
        const b = document.getElementById('demoBtn');
        if (b) b.addEventListener('click', startDemo);
      });
      return;
    }
    if (route === '/login') { finish(viewAuth('login'), () => mountAuth('login')); return; }
    if (route === '/signup') { finish(viewAuth('signup'), () => mountAuth('signup')); return; }
    if (route === '/how') { finish(viewHow()); return; }
    if (route === '/trust') { finish(viewTrust()); return; }
    if (route === '/pricing') { finish(viewPricing()); return; }

    if (route.startsWith('/app')) {
      if (!state.user) { location.hash = '#/login'; return; }
      if (!state.workspaces.length) await refreshWorkspaces();
      if (route === '/app' || route === '/app/') {
        const html = await viewDashboard();
        finish(html, mountDashboard);
        return;
      }
      if (route === '/app/upload') { finish(viewUpload(), mountUpload); return; }
      if (route === '/app/history') {
        const html = await viewHistory();
        finish(html, mountHistory);
        return;
      }
      if (route === '/app/cogs') { finish(await viewCogs(), mountCogs); return; }
      if (route === '/app/findings') {
        const html = await viewFindingsList();
        finish(html, () => mountFindings(null, state._findings || []));
        return;
      }
      if (route === '/app/value') { finish(await viewValue(), mountValue); return; }
      if (route === '/app/plans') { finish(await viewPlans(), mountPlans); return; }
      const m = route.match(/^\/app\/audit\/([^/]+)$/);
      if (m) {
        const html = await viewAudit(m[1]);
        finish(html, () => mountAudit(m[1]));
        return;
      }
    }

    finish('<div class="card mt"><h2>Page not found</h2><a class="btn" href="#/">Go home</a></div>');
  } catch (err) {
    if (err.status === 401) {
      state.user = null;
      forgetSession();
      location.hash = '#/login';
      return;
    }
    finish(`<div class="card mt"><h2>Something went wrong</h2>
      <div class="alert error">${esc(err.message)}</div>
      <a class="btn" href="#/app">Back to dashboard</a></div>`);
  }
}

async function refreshWorkspaces() {
  try {
    const me = await api.get('/auth/me');
    if (!me.user) { state.user = null; forgetSession(); return; }
    state.user = me.user;
    state.workspaces = me.workspaces;
    if (me.csrf) rememberSession({ csrf: me.csrf });
    if (!state.workspaceId || !state.workspaces.find((w) => w.id === state.workspaceId)) {
      state.workspaceId = state.workspaces[0] ? state.workspaces[0].id : null;
    }
  } catch { /* not signed in */ }
}

async function boot() {
  await refreshWorkspaces();
  await render();
}

window.addEventListener('hashchange', render);
boot();
