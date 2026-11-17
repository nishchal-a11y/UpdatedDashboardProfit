/* Project profitability dashboard.
 *
 * Reads the EDA datasets produced by build_eda.py and renders a sectioned
 * drill-down. Revenue is stored once per project, then attributed to rows by
 * their share of that project's total hours so every grouping reconciles to
 * the same total. Cost comes from monthly payroll totals joined by employee number.
 */

const UNALLOCATED_ID = '__unallocated__';
const DEPT_METHOD = 'Department Weighted Allocation';
const DEPT_OFF_METHOD = 'Unallocated (department pool off)';
const PAGE_SIZE = 50;

const DIMENSIONS = {
  projectTl: { label: 'Team lead', sub: 'Project team lead' },
  reportingTl: { label: 'Reporting TL', sub: 'Reporting line of the person logging' },
  employee: { label: 'Submitted by', sub: 'Person logging the hours' },
  client: { label: 'Client', sub: 'Client legal name' },
  project: { label: 'Project', sub: 'Individual project' },
  service: { label: 'Service', sub: 'Service line' },
  status: { label: 'Project status', sub: 'Lifecycle status' },
  frequency: { label: 'Frequency', sub: 'Billing frequency' },
  revenueType: { label: 'Revenue type', sub: 'Invoiced or not' },
  method: { label: 'Allocation method', sub: 'How the hours were attributed' },
};

const DRILL_PATH = ['client', 'project', 'projectTl', 'employee'];
const HOURS_PATH = ['projectTl', 'employee', 'client', 'project'];
const PEOPLE_PATH = ['projectTl', 'client', 'project'];
const CLIENT_PATH = ['client', 'project', 'projectTl', 'employee'];
const PERSON_SUMMARY_PATH = ['client', 'project', 'projectTl'];

/** Sections that get a page of their own rather than a slot in the scroll
 *  report. The header and filter bar stay put; only the blocks swap. */
const PAGES = [
  { view: 'trends', section: 'section-trends', hash: '#trends', label: 'Monthly Comparisons' },
  { view: 'clients', section: 'section-clients', hash: '#clients', label: 'Client summary' },
  { view: 'people-summary', section: 'section-person-summary', hash: '#people-summary', label: 'People summary' },
];

const INTERNAL_LABELS = {
  internal_category: 'Category', employee: 'Person', reporting_to: 'Reporting TL',
  department: 'Department', client: 'Client', project: 'Project',
};

const state = {
  facts: [],
  deptOffFacts: [],
  projects: new Map(),
  utilisation: [],
  internal: [],
  unallocated: [],
  unallocatedNoDept: [],
  mismatch: [],
  audit: [],
  clientSummary: [],
  peopleSummary: [],
  revisions: [],
  trends: [],
  trendGrain: 'month',
  costs: new Map(),
  manifest: null,
  filters: {
    search: '', client: 'all', tl: 'all', employee: 'all', service: 'all',
    status: 'all', frequency: 'all', revenueType: 'all', method: 'all',
    hoursBasis: 'all', hideZeroRevenue: false, hideUnallocated: false, hideNonLive: false,
    deptAllocation: true, costPerHourOverride: null, inrToAedOverride: null,
  },
  crumbs: [],
  hoursCrumbs: [],
  sort: { drill: { key: 'inWindowRevenue', dir: -1 }, hours: { key: 'totalHours', dir: -1 }, audit: { key: 'allocatedHours', dir: -1 }, people: { key: 'totalHours', dir: -1 }, internal: { key: 'hours', dir: -1 }, peopleDrill: { key: 'hours', dir: -1 }, clients: { key: 'inWindowRevenue', dir: -1 }, personSummary: { key: 'hours', dir: -1 }, personSummaryDrill: { key: 'hours', dir: -1 } },
  page: { drill: 0, audit: 0, clients: 0 },
  internalDimension: 'internal_category',
  internalCrumbs: [],
  peopleScope: 'all',
  peopleFocus: null,
  peopleCrumbs: [],
  visible: [],
  auditEmployee: 'all',
  clientCrumbs: [],
  // null = sweep k and keep the best-scoring split; a number pins it by hand.
  clusterK: null,
  clientCluster: null,
  // Flat rows of the fully expanded client breakdown, and the deferred builder
  // that fills them. See renderClientEda for why the work is put off.
  clientEda: [],
  clientEdaBuild: null,
  clientEdaReady: false,
  insightScope: 'all',
  personSummaryFocus: null,
  personSummaryCrumbs: [],
  view: 'page',
};

/* ------------------------------------------------------------------ helpers */

const $ = (id) => document.getElementById(id);

/** Replacing the clicked row shrinks the table; the browser then scroll-anchors
 *  upward and the sticky filter covers the section. Pin the node in the viewport. */
function keepViewport(id, fn) {
  const el = $(id);
  const top = el ? el.getBoundingClientRect().top : window.scrollY;
  fn();
  const pin = () => {
    if (!el) return;
    const delta = el.getBoundingClientRect().top - top;
    if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
  };
  pin();
  requestAnimationFrame(pin);
}
const text = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const num = (value) => {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};
const money = (value) => `AED ${new Intl.NumberFormat('en-AE', { maximumFractionDigits: 0 }).format(Math.round(value))}`;
const money2 = (value) => `AED ${new Intl.NumberFormat('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
const moneyInr = (value) => `INR ${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(value))}`;
const dec = (value, digits = 2) => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const int = (value) => new Intl.NumberFormat('en-US').format(value);
/** Hours as a duration. Timesheets are kept and read in hours and minutes, and
 *  a decimal tail like 45.31h hides how much of an hour that actually is.
 *  Exports keep the raw decimal, so only the display changes. */
const hoursText = (value) => {
  const sign = value < 0 ? '-' : '';
  const minutesTotal = Math.round(Math.abs(num(value)) * 60);
  const hours = Math.floor(minutesTotal / 60);
  const minutes = minutesTotal % 60;
  if (!minutesTotal) return '0h';
  if (!hours) return `${sign}${minutes}m`;
  if (!minutes) return `${sign}${int(hours)}h`;
  return `${sign}${int(hours)}h\u00a0${minutes}m`;
};
const pct = (value) => `${dec(value, 1)}%`;
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

/** Median rather than mean, because hours and revenue per head are long-tailed. */
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function loadCsv(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return Papa.parse(await response.text(), { header: true, skipEmptyLines: true }).data;
}

async function loadCsvOptional(path) {
  try {
    return await loadCsv(path);
  } catch (error) {
    return [];
  }
}

async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return response.json();
}

/* ------------------------------------------------------------------ ingest */

function ingestFacts(rows) {
  state.facts = rows.map((row) => {
    const projectId = text(row.project_id);
    const fact = {
      projectId,
      project: text(row.project_name) || 'Unknown project',
      clientId: text(row.client_id),
      client: text(row.client_name) || 'Unknown client',
      service: text(row.service_name) || text(row.task_name) || 'Unclassified',
      projectTl: text(row.project_team_lead) || 'Unassigned',
      reportingTl: text(row.reporting_to_tl) || 'Unassigned',
      employee: text(row.submitted_by) || 'Unknown',
      method: text(row.allocation_method) || 'Actual',
      allocationType: text(row.allocation_type),
      revenueBasis: text(row.revenue_basis),
      coverage: num(row.window_coverage_pct),
      status: text(row.project_status) || 'unknown',
      frequency: text(row.service_frequency) || 'unknown',
      revenueType: text(row.revenue_type) || 'unknown',
      serviceType: text(row.service_type),
      start: text(row.project_start),
      end: text(row.project_end),
      deadline: text(row.deadline),
      dupRows: num(row.duplicate_source_rows),
      clientConflict: text(row.client_name_conflict) === 'yes',
      actualHours: num(row.project_hours),
      allocatedHours: num(row.allocated_hours),
      unallocatedHours: num(row.unallocated_hours),
      totalHours: num(row.total_hours),
      approvedHours: num(row.approved_hours),
      nonApprovedHours: num(row.nonapproved_hours),
      nonWorkingHours: num(row.nonworking_hours),
      statusMix: text(row.timesheet_status_mix),
      dayMix: text(row.day_type_mix),
      topTasks: text(row.top_tasks),
    };
    fact.bucket = fact.unallocatedHours > 0 ? 'unallocated' : fact.allocatedHours > 0 ? 'allocated' : 'actual';
    if (!state.projects.has(projectId)) {
      state.projects.set(projectId, {
        projectId,
        project: fact.project,
        client: fact.client,
        clientId: fact.clientId,
        contractRevenue: num(row.contract_revenue),
        inWindowRevenue: num(row.in_window_revenue),
        revenueBasis: fact.revenueBasis,
        status: fact.status,
        coverage: fact.coverage,
      });
    }
    return fact;
  });
  state.deptOffFacts = withoutDepartmentPool(state.facts);
  revenueBaseCache = { key: null, hours: null, counts: null };
}

/**
 * The same facts with the department pool switched off: hours spread by a
 * department's historical mix return to the Unallocated bucket instead of
 * landing on client projects, so total company hours stay conserved and the
 * projects that absorbed them lose that share.
 */
function withoutDepartmentPool(facts) {
  let bucket = state.projects.get(UNALLOCATED_ID);
  if (!bucket) {
    bucket = {
      projectId: UNALLOCATED_ID, project: 'Unallocated internal time', client: 'Unallocated / Overhead',
      clientId: UNALLOCATED_ID, contractRevenue: 0, inWindowRevenue: 0, revenueBasis: 'No revenue',
      status: 'n/a', coverage: 0,
    };
    state.projects.set(UNALLOCATED_ID, bucket);
  }
  return facts.map((fact) => (fact.method !== DEPT_METHOD ? fact : {
    ...fact,
    projectId: UNALLOCATED_ID,
    project: bucket.project,
    clientId: UNALLOCATED_ID,
    client: bucket.client,
    service: 'Unallocated',
    projectTl: 'Unassigned',
    status: 'n/a',
    frequency: 'n/a',
    revenueType: 'n/a',
    method: DEPT_OFF_METHOD,
    allocationType: 'Unallocated',
    bucket: 'unallocated',
    allocatedHours: 0,
    unallocatedHours: fact.allocatedHours,
    dupRows: 0,
    clientConflict: false,
  }));
}

const activeFacts = () => (state.filters.deptAllocation ? state.facts : state.deptOffFacts);

const deptPoolHours = () => state.facts.reduce((sum, fact) => (fact.method === DEPT_METHOD ? sum + fact.totalHours : sum), 0);

/** Company-wide unallocated hours under the active allocation setting. */
const companyUnallocatedHours = () => num(state.manifest?.totals?.unallocated_hours)
  + (state.filters.deptAllocation ? 0 : deptPoolHours());

/**
 * Rows to display in the "Unallocated internal hours" register. Backed by
 * two build-time CSVs: the base file when the department pool is on, and a
 * sibling that includes the people returned when the toggle is off.
 */
const activeUnallocatedRows = () => (state.filters.deptAllocation
  ? state.unallocated
  : (state.unallocatedNoDept.length ? state.unallocatedNoDept : state.unallocated));

function ingestCosts(rows) {
  state.costs = new Map();
  rows.forEach((row) => {
    const employee = text(row.employee);
    if (!employee) return;
    state.costs.set(employee, {
      employeeNumber: text(row.employee_number),
      windowCostInr: num(row.window_cost_inr),
      windowCostAed: num(row.window_cost_aed),
      coveredPayrollDays: num(row.covered_payroll_days),
      revisionAdjustedMonths: num(row.revision_adjusted_months),
      costSource: text(row.cost_source),
      loggedHours: num(row.total_logged_hours),
    });
  });
}

const costLoaded = () => Boolean(state.manifest?.cost?.loaded);
const payrollCoveredDays = () => num(state.manifest?.cost?.covered_days);
const costOverride = () => state.filters.costPerHourOverride;
const inrToAedRate = () => state.filters.inrToAedOverride
  ?? (num(state.manifest?.cost?.inr_to_aed) || 0.042);
const costHasCoverage = () => costLoaded() && payrollCoveredDays() > 0;
const costReady = () => costOverride() !== null
  || (costHasCoverage() && payrollCoveredDays() >= num(state.manifest?.window?.days));
const costEstimated = () => false;

function renderCostRateStatus() {
  const status = $('costRateStatus');
  if (!status) return;
  const fxStatus = $('fxRateStatus');
  $('inrToAedRate').value = inrToAedRate().toFixed(4);
  fxStatus.textContent = state.filters.inrToAedOverride === null
    ? `Default · ${inrToAedRate().toFixed(4)} AED per INR`
    : `Applied · ${inrToAedRate().toFixed(4)} AED per INR`;
  status.textContent = costOverride() === null
    ? `Using payroll CSV · FX ${inrToAedRate().toFixed(4)}`
    : `Manual ${money2(costOverride())} / h applied to all employees`;
}

function costPerHour(employee) {
  if (costOverride() !== null) return costOverride();
  if (!costReady()) return 0;
  const entry = state.costs.get(employee);
  return entry?.loggedHours ? entry.windowCostInr * inrToAedRate() / entry.loggedHours : 0;
}

/* ------------------------------------------------------------------ filtering */

function factHours(fact) {
  return state.filters.hoursBasis === 'approved' ? fact.approvedHours : fact.totalHours;
}

function matchesFilters(fact) {
  const filters = state.filters;
  if (filters.hideUnallocated && fact.projectId === UNALLOCATED_ID) return false;
  if (filters.client !== 'all' && fact.client !== filters.client) return false;
  if (filters.tl !== 'all' && fact.projectTl !== filters.tl) return false;
  if (filters.employee !== 'all' && fact.employee !== filters.employee) return false;
  if (filters.service !== 'all' && fact.service !== filters.service) return false;
  if (filters.status !== 'all' && fact.status !== filters.status) return false;
  if (filters.frequency !== 'all' && fact.frequency !== filters.frequency) return false;
  if (filters.revenueType !== 'all' && fact.revenueType !== filters.revenueType) return false;
  if (filters.method !== 'all' && fact.method !== filters.method) return false;
  if (filters.hideNonLive && ['deleted', 'future', 'next_month', 'archived'].includes(fact.status)) return false;
  if (filters.hideZeroRevenue) {
    const project = state.projects.get(fact.projectId);
    if (!project || project.contractRevenue <= 0) return false;
  }
  if (filters.search) {
    const haystack = `${fact.client} ${fact.project} ${fact.projectTl} ${fact.reportingTl} ${fact.employee} ${fact.service}`.toLowerCase();
    if (!haystack.includes(filters.search)) return false;
  }
  return state.crumbs.every((crumb) => fact[crumb.dim] === crumb.value);
}

let revenueBaseCache = { key: null, hours: null, counts: null };

/**
 * Per-project hour totals used to attribute revenue. Method is the exception
 * to the usual filter-independent denominator: selecting a method changes
 * hours and cost, but must not remove any revenue from a represented project.
 */
function projectRevenueBase() {
  const key = `${state.filters.deptAllocation}|${state.filters.hoursBasis}|${state.filters.method}`;
  if (revenueBaseCache.key === key) return revenueBaseCache;
  const hours = new Map();
  const counts = new Map();
  activeFacts().filter((fact) => state.filters.method === 'all' || fact.method === state.filters.method).forEach((fact) => {
    hours.set(fact.projectId, (hours.get(fact.projectId) || 0) + factHours(fact));
    counts.set(fact.projectId, (counts.get(fact.projectId) || 0) + 1);
  });
  revenueBaseCache = { key, hours, counts };
  return revenueBaseCache;
}

/**
 * Filtered rows, each carrying their share of the parent project's revenue.
 * Revenue is spread over all project hours, or only the selected method's
 * hours, so method filters change hours and cost without dropping revenue.
 * Other row-level filters continue to scale revenue to the hours they retain.
 */
function visibleRows() {
  const rows = activeFacts().filter(matchesFilters);
  const base = projectRevenueBase();
  return rows.map((fact) => {
    const project = state.projects.get(fact.projectId);
    const totalHours = base.hours.get(fact.projectId) || 0;
    const hours = factHours(fact);
    const share = totalHours > 0 ? hours / totalHours : 1 / (base.counts.get(fact.projectId) || 1);
    const rate = costPerHour(fact.employee);
    const cost = hours * rate;
    const estimated = costEstimated(fact.employee);
    return {
      fact,
      hours,
      actualHours: fact.bucket === 'actual' ? hours : 0,
      allocatedHours: fact.bucket === 'allocated' ? hours : 0,
      unallocatedHours: fact.bucket === 'unallocated' ? hours : 0,
      inWindowRevenue: (project?.inWindowRevenue || 0) * share,
      contractRevenue: (project?.contractRevenue || 0) * share,
      cost,
      costed: costOverride() !== null || rate > 0,
      estimated,
    };
  });
}

function blankTotals() {
  return {
    inWindowRevenue: 0, contractRevenue: 0, hours: 0, actualHours: 0, allocatedHours: 0,
    unallocatedHours: 0, cost: 0, costedHours: 0, estimatedHours: 0, estimatedCost: 0,
    projects: new Set(), clients: new Set(), people: new Set(), rows: 0,
  };
}

function accumulate(totals, row) {
  totals.inWindowRevenue += row.inWindowRevenue;
  totals.contractRevenue += row.contractRevenue;
  totals.hours += row.hours;
  totals.actualHours += row.actualHours;
  totals.allocatedHours += row.allocatedHours;
  totals.unallocatedHours += row.unallocatedHours;
  totals.cost += row.cost;
  if (row.costed) totals.costedHours += row.hours;
  if (row.estimated) {
    totals.estimatedHours += row.hours;
    totals.estimatedCost += row.cost;
  }
  totals.projects.add(row.fact.projectId);
  totals.clients.add(row.fact.clientId);
  totals.people.add(row.fact.employee);
  totals.rows += 1;
  return totals;
}

function finalise(entry) {
  entry.profit = entry.inWindowRevenue - entry.cost;
  entry.margin = entry.inWindowRevenue > 0 ? entry.profit / entry.inWindowRevenue * 100 : 0;
  // Unallocated hours earn nothing, so they stay out of the revenue rate. That
  // keeps the rate sensitive to the department-pool toggle, which moves hours
  // between the allocated and unallocated buckets without changing the total.
  entry.deliveredHours = entry.hours - entry.unallocatedHours;
  entry.revenuePerHour = entry.deliveredHours > 0 ? entry.inWindowRevenue / entry.deliveredHours : 0;
  entry.costPerHour = entry.hours > 0 ? entry.cost / entry.hours : 0;
  entry.projectCount = entry.projects.size;
  entry.clientCount = entry.clients.size;
  entry.peopleCount = entry.people.size;
  entry.costCoverage = entry.hours > 0 ? entry.costedHours / entry.hours * 100 : 0;
  // Keep the coverage fields available for the payroll-cost coverage panel.
  entry.estimatedShare = entry.hours > 0 ? entry.estimatedHours / entry.hours * 100 : 0;
  entry.packagedHours = entry.costedHours - entry.estimatedHours;
  entry.packagedCost = entry.cost - entry.estimatedCost;
  return entry;
}

function groupBy(rows, dimension) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = row.fact[dimension] || 'Unassigned';
    if (!groups.has(key)) groups.set(key, Object.assign(blankTotals(), { key, label: key }));
    accumulate(groups.get(key), row);
  });
  return [...groups.values()].map(finalise);
}

function totalsOf(rows) {
  return finalise(rows.reduce(accumulate, blankTotals()));
}

/* ------------------------------------------------------------------ generic table */

function sortRows(rows, sort) {
  if (!sort.key) return rows;
  return [...rows].sort((a, b) => {
    const left = a[sort.key];
    const right = b[sort.key];
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * sort.dir;
    return String(left ?? '').localeCompare(String(right ?? '')) * sort.dir;
  });
}

function renderTable(config) {
  const { head, body, columns, rows, sort, sortId, rowKey, drillable, totalRow, empty } = config;
  head.innerHTML = `<tr>${columns.map((column) => {
    const sorted = sort && sort.key === column.key;
    const classes = [column.num ? 'num' : '', column.sortable === false ? '' : 'sortable', sorted ? 'sorted' : ''].filter(Boolean).join(' ');
    const arrow = sorted ? `<span class="arrow">${sort.dir === 1 ? '↑' : '↓'}</span>` : '';
    return `<th class="${classes}" data-sort-key="${esc(column.key)}" data-sort-id="${esc(sortId || '')}">${esc(column.label)}${arrow}</th>`;
  }).join('')}</tr>`;

  if (!rows.length) {
    body.innerHTML = `<tr><td class="empty" colspan="${columns.length}">${esc(empty || 'Nothing matches these filters.')}</td></tr>`;
    return;
  }

  const cells = (row) => columns.map((column) => `<td class="${column.num ? 'num ' : ''}${column.className || ''}">${column.render(row)}</td>`).join('');
  const total = totalRow ? `<tr class="total-row">${columns.map((column) => `<td class="${column.num ? 'num ' : ''}">${column.total ? column.total(totalRow) : ''}</td>`).join('')}</tr>` : '';
  body.innerHTML = rows.map((row) => `<tr class="${drillable ? 'drillable' : ''}" ${rowKey ? `data-row-key="${esc(rowKey(row))}"` : ''}>${cells(row)}</tr>`).join('') + total;
}

function bindSorting(head, sortId, onChange) {
  head.addEventListener('click', (event) => {
    const cell = event.target.closest('th.sortable');
    if (!cell) return;
    const key = cell.dataset.sortKey;
    const sort = state.sort[sortId];
    if (sort.key === key) sort.dir *= -1;
    else { sort.key = key; sort.dir = -1; }
    onChange();
  });
}

function renderPager(element, page, pageSize, total, onChange) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) { element.innerHTML = ''; return; }
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  element.innerHTML = `<span class="pager-info">${int(from)}–${int(to)} of ${int(total)}</span>
    <button data-page="0" ${page === 0 ? 'disabled' : ''}>First</button>
    <button data-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>Prev</button>
    <span class="pager-info">${page + 1} / ${pages}</span>
    <button data-page="${page + 1}" ${page >= pages - 1 ? 'disabled' : ''}>Next</button>
    <button data-page="${pages - 1}" ${page >= pages - 1 ? 'disabled' : ''}>Last</button>`;
  element.querySelectorAll('button[data-page]').forEach((button) => {
    button.addEventListener('click', () => onChange(Math.max(0, Math.min(pages - 1, Number(button.dataset.page)))));
  });
}

function renderBars(element, items, formatter) {
  const max = Math.max(...items.map((item) => item.value), 0) || 1;
  element.innerHTML = items.length ? items.map((item) => `
    <div class="bar-row">
      <div class="bar-top"><span title="${esc(item.label)}">${esc(item.label)}</span><span>${formatter(item.value)}</span></div>
      <div class="bar-track"><div class="bar-fill ${item.tone || ''}" style="width:${Math.max(1.5, item.value / max * 100)}%"></div></div>
    </div>`).join('') : '<p class="note">No data for this selection.</p>';
}

function statCard(label, value) {
  return `<div class="stat"><span>${esc(label)}</span><strong>${value}</strong></div>`;
}

function marginCell(entry) {
  if (!costReady()) return '<span class="locked">—</span>';
  const clamped = Math.max(-100, Math.min(100, entry.margin));
  const width = Math.abs(clamped);
  return `<div class="margin-cell"><span>${pct(entry.margin)}</span><div class="margin-bar"><i class="${entry.margin < 0 ? 'bad' : ''}" style="width:${width}%"></i></div></div>`;
}

function lockedMoney(value) {
  return costReady() ? money(value) : '<span class="locked">—</span>';
}

function downloadCsv(filename, columns, rows) {
  const escapeCell = (value) => {
    const cell = String(value ?? '');
    return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  };
  const header = columns.map((column) => escapeCell(column.label)).join(',');
  const body = rows.map((row) => columns.map((column) => escapeCell(column.value(row))).join(',')).join('\n');
  const blob = new Blob([`${header}\n${body}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ------------------------------------------------------------------ header + filters */

function fillSelect(element, values, allLabel) {
  const current = element.value;
  element.innerHTML = `<option value="all">${allLabel}</option>` + values.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
  if (current && [...element.options].some((option) => option.value === current)) element.value = current;
}

function uniqueValues(key) {
  return [...new Set(activeFacts().map((fact) => fact[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Rows passing every filter except the named one, so each dropdown lists only
 *  values still reachable given the other selections. Search is excluded so
 *  typing does not thin the dropdowns. */
function factsExcept(exclude) {
  const f = state.filters;
  return activeFacts().filter((fact) => {
    if (f.hideUnallocated && fact.projectId === UNALLOCATED_ID) return false;
    if (exclude !== 'client' && f.client !== 'all' && fact.client !== f.client) return false;
    if (exclude !== 'tl' && f.tl !== 'all' && fact.projectTl !== f.tl) return false;
    if (exclude !== 'employee' && f.employee !== 'all' && fact.employee !== f.employee) return false;
    if (exclude !== 'service' && f.service !== 'all' && fact.service !== f.service) return false;
    if (exclude !== 'status' && f.status !== 'all' && fact.status !== f.status) return false;
    if (exclude !== 'frequency' && f.frequency !== 'all' && fact.frequency !== f.frequency) return false;
    if (exclude !== 'revenueType' && f.revenueType !== 'all' && fact.revenueType !== f.revenueType) return false;
    if (exclude !== 'method' && f.method !== 'all' && fact.method !== f.method) return false;
    if (f.hideNonLive && ['deleted', 'future', 'next_month', 'archived'].includes(fact.status)) return false;
    if (f.hideZeroRevenue) {
      const project = state.projects.get(fact.projectId);
      if (!project || project.contractRevenue <= 0) return false;
    }
    return true;
  });
}

function uniqueValuesFor(key, exclude) {
  return [...new Set(factsExcept(exclude).map((fact) => fact[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Suggestion pool for the search box. Rebuilt whenever the filter option lists
 *  are rebuilt, so it narrows with the dropdowns without re-scanning on every
 *  keystroke. Kept as a tagged list so the dropdown can label each hit. */
const searchPool = [];
function rebuildSearchPool() {
  const facts = factsExcept(null);
  const seen = new Map();
  const add = (value, kind) => {
    if (!value) return;
    const key = `${kind}::${value}`;
    if (seen.has(key)) return;
    seen.set(key, { value, kind });
  };
  facts.forEach((fact) => {
    add(fact.client, 'Client');
    add(fact.project, 'Project');
    add(fact.projectTl, 'Team lead');
    add(fact.employee, 'Person');
  });
  searchPool.length = 0;
  [...seen.values()].sort((a, b) => a.value.localeCompare(b.value)).forEach((entry) => searchPool.push(entry));
}

function populateFilters() {
  fillSelect($('clientFilter'), uniqueValuesFor('client', 'client'), 'All clients');
  fillSelect($('tlFilter'), uniqueValuesFor('projectTl', 'tl'), 'All team leads');
  fillSelect($('employeeFilter'), uniqueValuesFor('employee', 'employee'), 'All people');
  fillSelect($('serviceFilter'), uniqueValuesFor('service', 'service'), 'All services');
  fillSelect($('statusFilter'), uniqueValuesFor('status', 'status'), 'All statuses');
  fillSelect($('frequencyFilter'), uniqueValuesFor('frequency', 'frequency'), 'All frequencies');
  fillSelect($('revenueTypeFilter'), uniqueValuesFor('revenueType', 'revenueType'), 'All revenue types');
  fillSelect($('methodFilter'), uniqueValuesFor('method', 'method'), 'All methods');
  fillSelect($('auditEmployee'), [...new Set(state.audit.map((row) => text(row.employee)))].sort(), 'All people');
  rebuildSearchPool();
}

/**
 * The window is baked into the EDA build, so editing it re-runs build_eda.py
 * with an explicit --start/--end rather than filtering in the browser.
 */
function renderWindowControl(window) {
  const dataStart = window.data_start || window.start;
  const dataEnd = window.data_end || window.end;
  [['windowStart', window.start, dataStart], ['windowEnd', window.end, dataEnd]].forEach(([id, value, bound]) => {
    const input = $(id);
    input.value = value || '';
    input.min = dataStart || '';
    input.max = dataEnd || '';
    input.dataset.full = bound || '';
  });
  $('fullWindow').disabled = !window.custom;
  setWindowStatus(window.custom
    ? `Custom window. Full timesheet history runs ${dataStart} → ${dataEnd}.`
    : `Full timesheet history: ${dataStart} → ${dataEnd}.`);
}

function setWindowStatus(message, tone = '') {
  const status = $('windowStatus');
  status.textContent = message;
  status.className = `range-status ${tone}`.trim();
}

function renderHeader() {
  const manifest = state.manifest;
  const window = manifest.window;
  $('railWindow').textContent = `${window.start} → ${window.end}`;
  renderWindowControl(window);
  $('railStamp').textContent = `Built ${manifest.generated_at.replace('T', ' ')}`;
  $('updatedAt').textContent = `Loaded ${new Date().toLocaleString()}`;

  const chip = $('costChip');
  if (costLoaded()) {
    chip.classList.add('ready');
    const carried = state.manifest.cost.carried_forward_months || [];
    const monthName = (key) => new Date(`${key.slice(0, 7)}-01T00:00:00`).toLocaleString('en', { month: 'short' });
    $('costChipText').textContent = `Payroll loaded · ${int(state.manifest.cost.matched)} / ${int(state.manifest.totals.employees)} people`
      + (carried.length ? ` · ${monthName(state.manifest.cost.last_payroll_month)} carried to ${monthName(carried.at(-1))}` : '');
    chip.title = carried.length ? state.manifest.cost.basis : '';
  } else {
    chip.classList.remove('ready');
    $('costChipText').textContent = 'Cost source not loaded';
  }
  renderCostRateStatus();
}

function renderFilterSummary(rows, totals) {
  const active = Object.entries(state.filters).filter(([key, value]) => {
    if (key === 'hoursBasis') return value !== 'all';
    if (key === 'deptAllocation') return !value;
    if (key === 'costPerHourOverride') return value !== null;
    if (typeof value === 'boolean') return value;
    return value && value !== 'all';
  }).length;
  $('filterSummary').textContent = `${int(rows.length)} rows · ${int(totals.projectCount)} projects · ${int(totals.peopleCount)} people${active ? ` · ${active} filter${active > 1 ? 's' : ''} active` : ''}`;
}

/* ------------------------------------------------------------------ overview */

function costNote(totals) {
  if (costOverride() !== null) return `Manual ${money2(costOverride())} / h rate applied to all employees; payroll CSV is overridden`;
  if (!costLoaded()) return 'Upload the monthly payroll and salary revision workbooks';
  if (!payrollCoveredDays()) return 'No payroll months overlap the selected window';
  const dateCoverage = `${int(payrollCoveredDays())} of ${int(state.manifest.window.days)} selected days`;
  if (!costReady()) return `${dateCoverage} covered; payroll costing is paused for partial windows`;
  return `${dateCoverage} covered · ${pct(totals.costCoverage)} of hours linked to payroll · ${inrToAedRate().toFixed(4)} AED per INR`;
}

function renderOverview(rows, totals) {
  const cards = [
    { label: 'In-window revenue', value: money(totals.inWindowRevenue), note: `Contract value ${money(totals.contractRevenue)}` },
    { label: 'Delivery hours', value: hoursText(totals.hours), note: `${hoursText(totals.actualHours)} actual · ${hoursText(totals.allocatedHours)} allocated` },
    { label: 'Cost', value: costReady() ? money(totals.cost) : '—', note: costNote(totals), locked: !costReady() },
    { label: 'Gross profit', value: costReady() ? money(totals.profit) : '—', note: costReady() ? `In-window revenue less ${costOverride() !== null ? 'manual-rate' : 'payroll'} cost` : 'Requires full payroll date coverage or a manual rate', locked: !costReady(), tone: costReady() ? (totals.profit >= 0 ? 'good' : 'bad') : '' },
    { label: 'Margin', value: costReady() ? pct(totals.margin) : '—', note: costReady() ? (costOverride() !== null ? 'Manual rate applied to all employees' : `Payroll-linked hours: ${pct(totals.costCoverage)}`) : 'Requires full payroll date coverage or a manual rate', locked: !costReady(), tone: costReady() ? (totals.margin >= 0 ? 'good' : 'bad') : '' },
    { label: 'Revenue / hour', value: money(totals.revenuePerHour), note: `Over ${hoursText(totals.deliveredHours)} delivered · unallocated excluded`, accent: true },
    { label: 'Unallocated hours', value: hoursText(totals.unallocatedHours), note: `${hoursText(companyUnallocatedHours())} company-wide${state.filters.deptAllocation ? '' : ' · department pool off'}`, tone: totals.unallocatedHours > 0 ? 'warn' : '' },
    { label: 'Coverage', value: `${int(totals.projectCount)} / ${int(totals.clientCount)}`, note: 'Projects / clients in view' },
  ];
  $('kpiGrid').innerHTML = cards.map((card) => `
    <article class="kpi ${card.accent ? 'accent' : ''} ${card.locked ? 'locked' : ''} ${card.tone || ''}">
      <span class="kpi-label">${esc(card.label)}</span>
      <strong>${card.value}</strong>
      <small>${esc(card.note)}</small>
    </article>`).join('');

  const methodGroups = groupBy(rows, 'method').sort((a, b) => b.hours - a.hours);
  renderBars($('methodBars'), methodGroups.map((entry) => ({
    label: entry.label,
    value: entry.hours,
    tone: entry.label === 'Actual' ? '' : entry.label.startsWith('Unallocated') ? 'bad' : 'alt',
  })), hoursText);
}

/* ------------------------------------------------------------------ drill */

function renderCrumbs(element, path, crumbs) {
  const rootSub = path.map((dimension) => DIMENSIONS[dimension].label).join(' › ');
  const levels = [{ label: 'All records', sub: rootSub }, ...crumbs.map((crumb) => ({ label: crumb.value, sub: DIMENSIONS[crumb.dim].label }))];
  element.innerHTML = levels.map((level, index) => {
    const current = index === levels.length - 1;
    return `${index ? '<span class="crumb-sep">›</span>' : ''}<button class="crumb ${current ? 'current' : ''}" data-crumb="${index}" ${current ? 'disabled' : ''}>${esc(level.label)}<small>${esc(level.sub)}</small></button>`;
  }).join('');
}

function drillColumns(dimension, isLeaf) {
  if (isLeaf) {
    return [
      { key: 'label', label: 'Contributor row', sortable: true, render: (row) => `<span class="label-main">${esc(row.fact.employee)}</span><span class="label-sub">${esc(row.fact.project)} · ${esc(row.fact.client)}</span>`, value: (row) => `${row.fact.employee} | ${row.fact.project}` },
      { key: 'method', label: 'Method', render: (row) => `${esc(row.fact.method)}${row.fact.projectId === UNALLOCATED_ID ? '<span class="tag unalloc">unallocated</span>' : ''}`, value: (row) => row.fact.method },
      { key: 'reportingTl', label: 'Reporting TL', render: (row) => esc(row.fact.reportingTl), value: (row) => row.fact.reportingTl },
      { key: 'service', label: 'Service', render: (row) => esc(row.fact.service), value: (row) => row.fact.service },
      { key: 'hours', label: 'Hours', num: true, render: (row) => hoursText(row.hours), value: (row) => row.hours.toFixed(6) },
      { key: 'inWindowRevenue', label: 'Revenue share', num: true, render: (row) => money(row.inWindowRevenue), value: (row) => row.inWindowRevenue.toFixed(2) },
      { key: 'cost', label: 'Cost', num: true, render: (row) => lockedMoney(row.cost), value: (row) => row.cost.toFixed(2) },
      { key: 'topTasks', label: 'Top tasks', render: (row) => esc(row.fact.topTasks) || '<span class="muted">—</span>', value: (row) => row.fact.topTasks },
    ];
  }
  const meta = DIMENSIONS[dimension];
  return [
    {
      key: 'label', label: meta.label, sortable: true,
      render: (row) => {
        const project = dimension === 'project' ? state.projects.get([...row.projects][0]) : null;
        const tags = dimension === 'project' && project && ['deleted', 'future', 'next_month'].includes(project.status)
          ? `<span class="tag ${project.status === 'deleted' ? 'deleted' : 'future'}">${esc(project.status)}</span>`
          : '';
        return `<span class="label-main">${esc(row.label)}${tags}</span><span class="label-sub">${int(row.projectCount)} projects · ${int(row.peopleCount)} people · ${int(row.rows)} rows</span>`;
      },
      value: (row) => row.label,
      total: () => '<strong>Total</strong>',
    },
    { key: 'inWindowRevenue', label: 'In-window revenue', num: true, render: (row) => money(row.inWindowRevenue), value: (row) => row.inWindowRevenue.toFixed(2), total: (row) => money(row.inWindowRevenue) },
    { key: 'contractRevenue', label: 'Contract value', num: true, render: (row) => `<span class="muted">${money(row.contractRevenue)}</span>`, value: (row) => row.contractRevenue.toFixed(2), total: (row) => money(row.contractRevenue) },
    { key: 'actualHours', label: 'Actual', num: true, render: (row) => hoursText(row.actualHours), value: (row) => row.actualHours.toFixed(4), total: (row) => hoursText(row.actualHours) },
    { key: 'allocatedHours', label: 'Allocated', num: true, render: (row) => hoursText(row.allocatedHours), value: (row) => row.allocatedHours.toFixed(4), total: (row) => hoursText(row.allocatedHours) },
    { key: 'unallocatedHours', label: 'Unallocated', num: true, render: (row) => row.unallocatedHours ? `<span class="tag unalloc">${hoursText(row.unallocatedHours)}</span>` : '<span class="muted">—</span>', value: (row) => row.unallocatedHours.toFixed(4), total: (row) => hoursText(row.unallocatedHours) },
    { key: 'hours', label: 'Total', num: true, render: (row) => `<strong>${hoursText(row.hours)}</strong>`, value: (row) => row.hours.toFixed(4), total: (row) => hoursText(row.hours) },
    { key: 'cost', label: 'Cost', num: true, render: (row) => lockedMoney(row.cost), value: (row) => row.cost.toFixed(2), total: (row) => lockedMoney(row.cost) },
    { key: 'profit', label: 'Gross profit', num: true, render: (row) => lockedMoney(row.profit), value: (row) => row.profit.toFixed(2), total: (row) => lockedMoney(row.profit) },
    { key: 'margin', label: 'Margin', num: true, render: marginCell, value: (row) => row.margin.toFixed(2), total: (row) => costReady() ? pct(row.margin) : '<span class="locked">—</span>' },
    { key: 'revenuePerHour', label: 'Rev / delivered h', num: true, render: (row) => money(row.revenuePerHour), value: (row) => row.revenuePerHour.toFixed(2), total: (row) => money(row.revenuePerHour) },
  ];
}

function renderDrill(rows, totals) {
  renderCrumbs($('crumbs'), DRILL_PATH, state.crumbs);
  const dimension = DRILL_PATH[state.crumbs.length];
  const isLeaf = !dimension;
  const columns = drillColumns(dimension, isLeaf);
  const entries = isLeaf ? rows : groupBy(rows, dimension);
  const sorted = sortRows(entries, state.sort.drill);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  if (state.page.drill >= pages) state.page.drill = 0;
  const slice = sorted.slice(state.page.drill * PAGE_SIZE, (state.page.drill + 1) * PAGE_SIZE);

  $('levelSummary').innerHTML = isLeaf
    ? `<span>Leaf level · <b>${int(rows.length)}</b> contributor rows</span><span>Hours <b>${hoursText(totals.hours)}</b></span><span>Revenue <b>${money(totals.inWindowRevenue)}</b></span>`
    : `<span>Grouped by <b>${esc(DIMENSIONS[dimension].label)}</b></span><span><b>${int(entries.length)}</b> groups</span><span>${esc(DIMENSIONS[dimension].sub)}</span>${state.crumbs.length < DRILL_PATH.length - 1 ? '<span class="muted">Click a row to drill in</span>' : '<span class="muted">Click a row for contributor rows</span>'}`;

  renderTable({
    head: $('drillHead'), body: $('drillBody'), columns, rows: slice,
    sort: state.sort.drill, sortId: 'drill', drillable: !isLeaf,
    rowKey: isLeaf ? null : (row) => row.key,
    totalRow: isLeaf ? null : totals,
    empty: 'No records match these filters.',
  });
  renderPager($('drillPager'), state.page.drill, PAGE_SIZE, sorted.length, (page) => { state.page.drill = page; render(); });

  $('exportDrill').onclick = () => downloadCsv(`drill_${isLeaf ? 'rows' : dimension}.csv`, columns, sorted);
}

/* ------------------------------------------------------------------ hours */

function renderHours(rows) {
  renderCrumbs($('hoursCrumbs'), HOURS_PATH, state.hoursCrumbs);
  const scoped = rows.filter((row) => state.hoursCrumbs.every((crumb) => row.fact[crumb.dim] === crumb.value));
  const totals = totalsOf(scoped);

  $('hoursStrip').innerHTML = [
    statCard('Total hours', hoursText(totals.hours)),
    statCard('Actual client', hoursText(totals.actualHours)),
    statCard('Allocated internal', hoursText(totals.allocatedHours)),
    statCard('Unallocated', hoursText(totals.unallocatedHours)),
    statCard('Allocated share', pct(totals.hours ? totals.allocatedHours / totals.hours * 100 : 0)),
    statCard('Cost coverage', costReady() ? pct(totals.costCoverage) : '—'),
  ].join('');

  const depth = state.hoursCrumbs.length;
  const dimension = HOURS_PATH[depth];
  const drillable = depth < HOURS_PATH.length - 1;
  const entries = groupBy(scoped, dimension);
  $('hoursLevelSummary').innerHTML = `<span>Grouped by <b>${esc(DIMENSIONS[dimension].label)}</b></span><span><b>${int(entries.length)}</b> groups</span><span>${esc(DIMENSIONS[dimension].sub)}</span>${drillable ? '<span class="muted">Click a row to drill in</span>' : '<span class="muted">Deepest level</span>'}`;

  const columns = [
    { key: 'label', label: DIMENSIONS[dimension].label, render: (row) => `<span class="label-main">${esc(row.label)}</span><span class="label-sub">${int(row.projectCount)} projects · ${int(row.peopleCount)} people</span>`, value: (row) => row.label, total: () => '<strong>Total</strong>' },
    { key: 'actualHours', label: 'Actual', num: true, render: (row) => hoursText(row.actualHours), value: (row) => row.actualHours.toFixed(4), total: (row) => hoursText(row.actualHours) },
    { key: 'allocatedHours', label: 'Allocated', num: true, render: (row) => hoursText(row.allocatedHours), value: (row) => row.allocatedHours.toFixed(4), total: (row) => hoursText(row.allocatedHours) },
    { key: 'unallocatedHours', label: 'Unallocated', num: true, render: (row) => row.unallocatedHours ? `<span class="tag unalloc">${hoursText(row.unallocatedHours)}</span>` : '<span class="muted">—</span>', value: (row) => row.unallocatedHours.toFixed(4), total: (row) => hoursText(row.unallocatedHours) },
    { key: 'hours', label: 'Total', num: true, render: (row) => `<strong>${hoursText(row.hours)}</strong>`, value: (row) => row.hours.toFixed(4), total: (row) => hoursText(row.hours) },
    { key: 'allocatedShare', label: 'Allocated %', num: true, render: (row) => pct(row.hours ? row.allocatedHours / row.hours * 100 : 0), value: (row) => (row.hours ? row.allocatedHours / row.hours * 100 : 0).toFixed(2) },
    { key: 'revenuePerHour', label: 'Rev / delivered h', num: true, render: (row) => money(row.revenuePerHour), value: (row) => row.revenuePerHour.toFixed(2) },
    { key: 'costPerHour', label: 'Payroll cost / logged h', num: true, render: (row) => lockedMoney(row.costPerHour), value: (row) => row.costPerHour.toFixed(2) },
  ];
  const sorted = sortRows(entries, state.sort.hours);
  renderTable({
    head: $('hoursHead'), body: $('hoursBody'), columns, rows: sorted.slice(0, 200),
    sort: state.sort.hours, sortId: 'hours', totalRow: totals,
    drillable, rowKey: drillable ? (row) => row.key : null,
    empty: 'No hours match these filters.',
  });
  $('exportHours').onclick = () => downloadCsv(`hours_by_${dimension}.csv`, columns, sorted);
}

/* ------------------------------------------------------------------ audit */

function renderAudit() {
  const filtered = state.audit.filter((row) => (state.filters.deptAllocation || text(row.allocation_method) !== DEPT_METHOD)
    && (state.auditEmployee === 'all' || text(row.employee) === state.auditEmployee));
  const rows = filtered.map((row) => ({
    employee: text(row.employee),
    method: text(row.allocation_method),
    donorProject: text(row.donor_project_name),
    donorClient: text(row.donor_client),
    donorHours: num(row.donor_history_hours),
    weight: num(row.weight_pct),
    allocatedHours: num(row.allocated_hours),
  }));
  const columns = [
    { key: 'employee', label: 'Person', render: (row) => esc(row.employee), value: (row) => row.employee },
    { key: 'method', label: 'Method', render: (row) => esc(row.method), value: (row) => row.method },
    { key: 'donorProject', label: 'Donor project', render: (row) => `<span class="label-main">${esc(row.donorProject)}</span><span class="label-sub">${esc(row.donorClient)}</span>`, value: (row) => row.donorProject },
    { key: 'donorHours', label: 'Donor history', num: true, render: (row) => hoursText(row.donorHours), value: (row) => row.donorHours.toFixed(4) },
    { key: 'weight', label: 'Weight', num: true, render: (row) => pct(row.weight), value: (row) => row.weight.toFixed(4) },
    { key: 'allocatedHours', label: 'Allocated', num: true, render: (row) => `<strong>${hoursText(row.allocatedHours)}</strong>`, value: (row) => row.allocatedHours.toFixed(6) },
  ];
  const sorted = sortRows(rows, state.sort.audit);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  if (state.page.audit >= pages) state.page.audit = 0;
  const totalAllocated = rows.reduce((sum, row) => sum + row.allocatedHours, 0);
  const deptNote = state.filters.deptAllocation ? '' : ` Department-pool weights are excluded because that allocation is switched off (${hoursText(deptPoolHours())} left unallocated).`;
  $('auditNote').textContent = (state.auditEmployee === 'all'
    ? `${int(rows.length)} weighting rows covering ${hoursText(totalAllocated)} of allocated internal time. Pick a person to see exactly which projects absorbed their internal hours.`
    : `${state.auditEmployee} spread ${hoursText(totalAllocated)} of internal time across ${int(new Set(rows.map((row) => row.donorProject)).size)} projects using their own historical mix.`) + deptNote;
  renderTable({
    head: $('auditHead'), body: $('auditBody'), columns,
    rows: sorted.slice(state.page.audit * PAGE_SIZE, (state.page.audit + 1) * PAGE_SIZE),
    sort: state.sort.audit, sortId: 'audit', empty: 'No allocation weights for this person.',
  });
  renderPager($('auditPager'), state.page.audit, PAGE_SIZE, sorted.length, (page) => { state.page.audit = page; renderAudit(); });
  $('exportAudit').onclick = () => downloadCsv('allocation_audit.csv', columns, sorted);
}

/* ------------------------------------------------------------------ internal time */

/** Category → person → client → project. Person is skipped when it is the top level. */
function internalPath() {
  const top = state.internalDimension;
  return top === 'employee' ? ['employee', 'client', 'project'] : [top, 'employee', 'client', 'project'];
}

let shareCache = { key: null, map: null };

/**
 * Each person's allocation targets and their share of that person's internal
 * time, taken from the audit weights. Lets any slice of someone's internal
 * hours be pushed down to the clients and projects that absorbed them.
 */
function allocationShares() {
  const key = `${state.filters.deptAllocation}|${state.audit.length}|${state.manifest?.generated_at || ''}`;
  if (shareCache.key === key) return shareCache.map;
  const byEmployee = new Map();
  state.audit.forEach((row) => {
    if (!state.filters.deptAllocation && text(row.allocation_method) === DEPT_METHOD) return;
    const employee = text(row.employee);
    if (!byEmployee.has(employee)) byEmployee.set(employee, { total: 0, targets: [] });
    const entry = byEmployee.get(employee);
    const hours = num(row.allocated_hours);
    entry.total += hours;
    entry.targets.push({
      project: text(row.donor_project_name) || 'Unknown project',
      client: text(row.donor_client) || 'Unknown client',
      hours,
    });
  });
  byEmployee.forEach((entry) => entry.targets.forEach((target) => {
    target.share = entry.total > 0 ? target.hours / entry.total : 0;
  }));
  shareCache = { key, map: byEmployee };
  return byEmployee;
}

/** Internal rows exploded onto the client work that absorbed them. */
function spreadInternal(rows) {
  const shares = allocationShares();
  const spread = [];
  rows.forEach((row) => {
    const employee = text(row.employee) || 'Unknown';
    const hours = num(row.hours);
    if (hours <= 0) return;
    const entry = shares.get(employee);
    if (!entry || entry.total <= 0) {
      spread.push({ employee, client: 'Unallocated / Overhead', project: 'Unallocated internal time', hours, allocated: false });
      return;
    }
    entry.targets.forEach((target) => {
      if (target.share <= 0) return;
      spread.push({ employee, client: target.client, project: target.project, hours: hours * target.share, allocated: true });
    });
  });
  return spread;
}

function groupInternal(rows, dimension, spread) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = (spread ? row[dimension] : text(row[dimension])) || 'Unassigned';
    if (!groups.has(key)) groups.set(key, { key, label: key, hours: 0, entries: 0, unallocatedHours: 0, people: new Set() });
    const group = groups.get(key);
    group.hours += spread ? row.hours : num(row.hours);
    if (spread) { if (!row.allocated) group.unallocatedHours += row.hours; } else group.entries += num(row.entries);
    group.people.add(spread ? row.employee : text(row.employee));
  });
  const entries = [...groups.values()].map((group) => ({ ...group, peopleCount: group.people.size }));
  const total = entries.reduce((sum, entry) => sum + entry.hours, 0) || 1;
  entries.forEach((entry) => { entry.share = entry.hours / total * 100; });
  return entries;
}

function renderInternalCrumbs(path) {
  const rootSub = path.map((dimension) => INTERNAL_LABELS[dimension] || dimension).join(' › ');
  const levels = [{ label: 'All internal time', sub: rootSub }, ...state.internalCrumbs.map((crumb) => ({ label: crumb.value, sub: INTERNAL_LABELS[crumb.dim] || crumb.dim }))];
  $('internalCrumbs').innerHTML = levels.map((level, index) => {
    const current = index === levels.length - 1;
    return `${index ? '<span class="crumb-sep">›</span>' : ''}<button class="crumb ${current ? 'current' : ''}" data-crumb="${index}" ${current ? 'disabled' : ''}>${esc(level.label)}<small>${esc(level.sub)}</small></button>`;
  }).join('');
}

function renderInternal() {
  const path = internalPath();
  const depth = Math.min(state.internalCrumbs.length, path.length - 1);
  const dimension = path[depth];
  // Client and project levels live on the spread rows, the shallower levels on
  // the raw internal rows, so the crumbs are applied to whichever fits.
  const rawCrumbs = state.internalCrumbs.filter((crumb) => !['client', 'project'].includes(crumb.dim));
  const spreadCrumbs = state.internalCrumbs.filter((crumb) => ['client', 'project'].includes(crumb.dim));
  const scoped = state.internal.filter((row) => rawCrumbs.every((crumb) => (text(row[crumb.dim]) || 'Unassigned') === crumb.value));
  const isSpread = depth >= path.indexOf('client');
  const rows = isSpread
    ? spreadInternal(scoped).filter((row) => spreadCrumbs.every((crumb) => row[crumb.dim] === crumb.value))
    : scoped;
  const entries = groupInternal(rows, dimension, isSpread);

  const companyHours = state.internal.reduce((sum, row) => sum + num(row.hours), 0);
  const scopedHours = rows.reduce((sum, row) => sum + (isSpread ? row.hours : num(row.hours)), 0);
  const idle = state.internal.filter((row) => /idle|no work/i.test(text(row.internal_category))).reduce((sum, row) => sum + num(row.hours), 0);
  const meetings = state.internal.filter((row) => /meeting/i.test(text(row.internal_category))).reduce((sum, row) => sum + num(row.hours), 0);
  const unallocatedHours = state.unallocated.reduce((sum, row) => sum + num(row.hours), 0)
    + (state.filters.deptAllocation ? 0 : deptPoolHours());
  $('internalStrip').innerHTML = [
    statCard('Internal hours', hoursText(companyHours)),
    statCard('Share of all logged', pct(state.manifest.totals.logged_hours ? companyHours / state.manifest.totals.logged_hours * 100 : 0)),
    statCard(depth ? 'Hours in this slice' : 'Meetings', hoursText(depth ? scopedHours : meetings)),
    statCard('Idle / no work', hoursText(idle)),
    statCard('Unallocated', hoursText(unallocatedHours)),
  ].join('');

  const label = INTERNAL_LABELS[dimension] || dimension;
  const sortedByHours = [...entries].sort((a, b) => b.hours - a.hours);
  $('internalChartTitle').textContent = `Top ${label.toLowerCase()} by internal hours`;
  renderBars($('internalBars'), sortedByHours.slice(0, 10).map((entry) => ({
    label: entry.label, value: entry.hours, tone: /idle|no work|unallocated/i.test(entry.label) ? 'bad' : /meeting/i.test(entry.label) ? 'warn' : 'alt',
  })), hoursText);

  renderInternalCrumbs(path);
  const drillable = depth < path.length - 1;
  $('internalLevelSummary').innerHTML = `<span>Grouped by <b>${esc(label)}</b></span><span><b>${int(entries.length)}</b> groups</span><span>${esc(hoursText(scopedHours))} in view</span>${drillable ? '<span class="muted">Click a row to drill in</span>' : '<span class="muted">Deepest level</span>'}`;

  const columns = [
    { key: 'label', label, render: (row) => `<span class="label-main">${esc(row.label)}</span><span class="label-sub">${int(row.peopleCount)} people</span>`, value: (row) => row.label, total: () => '<strong>Total</strong>' },
    { key: 'hours', label: 'Hours', num: true, render: (row) => hoursText(row.hours), value: (row) => row.hours.toFixed(4), total: (row) => hoursText(row.hours) },
    { key: 'share', label: 'Share', num: true, render: (row) => pct(row.share), value: (row) => row.share.toFixed(3), total: () => pct(100) },
    isSpread
      ? { key: 'unallocatedHours', label: 'Of which unallocated', num: true, render: (row) => (row.unallocatedHours ? `<span class="tag unalloc">${hoursText(row.unallocatedHours)}</span>` : '<span class="muted">—</span>'), value: (row) => row.unallocatedHours.toFixed(4) }
      : { key: 'entries', label: 'Entries', num: true, render: (row) => int(row.entries), value: (row) => row.entries, total: (row) => int(row.entries) },
    { key: 'peopleCount', label: 'People', num: true, render: (row) => int(row.peopleCount), value: (row) => row.peopleCount, total: (row) => int(row.peopleCount) },
  ];
  const sorted = sortRows(entries, state.sort.internal);
  const totalRow = {
    hours: scopedHours,
    entries: entries.reduce((sum, entry) => sum + entry.entries, 0),
    peopleCount: new Set(rows.map((row) => text(row.employee) || 'Unknown')).size,
  };
  renderTable({
    head: $('internalHead'), body: $('internalBody'), columns, rows: sorted.slice(0, 200),
    sort: state.sort.internal, sortId: 'internal', totalRow,
    drillable, rowKey: drillable ? (row) => row.key : null,
    empty: 'No internal time in this slice.',
  });
  $('exportInternal').onclick = () => downloadCsv(`internal_time_by_${dimension}.csv`, columns, sorted);
}

/* ------------------------------------------------------------------ people */

function renderPeople() {
  // With the department pool off, a person's department-allocated internal
  // hours stop reaching client projects and count as unallocated instead.
  const deptByEmployee = new Map();
  if (!state.filters.deptAllocation) {
    state.facts.forEach((fact) => {
      if (fact.method !== DEPT_METHOD) return;
      deptByEmployee.set(fact.employee, (deptByEmployee.get(fact.employee) || 0) + fact.totalHours);
    });
  }
  const mapped = state.utilisation.map((row) => {
    const employee = text(row.employee);
    const rate = costPerHour(employee);
    const totalHours = num(row.total_logged_hours);
    const payroll = state.costs.get(employee);
    const coveredPayrollDays = payroll?.coveredPayrollDays || 0;
    const windowDays = num(state.manifest?.window?.days);
    const manualRate = costOverride() !== null;
    const heldBack = deptByEmployee.get(employee) || 0;
    return {
      employee,
      department: text(row.department) || '—',
      reportingTo: text(row.reporting_to),
      inMaster: text(row.in_employee_master) === 'yes',
      clientHours: num(row.client_hours),
      internalHours: num(row.internal_hours),
      allocatedHours: Math.max(0, num(row.allocated_out_hours) - heldBack),
      unallocatedHours: num(row.unallocated_hours) + heldBack,
      totalHours,
      utilisation: num(row.utilization_pct),
      projects: num(row.projects_touched),
      nonApproved: num(row.nonapproved_hours),
      employeeNumber: text(row.employee_number),
      coveredPayrollDays,
      revisionAdjustedMonths: payroll?.revisionAdjustedMonths || 0,
      windowDays,
      hasPayroll: coveredPayrollDays > 0,
      hasCost: manualRate || (costReady() && coveredPayrollDays > 0),
      payrollGap: coveredPayrollDays < windowDays,
      payrollMatch: payroll?.costSource === 'employee name' ? 'Name fallback'
        : payroll?.costSource === 'employee number' ? 'Employee number' : 'No match',
      rate,
      cost: manualRate ? rate * totalHours : (payroll?.windowCostInr || 0) * inrToAedRate(),
    };
  });
  const scopes = {
    all: () => true,
    unallocated: (row) => row.unallocatedHours > 0,
    nomaster: (row) => !row.inMaster,
    nocost: (row) => row.payrollGap,
  };
  const rows = mapped.filter(scopes[state.peopleScope]);
  const columns = [
    { key: 'employee', label: 'Person', render: (row) => `<span class="label-main">${esc(row.employee)}${row.inMaster ? '' : '<span class="tag norev">not in master</span>'}</span><span class="label-sub">${esc(row.department)}${row.reportingTo ? ` · reports to ${esc(row.reportingTo)}` : ' · no reporting line'}</span>`, value: (row) => row.employee },
    { key: 'employeeNumber', label: 'Employee number', render: (row) => row.employeeNumber || '<span class="muted">—</span>', value: (row) => row.employeeNumber },
    { key: 'payrollMatch', label: 'Payroll match', render: (row) => row.hasPayroll ? esc(row.payrollMatch) : '<span class="muted">No match</span>', value: (row) => row.payrollMatch },
    { key: 'coveredPayrollDays', label: 'Payroll coverage', num: true, render: (row) => `${int(row.coveredPayrollDays)} / ${int(row.windowDays)} days`, value: (row) => row.coveredPayrollDays },
    { key: 'revisionAdjustedMonths', label: 'Revised months', num: true, render: (row) => row.revisionAdjustedMonths ? int(row.revisionAdjustedMonths) : '<span class="muted">—</span>', value: (row) => row.revisionAdjustedMonths },
    { key: 'clientHours', label: 'Client', num: true, render: (row) => hoursText(row.clientHours), value: (row) => row.clientHours.toFixed(4) },
    { key: 'internalHours', label: 'Internal', num: true, render: (row) => hoursText(row.internalHours), value: (row) => row.internalHours.toFixed(4) },
    { key: 'allocatedHours', label: 'Allocated', num: true, render: (row) => (row.allocatedHours ? hoursText(row.allocatedHours) : '<span class="muted">—</span>'), value: (row) => row.allocatedHours.toFixed(4) },
    { key: 'unallocatedHours', label: 'Unallocated', num: true, render: (row) => row.unallocatedHours ? `<span class="tag unalloc">${hoursText(row.unallocatedHours)}</span>` : '<span class="muted">—</span>', value: (row) => row.unallocatedHours.toFixed(4) },
    { key: 'totalHours', label: 'Total', num: true, render: (row) => `<strong>${hoursText(row.totalHours)}</strong>`, value: (row) => row.totalHours.toFixed(4) },
    { key: 'utilisation', label: 'Utilisation', num: true, render: (row) => pct(row.utilisation), value: (row) => row.utilisation.toFixed(2) },
    { key: 'projects', label: 'Projects', num: true, render: (row) => int(row.projects), value: (row) => row.projects },
    { key: 'nonApproved', label: 'Non-approved', num: true, render: (row) => row.nonApproved ? hoursText(row.nonApproved) : '<span class="muted">—</span>', value: (row) => row.nonApproved.toFixed(4) },
    { key: 'cost', label: 'Cost (AED)', num: true, render: (row) => row.hasCost ? money(row.cost) : '<span class="locked">—</span>', value: (row) => row.cost.toFixed(2) },
    { key: 'rate', label: 'Cost / h', num: true, render: (row) => row.hasCost ? money2(row.rate) : '<span class="locked">—</span>', value: (row) => row.rate.toFixed(4) },
  ];
  const sorted = sortRows(rows, state.sort.people);
  const revisedMonths = rows.reduce((sum, row) => sum + row.revisionAdjustedMonths, 0);
  $('peopleNote').textContent = `${int(rows.length)} people · ${int(revisedMonths)} employee-months adjusted from approved salary revisions. Click a person to open their breakdown.`;
  renderTable({
    head: $('peopleHead'), body: $('peopleBody'), columns, rows: sorted,
    sort: state.sort.people, sortId: 'people', drillable: true, rowKey: (row) => row.employee,
    empty: 'No people match this scope.',
  });
  $('exportPeople').onclick = () => downloadCsv('people.csv', columns, sorted);
  renderPersonDrill(mapped.find((row) => row.employee === state.peopleFocus) || null);
  renderSalaryRevisions();
}

function renderSalaryRevisions() {
  const end = state.manifest?.window?.end || '';
  const rows = state.revisions
    .filter((row) => row.effective_from <= end)
    .sort((left, right) => right.effective_from.localeCompare(left.effective_from));
  $('revisionNote').textContent = `${int(rows.length)} approved changes effective on or before ${end || 'the selected period'}. Payroll Total already reflects these changes; revisions are shown for audit, not added again.`;
  $('revisionHead').innerHTML = '<tr><th>Effective from</th><th>Employee</th><th>Employee number</th><th>Previous regular salary (INR)</th><th>Revised regular salary (INR)</th></tr>';
  $('revisionBody').innerHTML = rows.length
    ? rows.map((row) => `<tr><td>${esc(row.effective_from)}</td><td>${esc(row.employee)}</td><td>${esc(row.employee_number)}</td><td>${moneyInr(num(row.previous_regular_salary_inr))}</td><td>${moneyInr(num(row.revised_regular_salary_inr))}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No approved revisions in this period.</td></tr>';
}

/**
 * Per-person deep dive: team lead → client → project, built from the same
 * revenue-shared fact rows as the drill-downs so a person's slice of project
 * revenue and cost stays consistent with the rest of the dashboard.
 */
function renderPersonDrill(person) {
  const drawer = $('peopleDrill');
  if (!person) { drawer.hidden = true; drawer.innerHTML = ''; return; }
  const scoped = state.visible.filter((row) => row.fact.employee === person.employee
    && state.peopleCrumbs.every((crumb) => row.fact[crumb.dim] === crumb.value));
  const totals = totalsOf(scoped);
  const depth = Math.min(state.peopleCrumbs.length, PEOPLE_PATH.length - 1);
  const dimension = PEOPLE_PATH[depth];
  const drillable = depth < PEOPLE_PATH.length - 1;
  const entries = groupBy(scoped, dimension);

  drawer.hidden = false;
  drawer.innerHTML = `<div class="drawer-head">
      <div><h3>${esc(person.employee)}</h3>
        <p>${esc(person.department)}${person.reportingTo ? ` · reports to ${esc(person.reportingTo)}` : ' · no reporting line'}</p>
        <p>${hoursText(person.totalHours)} logged · ${hoursText(person.internalHours)} internal · ${hoursText(person.allocatedHours)} allocated onto projects · ${hoursText(person.unallocatedHours)} unallocated</p></div>
      <div class="block-tools"><button class="ghost small" id="personExport" type="button">Export</button><button class="ghost small" id="personClose" type="button">Close</button></div>
    </div>
    <div class="crumbs" id="personCrumbs"></div>
    <div class="stat-strip" id="personStrip"></div>
    <div class="level-summary" id="personLevelSummary"></div>
    <div class="table-scroll"><table class="grid"><thead id="personHead"></thead><tbody id="personBody"></tbody></table></div>`;

  const levels = [{ label: person.employee, sub: PEOPLE_PATH.map((dim) => DIMENSIONS[dim].label).join(' › ') },
    ...state.peopleCrumbs.map((crumb) => ({ label: crumb.value, sub: DIMENSIONS[crumb.dim].label }))];
  $('personCrumbs').innerHTML = levels.map((level, index) => {
    const current = index === levels.length - 1;
    return `${index ? '<span class="crumb-sep">›</span>' : ''}<button class="crumb ${current ? 'current' : ''}" data-crumb="${index}" ${current ? 'disabled' : ''}>${esc(level.label)}<small>${esc(level.sub)}</small></button>`;
  }).join('');

  $('personStrip').innerHTML = [
    statCard('Hours in view', hoursText(totals.hours)),
    statCard('Actual client', hoursText(totals.actualHours)),
    statCard('Allocated internal', hoursText(totals.allocatedHours)),
    statCard('Unallocated', hoursText(totals.unallocatedHours)),
    statCard('Revenue share', money(totals.inWindowRevenue)),
    statCard('Cost', costReady() ? money(totals.cost) : '—'),
  ].join('');
  $('personLevelSummary').innerHTML = `<span>Grouped by <b>${esc(DIMENSIONS[dimension].label)}</b></span><span><b>${int(entries.length)}</b> groups</span><span>${esc(DIMENSIONS[dimension].sub)}</span>${drillable ? '<span class="muted">Click a row to drill in</span>' : '<span class="muted">Deepest level</span>'}`;

  const columns = [
    { key: 'label', label: DIMENSIONS[dimension].label, render: (row) => `<span class="label-main">${esc(row.label)}</span><span class="label-sub">${int(row.projectCount)} projects · ${int(row.rows)} rows</span>`, value: (row) => row.label, total: () => '<strong>Total</strong>' },
    { key: 'actualHours', label: 'Actual', num: true, render: (row) => hoursText(row.actualHours), value: (row) => row.actualHours.toFixed(4), total: (row) => hoursText(row.actualHours) },
    { key: 'allocatedHours', label: 'Allocated', num: true, render: (row) => hoursText(row.allocatedHours), value: (row) => row.allocatedHours.toFixed(4), total: (row) => hoursText(row.allocatedHours) },
    { key: 'unallocatedHours', label: 'Unallocated', num: true, render: (row) => (row.unallocatedHours ? `<span class="tag unalloc">${hoursText(row.unallocatedHours)}</span>` : '<span class="muted">—</span>'), value: (row) => row.unallocatedHours.toFixed(4), total: (row) => hoursText(row.unallocatedHours) },
    { key: 'hours', label: 'Total', num: true, render: (row) => `<strong>${hoursText(row.hours)}</strong>`, value: (row) => row.hours.toFixed(4), total: (row) => hoursText(row.hours) },
    { key: 'inWindowRevenue', label: 'Revenue share', num: true, render: (row) => money(row.inWindowRevenue), value: (row) => row.inWindowRevenue.toFixed(2), total: (row) => money(row.inWindowRevenue) },
    { key: 'cost', label: 'Cost', num: true, render: (row) => lockedMoney(row.cost), value: (row) => row.cost.toFixed(2), total: (row) => lockedMoney(row.cost) },
  ];
  const sorted = sortRows(entries, state.sort.peopleDrill);
  renderTable({
    head: $('personHead'), body: $('personBody'), columns, rows: sorted,
    sort: state.sort.peopleDrill, sortId: 'peopleDrill', totalRow: totals,
    drillable, rowKey: drillable ? (row) => row.key : null,
    empty: 'No hours for this person under the current filters.',
  });

  $('personClose').addEventListener('click', () => {
    state.peopleFocus = null;
    state.peopleCrumbs = [];
    renderPeople();
  });
  $('personExport').addEventListener('click', () => downloadCsv(`${person.employee.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_by_${dimension}.csv`, columns, sorted));
  $('personCrumbs').addEventListener('click', (event) => {
    const crumb = event.target.closest('[data-crumb]');
    if (!crumb) return;
    state.peopleCrumbs = state.peopleCrumbs.slice(0, Number(crumb.dataset.crumb));
    renderPeople();
  });
  $('personBody').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-row-key]');
    if (!row || !drillable) return;
    state.peopleCrumbs.push({ dim: dimension, value: row.dataset.rowKey });
    state.sort.peopleDrill = { key: 'hours', dir: -1 };
    renderPeople();
  });
  bindSorting($('personHead'), 'peopleDrill', renderPeople);
}

/* ------------------------------------------------------------------ clustering */

const CLUSTER_K_MIN = 2;
const CLUSTER_K_MAX = 8;
const CLUSTER_SEED = 0x9e3779b9;
const CLUSTER_ITERATIONS = 50;
const CLUSTER_MIN_POINTS = 4;
const RATE_LABELS = { high: 'High rate', par: 'Standard rate', low: 'Low rate' };

/** Rank 0 becomes A, 1 becomes B, and so on. k never exceeds CLUSTER_K_MAX, so
 *  the alphabet cannot run out, but the fallback keeps the label unique if it
 *  ever did. */
function clusterLetter(rank) {
  return rank < 26 ? String.fromCharCode(65 + rank) : `#${rank + 1}`;
}

/**
 * Deterministic PRNG, so the same filter set always produces the same clusters.
 * A dashboard whose cluster membership reshuffles on every re-render cannot be
 * reasoned about, which rules out Math.random for the k-means++ seeding.
 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distanceSq(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = a[i] - b[i];
    sum += delta * delta;
  }
  return sum;
}

/**
 * Feature matrix for the client clustering, two dimensions: revenue and
 * delivered hours.
 *
 * log1p comes first because both are heavily right-skewed — a handful of anchor
 * clients would otherwise define every centroid on their own and the remaining
 * clusters would just be noise around zero. The z-score comes second so AED
 * figures do not swamp the hours axis purely because they are numerically
 * larger.
 */
function clusterFeatures(entries) {
  const raw = entries.map((entry) => [
    Math.log1p(Math.max(0, entry.inWindowRevenue)),
    Math.log1p(Math.max(0, entry.deliveredHours)),
  ]);
  const stats = [0, 1].map((dimension) => {
    const column = raw.map((point) => point[dimension]);
    const mean = column.reduce((sum, value) => sum + value, 0) / (column.length || 1);
    const variance = column.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (column.length || 1);
    return { mean, sd: Math.sqrt(variance) || 1 };
  });
  return raw.map((point) => point.map((value, dimension) => (value - stats[dimension].mean) / stats[dimension].sd));
}

/** k-means++ seeding followed by Lloyd iterations. */
function kmeans(points, k, random) {
  const centroids = [points[Math.floor(random() * points.length)].slice()];
  while (centroids.length < k) {
    // k-means++: each further seed is drawn with probability proportional to its
    // squared distance from the nearest seed already chosen, which keeps the
    // starting centroids spread out instead of clumped in the dense low end.
    const weights = points.map((point) => Math.min(...centroids.map((centroid) => distanceSq(point, centroid))));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) break;
    let target = random() * total;
    let picked = points.length - 1;
    for (let index = 0; index < points.length; index += 1) {
      target -= weights[index];
      if (target <= 0) { picked = index; break; }
    }
    centroids.push(points[picked].slice());
  }

  let assignments = new Array(points.length).fill(0);
  for (let pass = 0; pass < CLUSTER_ITERATIONS; pass += 1) {
    let moved = false;
    points.forEach((point, index) => {
      let best = 0;
      let bestDistance = Infinity;
      centroids.forEach((centroid, cluster) => {
        const distance = distanceSq(point, centroid);
        if (distance < bestDistance) { bestDistance = distance; best = cluster; }
      });
      if (assignments[index] !== best) { assignments[index] = best; moved = true; }
    });
    const sums = centroids.map(() => [0, 0]);
    const counts = centroids.map(() => 0);
    points.forEach((point, index) => {
      const cluster = assignments[index];
      sums[cluster][0] += point[0];
      sums[cluster][1] += point[1];
      counts[cluster] += 1;
    });
    counts.forEach((count, cluster) => {
      if (count) centroids[cluster] = [sums[cluster][0] / count, sums[cluster][1] / count];
    });
    if (!moved && pass > 0) break;
  }

  const inertia = points.reduce((sum, point, index) => sum + distanceSq(point, centroids[assignments[index]]), 0);
  return { assignments, centroids, inertia };
}

/**
 * Centroid-based simplified silhouette, in -1..1.
 *
 * Each point's distance to its own centroid is compared against its distance to
 * the nearest rival centroid. The textbook silhouette compares against every
 * other point instead, which is O(n squared) — at over a thousand clients,
 * recomputed for each candidate k on every render, that is too slow to sit
 * behind a filter box. This form is O(n*k) and picks the same k in practice.
 */
function simplifiedSilhouette(points, assignments, centroids) {
  if (centroids.length < 2) return 0;
  let total = 0;
  points.forEach((point, index) => {
    const own = Math.sqrt(distanceSq(point, centroids[assignments[index]]));
    let nearest = Infinity;
    centroids.forEach((centroid, cluster) => {
      if (cluster === assignments[index]) return;
      nearest = Math.min(nearest, Math.sqrt(distanceSq(point, centroid)));
    });
    const divisor = Math.max(own, nearest);
    total += divisor > 0 ? (nearest - own) / divisor : 0;
  });
  return total / points.length;
}

let clusterCache = { key: null, result: null };

/**
 * Cluster clients on revenue and delivered hours, choosing k by silhouette.
 *
 * `requestedK` of null sweeps k and takes the best-scoring one; a number pins it
 * so the shape of a specific k can be inspected. Either way the score for every
 * candidate k is returned, so the page can show why the chosen k won rather
 * than just asserting it.
 */
function clusterClients(entries, requestedK) {
  const key = `${requestedK}|${entries.length}|${JSON.stringify(state.filters)}|${JSON.stringify(state.crumbs)}`;
  if (clusterCache.key === key) return clusterCache.result;

  const overallRate = (() => {
    const revenue = entries.reduce((sum, entry) => sum + entry.inWindowRevenue, 0);
    const hours = entries.reduce((sum, entry) => sum + entry.deliveredHours, 0);
    return hours > 0 ? revenue / hours : 0;
  })();

  const decorate = (groups, k, note) => {
    const clusters = groups.map((members, index) => {
      const revenue = members.reduce((sum, entry) => sum + entry.inWindowRevenue, 0);
      const delivered = members.reduce((sum, entry) => sum + entry.deliveredHours, 0);
      return {
        index,
        entries: members,
        size: members.length,
        revenue,
        delivered,
        hours: members.reduce((sum, entry) => sum + entry.hours, 0),
        cost: members.reduce((sum, entry) => sum + entry.cost, 0),
        revenuePerHour: delivered > 0 ? revenue / delivered : 0,
        medianRevenue: median(members.map((entry) => entry.inWindowRevenue)),
        medianHours: median(members.map((entry) => entry.deliveredHours)),
      };
    }).filter((cluster) => cluster.size > 0);

    // Rank by median revenue so the ordering follows the data rather than the
    // arbitrary order k-means happened to converge in, then name each cluster
    // from its own position against the company medians. Naming by rank alone
    // would call a zero-revenue cluster "mid-market" purely for placing third.
    const ranked = [...clusters].sort((a, b) => b.medianRevenue - a.medianRevenue);
    // Clusters with no revenue at all always sort last, so the revenue-bearing
    // ones occupy the front of the list and the tier word can come from position
    // within them. Naming from position rather than from a threshold keeps the
    // letter and the word telling the same story: B is never smaller than C.
    const earning = ranked.filter((cluster) => cluster.medianRevenue > 0).length;
    ranked.forEach((cluster, rank) => {
      const zero = cluster.medianRevenue <= 0;
      const ratio = overallRate > 0 ? cluster.revenuePerHour / overallRate : 1;
      const tier = zero ? 'Zero revenue'
        : rank === 0 ? 'Top revenue'
          : rank === earning - 1 ? 'Small revenue'
            : 'Mid revenue';
      cluster.rank = rank;
      cluster.tier = tier;
      // Rate is what the old label called "yield": revenue per delivered hour
      // against the company average. It lives on the object rather than in the
      // name so the name stays short and the card can spell the rule out. A
      // cluster with no revenue has no rate to report, only a rate of zero.
      cluster.rate = zero ? null : ratio >= 1.25 ? 'high' : ratio <= 0.8 ? 'low' : 'par';
      cluster.rateLabel = cluster.rate ? RATE_LABELS[cluster.rate] : '';
      cluster.rateRatio = ratio;
      // Two clusters can land in the same tier; the rank letter is unique by
      // construction, so it carries the identity and the tier just describes.
      cluster.letter = clusterLetter(rank);
      cluster.label = `${cluster.letter} - ${tier}`;
    });

    const byKey = new Map();
    ranked.forEach((cluster) => cluster.entries.forEach((entry) => byKey.set(entry.key, cluster)));
    const result = { clusters: ranked, byKey, k, note, requestedK };
    clusterCache = { key, result };
    return result;
  };

  if (entries.length < CLUSTER_MIN_POINTS) {
    return decorate([entries], entries.length ? 1 : 0,
      `Only ${int(entries.length)} client${entries.length === 1 ? '' : 's'} in view — too few to cluster, so all of them sit in one group.`);
  }

  const points = clusterFeatures(entries);
  const maxK = Math.min(CLUSTER_K_MAX, entries.length - 1);
  const candidates = [];
  for (let k = CLUSTER_K_MIN; k <= maxK; k += 1) {
    const fit = kmeans(points, k, mulberry32(CLUSTER_SEED));
    candidates.push({ k, fit, silhouette: simplifiedSilhouette(points, fit.assignments, fit.centroids), inertia: fit.inertia });
  }
  if (!candidates.length) {
    return decorate([entries], 1, 'Not enough spread in revenue and hours to separate the clients.');
  }

  const best = requestedK
    ? candidates.find((candidate) => candidate.k === requestedK) || candidates[0]
    : candidates.reduce((winner, candidate) => (candidate.silhouette > winner.silhouette ? candidate : winner), candidates[0]);
  const groups = best.fit.centroids.map(() => []);
  best.fit.assignments.forEach((cluster, index) => groups[cluster].push(entries[index]));
  const elbow = candidates.length > 1 ? 1 - best.fit.inertia / candidates[0].inertia : 0;
  const note = requestedK
    ? `k pinned to ${best.k} by hand · silhouette ${dec(best.silhouette, 3)}`
    : `k = ${best.k} chosen by the best silhouette (${dec(best.silhouette, 3)}) across k = ${CLUSTER_K_MIN}–${maxK} · ${pct(elbow * 100)} of the k=${CLUSTER_K_MIN} spread explained away`;
  return decorate(groups, best.k, note);
}

/* ------------------------------------------------------------------ client summary */

const OVERHEAD_CLIENT = 'Unallocated / Overhead';

/**
 * Payroll cost panel with date and employee coverage.
 */
function renderBlendedCost(totals) {
  const uncovered = Math.max(0, totals.hours - totals.costedHours);
  const share = (hours) => (totals.hours > 0 ? hours / totals.hours * 100 : 0);
  const fx = inrToAedRate();
  const coveredDays = payrollCoveredDays();
  const windowDays = num(state.manifest?.window?.days);

  $('blendFigures').innerHTML = [
    statCard('Cost source', costOverride() !== null ? 'Manual rate' : 'Payroll CSV'),
    statCard('Cost in view · AED', costReady() ? money(totals.cost) : '—'),
    statCard('INR → AED', `${fx.toFixed(4)} AED / INR`),
    statCard('Date coverage', costOverride() !== null ? 'Not required' : `${int(coveredDays)} / ${int(windowDays)} days`),
  ].join('');

  const segments = costReady() ? [
    { label: costOverride() !== null ? 'Costed at manual rate' : 'Linked to payroll', hours: totals.costedHours, tone: '' },
    { label: 'No matched payroll', hours: costOverride() !== null ? 0 : uncovered, tone: 'bad' },
  ].filter((segment) => segment.hours > 1e-4) : [];

  $('costCoverage').innerHTML = segments.length
    ? `<div class="coverage-bar">${segments.map((segment) => `<div class="coverage-seg ${segment.tone}" style="width:${share(segment.hours)}%" title="${esc(segment.label)}: ${hoursText(segment.hours)}"></div>`).join('')}</div>
       <div class="coverage-legend">${segments.map((segment) => `<span class="coverage-key ${segment.tone}">${esc(segment.label)} · ${hoursText(segment.hours)} (${pct(share(segment.hours))})</span>`).join('')}</div>`
    : `<p class="note">${costReady() ? 'No hours in view.' : 'Employee coverage is shown after the selected date range is fully covered.'}</p>`;

  const note = $('blendNote');
  if (costOverride() !== null) {
    note.textContent = `Manual rate ${money2(costOverride())} per hour is applied to all employees and overrides the payroll CSV. Select Use payroll CSV to return to imported monthly costs.`;
  } else if (!costLoaded()) {
    note.textContent = 'Monthly payroll data is not loaded. Add the payroll and approved salary revision workbooks under Sources.';
  } else if (coveredDays < windowDays) {
    note.textContent = `Payroll covers ${int(coveredDays)} of ${int(windowDays)} selected days. Cost, profit and margin are unavailable until the entire date window is covered.`;
  } else if (uncovered > 1e-4) {
    note.textContent = `${hoursText(uncovered)} (${pct(share(uncovered))}) have no matched employee payroll rows. They are excluded from cost, which may overstate profit and margin.`;
  } else {
    const revisedMonths = int(state.manifest?.cost?.revision_adjusted_months || 0);
    note.textContent = `Monthly payroll and revised costs are converted from INR to AED at ${fx.toFixed(4)} AED per INR. ${revisedMonths} employee-months use effective-dated revisions where Total still matched the old salary base.`;
  }
}

function renderClusterPanel(clustering) {
  $('clusterCards').innerHTML = clustering.clusters.length
    ? clustering.clusters.map((cluster) => `
      <button class="cluster-card ${state.clientCluster === cluster.label ? 'active' : ''}" data-cluster="${esc(cluster.label)}" type="button">
        <span class="cluster-name">${esc(cluster.label)}${cluster.rate ? `<span class="rate-pill ${cluster.rate}">${esc(cluster.rateLabel)}</span>` : ''}</span>
        <strong>${int(cluster.size)} client${cluster.size === 1 ? '' : 's'}</strong>
        <small>${money(cluster.revenue)} · ${hoursText(cluster.delivered)} delivered</small>
        <small>${cluster.rate
          ? `${money(cluster.revenuePerHour)} / delivered h · ${pct(cluster.rateRatio * 100)} of average`
          : 'Hours logged, nothing booked against them'}</small>
        <small class="muted">median ${money(cluster.medianRevenue)} · ${hoursText(cluster.medianHours)}</small>
      </button>`).join('')
    : '<p class="note">No clients in view to cluster.</p>';

  $('clusterNote').textContent = `${clustering.note}${state.clientCluster ? ` · showing only ${state.clientCluster}, click the card again to clear` : ''}`;
}

function clientColumns(dimension, isLeaf) {
  const columns = drillColumns(dimension, isLeaf);
  if (dimension !== 'client') return columns;
  const cluster = {
    key: 'cluster', label: 'Cluster',
    render: (row) => (row.cluster === OVERHEAD_CLIENT
      ? '<span class="muted">overhead</span>'
      : `<span class="tag cluster">${esc(row.cluster)}</span>`),
    value: (row) => row.cluster,
  };
  return [columns[0], cluster, ...columns.slice(1)];
}

function renderClients(rows) {
  // Clusters are built from the full filtered set at client grain, before the
  // drill narrows it, so descending into one client does not re-cluster the
  // company around it.
  const clientEntries = groupBy(rows, 'client');
  const clustering = clusterClients(clientEntries.filter((entry) => entry.key !== OVERHEAD_CLIENT), state.clusterK);
  const clusterOf = (client) => clustering.byKey.get(client)?.label || OVERHEAD_CLIENT;
  renderClusterPanel(clustering);

  const scoped = rows.filter((row) => state.clientCrumbs.every((crumb) => row.fact[crumb.dim] === crumb.value)
    && (state.clientCluster === null || clusterOf(row.fact.client) === state.clientCluster));
  const totals = totalsOf(scoped);

  $('clientStrip').innerHTML = [
    statCard('In-window revenue', money(totals.inWindowRevenue)),
    statCard('Delivered hours', hoursText(totals.deliveredHours)),
    statCard('Payroll cost / h', costReady() ? money2(totals.costPerHour) : '—'),
    statCard('Cost', lockedMoney(totals.cost)),
    statCard('Gross profit', lockedMoney(totals.profit)),
    statCard('Margin', costReady() ? pct(totals.margin) : '—'),
    statCard('Revenue / delivered h', money(totals.revenuePerHour)),
    statCard('Clients', int(totals.clientCount)),
  ].join('');
  renderBlendedCost(totals);

  renderCrumbs($('clientCrumbs'), CLIENT_PATH, state.clientCrumbs);
  const dimension = CLIENT_PATH[state.clientCrumbs.length];
  const isLeaf = !dimension;
  const columns = clientColumns(dimension, isLeaf);
  const entries = isLeaf ? scoped : groupBy(scoped, dimension);
  if (dimension === 'client') entries.forEach((entry) => { entry.cluster = clusterOf(entry.key); });
  const sorted = sortRows(entries, state.sort.clients);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  if (state.page.clients >= pages) state.page.clients = 0;
  const slice = sorted.slice(state.page.clients * PAGE_SIZE, (state.page.clients + 1) * PAGE_SIZE);

  $('clientLevelSummary').innerHTML = isLeaf
    ? `<span>Leaf level · <b>${int(scoped.length)}</b> contributor rows</span><span>Hours <b>${hoursText(totals.hours)}</b></span><span>Revenue <b>${money(totals.inWindowRevenue)}</b></span>`
    : `<span>Grouped by <b>${esc(DIMENSIONS[dimension].label)}</b></span><span><b>${int(entries.length)}</b> groups</span><span>${esc(DIMENSIONS[dimension].sub)}</span>${state.clientCrumbs.length < CLIENT_PATH.length - 1 ? '<span class="muted">Click a row to drill in</span>' : '<span class="muted">Click a row for contributor rows</span>'}`;

  renderTable({
    head: $('clientHead'), body: $('clientBody'), columns, rows: slice,
    sort: state.sort.clients, sortId: 'clients', drillable: !isLeaf,
    rowKey: isLeaf ? null : (row) => row.key,
    totalRow: isLeaf ? null : totals,
    empty: 'No clients match these filters.',
  });
  renderPager($('clientPager'), state.page.clients, PAGE_SIZE, sorted.length, (page) => { state.page.clients = page; render(); });
  $('exportClients').onclick = () => downloadCsv(`clients_${isLeaf ? 'rows' : dimension}.csv`, columns, sorted);

  renderClientEda(rows, clusterOf);
}

/* ------------------------------------------------------------------ client EDA tree */

/** The fact dimension behind each level of the breakdown, outermost first. */
const EDA_LEVELS = [
  { dim: 'client', kind: 'client' },
  { dim: 'project', kind: 'project' },
  { dim: 'projectTl', kind: 'tl' },
  { dim: 'employee', kind: 'person' },
];

/** Every kind of row the breakdown can produce, the four levels plus the three
 *  rolled-up lines. Doubles as the Level column in the export. */
const EDA_LABELS = {
  client: 'Client', project: 'Project', tl: 'Team lead', person: 'Submitted by',
  projectTotal: 'Project total', clientTotal: 'Client total', grandTotal: 'Grand total',
};

/**
 * The column a row is *about*, as opposed to the ones it inherits from its
 * parents. Only used to dim the inherited cells; a total belongs to the level
 * it closes, which is the column its numbers are a total of.
 */
const EDA_COLUMN_OF = {
  client: 'client', project: 'project', tl: 'tl', person: 'person',
  projectTotal: 'project', clientTotal: 'client', grandTotal: 'client',
};

const EDA_EXPORT_COLUMNS = [
  { label: 'Level', value: (row) => EDA_LABELS[row.kind] },
  { label: 'Client', value: (row) => row.client },
  { label: 'Project', value: (row) => row.project },
  { label: 'Team lead', value: (row) => row.tl },
  { label: 'Submitted by', value: (row) => row.person },
  { label: 'Cluster', value: (row) => row.cluster },
  { label: 'Hours', value: (row) => row.hours.toFixed(4) },
  { label: 'Revenue', value: (row) => row.revenue.toFixed(2) },
  { label: 'Cost', value: (row) => (row.costed ? row.cost.toFixed(2) : '') },
];

/**
 * Split rows by one dimension without rolling them up.
 *
 * groupBy collapses each bucket into a totals object, which loses the rows the
 * next level down needs. Partitioning once per level keeps the whole walk
 * linear in the number of rows rather than rows times groups.
 */
function partitionBy(rows, dimension) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = row.fact[dimension] || 'Unassigned';
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  });
  return groups;
}

/** Client → Project → Team lead → Submitted by, each node carrying its own
 *  totals, ordered by revenue so the biggest contributor leads every group. */
function edaNodes(rows, depth) {
  if (depth >= EDA_LEVELS.length) return [];
  const level = EDA_LEVELS[depth];
  const nodes = [];
  partitionBy(rows, level.dim).forEach((members, key) => {
    nodes.push({ kind: level.kind, key, totals: totalsOf(members), children: edaNodes(members, depth + 1) });
  });
  return nodes.sort((a, b) => b.totals.inWindowRevenue - a.totals.inWindowRevenue
    || b.totals.hours - a.totals.hours
    || String(a.key).localeCompare(String(b.key)));
}

/**
 * Flatten the tree into the display rows, one per line on screen and one per
 * line in the export, in the same order.
 *
 * Every row carries the whole path above it rather than just its own name, and
 * every cell it can fill, it fills. Suppressing the repeats would read better on
 * screen, but a column that only holds a value on the first row of each group is
 * useless to a spreadsheet: sorting it scrambles the association, and filtering
 * or pivoting on it drops every row that inherited its value from above. So the
 * table on screen is the same rectangle as the export, and can be copied
 * straight out of the page into a sheet.
 */
function edaFlatRows(rows, clusterOf) {
  const out = [];
  const push = (kind, path, totals) => out.push({
    kind,
    client: path.client || '',
    project: path.project || '',
    tl: path.tl || '',
    person: path.person || '',
    // The cluster belongs to the client, so every row underneath one inherits
    // it. That is what makes it usable as a pivot field in a sheet.
    cluster: path.client ? clusterOf(path.client) : '',
    hours: totals.hours,
    revenue: totals.inWindowRevenue,
    cost: totals.cost,
    // Blank cost cell when the group has no matched payroll hours.
    costed: costReady() && totals.costedHours > 0,
  });

  const walk = (nodes, trail) => {
    nodes.forEach((node) => {
      const path = { ...trail, [node.kind]: node.key };
      push(node.kind, path, node.totals);
      walk(node.children, path);
      // Rolled-up rows repeat the numbers already on the group's own line. They
      // stay because they are what makes the file readable on its own, and the
      // Level column is what lets a sheet filter them back out again.
      if (node.kind === 'project') push('projectTotal', path, node.totals);
      if (node.kind === 'client') push('clientTotal', path, node.totals);
    });
  };

  walk(edaNodes(rows, 0), {});
  if (out.length) push('grandTotal', {}, totalsOf(rows));
  return out;
}

/**
 * Kept to one line and to as few nodes as the layout allows: at this row count
 * every extra element and every run of whitespace is paid for sixteen thousand
 * times over, so the cells hold bare text and the row class does the styling.
 *
 * A repeated value is dimmed rather than hidden. The value is still there to be
 * copied or sorted, but the eye can find where each group starts, which is the
 * part a suppressed pivot would have given away for free.
 */
function edaRowsHtml(rows) {
  return rows.map((row) => {
    const own = EDA_COLUMN_OF[row.kind];
    const cell = (key) => {
      if (!row[key]) return '<td></td>';
      const value = esc(row[key]);
      // Names are clipped to keep every row one line tall; the title puts the
      // full text back within reach without another element in the row.
      return `<td class="${own === key ? 'eda-own' : 'eda-repeat'}" title="${value}">${value}</td>`;
    };
    return `<tr class="eda-${row.kind}">`
      + `<td class="eda-level">${EDA_LABELS[row.kind]}</td>`
      + cell('client') + cell('project') + cell('tl') + cell('person')
      // Only the group letter fits the column, and it is all that is needed to
      // tie a row back to the cards above; the full name rides along as a title.
      + (row.cluster ? `<td class="${own === 'client' ? 'eda-own' : 'eda-repeat'}" title="${esc(row.cluster)}">${esc(row.cluster.split(' - ')[0])}</td>` : '<td></td>')
      + `<td class="num hours">${hoursText(row.hours)}</td>`
      + `<td class="num money">${money(row.revenue)}</td>`
      + `<td class="num money">${row.costed ? money(row.cost) : '<span class="locked">—</span>'}</td></tr>`;
  }).join('');
}

// Rows painted per frame. Building the tree costs almost nothing; parsing it
// into a hundred thousand DOM nodes is the whole cost, and doing that in one
// go locks the page up for the best part of a second.
const EDA_PAINT_CHUNK = 1500;
let edaPaintHandle = null;

function paintClientEda() {
  const rows = state.clientEda;
  const body = $('clientEdaBody');
  if (edaPaintHandle) { cancelAnimationFrame(edaPaintHandle); edaPaintHandle = null; }

  if (!rows.length) {
    body.innerHTML = '<tr><td class="empty" colspan="9">No clients match these filters.</td></tr>';
    $('clientEdaNote').textContent = 'Nothing to break down under the current filters.';
    return;
  }

  const count = (kind) => rows.reduce((sum, row) => sum + (row.kind === kind ? 1 : 0), 0);
  $('clientEdaNote').textContent = 'Every level of the filtered set, fully expanded: Client → Project → Team lead → Submitted by. '
    + `${int(count('client'))} clients · ${int(count('project'))} projects · ${int(count('tl'))} team-lead groups · ${int(count('person'))} people rows. `
    + 'Each row repeats its full path, so the table is a plain rectangle that can be sorted, filtered and pivoted in Excel or Sheets as it stands; inherited values are dimmed only to show where each group starts. '
    + 'Each project closes with its own total, each client with a total across its projects, and the last row totals every client in view — filter the Level column to keep or drop those. '
    + 'The drill table above narrows with the breadcrumb and cluster cards; this one always shows everything the filters allow, and Export writes it row for row.';

  // The first screenful lands straight away and the rest streams in over the
  // following frames, so scrolling and clicking stay live while it fills.
  body.innerHTML = edaRowsHtml(rows.slice(0, EDA_PAINT_CHUNK));
  let painted = EDA_PAINT_CHUNK;
  const step = () => {
    body.insertAdjacentHTML('beforeend', edaRowsHtml(rows.slice(painted, painted + EDA_PAINT_CHUNK)));
    painted += EDA_PAINT_CHUNK;
    edaPaintHandle = painted < rows.length ? requestAnimationFrame(step) : null;
  };
  if (painted < rows.length) edaPaintHandle = requestAnimationFrame(step);
}

let clientEdaCache = { key: null, facts: null };

/**
 * Fully expanded, this breakdown runs to tens of thousands of rows, which is far
 * more than any other table on the page. Two things keep that affordable.
 *
 * The work is held in a closure and only run once the client page is on screen,
 * so a keystroke in the search box while the report page is open costs nothing.
 * And it is skipped outright when nothing it depends on has moved: a sort, page,
 * drill or cluster-card click re-renders the page without changing which rows
 * are in view, and the tree cannot have moved. Only the filters, the window
 * rebuild and the pinned k can change it.
 */
function renderClientEda(rows, clusterOf) {
  $('exportClientEda').onclick = () => {
    flushClientEda();
    downloadCsv('client_breakdown.csv', EDA_EXPORT_COLUMNS, state.clientEda);
  };

  // The facts array is compared by identity because a window rebuild replaces
  // it wholesale, which the filter signature on its own would not catch. Cost
  // Payroll rows move every cost figure, so they remain in the cache key.
  const key = `${rows.length}|${JSON.stringify(state.filters)}|${state.clusterK}|${state.costs.size}`;
  const unchanged = clientEdaCache.key === key && clientEdaCache.facts === state.facts;
  if (unchanged && state.clientEdaReady) return;
  if (!unchanged) {
    clientEdaCache = { key, facts: state.facts };
    state.clientEdaReady = false;
    state.clientEdaBuild = () => {
      state.clientEda = edaFlatRows(rows, clusterOf);
      paintClientEda();
    };
  }
  if (state.view === 'clients') flushClientEda();
}

function flushClientEda() {
  if (state.clientEdaReady || !state.clientEdaBuild) return;
  state.clientEdaReady = true;
  state.clientEdaBuild();
}

/* ------------------------------------------------------------------ people summary */

/** Every threshold the insight rules use, in one place so they stay tunable. */
const INSIGHT_THRESHOLDS = {
  singleClientSharePct: 70,
  minHoursForFlag: 20,
  spreadProjects: 12,
  spreadMedianHoursPerProject: 2,
  lowUtilisationPct: 50,
  nonApprovedSharePct: 25,
};

/**
 * Deterministic insight rules over the people in view.
 *
 * Each rule states its own arithmetic and reports the numbers behind it, so a
 * card can be checked against the table underneath rather than taken on trust.
 * `requires` gates the rules that only mean something once cost is available.
 */
const PEOPLE_INSIGHTS = [
  {
    id: 'concentrated',
    label: 'Single-client dependency',
    tone: 'warn',
    rule: () => `Top client takes ${INSIGHT_THRESHOLDS.singleClientSharePct}% or more of their hours, on at least ${hoursText(INSIGHT_THRESHOLDS.minHoursForFlag)} logged`,
    test: (person) => person.hours >= INSIGHT_THRESHOLDS.minHoursForFlag
      && person.topClientShare >= INSIGHT_THRESHOLDS.singleClientSharePct,
    figure: (matched) => `${hoursText(matched.reduce((sum, person) => sum + person.hours, 0))} concentrated`,
  },
  {
    id: 'lowutil',
    label: 'Low utilisation',
    tone: 'bad',
    rule: () => `Client-billable hours (actual on client projects) are under ${INSIGHT_THRESHOLDS.lowUtilisationPct}% of their logged time. Only counts people with at least ${hoursText(INSIGHT_THRESHOLDS.minHoursForFlag)} logged. Utilisation = client hours ÷ total logged.`,
    test: (person) => person.hours >= INSIGHT_THRESHOLDS.minHoursForFlag
      && person.utilisation < INSIGHT_THRESHOLDS.lowUtilisationPct,
    figure: (matched) => {
      const totals = matched.reduce((sum, person) => {
        sum.hours += person.hours;
        sum.actual += person.actualHours;
        sum.allocated += person.allocatedHours;
        sum.unallocated += person.unallocatedHours;
        return sum;
      }, { hours: 0, actual: 0, allocated: 0, unallocated: 0 });
      const util = totals.hours > 0 ? totals.actual / totals.hours * 100 : 0;
      const internal = totals.allocated + totals.unallocated;
      return `${hoursText(totals.actual)} on clients vs ${hoursText(internal)} internal · ${pct(util)} pooled utilisation<br><span class="muted">Internal splits into ${hoursText(totals.allocated)} allocated to portfolios and ${hoursText(totals.unallocated)} unallocated</span>`;
    },
  },
  {
    id: 'unallocated',
    label: 'Unallocated hours',
    tone: 'bad',
    rule: () => 'Internal time that no portfolio could absorb, so it earns nothing',
    test: (person) => person.unallocatedHours > 1e-4,
    figure: (matched) => `${hoursText(matched.reduce((sum, person) => sum + person.unallocatedHours, 0))} unallocated`,
  },
  {
    id: 'nonapproved',
    label: 'Non-approved backlog',
    tone: 'warn',
    rule: () => `More than ${INSIGHT_THRESHOLDS.nonApprovedSharePct}% of their logged hours never reached approved`,
    test: (person) => person.nonApprovedShare > INSIGHT_THRESHOLDS.nonApprovedSharePct,
    figure: (matched) => `${hoursText(matched.reduce((sum, person) => sum + person.nonApprovedHours, 0))} awaiting approval`,
  },
];

const activeInsights = () => PEOPLE_INSIGHTS.filter((insight) => !insight.requires || insight.requires());

function bumpMap(map, key, amount) {
  map.set(key, (map.get(key) || 0) + amount);
}

function topOf(map) {
  let label = '';
  let value = 0;
  map.forEach((amount, key) => { if (amount > value) { label = key; value = amount; } });
  return { label, value };
}

/**
 * One row per person from the filtered fact rows, carrying the client and
 * project mix each rule needs. Built from the same revenue-shared rows as the
 * drill-downs, so a person's revenue matches what they show elsewhere.
 */
function personSummaryRows(rows) {
  const utilisationByEmployee = new Map(state.utilisation.map((row) => [text(row.employee), row]));
  const groups = new Map();
  rows.forEach((row) => {
    const employee = row.fact.employee || 'Unknown';
    if (!groups.has(employee)) {
      groups.set(employee, Object.assign(blankTotals(), {
        key: employee, label: employee, clientHours: new Map(), projectHours: new Map(),
        leadHours: new Map(), nonApprovedHours: 0, rawHours: 0,
      }));
    }
    const entry = groups.get(employee);
    accumulate(entry, row);
    bumpMap(entry.clientHours, row.fact.client, row.hours);
    bumpMap(entry.projectHours, row.fact.project, row.hours);
    bumpMap(entry.leadHours, row.fact.projectTl, row.hours);
    // Approval state belongs to the underlying rows, not to the hours basis, so
    // the backlog stays visible even when the view is filtered to approved.
    entry.nonApprovedHours += row.fact.nonApprovedHours;
    entry.rawHours += row.fact.totalHours;
  });

  return [...groups.values()].map((entry) => {
    finalise(entry);
    const utilisation = utilisationByEmployee.get(entry.key);
    const topClient = topOf(entry.clientHours);
    const topProject = topOf(entry.projectHours);
    const topLead = topOf(entry.leadHours);
    entry.department = text(utilisation?.department) || '—';
    entry.reportingTo = text(utilisation?.reporting_to);
    entry.inMaster = text(utilisation?.in_employee_master) === 'yes';
    entry.hasPayroll = Boolean(state.costs.get(entry.key)?.coveredPayrollDays);
    entry.internalHours = entry.allocatedHours + entry.unallocatedHours;
    // Utilisation is recomputed from the rows in view rather than read from the
    // build, so it tracks the filters like every other figure on the page.
    entry.utilisation = entry.hours > 0 ? entry.actualHours / entry.hours * 100 : 0;
    entry.topClient = topClient.label;
    entry.topClientHours = topClient.value;
    entry.topClientShare = entry.hours > 0 ? topClient.value / entry.hours * 100 : 0;
    entry.topProject = topProject.label;
    entry.topProjectHours = topProject.value;
    entry.topLead = topLead.label;
    entry.medianProjectHours = median([...entry.projectHours.values()]);
    entry.nonApprovedShare = entry.rawHours > 0 ? entry.nonApprovedHours / entry.rawHours * 100 : 0;
    entry.flags = activeInsights().filter((insight) => insight.test(entry)).map((insight) => insight.id);
    return entry;
  });
}

function renderPeopleSummary(rows) {
  const people = personSummaryRows(rows);
  const insights = activeInsights();

  const options = [{ value: 'all', label: 'Everyone' },
    ...insights.map((insight) => ({ value: insight.id, label: insight.label }))];
  if (!options.some((option) => option.value === state.insightScope)) state.insightScope = 'all';
  const select = $('insightScope');
  select.innerHTML = options.map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join('');
  select.value = state.insightScope;

  $('personSummaryStrip').innerHTML = statCard('People in view', int(people.length));

  $('peopleInsights').innerHTML = insights.map((insight) => {
    const matched = people.filter((person) => person.flags.includes(insight.id));
    return `<button class="insight ${insight.tone} ${state.insightScope === insight.id ? 'active' : ''} ${matched.length ? '' : 'quiet'}" data-insight="${esc(insight.id)}" type="button">
      <span class="insight-label">${esc(insight.label)}</span>
      <strong>${int(matched.length)} ${matched.length === 1 ? 'person' : 'people'}</strong>
      <small>${matched.length ? insight.figure(matched) : 'Nothing matches'}</small>
      <small class="muted">${esc(insight.rule())}</small>
    </button>`;
  }).join('');

  const scope = insights.find((insight) => insight.id === state.insightScope);
  const shown = scope ? people.filter((person) => person.flags.includes(scope.id)) : people;

  const columns = [
    { key: 'label', label: 'Person', render: (person) => `<span class="label-main">${esc(person.label)}${person.inMaster ? '' : '<span class="tag norev">not in master</span>'}</span><span class="label-sub">${esc(person.department)}${person.reportingTo ? ` · reports to ${esc(person.reportingTo)}` : ' · no reporting line'}</span>`, value: (person) => person.label, total: () => '<strong>Total</strong>' },
    { key: 'topClient', label: 'Top client', render: (person) => `<span class="label-main">${esc(person.topClient) || '<span class="muted">—</span>'}</span><span class="label-sub">${pct(person.topClientShare)} of their hours · ${int(person.clientCount)} client${person.clientCount === 1 ? '' : 's'}</span>`, value: (person) => person.topClient },
    { key: 'topProject', label: 'Biggest project', render: (person) => `<span class="label-main">${esc(person.topProject) || '<span class="muted">—</span>'}</span><span class="label-sub">${hoursText(person.topProjectHours)} · ${int(person.projectCount)} project${person.projectCount === 1 ? '' : 's'}</span>`, value: (person) => person.topProject },
    { key: 'topProjectHours', label: 'Max', num: true, render: (person) => hoursText(person.topProjectHours), value: (person) => person.topProjectHours.toFixed(4) },
    { key: 'hours', label: 'Total logged', num: true, render: (person) => `<strong>${hoursText(person.hours)}</strong>`, value: (person) => person.hours.toFixed(4), total: (row) => hoursText(row.hours) },
    { key: 'actualHours', label: 'Client hours', num: true, render: (person) => `<span class="label-main">${hoursText(person.actualHours)}</span><span class="label-sub">${pct(person.utilisation)} of logged</span>`, value: (person) => person.actualHours.toFixed(4), total: (row) => hoursText(row.actualHours) },
    { key: 'internalHours', label: 'Internal hours', num: true, render: (person) => {
      const internal = person.internalHours;
      if (internal <= 1e-4) return '<span class="muted">—</span>';
      const internalShare = person.hours > 0 ? internal / person.hours * 100 : 0;
      const parts = [];
      if (person.allocatedHours > 1e-4) parts.push(`${hoursText(person.allocatedHours)} allocated`);
      if (person.unallocatedHours > 1e-4) parts.push(`<span class="tag unalloc">${hoursText(person.unallocatedHours)} unallocated</span>`);
      return `<span class="label-main">${hoursText(internal)}</span><span class="label-sub">${pct(internalShare)} of logged${parts.length ? ` · ${parts.join(' · ')}` : ''}</span>`;
    }, value: (person) => person.internalHours.toFixed(4), total: (row) => hoursText(row.allocatedHours + row.unallocatedHours) },
    { key: 'utilisation', label: 'Utilisation', num: true, render: (person) => {
      const flagged = person.flags.includes('lowutil');
      const tone = flagged ? '<span class="tag flag bad">low</span> ' : '';
      return `<span class="label-main">${tone}${pct(person.utilisation)}</span><span class="label-sub">client ÷ total logged</span>`;
    }, value: (person) => person.utilisation.toFixed(2) },
    { key: 'inWindowRevenue', label: 'Revenue share', num: true, render: (person) => money(person.inWindowRevenue), value: (person) => person.inWindowRevenue.toFixed(2), total: (row) => money(row.inWindowRevenue) },
    { key: 'revenuePerHour', label: 'Rev / delivered h', num: true, render: (person) => money(person.revenuePerHour), value: (person) => person.revenuePerHour.toFixed(2) },
    { key: 'costPerHour', label: 'Payroll cost / h', num: true, render: (person) => lockedMoney(person.costPerHour), value: (person) => person.costPerHour.toFixed(4) },
    { key: 'cost', label: 'Cost', num: true, render: (person) => lockedMoney(person.cost), value: (person) => person.cost.toFixed(2), total: (row) => lockedMoney(row.cost) },
    {
      key: 'flags', label: 'Flags', sortable: false,
      render: (person) => (person.flags.length
        ? person.flags.map((id) => {
          const insight = insights.find((item) => item.id === id);
          return `<span class="tag flag ${insight.tone}" title="${esc(insight.rule())}">${esc(insight.label)}</span>`;
        }).join('')
        : '<span class="muted">clear</span>'),
      value: (person) => person.flags.join(' | '),
    },
  ];

  const sorted = sortRows(shown, state.sort.personSummary);
  $('personSummaryNote').textContent = scope
    ? `${int(shown.length)} of ${int(people.length)} people match "${scope.label}". ${scope.rule()} Click a person for their client and project breakdown.`
    : `${int(people.length)} people. Utilisation = client hours ÷ total logged. Internal hours = allocated (absorbed by a portfolio) + unallocated (no portfolio could absorb it). Click a person for their client and project breakdown, or a card above to keep only the people it flags.`;
  renderTable({
    head: $('personSummaryHead'), body: $('personSummaryBody'), columns, rows: sorted,
    sort: state.sort.personSummary, sortId: 'personSummary', drillable: true, rowKey: (person) => person.key,
    totalRow: totalsOf(rows.filter((row) => shown.some((person) => person.key === row.fact.employee))),
    empty: 'No people match this scope.',
  });
  $('exportPeopleSummary').onclick = () => downloadCsv('people_summary.csv', columns, sorted);
  renderPersonSummaryDrill(people.find((person) => person.key === state.personSummaryFocus) || null, rows);
}

function renderPersonSummaryDrill(person, rows) {
  const drawer = $('personSummaryDrill');
  if (!person) { drawer.hidden = true; drawer.innerHTML = ''; return; }
  const scoped = rows.filter((row) => row.fact.employee === person.key
    && state.personSummaryCrumbs.every((crumb) => row.fact[crumb.dim] === crumb.value));
  const totals = totalsOf(scoped);
  const depth = Math.min(state.personSummaryCrumbs.length, PERSON_SUMMARY_PATH.length - 1);
  const dimension = PERSON_SUMMARY_PATH[depth];
  const drillable = depth < PERSON_SUMMARY_PATH.length - 1;
  const entries = groupBy(scoped, dimension);

  drawer.hidden = false;
  drawer.innerHTML = `<div class="drawer-head">
      <div><h3>${esc(person.label)}</h3>
        <p>${esc(person.department)}${person.reportingTo ? ` · reports to ${esc(person.reportingTo)}` : ' · no reporting line'}</p>
        <p>${int(person.clientCount)} clients · ${int(person.projectCount)} projects · biggest is ${esc(person.topProject) || 'none'} at ${hoursText(person.topProjectHours)} · most hours for ${esc(person.topClient) || 'nobody'} at ${pct(person.topClientShare)}</p>
        <p>${person.flags.length ? `Flagged: ${esc(person.flags.map((id) => PEOPLE_INSIGHTS.find((insight) => insight.id === id).label).join(', '))}` : 'No rules flag this person.'}</p></div>
      <div class="block-tools"><button class="ghost small" id="personSummaryExport" type="button">Export</button><button class="ghost small" id="personSummaryClose" type="button">Close</button></div>
    </div>
    <div class="crumbs" id="personSummaryCrumbs"></div>
    <div class="stat-strip" id="personSummaryDrillStrip"></div>
    <div class="level-summary" id="personSummaryLevel"></div>
    <div class="table-scroll"><table class="grid"><thead id="personSummaryDrillHead"></thead><tbody id="personSummaryDrillBody"></tbody></table></div>`;

  const levels = [{ label: person.label, sub: PERSON_SUMMARY_PATH.map((dim) => DIMENSIONS[dim].label).join(' › ') },
    ...state.personSummaryCrumbs.map((crumb) => ({ label: crumb.value, sub: DIMENSIONS[crumb.dim].label }))];
  $('personSummaryCrumbs').innerHTML = levels.map((level, index) => {
    const current = index === levels.length - 1;
    return `${index ? '<span class="crumb-sep">›</span>' : ''}<button class="crumb ${current ? 'current' : ''}" data-crumb="${index}" ${current ? 'disabled' : ''}>${esc(level.label)}<small>${esc(level.sub)}</small></button>`;
  }).join('');

  $('personSummaryDrillStrip').innerHTML = [
    statCard('Hours in view', hoursText(totals.hours)),
    statCard('Delivered', hoursText(totals.deliveredHours)),
    statCard('Unallocated', hoursText(totals.unallocatedHours)),
    statCard('Revenue share', money(totals.inWindowRevenue)),
    statCard('Cost', lockedMoney(totals.cost)),
    statCard('Margin', costReady() ? pct(totals.margin) : '—'),
  ].join('');
  $('personSummaryLevel').innerHTML = `<span>Grouped by <b>${esc(DIMENSIONS[dimension].label)}</b></span><span><b>${int(entries.length)}</b> groups</span><span>${esc(DIMENSIONS[dimension].sub)}</span>${drillable ? '<span class="muted">Click a row to drill in</span>' : '<span class="muted">Deepest level</span>'}`;

  const columns = [
    { key: 'label', label: DIMENSIONS[dimension].label, render: (row) => `<span class="label-main">${esc(row.label)}</span><span class="label-sub">${int(row.projectCount)} projects · ${int(row.rows)} rows</span>`, value: (row) => row.label, total: () => '<strong>Total</strong>' },
    { key: 'actualHours', label: 'Actual', num: true, render: (row) => hoursText(row.actualHours), value: (row) => row.actualHours.toFixed(4), total: (row) => hoursText(row.actualHours) },
    { key: 'allocatedHours', label: 'Allocated', num: true, render: (row) => hoursText(row.allocatedHours), value: (row) => row.allocatedHours.toFixed(4), total: (row) => hoursText(row.allocatedHours) },
    { key: 'unallocatedHours', label: 'Unallocated', num: true, render: (row) => (row.unallocatedHours ? `<span class="tag unalloc">${hoursText(row.unallocatedHours)}</span>` : '<span class="muted">—</span>'), value: (row) => row.unallocatedHours.toFixed(4), total: (row) => hoursText(row.unallocatedHours) },
    { key: 'hours', label: 'Total', num: true, render: (row) => `<strong>${hoursText(row.hours)}</strong>`, value: (row) => row.hours.toFixed(4), total: (row) => hoursText(row.hours) },
    { key: 'inWindowRevenue', label: 'Revenue share', num: true, render: (row) => money(row.inWindowRevenue), value: (row) => row.inWindowRevenue.toFixed(2), total: (row) => money(row.inWindowRevenue) },
    { key: 'cost', label: 'Cost', num: true, render: (row) => lockedMoney(row.cost), value: (row) => row.cost.toFixed(2), total: (row) => lockedMoney(row.cost) },
  ];
  const sorted = sortRows(entries, state.sort.personSummaryDrill);
  renderTable({
    head: $('personSummaryDrillHead'), body: $('personSummaryDrillBody'), columns, rows: sorted,
    sort: state.sort.personSummaryDrill, sortId: 'personSummaryDrill', totalRow: totals,
    drillable, rowKey: drillable ? (row) => row.key : null,
    empty: 'No hours for this person under the current filters.',
  });

  $('personSummaryClose').addEventListener('click', () => {
    state.personSummaryFocus = null;
    state.personSummaryCrumbs = [];
    render();
  });
  $('personSummaryExport').addEventListener('click', () => downloadCsv(`${person.key.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_summary_by_${dimension}.csv`, columns, sorted));
  $('personSummaryCrumbs').addEventListener('click', (event) => {
    const crumb = event.target.closest('[data-crumb]');
    if (!crumb) return;
    state.personSummaryCrumbs = state.personSummaryCrumbs.slice(0, Number(crumb.dataset.crumb));
    render();
  });
  $('personSummaryDrillBody').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-row-key]');
    if (!row || !drillable) return;
    state.personSummaryCrumbs.push({ dim: dimension, value: row.dataset.rowKey });
    state.sort.personSummaryDrill = { key: 'hours', dir: -1 };
    render();
  });
  bindSorting($('personSummaryDrillHead'), 'personSummaryDrill', render);
}

/* ------------------------------------------------------------------ manifest */

function renderManifest() {
  const manifest = state.manifest;
  const totals = manifest.totals;
  const items = [
    ['Window', `${manifest.window.days} days`],
    ['Timesheet rows', int(totals.timesheet_rows)],
    ['Logged hours', hoursText(totals.logged_hours)],
    ['Emitted hours', hoursText(totals.emitted_hours)],
    // Drift is a tolerance check, so it stays a precise decimal rather than a duration.
    ['Reconciliation drift', `${dec(totals.reconciliation_drift, 4)}h`],
    ['Client hours', hoursText(totals.client_hours)],
    ['Internal hours', hoursText(totals.internal_hours)],
    ['Unallocated hours', hoursText(companyUnallocatedHours())],
    ['Department allocation', state.filters.deptAllocation ? `on · ${hoursText(deptPoolHours())} spread` : `off · ${hoursText(deptPoolHours())} held back`],
    ['Projects touched', int(totals.projects_touched)],
    ['Clients touched', int(totals.clients_touched)],
    ['Contract revenue', money(totals.contract_revenue)],
    ['In-window revenue', money(totals.in_window_revenue)],
    ['Cost file', manifest.cost.file || 'not uploaded'],
    ['People with cost', `${int(manifest.cost.matched)} / ${int(totals.employees)}`],
  ];
  $('manifestSummary').innerHTML = items.map(([label, value]) => `<div class="manifest-item"><span>${esc(label)}</span><b>${esc(String(value))}</b></div>`).join('');
}

/* ------------------------------------------------------------------ render */

/* ------------------------------------------------------------------ monthly comparisons */

// Brand orange plus a blue validated for colour-blind separation (worst ΔE 30, protan).
const TREND_COLORS = { primary: '#f58217', secondary: '#3b6fd8' };
const compact = (value) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const CHART = { width: 640, height: 210, top: 22, right: 12, bottom: 28, left: 46 };

function parseTrendRow(row) {
  return {
    grain: row.grain, key: row.period_key, label: row.label,
    start: row.period_start, end: row.period_end,
    calendarDays: num(row.calendar_days), dataDays: num(row.data_days), partial: row.partial === 'yes',
    projects: num(row.projects_active), clients: num(row.clients_active), people: num(row.people_active),
    hours: num(row.logged_hours), clientHours: num(row.client_hours), internalHours: num(row.internal_hours),
    revenue: num(row.revenue), costInr: num(row.payroll_cost_inr),
    payrollDays: num(row.payroll_days_covered), costedHours: num(row.costed_hours), costedPeople: num(row.costed_people),
  };
}

/** Payroll cost in AED at the current FX, or hours × the manual rate when one is applied. */
function trendCost(row) {
  const rate = costOverride();
  return rate !== null ? row.hours * rate : row.costInr * inrToAedRate();
}

/** Decide whether a period has trustworthy enough cost to show profit.
 *  Return { cost, profit, margin } (margin in %), or null to leave the period
 *  out of the profitability charts with a "No payroll data" band. */
function profitForPeriod(row) {
  const cost = trendCost(row);
  // A partly costed period would understate cost and overstate margin, so it
  // needs every logged day priced, unless a manual rate prices every hour.
  const priced = costOverride() !== null || row.payrollDays >= row.dataDays;
  if (!priced || cost <= 0 || row.revenue <= 0) return null;
  const profit = row.revenue - cost;
  return { cost, profit, margin: (profit / row.revenue) * 100 };
}

function niceScale(min, max, ticks = 4) {
  if (max === min) max = min + 1;
  const raw = (max - min) / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((candidate) => candidate >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const values = [];
  for (let value = lo; value <= hi + step / 2; value += step) values.push(Math.round(value * 1e6) / 1e6);
  return { lo, hi, values };
}

/** Column with a 4px rounded data end and a square baseline. */
function barPath(x, from, to, width, round) {
  const height = Math.abs(from - to);
  if (height < 0.5) return '';
  const r = round ? Math.min(4, height, width / 2) : 0;
  const s = to < from ? 1 : -1;
  return `M${x},${from}V${to + s * r}Q${x},${to} ${x + r},${to}H${x + width - r}Q${x + width},${to} ${x + width},${to + s * r}V${from}Z`;
}

/** SVG trend chart. mode: 'stacked' (one or more series summed), 'grouped', or 'line'.
 *  `missing(row)` marks periods drawn as a shaded band instead of marks. */
function trendChart({ rows, series, mode = 'stacked', axis = compact, tip, missing, missingLabel = 'No data', labelLast }) {
  const { width, height, top, right, bottom, left } = CHART;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const band = plotW / Math.max(rows.length, 1);
  const isMissing = (row) => Boolean(missing && missing(row));
  // Scale over exactly the marks that get drawn: grouped charts still draw the
  // series that do not need cost (revenue) inside a missing period.
  const drawn = (row) => {
    if (!isMissing(row)) return series;
    return mode === 'grouped' ? series.filter((item) => !item.needsCost) : [];
  };
  const totals = rows.flatMap((row) => {
    const values = drawn(row).map((item) => item.get(row)).filter((value) => value !== null && value !== undefined);
    if (!values.length) return [];
    return mode === 'stacked' ? [values.reduce((sum, value) => sum + value, 0)] : values;
  });
  const scale = niceScale(Math.min(0, ...totals), Math.max(0, ...totals) || 1);
  const y = (value) => top + plotH - ((value - scale.lo) / (scale.hi - scale.lo)) * plotH;
  const cx = (index) => left + band * index + band / 2;
  const parts = [];

  // Missing periods first, so gridlines and marks sit on top of the band.
  let run = null;
  rows.forEach((row, index) => {
    if (isMissing(row) && run === null) run = index;
    if (run !== null && (!isMissing(row) || index === rows.length - 1)) {
      const last = isMissing(row) ? index : index - 1;
      const x = left + band * run;
      const w = band * (last - run + 1);
      parts.push(`<rect class="missing-band" x="${x}" y="${top}" width="${w}" height="${plotH}"/>`);
      if (w > 70) parts.push(`<text class="missing-label" x="${x + w / 2}" y="${top + 14}" text-anchor="middle">${esc(missingLabel)}</text>`);
      run = null;
    }
  });

  scale.values.forEach((value) => {
    parts.push(`<line class="grid-line${value === 0 ? ' zero' : ''}" x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/>`);
    parts.push(`<text class="axis" x="${left - 6}" y="${y(value) + 3.5}" text-anchor="end">${esc(axis(value))}</text>`);
  });

  const every = Math.ceil(rows.length / 12);
  rows.forEach((row, index) => {
    if (index % every === 0 || index === rows.length - 1) {
      const short = row.grain === 'month' ? row.label.slice(0, 3) : row.label.split(' · ')[1];
      parts.push(`<text class="axis" x="${cx(index)}" y="${height - 9}" text-anchor="middle">${esc(short)}</text>`);
    }
  });

  if (mode === 'line') {
    const item = series[0];
    let path = '';
    rows.forEach((row, index) => {
      const value = isMissing(row) ? null : item.get(row);
      if (value === null || value === undefined) { path += ' '; return; }
      path += `${path.endsWith(' ') || !path ? 'M' : 'L'}${cx(index)},${y(value)}`;
    });
    parts.push(`<path class="trend-line" d="${path.trim()}" stroke="${item.color}"/>`);
    rows.forEach((row, index) => {
      const value = isMissing(row) ? null : item.get(row);
      if (value === null || value === undefined) return;
      parts.push(`<circle class="trend-dot${row.partial ? ' partial' : ''}" cx="${cx(index)}" cy="${y(value)}" r="4" fill="${item.color}"/>`);
    });
  } else {
    const groupW = mode === 'grouped' ? Math.min(14, band * 0.34) : Math.min(24, band * 0.62);
    rows.forEach((row, index) => {
      if (isMissing(row) && mode !== 'grouped') return;
      const cls = row.partial ? ' class="partial"' : '';
      if (mode === 'grouped') {
        const live = drawn(row);
        const span = live.length * groupW + (live.length - 1) * 2;
        live.forEach((item, slot) => {
          const value = item.get(row);
          if (value === null || value === undefined) return;
          const x = cx(index) - span / 2 + slot * (groupW + 2);
          parts.push(`<path${cls} d="${barPath(x, y(0), y(value), groupW, true)}" fill="${item.color}"/>`);
        });
        return;
      }
      let base = 0;
      const values = series.map((item) => item.get(row) || 0);
      const topIndex = values.reduce((found, value, i) => (value > 0 ? i : found), -1);
      values.forEach((value, i) => {
        if (value <= 0) return;
        const from = y(base);
        const to = y(base + value) + (i === topIndex ? 0 : 2);
        parts.push(`<path${cls} d="${barPath(cx(index) - groupW / 2, from, to, groupW, i === topIndex)}" fill="${series[i].color}"/>`);
        base += value;
      });
    });
  }

  if (labelLast) {
    const index = rows.map((row) => !isMissing(row)).lastIndexOf(true);
    if (index >= 0) {
      const row = rows[index];
      const value = mode === 'stacked' ? series.reduce((sum, item) => sum + (item.get(row) || 0), 0) : series[0].get(row);
      if (value !== null && value !== undefined) {
        parts.push(`<text class="value-label" x="${cx(index)}" y="${y(Math.max(value, 0)) - 7}" text-anchor="middle">${esc(labelLast(value))}</text>`);
      }
    }
  }

  rows.forEach((row, index) => {
    parts.push(`<rect class="hit" x="${left + band * index}" y="${top}" width="${band}" height="${plotH}" data-tip="${esc(tip(row, index))}"/>`);
  });
  return `<svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img">${parts.join('')}</svg>`;
}

function changeOf(current, previous) {
  if (previous === null || previous === undefined || !previous) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function deltaBadge(change, { neutral = false, unit = '%' } = {}) {
  if (change === null || !Number.isFinite(change)) return '<span class="delta flat">—</span>';
  const dir = change > 0.05 ? 'up' : change < -0.05 ? 'down' : 'flat';
  const arrow = { up: '▲', down: '▼', flat: '▬' }[dir];
  return `<span class="delta ${dir}${neutral ? ' neutral' : ''}">${arrow} ${dec(Math.abs(change), 1)}${unit}</span>`;
}

function legendItems(items) {
  return items.map((item) => `<span class="legend-item"><i style="background:${item.color}"></i>${esc(item.label)}</span>`).join('');
}

/** Only complete periods are compared: an in-progress month or week (or one the
 *  data only partly covers) would read as a fall against a full one. */
function trendRowsForGrain({ includePartial = false } = {}) {
  return state.trends.filter((row) => row.grain === state.trendGrain && (includePartial || !row.partial));
}

const TREND_METRICS = [
  { key: 'projects', label: 'Projects active', format: int, sub: (row) => `${int(row.clients)} clients` },
  { key: 'people', label: 'People logging time', format: int, neutral: true, sub: (row) => `${hoursText(row.hours / Math.max(row.people, 1))} per person` },
  { key: 'hours', label: 'Hours logged', format: hoursText, sub: (row) => `${pct(row.hours ? row.clientHours / row.hours * 100 : 0)} on client work` },
  { key: 'revenue', label: 'Revenue recognised', format: money, sub: (row) => `${money(row.hours ? row.revenue / row.hours : 0)} / logged hour` },
];

function renderTrends() {
  if (!$('section-trends')) return;
  const rows = trendRowsForGrain();
  const unit = state.trendGrain === 'month' ? 'month' : 'week';
  if (!rows.length) {
    $('trendStrip').innerHTML = '';
    $('trendCharts').innerHTML = '<p class="note">EDA_Trends.csv is missing. Rebuild the EDA from Sources to create it.</p>';
    $('profitCharts').innerHTML = '';
    $('trendHead').innerHTML = '';
    $('trendBody').innerHTML = '';
    return;
  }
  const profits = rows.map(profitForPeriod);
  const current = { row: rows.at(-1), index: rows.length - 1 };
  const previous = rows.length > 1 ? { row: rows.at(-2), index: rows.length - 2 } : null;
  const partialRows = trendRowsForGrain({ includePartial: true }).filter((row) => row.partial);

  // ---- headline: latest complete period against the one before it
  const cards = TREND_METRICS.map((metric) => {
    const now = current ? current.row[metric.key] : 0;
    const change = current && previous ? changeOf(now, previous.row[metric.key]) : null;
    return `<div class="stat trend-stat"><span>${esc(metric.label)}</span><strong>${metric.format(now)}</strong>
      <small>${deltaBadge(change, { neutral: metric.neutral })} <em>${current ? esc(metric.sub(current.row)) : ''}</em></small></div>`;
  });
  const marginNow = current ? profits[current.index] : null;
  const marginPrev = previous ? profits[previous.index] : null;
  const lastProfit = profits.map((profit, index) => ({ profit, index })).filter((item) => item.profit && !rows[item.index].partial).at(-1);
  cards.push(`<div class="stat trend-stat"><span>Gross margin</span><strong>${marginNow ? pct(marginNow.margin) : '—'}</strong>
    <small>${marginNow && marginPrev ? deltaBadge(marginNow.margin - marginPrev.margin, { unit: ' pts' }) : ''}
    <em>${marginNow ? `${money(marginNow.profit)} gross profit` : lastProfit ? `Last costed: ${esc(rows[lastProfit.index].label)} · ${pct(lastProfit.profit.margin)}` : 'No payroll for this period'}</em></small></div>`);
  $('trendStrip').innerHTML = cards.join('');
  $('trendCompareNote').textContent = current && previous
    ? `Latest complete ${unit}, ${current.row.label}, compared with ${previous.row.label}. Every change on this page is against the previous complete ${unit}.${partialRows.length ? ` Not shown because the data covers only part of the ${unit}: ${partialRows.map((row) => `${row.label} (${row.dataDays} of ${row.calendarDays} days)`).join(', ')}.` : ''}`
    : 'Need at least two complete periods to compare.';

  // ---- small multiples
  const tipFor = (row, index, lines) => {
    const prior = rows[index - 1];
    return `<b>${esc(row.label)}</b>${row.partial ? `<em>Partial · ${row.dataDays} of ${row.calendarDays} days</em>` : ''}`
      + lines.map(([label, value, change]) => `<div><span>${esc(label)}</span><strong>${value}</strong>${change !== undefined && prior ? deltaBadge(change) : ''}</div>`).join('');
  };
  const single = (metric) => trendChart({
    rows,
    series: [{ color: TREND_COLORS.primary, get: (row) => row[metric.key] }],
    axis: metric.key === 'revenue' ? compact : (value) => int(value),
    labelLast: metric.key === 'revenue' ? compact : metric.key === 'hours' ? compact : int,
    tip: (row, index) => tipFor(row, index, [[metric.label, metric.format(row[metric.key]), changeOf(row[metric.key], rows[index - 1]?.[metric.key])], ['', esc(metric.sub(row))]]),
  });
  const hoursSeries = [
    { label: 'Client', color: TREND_COLORS.primary, get: (row) => row.clientHours },
    { label: 'Internal', color: TREND_COLORS.secondary, get: (row) => row.internalHours },
  ];
  const chartCard = (title, svg, legend = '') => `<div class="mini-card trend-card"><div class="mini-card-head"><h3>${esc(title)}</h3>${legend ? `<div class="legend">${legend}</div>` : ''}</div>${svg}</div>`;
  $('trendCharts').innerHTML = [
    chartCard(`Projects active per ${unit}`, single(TREND_METRICS[0])),
    chartCard(`People logging time per ${unit}`, single(TREND_METRICS[1])),
    chartCard(`Hours logged per ${unit}`, trendChart({
      rows, series: hoursSeries, axis: compact, labelLast: compact,
      tip: (row, index) => tipFor(row, index, [
        ['Total', hoursText(row.hours), changeOf(row.hours, rows[index - 1]?.hours)],
        ['Client', hoursText(row.clientHours)], ['Internal', hoursText(row.internalHours)]]),
    }), legendItems(hoursSeries)),
    chartCard(`Revenue recognised per ${unit} (AED)`, single(TREND_METRICS[3])),
  ].join('');

  // ---- profitability
  const noCost = (row, index) => !profits[rows.indexOf(row)];
  const profitSeries = [
    { label: 'Revenue', color: TREND_COLORS.primary, get: (row) => row.revenue },
    { label: 'Payroll cost', color: TREND_COLORS.secondary, needsCost: true, get: (row) => profits[rows.indexOf(row)]?.cost ?? null },
  ];
  const profitTip = (row, index) => {
    const profit = profits[index];
    return tipFor(row, index, profit
      ? [['Revenue', money(row.revenue)], ['Payroll cost', money(profit.cost)], ['Gross profit', money(profit.profit)], ['Margin', pct(profit.margin)]]
      : [['Revenue', money(row.revenue)], ['Payroll cost', 'No payroll data']]);
  };
  $('profitLegend').innerHTML = legendItems(profitSeries);
  $('profitCharts').innerHTML = [
    chartCard(`Revenue vs payroll cost per ${unit} (AED)`, trendChart({
      rows, series: profitSeries, mode: 'grouped', missing: noCost, missingLabel: 'No payroll data', tip: profitTip,
    })),
    chartCard(`Gross margin per ${unit}`, trendChart({
      rows, mode: 'line', missing: noCost, missingLabel: 'No payroll data', tip: profitTip,
      axis: (value) => `${int(value)}%`, labelLast: (value) => pct(value),
      series: [{ color: TREND_COLORS.primary, get: (row) => profits[rows.indexOf(row)]?.margin ?? null }],
    })),
  ].join('');
  const costed = rows.filter((row, index) => profits[index]);
  const uncosted = rows.filter((row, index) => !profits[index]);
  const linked = costed.reduce((sum, row) => sum + row.costedHours, 0) / Math.max(costed.reduce((sum, row) => sum + row.hours, 0), 1) * 100;
  $('profitNote').textContent = [
    costOverride() !== null
      ? `Cost uses the manual rate of ${money2(costOverride())} per logged hour for every ${unit}.`
      : `Cost is the payroll of people who log time, prorated by calendar day at ${inrToAedRate().toFixed(4)} AED per INR.`,
    costOverride() === null && state.manifest?.cost?.carried_forward_months?.length
      ? `Payroll runs to ${new Date(`${state.manifest.cost.last_payroll_month}T00:00:00`).toLocaleString('en', { month: 'short', year: 'numeric' })}; later months repeat each current employee's latest monthly cost, with approved salary revisions applied from their effective dates.`
      : '',
    costed.length && costOverride() === null ? `${pct(linked)} of hours in costed ${unit}s belong to someone matched to payroll, so margins run high by the unmatched share.` : '',
    uncosted.length ? `${uncosted.length} ${unit}${uncosted.length > 1 ? 's' : ''} (${uncosted[0].label} – ${uncosted.at(-1).label}) have no usable payroll; upload a newer payroll export in Sources or apply a manual cost / hour in Filters.` : '',
    'Revenue is the full-history recognised revenue split by period: dated contracts by calendar days, undated ones by hours logged.',
  ].filter(Boolean).join(' ');

  // ---- table, newest first
  const deltaCell = (row, index, key) => {
    const prior = rows[index - 1];
    return prior ? deltaBadge(changeOf(row[key], prior[key]), { neutral: key === 'people' }) : '<span class="delta flat">—</span>';
  };
  $('trendHead').innerHTML = `<tr><th>Period</th><th class="num">Days</th><th class="num">Projects</th><th class="num">Δ</th><th class="num">People</th><th class="num">Δ</th>
    <th class="num">Hours</th><th class="num">Δ</th><th class="num">Client share</th><th class="num">Revenue</th><th class="num">Δ</th>
    <th class="num">Payroll cost</th><th class="num">Gross profit</th><th class="num">Margin</th><th class="num">Payroll-linked hours</th></tr>`;
  $('trendBody').innerHTML = rows.map((row, index) => ({ row, index })).reverse().map(({ row, index }) => {
    const profit = profits[index];
    return `<tr class="${row.partial ? 'partial-row' : ''}">
      <td><b>${esc(row.label)}</b>${row.partial ? ' <span class="tag">partial</span>' : ''}</td>
      <td class="num">${row.dataDays}/${row.calendarDays}</td>
      <td class="num">${int(row.projects)}</td><td class="num">${deltaCell(row, index, 'projects')}</td>
      <td class="num">${int(row.people)}</td><td class="num">${deltaCell(row, index, 'people')}</td>
      <td class="num">${hoursText(row.hours)}</td><td class="num">${deltaCell(row, index, 'hours')}</td>
      <td class="num">${pct(row.hours ? row.clientHours / row.hours * 100 : 0)}</td>
      <td class="num">${money(row.revenue)}</td><td class="num">${deltaCell(row, index, 'revenue')}</td>
      <td class="num">${profit ? money(profit.cost) : '<span class="locked">—</span>'}</td>
      <td class="num">${profit ? money(profit.profit) : '<span class="locked">—</span>'}</td>
      <td class="num">${profit ? pct(profit.margin) : '<span class="locked">—</span>'}</td>
      <td class="num">${row.payrollDays ? pct(row.hours ? row.costedHours / row.hours * 100 : 0) : '<span class="locked">—</span>'}</td>
    </tr>`;
  }).join('');
}

function exportTrends() {
  const rows = trendRowsForGrain();
  const profits = rows.map(profitForPeriod);
  const at = (row) => profits[rows.indexOf(row)];
  downloadCsv(`trends_${state.trendGrain}.csv`, [
    { label: 'Period', value: (row) => row.key },
    { label: 'Label', value: (row) => row.label },
    { label: 'Start', value: (row) => row.start },
    { label: 'End', value: (row) => row.end },
    { label: 'Data days', value: (row) => row.dataDays },
    { label: 'Partial', value: (row) => (row.partial ? 'yes' : 'no') },
    { label: 'Projects active', value: (row) => row.projects },
    { label: 'Clients active', value: (row) => row.clients },
    { label: 'People active', value: (row) => row.people },
    { label: 'Logged hours', value: (row) => row.hours.toFixed(2) },
    { label: 'Client hours', value: (row) => row.clientHours.toFixed(2) },
    { label: 'Internal hours', value: (row) => row.internalHours.toFixed(2) },
    { label: 'Revenue AED', value: (row) => row.revenue.toFixed(2) },
    { label: 'Payroll cost AED', value: (row) => (at(row) ? at(row).cost.toFixed(2) : '') },
    { label: 'Gross profit AED', value: (row) => (at(row) ? at(row).profit.toFixed(2) : '') },
    { label: 'Margin %', value: (row) => (at(row) ? at(row).margin.toFixed(2) : '') },
  ], rows);
}

function bindTrends() {
  $('trendGrain').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-grain]');
    if (!button) return;
    state.trendGrain = button.dataset.grain;
    $('trendGrain').querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button));
    renderTrends();
  });
  $('exportTrends').addEventListener('click', exportTrends);
  const tipBox = $('chartTip');
  const section = $('section-trends');
  section.addEventListener('mousemove', (event) => {
    const hit = event.target.closest('[data-tip]');
    if (!hit) { tipBox.hidden = true; return; }
    tipBox.innerHTML = hit.dataset.tip;
    tipBox.hidden = false;
    const pad = 14;
    const box = tipBox.getBoundingClientRect();
    const x = event.clientX + pad + box.width > window.innerWidth ? event.clientX - pad - box.width : event.clientX + pad;
    const y = Math.min(event.clientY + pad, window.innerHeight - box.height - 8);
    tipBox.style.left = `${x}px`;
    tipBox.style.top = `${y}px`;
    section.querySelectorAll('.hit.on').forEach((item) => item.classList.remove('on'));
    hit.classList.add('on');
  });
  section.addEventListener('mouseleave', () => {
    tipBox.hidden = true;
    section.querySelectorAll('.hit.on').forEach((item) => item.classList.remove('on'));
  });
}

function render() {
  const rows = visibleRows();
  state.visible = rows;
  const totals = totalsOf(rows);
  renderFilterSummary(rows, totals);
  renderOverview(rows, totals);
  renderDrill(rows, totals);
  renderHours(rows);
  renderAudit();
  renderInternal();
  renderPeople();
  renderClients(rows);
  renderPeopleSummary(rows);
  renderTrends();
  renderManifest();
}

/* ------------------------------------------------------------------ shell */

let railObserver = null;

function pageCount(page) {
  const totals = state.manifest?.totals || {};
  if (page.view === 'trends') return state.trends.filter((row) => row.grain === 'month').length;
  if (page.view === 'clients') return num(totals.clients_summarised) || state.clientSummary.length;
  return num(totals.people_summarised) || state.peopleSummary.length;
}

const RAIL_ICONS = {
  overview: 'layout-dashboard',
  drill: 'chart-no-axes-combined',
  hours: 'clock-3',
  audit: 'clipboard-check',
  internal: 'timer',
  people: 'users-round',
  sources: 'database',
  clients: 'chart-pie',
  'people-summary': 'users-round',
  trends: 'chart-column-increasing',
};

function buildRailNav() {
  if (railObserver) { railObserver.disconnect(); railObserver = null; }
  const sections = [...document.querySelectorAll('.block:not([data-page])')];
  const overview = sections[0];
  const rest = sections.slice(1);
  const link = (section) => {
    const title = section.querySelector('h2').textContent;
    const icon = RAIL_ICONS[section.dataset.section] || 'circle';
    return `<a href="#${section.id}" data-target="${section.id}"><span class="rail-link-content"><i class="rail-icon" data-lucide="${icon}" aria-hidden="true"></i>${esc(title)}</span></a>`;
  };
  const pageLinks = PAGES.map((page) => {
    const icon = RAIL_ICONS[page.view] || 'circle';
    return `<a href="${page.hash}" data-view="${page.view}" class="page-link${state.view === page.view ? ' active' : ''}"><span class="rail-link-content"><i class="rail-icon" data-lucide="${icon}" aria-hidden="true"></i>${esc(page.label)}</span><b>${int(pageCount(page))}</b></a>`;
  }).join('');
  $('railNav').innerHTML = [
    overview ? link(overview) : '', ...rest.map(link),
    '<div class="rail-group">Summaries</div>', pageLinks,
  ].join('');
  if (window.lucide?.createIcons) {
    window.lucide.createIcons({ root: $('railNav'), attrs: { focusable: 'false' } });
  }
  if (state.view !== 'page') return;
  railObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      document.querySelectorAll('.rail-nav a[data-target]').forEach((item) => item.classList.toggle('active', item.dataset.target === entry.target.id));
    });
  }, { rootMargin: '-15% 0px -70% 0px' });
  sections.forEach((section) => railObserver.observe(section));
}

/** Single entry point for the shell: 'page' is the scroll report and each
 *  PAGES entry a section shown on its own. */
function setView(view) {
  const page = PAGES.find((item) => item.view === view);
  const known = view === 'page' || page;
  state.view = known ? view : 'page';
  document.body.dataset.view = state.view;
  if (page) {
    const section = $(page.section);
    section.classList.remove('collapsed');
    window.scrollTo(0, 0);
  }
  // The client breakdown skips itself while the page is hidden, so arriving on
  // the page is the point at which it has to catch up.
  if (state.view === 'clients') flushClientEda();
  const hash = page ? page.hash : '';
  if (hash) history.replaceState(null, '', hash);
  // Only a view hash is worth clearing; a section anchor is a legitimate deep link.
  else if (viewFromHash() !== 'page') history.replaceState(null, '', location.pathname + location.search);
  buildRailNav();
}

function openPayrollCoverage() {
  if (state.view !== 'page') setView('page');
  const section = $('section-people');
  section.classList.remove('collapsed');
  section.querySelector('.twist').setAttribute('aria-expanded', 'true');
  state.peopleScope = 'all';
  $('peopleScope').value = 'all';
  setFilterBar(false);
  renderPeople();
  if (window.location.hash !== '#section-people') history.pushState(null, '', '#section-people');
  requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function viewFromHash() {
  const hash = location.hash;
  const page = PAGES.find((item) => item.hash === hash || `#${item.section}` === hash);
  return page ? page.view : 'page';
}

function bindRailNav() {
  $('railNav').addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link) return;
    if (link.dataset.view) {
      event.preventDefault();
      setView(link.dataset.view);
      return;
    }
    if (state.view !== 'page') setView('page');
    const target = link.dataset.target && $(link.dataset.target);
    if (target) {
      target.classList.remove('collapsed');
      const twist = target.querySelector('.twist');
      if (twist) twist.setAttribute('aria-expanded', 'true');
    }
  });
  $('costChip').addEventListener('click', openPayrollCoverage);
}

function bindSections() {
  document.querySelectorAll('.block-head').forEach((head) => {
    head.addEventListener('click', (event) => {
      if (event.target.closest('.block-tools')) return;
      const twist = head.querySelector('.twist');
      if (!twist) return;
      const block = head.closest('.block');
      block.classList.toggle('collapsed');
      twist.setAttribute('aria-expanded', String(!block.classList.contains('collapsed')));
    });
  });
  $('filterHead').addEventListener('click', (event) => {
    if (event.target.closest('button.ghost')) return;
    setFilterBar($('filterBar').classList.contains('collapsed'));
  });
  // Page blocks are left out: they are whole pages, not rows of the report.
  $('expandAll').addEventListener('click', () => {
    document.querySelectorAll('.block:not([data-page])').forEach((block) => block.classList.remove('collapsed'));
    document.querySelectorAll('.block .twist').forEach((twist) => twist.setAttribute('aria-expanded', 'true'));
    setFilterBar(true);
  });
  $('collapseAll').addEventListener('click', () => {
    document.querySelectorAll('.block:not([data-page])').forEach((block) => block.classList.add('collapsed'));
    document.querySelectorAll('.block .twist').forEach((twist) => twist.setAttribute('aria-expanded', 'false'));
    setFilterBar(false);
  });
}

function setFilterBar(open) {
  $('filterBar').classList.toggle('collapsed', !open);
  $('filterHead').querySelector('.twist').setAttribute('aria-expanded', String(open));
}

function resetDrill() {
  state.crumbs = [];
  state.hoursCrumbs = [];
  state.clientCrumbs = [];
  state.clientCluster = null;
  state.personSummaryFocus = null;
  state.personSummaryCrumbs = [];
  state.insightScope = 'all';
  state.page.drill = 0;
  state.page.clients = 0;
}

/** Custom suggestion dropdown for the search box. Native <datalist> takes over
 *  the whole viewport and does not scroll, so a tiny listbox is rendered by
 *  hand: match as the user types, cap at ten rows before scrolling, and only
 *  apply the filter once the user commits with click / Enter / blur. */
function bindSearchSuggest() {
  const input = $('search');
  const box = $('searchSuggest');
  if (!input || !box) return;
  let matches = [];
  let active = -1;

  const hide = () => { box.hidden = true; active = -1; };

  const paint = () => {
    const query = input.value.trim().toLowerCase();
    matches = query
      ? searchPool.filter((entry) => entry.value.toLowerCase().includes(query))
      : searchPool.slice();
    if (!matches.length) {
      box.innerHTML = '<div class="empty">No matches</div>';
      box.hidden = false;
      active = -1;
      return;
    }
    box.innerHTML = matches.map((entry, index) =>
      `<div class="item${index === active ? ' active' : ''}" role="option" data-index="${index}"><span>${esc(entry.value)}</span><span class="kind">${esc(entry.kind)}</span></div>`
    ).join('');
    box.hidden = false;
  };

  const commit = (value) => {
    input.value = value;
    state.filters.search = String(value).trim().toLowerCase();
    hide();
    populateFilters();
    resetDrill();
    render();
  };

  input.addEventListener('focus', paint);
  input.addEventListener('input', () => { active = -1; paint(); });
  input.addEventListener('keydown', (event) => {
    if (box.hidden || !matches.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = (active + 1) % matches.length;
      paint();
      box.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = (active - 1 + matches.length) % matches.length;
      paint();
      box.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      if (active >= 0) { event.preventDefault(); commit(matches[active].value); }
    } else if (event.key === 'Escape') {
      hide();
    }
  });
  input.addEventListener('blur', () => {
    // Delay so a click on an item lands before the box closes.
    setTimeout(hide, 120);
  });
  box.addEventListener('mousedown', (event) => {
    const item = event.target.closest('.item');
    if (!item) return;
    event.preventDefault();
    commit(matches[Number(item.dataset.index)].value);
  });
}

function bindFilters() {
  // Filters that shape the dropdown option list. Search and hoursBasis do not,
  // so they skip the repopulate step to avoid churn on every keystroke.
  const dependent = new Set(['client', 'tl', 'employee', 'service', 'status', 'frequency', 'revenueType', 'method', 'hideZeroRevenue', 'hideUnallocated', 'hideNonLive']);
  const bind = (id, key, transform = (value) => value) => {
    $(id).addEventListener('change', (event) => {
      state.filters[key] = transform(event.target.type === 'checkbox' ? event.target.checked : event.target.value);
      if (dependent.has(key)) populateFilters();
      resetDrill();
      render();
    });
  };
  bindSearchSuggest();
  bind('search', 'search', (value) => String(value).trim().toLowerCase());
  bind('clientFilter', 'client');
  bind('tlFilter', 'tl');
  bind('employeeFilter', 'employee');
  bind('serviceFilter', 'service');
  bind('statusFilter', 'status');
  bind('frequencyFilter', 'frequency');
  bind('revenueTypeFilter', 'revenueType');
  bind('methodFilter', 'method');
  bind('hoursBasis', 'hoursBasis');
  $('applyFxRate').addEventListener('click', () => {
    const raw = $('inrToAedRate').value.trim();
    const rate = Number(raw);
    if (!raw || !Number.isFinite(rate) || rate <= 0) {
      $('fxRateStatus').textContent = 'Enter a positive AED-per-INR conversion rate.';
      return;
    }
    state.filters.inrToAedOverride = rate;
    renderCostRateStatus();
    render();
  });
  $('resetFxRate').addEventListener('click', () => {
    state.filters.inrToAedOverride = null;
    renderCostRateStatus();
    render();
  });
  $('applyCostRate').addEventListener('click', () => {
    const raw = $('costPerHour').value.trim();
    const rate = Number(raw);
    if (!raw || !Number.isFinite(rate) || rate < 0) {
      $('costRateStatus').textContent = 'Enter a nonnegative AED/hour rate to apply.';
      return;
    }
    state.filters.costPerHourOverride = rate;
    renderCostRateStatus();
    render();
  });
  $('usePayrollCost').addEventListener('click', () => {
    state.filters.costPerHourOverride = null;
    $('costPerHour').value = '';
    renderCostRateStatus();
    render();
  });
  bind('hideZeroRevenue', 'hideZeroRevenue');
  bind('hideUnallocated', 'hideUnallocated');
  bind('hideNonLive', 'hideNonLive');

  // Switching the department pool rewrites which projects the facts sit on, so
  // the dependent selects have to be rebuilt and a stale method filter cleared.
  $('deptAllocation').addEventListener('change', (event) => {
    state.filters.deptAllocation = event.target.checked;
    if (state.filters.method === (event.target.checked ? DEPT_OFF_METHOD : DEPT_METHOD)) {
      state.filters.method = 'all';
      $('methodFilter').value = 'all';
    }
    populateFilters();
    resetDrill();
    render();
  });

  $('resetBtn').addEventListener('click', () => {
    Object.assign(state.filters, {
      search: '', client: 'all', tl: 'all', employee: 'all', service: 'all', status: 'all',
      frequency: 'all', revenueType: 'all', method: 'all', hoursBasis: 'all',
      hideZeroRevenue: false, hideUnallocated: false, hideNonLive: false, deptAllocation: true,
      costPerHourOverride: null, inrToAedOverride: null,
    });
    $('search').value = '';
    $('costPerHour').value = '';
    renderCostRateStatus();
    ['clientFilter', 'tlFilter', 'employeeFilter', 'serviceFilter', 'statusFilter', 'frequencyFilter', 'revenueTypeFilter', 'methodFilter', 'hoursBasis'].forEach((id) => { $(id).value = 'all'; });
    ['hideZeroRevenue', 'hideUnallocated', 'hideNonLive'].forEach((id) => { $(id).checked = false; });
    $('deptAllocation').checked = true;
    populateFilters();
    resetDrill();
    render();
  });
}

function bindDrill() {
  $('drillBody').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-row-key]');
    if (!row) return;
    const dimension = DRILL_PATH[state.crumbs.length];
    if (!dimension) return;
    state.crumbs.push({ dim: dimension, value: row.dataset.rowKey });
    state.page.drill = 0;
    keepViewport('section-drill', render);
  });
  $('crumbs').addEventListener('click', (event) => {
    const crumb = event.target.closest('[data-crumb]');
    if (!crumb) return;
    state.crumbs = state.crumbs.slice(0, Number(crumb.dataset.crumb));
    state.page.drill = 0;
    keepViewport('section-drill', render);
  });
  bindSorting($('drillHead'), 'drill', () => { state.page.drill = 0; keepViewport('section-drill', render); });
}

function bindHoursDrill() {
  $('hoursBody').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-row-key]');
    if (!row) return;
    const dimension = HOURS_PATH[state.hoursCrumbs.length];
    if (!dimension || state.hoursCrumbs.length >= HOURS_PATH.length - 1) return;
    state.hoursCrumbs.push({ dim: dimension, value: row.dataset.rowKey });
    render();
    $('section-hours').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('hoursCrumbs').addEventListener('click', (event) => {
    const crumb = event.target.closest('[data-crumb]');
    if (!crumb) return;
    state.hoursCrumbs = state.hoursCrumbs.slice(0, Number(crumb.dataset.crumb));
    render();
  });
}

function bindPanels() {
  bindSorting($('hoursHead'), 'hours', render);
  bindSorting($('auditHead'), 'audit', renderAudit);
  bindSorting($('peopleHead'), 'people', renderPeople);
  bindSorting($('internalHead'), 'internal', renderInternal);
  $('internalDimension').addEventListener('change', (event) => {
    state.internalDimension = event.target.value;
    state.internalCrumbs = [];
    renderInternal();
  });
  $('internalBody').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-row-key]');
    if (!row) return;
    const path = internalPath();
    if (state.internalCrumbs.length >= path.length - 1) return;
    state.internalCrumbs.push({ dim: path[state.internalCrumbs.length], value: row.dataset.rowKey });
    state.sort.internal = { key: 'hours', dir: -1 };
    renderInternal();
  });
  $('internalCrumbs').addEventListener('click', (event) => {
    const crumb = event.target.closest('[data-crumb]');
    if (!crumb) return;
    state.internalCrumbs = state.internalCrumbs.slice(0, Number(crumb.dataset.crumb));
    renderInternal();
  });
  $('peopleScope').addEventListener('change', (event) => { state.peopleScope = event.target.value; renderPeople(); });
  $('peopleBody').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-row-key]');
    if (!row) return;
    const employee = row.dataset.rowKey;
    state.peopleFocus = state.peopleFocus === employee ? null : employee;
    state.peopleCrumbs = [];
    state.sort.peopleDrill = { key: 'hours', dir: -1 };
    renderPeople();
    if (state.peopleFocus) $('peopleDrill').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('auditEmployee').addEventListener('change', (event) => { state.auditEmployee = event.target.value; state.page.audit = 0; renderAudit(); });
}

function bindClients() {
  $('clusterK').addEventListener('change', (event) => {
    state.clusterK = event.target.value === 'auto' ? null : Number(event.target.value);
    state.clientCluster = null;
    state.page.clients = 0;
    render();
  });
  $('clusterCards').addEventListener('click', (event) => {
    const card = event.target.closest('[data-cluster]');
    if (!card) return;
    state.clientCluster = state.clientCluster === card.dataset.cluster ? null : card.dataset.cluster;
    state.clientCrumbs = [];
    state.page.clients = 0;
    render();
  });
  $('clientBody').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-row-key]');
    if (!row) return;
    const dimension = CLIENT_PATH[state.clientCrumbs.length];
    if (!dimension) return;
    state.clientCrumbs.push({ dim: dimension, value: row.dataset.rowKey });
    state.page.clients = 0;
    render();
  });
  $('clientCrumbs').addEventListener('click', (event) => {
    const crumb = event.target.closest('[data-crumb]');
    if (!crumb) return;
    state.clientCrumbs = state.clientCrumbs.slice(0, Number(crumb.dataset.crumb));
    state.page.clients = 0;
    render();
  });
  bindSorting($('clientHead'), 'clients', () => { state.page.clients = 0; render(); });
}

function bindPeopleSummary() {
  $('insightScope').addEventListener('change', (event) => {
    state.insightScope = event.target.value;
    state.personSummaryFocus = null;
    state.personSummaryCrumbs = [];
    render();
  });
  $('peopleInsights').addEventListener('click', (event) => {
    const card = event.target.closest('[data-insight]');
    if (!card) return;
    state.insightScope = state.insightScope === card.dataset.insight ? 'all' : card.dataset.insight;
    state.personSummaryFocus = null;
    state.personSummaryCrumbs = [];
    render();
  });
  $('personSummaryBody').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-row-key]');
    if (!row) return;
    const employee = row.dataset.rowKey;
    state.personSummaryFocus = state.personSummaryFocus === employee ? null : employee;
    state.personSummaryCrumbs = [];
    state.sort.personSummaryDrill = { key: 'hours', dir: -1 };
    render();
    if (state.personSummaryFocus) $('personSummaryDrill').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  bindSorting($('personSummaryHead'), 'personSummary', render);
}

/* ------------------------------------------------------------------ sources */

const SOURCE_FIELDS = { projects: 'projectsFile', timesheet: 'timesheetFile', employees: 'employeesFile', payroll: 'payrollFile', revisions: 'revisionsFile' };

/**
 * Rebuild the EDA server-side, then reload every dataset in place. Files are
 * optional; the requested window always rides along so a rebuild keeps it.
 */
async function rebuild(files = {}) {
  const form = new FormData();
  Object.entries(files).forEach(([field, file]) => form.append(field, file));
  form.append('start', $('windowStart').value || '');
  form.append('end', $('windowEnd').value || '');
  const response = await fetch('/api/regenerate', { method: 'POST', body: form });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || 'Rebuild failed');
  await loadAll();
  populateFilters();
  renderHeader();
  renderManifest();
  resetDrill();
  render();
  return result;
}

function bindWindow() {
  const apply = async (start, end, pending) => {
    const buttons = [$('applyWindow'), $('fullWindow'), $('regenerateBtn')];
    $('windowStart').value = start;
    $('windowEnd').value = end;
    buttons.forEach((button) => { button.disabled = true; });
    setWindowStatus(pending);
    try {
      await rebuild();
      setWindowStatus(`Rebuilt for ${state.manifest.window.start} → ${state.manifest.window.end} · ${state.manifest.window.days} days.`, 'success');
    } catch (error) {
      setWindowStatus(error.message, 'failure');
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
      $('fullWindow').disabled = !state.manifest.window.custom;
    }
  };

  $('applyWindow').addEventListener('click', () => {
    const start = $('windowStart').value;
    const end = $('windowEnd').value;
    if (!start || !end) { setWindowStatus('Pick both a start and an end date.', 'failure'); return; }
    if (start > end) { setWindowStatus('Start date must be on or before the end date.', 'failure'); return; }
    apply(start, end, `Rebuilding for ${start} → ${end}...`);
  });

  $('fullWindow').addEventListener('click', () => apply('', '', 'Rebuilding for the full timesheet history...'));
}

function bindSources() {
  Object.values(SOURCE_FIELDS).forEach((id) => {
    const input = $(id);
    input.addEventListener('change', () => {
      const label = input.closest('.file-input');
      const file = input.files[0];
      label.classList.toggle('chosen', Boolean(file));
      label.querySelector('.file-state').textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB` : 'No file chosen';
    });
  });

  $('regenerateBtn').addEventListener('click', async () => {
    const status = $('regenerateStatus');
    const button = $('regenerateBtn');
    const files = {};
    let chosen = 0;
    Object.entries(SOURCE_FIELDS).forEach(([field, id]) => {
      const file = $(id).files[0];
      if (file) { files[field] = file; chosen += 1; }
    });
    if (!chosen) {
      status.textContent = 'Choose at least one file to replace.';
      status.className = 'regenerate-status failure';
      return;
    }
    button.disabled = true;
    status.textContent = 'Uploading and rebuilding the EDA...';
    status.className = 'regenerate-status';
    try {
      const result = await rebuild(files);
      status.textContent = `${result.replaced.join(', ')} replaced. ${costLoaded() ? 'Cost is now live.' : 'Cost still locked.'}`;
      status.className = 'regenerate-status success';
      Object.values(SOURCE_FIELDS).forEach((id) => {
        $(id).value = '';
        const label = $(id).closest('.file-input');
        label.classList.remove('chosen');
        label.querySelector('.file-state').textContent = 'No file chosen';
      });
    } catch (error) {
      status.textContent = error.message;
      status.className = 'regenerate-status failure';
    } finally {
      button.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ boot */

async function loadAll() {
  const stamp = `?v=${Date.now()}`;
  $('bootText').textContent = 'Loading manifest';
  state.manifest = await loadJson(`EDA_Manifest.json${stamp}`);
  $('bootText').textContent = 'Loading project hours';
  state.projects = new Map();
  ingestFacts(await loadCsv(`EDA_Project_Hours.csv${stamp}`));
  $('bootText').textContent = 'Loading supporting datasets';
  const [utilisation, internal, unallocated, unallocatedNoDept, mismatch, audit, costs, clientSummary, peopleSummary, revisions, trends] = await Promise.all([
    loadCsvOptional(`EDA_Employee_Utilization.csv${stamp}`),
    loadCsvOptional(`EDA_Internal_Time.csv${stamp}`),
    loadCsvOptional(`EDA_Unallocated_Hours.csv${stamp}`),
    loadCsvOptional(`EDA_Unallocated_Hours_no_dept.csv${stamp}`),
    loadCsvOptional(`EDA_Period_Mismatch.csv${stamp}`),
    loadCsvOptional(`EDA_Allocation_Audit.csv${stamp}`),
    loadCsvOptional(`EDA_Employee_Cost.csv${stamp}`),
    loadCsvOptional(`EDA_Client_Summary.csv${stamp}`),
    loadCsvOptional(`EDA_People_Summary.csv${stamp}`),
    loadCsvOptional(`EDA_Salary_Revisions.csv${stamp}`),
    loadCsvOptional(`EDA_Trends.csv${stamp}`),
  ]);
  state.trends = trends.map(parseTrendRow);
  state.utilisation = utilisation;
  state.internal = internal;
  state.unallocated = unallocated;
  state.unallocatedNoDept = unallocatedNoDept;
  state.mismatch = mismatch;
  state.audit = audit;
  state.clientSummary = clientSummary;
  state.peopleSummary = peopleSummary;
  state.revisions = revisions;
  ingestCosts(costs);
}

async function init() {
  try {
    await loadAll();
    populateFilters();
    renderHeader();
    renderManifest();
    buildRailNav();
    bindRailNav();
    bindSections();
    setView(viewFromHash());
    window.addEventListener('hashchange', () => setView(viewFromHash()));
    bindFilters();
    bindWindow();
    bindDrill();
    bindHoursDrill();
    bindPanels();
    bindClients();
    bindPeopleSummary();
    bindTrends();
    bindSources();
    render();
    $('boot').classList.add('done');
    setTimeout(() => { $('boot').hidden = true; }, 300);
  } catch (error) {
    console.error(error);
    $('bootText').textContent = 'Load failed';
    $('errorBox').hidden = false;
    $('errorBox').textContent = `${error.message}. Run "python3 dashboard_server.py" in this folder and open http://localhost:8765/index.html`;
  }
}

init();
