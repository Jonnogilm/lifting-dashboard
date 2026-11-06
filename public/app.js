const app = document.querySelector('#app');
const modalRoot = document.querySelector('#modal-root');
const LENGTH_FIELDS = ['waist', 'chest', 'neck', 'leftArm', 'rightArm', 'hips', 'leftThigh', 'rightThigh'];
const DRAFT_KEY = 'ironlog-workout-draft-v2';
const toastRoot = document.querySelector('#toast-root');

const ui = {
  route: location.hash.slice(1) || 'dashboard',
  workoutSearch: '',
  exerciseSearch: '',
  exerciseMuscle: 'All',
  strengthExercise: '',
  strengthVariation: '',
  strengthSelections: {},
  bodyCompositionMetric: 'weight',
  circumferenceMetric: 'waist',
  recoveryMetric: 'restingHeartRate',
  workoutDraft: null,
  recommendations: null,
  initialDraftChecked: false,
  exercisePickerQuery: '',
  templateQuery: '',
  savingVariation: false,
  saving: false,
  exerciseScope: 'recent',
  librarySelections: {},
  strengthMetric: 'estimated',
  chartRange: 'all',
  bodyTab: 'weight'
};

try {
  const views = JSON.parse(localStorage.getItem('ironlog-views') || '{}');
  for (const key of ['strengthExercise','strengthVariation','strengthSelections','librarySelections','exerciseScope','chartRange','strengthMetric','bodyTab']) if (views[key] != null) ui[key] = views[key];
} catch {}
function rememberViews() {
  try { localStorage.setItem('ironlog-views', JSON.stringify(Object.fromEntries(['strengthExercise','strengthVariation','strengthSelections','librarySelections','exerciseScope','chartRange','strengthMetric','bodyTab'].map(key => [key,ui[key]])))); } catch {}
}

let state = null;
let modalPageScrollY = 0;
let modalPageScrollLocked = false;
let modalTrigger = null;
let recommendationPoll = null;

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const number = (value, maximumFractionDigits = 0) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits });
const localIso = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const todayIso = () => localIso();
const dateFromIso = value => new Date(`${value}T12:00:00`);
const daysBetween = (later, earlier) => Math.floor((later - earlier) / 86400000);
const shortDate = value => dateFromIso(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDate = value => dateFromIso(value).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const monthName = value => dateFromIso(value).toLocaleDateString(undefined, { month: 'short' });
const unit = () => state?.settings?.weightUnit || 'lb';
const measureUnit = () => state?.settings?.measurementUnit || 'in';
const estimateOneRepMax = (weight, reps) => Number(weight) > 0 ? Number(weight) * (1 + Number(reps) / 30) : 0;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers
  });
  if (!response.ok) {
    let error = `Request failed (${response.status})`;
    try { error = (await response.json()).error || error; } catch {}
    throw new Error(error);
  }
  return response.json();
}

async function refresh() {
  state = await api('/api/state');
  if (state.settings.measurementUnit === 'cm') for (const item of state.measurements) for (const field of LENGTH_FIELDS) if (item[field] != null) item[field] *= 2.54;
  render();
  refreshRecommendations(true).then(result => { if (result.status === 'running') pollRecommendations().catch(() => {}); }).catch(() => {});
  if (!ui.initialDraftChecked) {
    ui.initialDraftChecked = true;
    render();
  }
}

function toast(message, type = '') {
  if (type === 'error') { const inline = modalRoot.querySelector('.form-error'); if (inline) { inline.textContent = message; inline.hidden = false; } }
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  toastRoot.replaceChildren(element);
  setTimeout(() => element.remove(), 3200);
}

function allSets() {
  return state.workouts.flatMap(workout => workout.exercises.flatMap(exercise =>
    exercise.sets.filter(set => set.completed !== false).map(set => ({ ...set, exerciseName: exercise.name, exerciseId: exercise.exerciseId, date: workout.date, workoutId: workout.id }))
  ));
}

function workoutVolume(workout) {
  return workout.exercises.reduce((sum, exercise) => sum + exercise.sets.reduce((exerciseSum, set) =>
    exerciseSum + (set.completed === false ? 0 : Number(set.weight || 0) * Number(set.reps || 0)), 0), 0);
}

function workoutSetCount(workout) {
  return workout.exercises.reduce((sum, exercise) => sum + exercise.sets.filter(set => set.completed !== false).length, 0);
}

function personalRecords() {
  const records = new Map();
  for (const set of allSets()) {
    const estimated = estimateOneRepMax(set.weight, set.reps);
    if (estimated <= 0 || Number(set.reps) <= 0) continue;
    const key = trackingExercise({ exerciseId: set.exerciseId, name: set.exerciseName }).key;
    const current = records.get(key);
    if (!current || estimated > current.estimated) records.set(key, { ...set, trackingKey: key, estimated });
  }
  return [...records.values()].sort((a, b) => b.estimated - a.estimated);
}

// Resolve catalog IDs first so renamed and separately logged variations stay distinct.
function trackingExercise(entry) {
  const catalog = state.exercises.find(item => item.id === entry.exerciseId)
    || (!entry.exerciseId ? state.exercises.find(item => item.name === entry.name) : null);
  const name = catalog?.name || entry.name;
  const family = catalog?.family || entry.family || name;
  return {
    key: catalog?.id || entry.exerciseId || `name:${name}`,
    family,
    name,
    variation: catalog?.variation || entry.variation || (name === family ? 'Unspecified' : name)
  };
}

function strengthOptions() {
  const entries = new Map(state.exercises.map(item => {
    const resolved = trackingExercise({ exerciseId: item.id, name: item.name });
    return [resolved.key, resolved];
  }));
  for (const workout of state.workouts) for (const entry of workout.exercises) {
    const resolved = trackingExercise(entry);
    if (!entries.has(resolved.key)) entries.set(resolved.key, resolved);
  }
  return [...entries.values()].sort((a, b) => a.family.localeCompare(b.family) || a.variation.localeCompare(b.variation, undefined, { numeric: true }));
}

function selectStrengthTracking() {
  const options = strengthOptions();
  const families = [...new Set(options.map(item => item.family))];
  const latestTracked = [...state.workouts].sort((a, b) => b.date.localeCompare(a.date))
    .flatMap(workout => workout.exercises).filter(entry => entry.sets.some(set => set.completed !== false && Number(set.reps) > 0 && Number(set.weight) > 0))
    .map(trackingExercise);
  if (!families.includes(ui.strengthExercise)) ui.strengthExercise = latestTracked[0]?.family || families[0] || '';
  const variants = options.filter(item => item.family === ui.strengthExercise);
  const remembered = ui.strengthSelections[ui.strengthExercise];
  if (!variants.some(item => item.key === ui.strengthVariation)) {
    ui.strengthVariation = variants.find(item => item.key === remembered)?.key
      || latestTracked.find(item => item.family === ui.strengthExercise)?.key || variants[0]?.key || '';
  }
  ui.strengthSelections[ui.strengthExercise] = ui.strengthVariation;
  return { families, variants, selected: variants.find(item => item.key === ui.strengthVariation) };
}

function strengthSelectors(selection) {
  return `<div class="strength-selectors">
    <label for="strength-exercise">Exercise<select class="select-compact" id="strength-exercise">${selection.families.map(name => `<option value="${escapeHtml(name)}" ${name === ui.strengthExercise ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></label>
    ${selection.variants.length > 1 || selection.selected?.variation !== 'Unspecified' ? `<label for="strength-variation">Variation<select class="select-compact" id="strength-variation">${selection.variants.map(item => `<option value="${escapeHtml(item.key)}" ${item.key === ui.strengthVariation ? 'selected' : ''}>${escapeHtml(item.variation)}</option>`).join('')}</select></label>` : ''}
  </div>`;
}

function rangePoints(points) {
  const cutoff = new Date();
  if (ui.chartRange !== 'all') cutoff.setDate(cutoff.getDate() - Number(ui.chartRange) * 7);
  const start = localIso(cutoff);
  return points.filter(point => point.date <= todayIso() && (ui.chartRange === 'all' || point.date >= start));
}

function strengthHistory(variationKey) {
  return rangePoints([...state.workouts].sort((a, b) => a.date.localeCompare(b.date)).map(workout => {
    const sets = workout.exercises.filter(item => trackingExercise(item).key === variationKey).flatMap(item => item.sets)
      .filter(set => set.completed !== false && Number(set.reps) > 0 && Number(set.weight) > 0);
    if (!sets.length) return null;
    const score = set => ui.strengthMetric === 'load' ? Number(set.weight) : estimateOneRepMax(set.weight, set.reps);
    const best = [...sets].sort((a, b) => score(b) - score(a))[0];
    const value = ui.strengthMetric === 'volume' ? sets.reduce((sum, set) => sum + set.weight * set.reps, 0) : score(best);
    return { date: workout.date, value, detail: ui.strengthMetric === 'volume' ? `${sets.length} completed sets` : `${number(best.weight, 1)} ${unit()} × ${best.reps} reps · estimated 1RM ${number(estimateOneRepMax(best.weight, best.reps), 1)} ${unit()}` };
  }).filter(Boolean));
}

function selectedStrengthRecord(variationKey) {
  let best = null;
  for (const workout of state.workouts) for (const entry of workout.exercises) {
    if (trackingExercise(entry).key !== variationKey) continue;
    for (const set of entry.sets) {
      if (set.completed === false || Number(set.reps) <= 0 || Number(set.weight) <= 0) continue;
      const estimated = estimateOneRepMax(set.weight, set.reps);
      if (!best || estimated > best.estimated) best = { ...set, estimated, date: workout.date };
    }
  }
  return best;
}

function rangeSelector() {
  return `<label>Period<select class="select-compact" data-chart-range>${[['4','4 weeks'],['12','12 weeks'],['all','All time']].map(([value,label]) => `<option value="${value}" ${ui.chartRange === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
}

function renderStrengthPanel(showRecord = false) {
  const selection = selectStrengthTracking();
  const history = strengthHistory(ui.strengthVariation);
  const record = showRecord ? selectedStrengthRecord(ui.strengthVariation) : null;
  const label = selection.selected ? `${selection.selected.family}${selection.variants.length > 1 || selection.selected.variation !== 'Unspecified' ? ` · ${selection.selected.variation}` : ''}` : '';
  const change = history.length >= 2 ? history.at(-1).value - history[0].value : null;
  const suffix = ui.strengthMetric === 'volume' ? ` ${unit()}·reps` : ` ${unit()}`;
  return `<article class="panel strength-panel">
    <div class="panel-header"><div><h2>${showRecord ? 'Exercise progress' : 'Strength trend'}</h2></div>${selection.families.length ? strengthSelectors(selection) : ''}</div>
    <div class="chart-toolbar"><label>Metric<select class="select-compact" id="strength-metric">${[['estimated','Estimated strength'],['load','Best set load'],['volume','Session volume']].map(([value,label]) => `<option value="${value}" ${ui.strengthMetric === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${rangeSelector()}
    ${state.exercises.some(e => e.id === selection.selected?.key) ? `<button class="link-button" data-action="add-variation" data-id="${escapeHtml(selection.selected.key)}">+ Add variation</button>` : ''}</div>
    <div class="trend-summary"><span>${history.length ? `<strong>${number(history.at(-1).value, 1)}${suffix}</strong> latest · ${shortDate(history.at(-1).date)}` : escapeHtml(label)}</span>${change != null ? `<span>${change > 0 ? '+' : ''}${number(change,1)}${suffix} over ${history.length} sessions</span>` : ''}
    ${record ? `<span><strong>Estimated 1RM: ${number(record.estimated, 1)} ${unit()}</strong><br>${number(record.weight, 1)} ${unit()} × ${record.reps} · ${shortDate(record.date)} · all-time best</span>` : ''}</div>
    ${history.length ? lineChart(history, suffix) : '<div class="empty-chart">No weighted sets logged for this variation in this period.</div>'}
    <p class="panel-subtitle">Estimated strength uses load × (1 + reps ÷ 30). Volume is load × reps, not a measure of muscle growth.</p>
  </article>`;
}

function variationPayload(exercise, label) {
  const variation = String(label || '').trim().replace(/\s+/g, ' ');
  if (!variation) throw new Error('Enter a variation, such as 45° or Single arm.');
  const family = exercise.family || exercise.name;
  const name = `${family} (${variation})`;
  if (name.length > 100) throw new Error('Use a shorter variation name.');
  const comparable = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (state.exercises.some(e => (e.family || e.name) === family &&
    (comparable(e.variation) === comparable(variation) || comparable(e.name) === comparable(name)))) {
    throw new Error('That variation already exists for this exercise.');
  }
  return { name, family, variation, muscle: exercise.muscle, equipment: exercise.equipment, loadMode: exerciseLoadMode(exercise), targets: [...(exercise.targets || [])] };
}

function weeksData(count = 8) {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const mondayFirst = state.settings.weekStartsOn !== 'sunday';
  const day = now.getDay();
  const offset = mondayFirst ? (day === 0 ? 6 : day - 1) : day;
  const currentStart = new Date(now);
  currentStart.setDate(now.getDate() - offset);
  return Array.from({ length: count }, (_, index) => {
    const weeksAgo = count - 1 - index;
    const start = new Date(currentStart);
    start.setDate(start.getDate() - weeksAgo * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const workouts = state.workouts.filter(item => {
      const date = dateFromIso(item.date);
      return date >= start && date < end && item.date <= todayIso();
    });
    return {
      start,
      label: start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      sessions: workouts.length,
      volume: workouts.reduce((sum, workout) => sum + workoutVolume(workout), 0)
    };
  });
}

function measurementsFor(field) {
  return [...state.measurements].filter(item => item.date <= todayIso() && (!field || (item[field] != null && item[field] !== ''))).sort((a, b) => b.date.localeCompare(a.date));
}
function latestMeasurement(field) { return measurementsFor(field)[0] || null; }
function previousMeasurement(field) { return measurementsFor(field)[1] || null; }

function getGoalCurrent(goal) {
  if (goal.type === 'strength') return personalRecords().find(item => goal.exerciseId ? item.trackingKey === goal.exerciseId : item.exerciseName === goal.exerciseName)?.estimated ?? 0;
  if (goal.type === 'bodyweight') return latestMeasurement('weight')?.weight ?? goal.start ?? 0;
  if (goal.type === 'consistency') return weeksData(1)[0]?.sessions || 0;
  return 0;
}

function getGoalProgress(goal) {
  const current = getGoalCurrent(goal);
  const denominator = goal.target - goal.start;
  if (!denominator) return current >= goal.target ? 100 : 0;
  return Math.max(0, Math.min(100, ((current - goal.start) / denominator) * 100));
}

function pageHeader(eyebrow, title, actions = '') {
  return `<header class="page-header">
    <div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1></div>
    <div class="page-actions">${actions}</div>
  </header>`;
}

function emptyState(title, message, action = '') {
  return `<div class="empty-state"><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p>${action}</div></div>`;
}

function statCard(label, value, meta, icon, color) {
  return `<article class="stat-card">
    <div class="stat-top"><span class="stat-label">${escapeHtml(label)}</span><span class="stat-icon ${color}">${escapeHtml(icon)}</span></div>
    <div class="stat-value">${value}</div><div class="stat-meta">${meta}</div>
  </article>`;
}

function lineChart(rawPoints, suffix = '', colorClass = '') {
  const points = [...rawPoints].sort((a,b) => a.date.localeCompare(b.date));
  if (!points.length) return '<div class="empty-chart">No entries in this period.</div>';
  const compact = typeof window !== 'undefined' && window.matchMedia('(max-width: 600px)').matches;
  const width = compact ? 340 : 700;
  const height = compact ? 220 : 260;
  const padding = { top: 18, right: 30, bottom: 32, left: 52 };
  const values = points.map(point => Number(point.value));
  let min = Math.min(...values), max = Math.max(...values);
  const spread = max - min || Math.max(Math.abs(max) * .1, 1);
  min = Math.max(0, min - spread * .18); max += spread * .18;
  const dates = points.map(point => dateFromIso(point.date).getTime());
  const first = dates[0], span = dates.at(-1) - first;
  const x = index => padding.left + (span ? (dates[index] - first) / span : .5) * (width - padding.left - padding.right);
  const y = value => padding.top + ((max - value) / (max - min)) * (height - padding.top - padding.bottom);
  const grid = Array.from({ length: 4 }, (_, i) => {
    const value = max - i * (max - min) / 3;
    return `<line class="chart-grid-line" x1="${padding.left}" y1="${y(value)}" x2="${width-padding.right}" y2="${y(value)}"/><text class="chart-axis-label" x="${padding.left-7}" y="${y(value)+4}" text-anchor="end">${number(value, 1)}</text>`;
  }).join('');
  const labels = [...new Set([0, points.length-1])];
  const description = point => `${longDate(point.date)}: ${number(point.value,1)}${suffix}${point.detail ? ` · ${point.detail}` : ''}`;
  return `<div class="interactive-chart"><svg class="line-chart ${colorClass}" viewBox="0 0 ${width} ${height}" aria-label="Trend over calendar dates" role="group">
    ${grid}${points.length > 1 ? `<polyline class="chart-line" points="${points.map((p,i) => `${x(i)},${y(p.value)}`).join(' ')}"/>` : ''}
    ${points.map((point,i) => `<g role="button" tabindex="0" data-chart-point="${escapeHtml(description(point))}" aria-label="${escapeHtml(description(point))}"><circle class="chart-hit" cx="${x(i)}" cy="${y(point.value)}" r="16"/><circle class="chart-point" cx="${x(i)}" cy="${y(point.value)}" r="4"/></g>`).join('')}
    ${labels.map(i => `<text class="chart-axis-label" x="${x(i)}" y="${height-8}" text-anchor="middle">${escapeHtml(shortDate(points[i].date))}</text>`).join('')}
    </svg><p class="chart-readout" aria-live="polite">${points.length === 1 ? escapeHtml(description(points[0])) : 'Tap a point for the date and values.'}</p>
    <details class="chart-data"><summary>View data (${points.length} ${points.length === 1 ? 'entry' : 'entries'})</summary><div class="table-scroll"><table class="data-table"><caption class="sr-only">Chart values by date</caption><thead><tr><th>Date</th><th>Value (${escapeHtml(suffix.trim())})</th><th>Details</th></tr></thead><tbody>${points.map(point => `<tr><td>${longDate(point.date)}</td><td>${number(point.value,1)}</td><td>${escapeHtml(point.detail || '—')}</td></tr>`).join('')}</tbody></table></div></details></div>`;
}

function barChart(weeks) {
  const max = Math.max(...weeks.map(week => week.volume), 1);
  return `<div class="bar-chart" role="img" aria-label="Weekly training volume">
    ${weeks.map(week => `<div class="bar-column">
      <span class="bar-value">${week.volume ? number(week.volume / 1000, 1) + 'k' : ''}</span>
      <div class="bar-track"><div class="bar-fill" style="height:${Math.max(week.volume ? 4 : 0, week.volume / max * 100)}%"></div></div>
      <span class="bar-label">${escapeHtml(week.label)}</span>
    </div>`).join('')}
  </div>`;
}

function renderDashboard() {
  const now = new Date();
  const start = weeksData(1)[0].start;
  const recent = state.workouts.filter(workout => dateFromIso(workout.date) >= start && workout.date <= todayIso());
  const recentVolume = recent.reduce((sum, workout) => sum + workoutVolume(workout), 0);
  const latest = latestMeasurement('weight');
  const previous = previousMeasurement('weight');
  const weightDelta = latest && previous ? latest.weight - previous.weight : null;
  const latestSessions = [...state.workouts].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const greetingHour = new Date().getHours();
  const greeting = greetingHour < 12 ? 'Good morning' : greetingHour < 18 ? 'Good afternoon' : 'Good evening';

  return `${pageHeader(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), `${greeting}, ${state.settings.athleteName}`, `<button class="button primary" data-action="new-workout">+ Log workout</button>`)}
    <section class="stat-grid">
      ${statCard('Sessions this week', number(recent.length), recent.length ? `${number(recent.reduce((sum, workout) => sum + workout.duration, 0))} training minutes` : 'No sessions this calendar week', 'WK', 'green')}
      ${statCard('Volume this week', `${number(recentVolume / 1000, 1)}k`, recentVolume ? `${unit()} moved across ${number(recent.reduce((sum, workout) => sum + workoutSetCount(workout), 0))} sets` : `0 ${unit()} logged`, 'VOL', 'blue')}
      ${statCard('Bodyweight', latest?.weight != null ? `${number(latest.weight, 1)} <small>${unit()}</small>` : '--', weightDelta == null ? 'No trend yet' : `<span>${weightDelta > 0 ? '+' : ''}${number(weightDelta, 1)} ${unit()}</span> since ${shortDate(previous.date)} · latest ${shortDate(latest.date)}`, 'BW', 'coral')}
      ${statCard('Last workout', latestSessions[0] ? escapeHtml(shortDate(latestSessions[0].date)) : '--', latestSessions[0] ? escapeHtml(latestSessions[0].name) : 'Log your first session', 'LAST', 'acid')}
    </section>
    <section class="dashboard-grid">
      ${renderStrengthPanel()}
      <article class="panel"><div class="panel-header"><div><h2>Weekly volume</h2><p class="panel-subtitle">Last eight weeks, ${unit()}</p></div></div>${barChart(weeksData(8))}</article>
    </section>
    <section class="dashboard-grid">
      <article class="panel table-panel">
        <div class="panel-header"><div><h2>Recent sessions</h2><p class="panel-subtitle">Latest training activity</p></div><a href="#workouts" class="link-button">View all</a></div>
        ${latestSessions.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Session</th><th>Date</th><th>Sets</th><th>Volume</th><th></th></tr></thead><tbody>${latestSessions.map(workout => `<tr>
          <td><div class="session-name">${escapeHtml(workout.name)}</div><div class="session-meta">${workout.exercises.map(item => escapeHtml(item.name)).slice(0, 3).join(', ')}</div></td>
          <td>${escapeHtml(shortDate(workout.date))}</td><td>${workoutSetCount(workout)}</td><td>${number(workoutVolume(workout))} ${unit()}</td>
          <td><button class="link-button" data-action="edit-workout" data-id="${workout.id}">Open</button></td></tr>`).join('')}</tbody></table></div>` : emptyState('No sessions yet', 'Your completed workouts will appear here.', '<button class="button primary" data-action="new-workout">Log first workout</button>')}
      </article>
      <article class="panel">
        <div class="panel-header"><div><h2>Active goals</h2><p class="panel-subtitle">Current targets</p></div><button class="link-button" data-action="new-goal">Add goal</button></div>
        ${state.goals.length ? `<div class="goal-list">${state.goals.filter(goal => !goal.completed).slice(0, 3).map(goalCard).join('')}</div>` : '<p class="muted">Set a strength, bodyweight, or weekly consistency target.</p>'}
      </article>
    </section>`;
}

function renderWorkouts() {
  const workouts = [...state.workouts]
    .filter(workout => !ui.workoutSearch || `${workout.name} ${workout.exercises.map(item => item.name).join(' ')}`.toLowerCase().includes(ui.workoutSearch.toLowerCase()))
    .sort((a, b) => b.date.localeCompare(a.date));
  return `${pageHeader('Training log', 'Workouts', `<button class="button primary" data-action="new-workout">+ Log workout</button>`)}
    <div class="toolbar"><div class="search-field"><input id="workout-search" type="search" value="${escapeHtml(ui.workoutSearch)}" placeholder="Search sessions or exercises" aria-label="Search workouts"></div>
      <span class="pill">${state.workouts.length} sessions</span></div>
    ${workouts.length ? `<div class="workout-list">${workouts.map(workout => {
      const date = dateFromIso(workout.date);
      return `<article class="workout-card">
        <div class="date-block"><div class="date-day">${date.getDate()}</div><div class="date-month">${monthName(workout.date)} ${date.getFullYear()}</div></div>
        <div><div class="workout-title">${escapeHtml(workout.name)}</div><div class="exercise-summary">${workout.exercises.map(exercise => `${escapeHtml(exercise.name)} (${exercise.sets.length})`).join(' · ')}</div></div>
        <div class="workout-numbers"><div class="mini-number"><strong>${workoutSetCount(workout)}</strong><span>sets</span></div><div class="mini-number"><strong>${number(workoutVolume(workout) / 1000, 1)}k</strong><span>${unit()} volume</span></div><div class="row-actions"><button class="link-button" data-action="edit-workout" data-id="${workout.id}">Edit</button><button class="link-button danger" data-action="delete-workout" data-id="${workout.id}">Delete</button></div></div>
      </article>`;
    }).join('')}</div>` : emptyState(ui.workoutSearch ? 'No matching workouts' : 'Start your training log', ui.workoutSearch ? 'Try a different search.' : 'Log exercises, sets, reps, weight, duration, and notes.', ui.workoutSearch ? '' : '<button class="button primary" data-action="new-workout">Log first workout</button>')}`;
}

function librarySelection(family, members) {
  const remembered = ui.librarySelections[family];
  if (members.some(e => e.id === remembered)) return members.find(e => e.id === remembered);
  for (const workout of [...state.workouts].sort((a,b) => b.date.localeCompare(a.date))) {
    const used = workout.exercises.find(entry => members.some(e => e.id === entry.exerciseId));
    if (used) return members.find(e => e.id === used.exerciseId);
  }
  return members[0];
}

function renderExercises() {
  const muscles = ['All', ...new Set(state.exercises.map(item => item.muscle).sort())];
  const recentDate = new Date(); recentDate.setDate(recentDate.getDate()-56);
  const recentIds = new Set(state.workouts.filter(w => w.date >= localIso(recentDate) && w.date <= todayIso()).flatMap(w => w.exercises.map(e => e.exerciseId)));
  const families = groupedExercises(state.exercises).filter(base => {
    const members = state.exercises.filter(e => familyName(e) === familyName(base));
    return members.some(e => (ui.exerciseMuscle === 'All' || e.muscle === ui.exerciseMuscle) && (!ui.exerciseSearch || `${e.name} ${familyName(e)} ${e.variation} ${e.muscle} ${e.equipment}`.toLowerCase().includes(ui.exerciseSearch.toLowerCase()))) &&
      (ui.exerciseScope === 'all' || ui.exerciseSearch || members.some(e => recentIds.has(e.id)));
  }).sort((a,b) => familyName(a).localeCompare(familyName(b)));
  return `${pageHeader('Movement library', 'Exercises', '<button class="button primary" data-action="new-exercise">+ Add exercise</button>')}
    <div class="toolbar"><div class="search-field"><input id="exercise-search" type="search" value="${escapeHtml(ui.exerciseSearch)}" placeholder="Search exercises" aria-label="Search exercises"></div>
    <label>Show<select class="select-compact" id="exercise-scope"><option value="recent" ${ui.exerciseScope === 'recent' ? 'selected' : ''}>Recent (8 weeks)</option><option value="all" ${ui.exerciseScope === 'all' ? 'selected' : ''}>All exercises</option></select></label>
    <label>Muscle<select class="select-compact" id="muscle-filter">${muscles.map(m => `<option ${m === ui.exerciseMuscle ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}</select></label></div>
    ${families.length ? `<div class="exercise-grid">${families.map(base => {
      const family = familyName(base), members = state.exercises.filter(e => familyName(e) === family);
      const exercise = librarySelection(family, members);
      const record = selectedStrengthRecord(exercise.id);
      const sessions = state.workouts.filter(w => w.exercises.some(e => e.exerciseId === exercise.id)).sort((a,b) => b.date.localeCompare(a.date));
      return `<article class="exercise-card"><div class="exercise-card-top"><div><h3>${escapeHtml(family)}</h3><p class="exercise-meta">${escapeHtml(exercise.muscle)} · ${escapeHtml(exercise.equipment)}</p></div>
      <details class="actions-menu"><summary aria-label="Actions for ${escapeHtml(exercise.name)}">Actions</summary><button class="link-button" data-action="edit-exercise" data-id="${exercise.id}">Edit selected variation</button><button class="link-button danger" data-action="delete-exercise" data-id="${exercise.id}">Delete selected variation</button></details></div>
      ${members.length > 1 ? `<div class="field"><label>Variation<select data-library-variation="${escapeHtml(family)}">${members.map(e => `<option value="${e.id}" ${e.id === exercise.id ? 'selected' : ''}>${escapeHtml(e.variation || (e.name === family ? 'Unspecified' : e.name))}</option>`).join('')}</select></label></div>` : exercise.variation ? `<p>${escapeHtml(exercise.variation)}</p>` : ''}
      <button class="link-button" data-action="add-variation" data-id="${exercise.id}">+ Add variation</button>
      ${exercise.targets?.length ? '' : '<p class="muted">Muscle targets need review.</p>'}
      <div class="exercise-record"><span>Estimated 1RM<br><strong>${record ? `${number(record.estimated,1)} ${unit()}` : '—'}</strong></span><span>Sessions<br><strong>${sessions.length}</strong></span><span>Last logged<br><strong>${sessions[0] ? shortDate(sessions[0].date) : '—'}</strong></span></div></article>`;
    }).join('')}</div>` : emptyState('No exercises in this view', 'Search your full library or switch to All exercises.', '<button class="button" data-action="show-all-exercises">Show all exercises</button>')}`;
}

function measurementValue(value, suffix, digits = 1) {
  return value == null ? '--' : `${number(value, digits)} ${suffix}`;
}

const BODY_TREND_GROUPS = [
  {
    id: 'body-composition-metric', stateKey: 'bodyCompositionMetric', title: 'Body composition', color: 'coral',
    metrics: [
      { key: 'weight', label: 'Bodyweight', suffix: () => ` ${unit()}` },
      { key: 'bodyFat', label: 'Body fat', suffix: () => '%' }
    ]
  },
  {
    id: 'circumference-metric', stateKey: 'circumferenceMetric', title: 'Circumferences', color: 'blue',
    metrics: [
      { key: 'waist', label: 'Waist' }, { key: 'chest', label: 'Chest' },
      { key: 'neck', label: 'Neck' }, { key: 'hips', label: 'Hips' },
      { key: 'leftArm', label: 'Left arm' }, { key: 'rightArm', label: 'Right arm' },
      { key: 'leftThigh', label: 'Left thigh' }, { key: 'rightThigh', label: 'Right thigh' }
    ].map(metric => ({ ...metric, suffix: () => ` ${measureUnit()}` }))
  },
  {
    id: 'recovery-metric', stateKey: 'recoveryMetric', title: 'Recovery', color: 'green',
    metrics: [
      { key: 'restingHeartRate', label: 'Resting heart rate', suffix: () => ' bpm' },
      { key: 'sleep', label: 'Sleep', suffix: () => ' hrs' }
    ]
  }
];

function bodyTrendPanel(group, measurements) {
  const metric = group.metrics.find(item => item.key === ui[group.stateKey]) || group.metrics[0];
  const points = measurements
    .filter(item => item[metric.key] != null)
    .map(item => ({ date: item.date, value: item[metric.key] }));
  return `<article class="panel body-trend-panel"><div class="panel-header"><div><h2>${escapeHtml(group.title)}</h2><p class="panel-subtitle">${escapeHtml(metric.label)} over all check-ins</p></div>
    <select class="select-compact" id="${group.id}" aria-label="${escapeHtml(group.title)} chart metric">${group.metrics.map(item => `<option value="${item.key}" ${item.key === metric.key ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select>
    </div><div class="chart-wrap">${lineChart(rangePoints(points), metric.suffix(), group.color)}</div></article>`;
}

function renderBody() {
  const sorted = [...state.measurements].filter(item => item.date <= todayIso()).sort((a,b) => a.date.localeCompare(b.date));
  const summaryFields = ui.bodyTab === 'weight' ? [['weight','Bodyweight',unit()],['bodyFat','Body fat','%']] : ui.bodyTab === 'recovery' ? [['restingHeartRate','Resting heart rate','bpm'],['sleep','Sleep','hours']] : LENGTH_FIELDS.map(key => [key, ({leftArm:'Left arm',rightArm:'Right arm',leftThigh:'Left thigh',rightThigh:'Right thigh'})[key] || key[0].toUpperCase()+key.slice(1), measureUnit()]);
  const tracked = summaryFields.filter(([key]) => latestMeasurement(key));
  const missing = summaryFields.filter(([key]) => !latestMeasurement(key));
  const group = BODY_TREND_GROUPS[ui.bodyTab === 'weight' ? 0 : ui.bodyTab === 'measurements' ? 1 : 2];
  return `${pageHeader('Measurements and recovery', 'Body', '<button class="button primary" data-action="new-measurement">+ Add check-in</button>')}
    <div class="segmented" role="group" aria-label="Body section">${[['weight','Weight'],['measurements','Measurements'],['recovery','Recovery']].map(([value,label]) => `<button class="button" data-action="body-tab" data-value="${value}" aria-pressed="${ui.bodyTab === value}">${label}</button>`).join('')}</div>
    <section class="metric-summary">${tracked.map(([key,label,suffix]) => { const latest = latestMeasurement(key), previous = previousMeasurement(key); return `<div><span>${label}</span><strong>${measurementValue(latest[key],suffix)}</strong><small>${shortDate(latest.date)}${previous ? ` · ${latest[key]-previous[key] > 0 ? '+' : ''}${number(latest[key]-previous[key],1)} ${key === 'bodyFat' ? 'percentage points' : suffix} since ${shortDate(previous.date)}` : ''}</small></div>`; }).join('')}</section>
    ${missing.length ? `<details class="disclosure"><summary>${missing.length} untracked ${missing.length === 1 ? 'metric' : 'metrics'}</summary><p>${missing.map(([,label]) => label).join(', ')}</p><button class="button" data-action="new-measurement">Add these measurements</button></details>` : ''}
    <div class="chart-toolbar">${rangeSelector()}</div>${bodyTrendPanel(group, sorted)}
    <details class="disclosure"><summary>Check-in history (${state.measurements.length})</summary><div class="table-scroll"><table class="data-table"><thead><tr><th>Date</th><th>Weight</th><th>Waist</th><th>Sleep</th><th>Actions</th></tr></thead><tbody>${[...state.measurements].sort((a,b) => b.date.localeCompare(a.date)).map(item => `<tr><td>${longDate(item.date)}</td><td>${measurementValue(item.weight,unit())}</td><td>${measurementValue(item.waist,measureUnit())}</td><td>${measurementValue(item.sleep,'hrs')}</td><td><button class="link-button" data-action="edit-measurement" data-id="${item.id}">Edit</button><button class="link-button danger" data-action="delete-measurement" data-id="${item.id}">Delete</button></td></tr>`).join('')}</tbody></table></div></details>`;
}

function goalCard(goal) {
  const current = getGoalCurrent(goal);
  const progress = getGoalProgress(goal);
  const suffix = goal.type === 'consistency' ? ' sessions' : ` ${unit()}`;
  return `<article class="goal-card"><div class="goal-top"><div><div class="goal-title">${escapeHtml(goal.title)}</div><div class="goal-deadline">${goal.deadline ? `Target ${shortDate(goal.deadline)}` : 'Open deadline'}</div></div><button class="link-button" data-action="edit-goal" data-id="${goal.id}">Edit</button></div>
    <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div><div class="goal-range"><span>${number(current, 1)}${suffix}</span><span>${number(goal.target, 1)}${suffix}</span></div></article>`;
}

function recommendationCard(item, index) {
  return `<section class="recommendation-card"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.recommendation)}</p>
    <details><summary>Why this is shown</summary><p>${escapeHtml(item.evidence)}</p>
    ${item.comparison?.length ? `<ul>${item.comparison.map(set => `<li>${escapeHtml(shortDate(set.date))}: ${number(set.weight,1)} ${unit()} × ${set.reps} — estimated 1RM ${number(set.estimated,1)} ${unit()}</li>`).join('')}</ul>` : ''}
    ${item.exercises?.length ? `<p>Exercises: ${item.exercises.map(escapeHtml).join(', ')}</p>` : ''}
    ${item.aiExplanation ? `<details><summary>AI explanation</summary><p>${escapeHtml(item.aiExplanation)}</p></details>` : ''}</details></section>`;
}

function renderRecommendations() {
  const result = ui.recommendations || state.recommendations || { status: 'idle', items: [] };
  const running = result.status === 'running';
  // Older cached items may contain AI-replaced actions; refresh before presenting them.
  const items = result.analysisVersion === 2 && Array.isArray(result.items) ? result.items : [];
  return `<article class="panel recommendation-panel"><div class="panel-header"><div><h2>Training observations</h2><p class="panel-subtitle">Last ${result.windowDays || 56} days of logged sets</p></div><button class="button small" data-action="refresh-recommendations" ${running ? 'disabled' : ''}>${running ? 'Updating…' : 'Refresh'}</button></div>
    ${running ? '<p role="status">Updating observations. You can keep using IronLog.</p>' : ''}
    ${result.stale || result.analysisVersion !== 2 ? '<p class="model-notice">Refresh to include the latest data and analysis rules.</p>' : ''}
    ${result.status === 'error' ? `<p class="form-error">${escapeHtml(result.error || 'Could not update observations.')}</p>` : ''}
    <div class="recommendation-grid">${items.slice(0,3).map(recommendationCard).join('')}</div>
    ${items.length > 3 ? `<details class="disclosure"><summary>${items.length-3} more observations</summary><div class="recommendation-grid">${items.slice(3).map(recommendationCard).join('')}</div></details>` : ''}
    ${!items.length && !running ? '<p class="muted">Generate observations from your logged workouts.</p>' : ''}
    <details class="disclosure"><summary>Coverage and counting method</summary><p>Each completed set counts once toward every muscle target assigned to its exercise. These are logged set emphases, not measurements of muscle growth or equal training stimulus.</p>
    <p>${number(result.workoutCount)} workouts analyzed${result.generatedAt ? ` · ${escapeHtml(new Date(result.generatedAt).toLocaleString())}` : ''}.</p>
    ${result.coverage?.unmapped?.length ? `<p>Targets need review: ${result.coverage.unmapped.map(escapeHtml).join(', ')}.</p>` : ''}
    ${result.targetSets ? `<ul class="target-counts">${Object.entries(result.targetSets).map(([target,count]) => `<li>${escapeHtml(targetLabel(target))}: ${count}</li>`).join('')}</ul>` : ''}
    ${result.modelStatus === 'unavailable' ? '<p>AI explanations are unavailable. The calculated observations are still shown.</p>' : '<p>AI explanations supplement the calculated action and evidence.</p>'}</details></article>`;
}

async function refreshRecommendations(shouldRender = true) {
  ui.recommendations = await api('/api/recommendations');
  if (shouldRender && ui.route === 'progress') render();
  return ui.recommendations;
}

async function pollRecommendations(attempt = 0) {
  const result = await refreshRecommendations();
  clearTimeout(recommendationPoll);
  if (result.status === 'running' && attempt < 120) recommendationPoll = setTimeout(() => pollRecommendations(attempt + 1).catch(() => {}), 2000);
}

function renderProgress() {
  const records = personalRecords();
  const weeks = weeksData(12);
  const maxSessions = Math.max(...weeks.map(week => week.sessions), 1);
  const totalVolume = state.workouts.reduce((sum, workout) => sum + workoutVolume(workout), 0);
  const totalSets = state.workouts.reduce((sum, workout) => sum + workoutSetCount(workout), 0);
  return `${pageHeader('Performance analysis', 'Progress', `<button class="button" data-action="new-goal">+ Add goal</button><button class="button primary" data-action="new-workout">+ Log workout</button>`)}
    ${renderStrengthPanel(true)}
    ${renderRecommendations()}
    <details class="disclosure"><summary>Lifetime totals</summary>    <section class="stat-grid">
      ${statCard('Lifetime volume', `${number(totalVolume / 1000, 1)}k`, `${unit()} moved`, 'VOL', 'blue')}
      ${statCard('Training sessions', number(state.workouts.length), `${number(totalSets)} working sets`, 'ALL', 'green')}
      ${statCard('Exercise records', number(records.length), 'Estimated one-rep max leaders', 'PR', 'coral')}
      ${statCard('Last 12 weeks', `${number(weeks.reduce((sum, week) => sum + week.sessions, 0))}`, 'Completed sessions', '12W', 'acid')}
    </section>
    </details>
    <section class="dashboard-grid">
      <article class="panel"><div class="panel-header"><div><h2>Training consistency</h2><p class="panel-subtitle">Sessions per week</p></div></div><div class="consistency-grid">${weeks.map(week => `<div class="week-column"><span class="bar-value">${week.sessions || ''}</span><div class="week-bar" style="height:${week.sessions / maxSessions * 100}%"></div><span class="week-label">${escapeHtml(week.label)}</span></div>`).join('')}</div></article>
      <article class="panel"><div class="panel-header"><div><h2>Goals</h2><p class="panel-subtitle">Strength, body, and consistency</p></div><button class="link-button" data-action="new-goal">Add</button></div>${state.goals.length ? `<div class="goal-list">${state.goals.map(goalCard).join('')}</div>` : emptyState('No goals yet', 'Add a measurable target to track here.', '<button class="button small" data-action="new-goal">Add goal</button>')}</article>
    </section>`;
}

function renderSettings() {
  return `${pageHeader('Preferences and data', 'Settings')}
    <div class="settings-grid">
      <article class="panel"><form id="settings-form">
        <section class="settings-section"><h2>Profile</h2><div class="form-grid">
          <div class="field full"><label for="athlete-name">Display name</label><input id="athlete-name" name="athleteName" value="${escapeHtml(state.settings.athleteName)}" maxlength="80" required></div>
          <div class="field"><label for="weight-unit">Weight unit</label><select id="weight-unit" name="weightUnit"><option value="lb" ${unit() === 'lb' ? 'selected' : ''}>Pounds (lb)</option><option value="kg" ${unit() === 'kg' ? 'selected' : ''}>Kilograms (kg)</option></select></div>
          <div class="field"><label for="measurement-unit">Measurement unit</label><select id="measurement-unit" name="measurementUnit"><option value="in" ${measureUnit() === 'in' ? 'selected' : ''}>Inches (in)</option><option value="cm" ${measureUnit() === 'cm' ? 'selected' : ''}>Centimeters (cm)</option></select></div>
          <div class="field"><label for="week-start">Week starts on</label><select id="week-start" name="weekStartsOn"><option value="monday" ${state.settings.weekStartsOn === 'monday' ? 'selected' : ''}>Monday</option><option value="sunday" ${state.settings.weekStartsOn === 'sunday' ? 'selected' : ''}>Sunday</option></select></div>
        </div><div class="form-actions"><button class="button primary" type="submit">Save preferences</button></div></section>
      </form></article>
      <div>
        <article class="panel"><section class="settings-section"><h2>Data backup</h2><p class="muted">Your database contains ${state.workouts.length} workouts and ${state.measurements.length} body check-ins.</p><div class="page-actions"><a class="button" href="/api/export" download>Export backup</a><label class="button" for="import-file">Import backup</label><input class="file-input" id="import-file" type="file" accept="application/json"></div></section>
          ${state.workouts.length || state.measurements.length ? '' : `<section class="settings-section"><h2>Demo data</h2><p class="muted">Populate the dashboard with example training and body data.</p><button class="button" data-action="load-demo" type="button">Load demo data</button></section>`}
        </article>
        <article class="panel danger-zone" style="margin-top:12px"><section class="settings-section"><h2>Reset database</h2><p class="muted">Remove every workout, measurement, and goal. Export a backup first.</p><button class="button danger" data-action="reset-data" type="button">Delete all data</button></section></article>
      </div>
    </div>`;
}

function render() {
  if (!state) {
    app.innerHTML = '<div class="skeleton"></div>';
    return;
  }
  const routes = {
    dashboard: renderDashboard,
    workouts: renderWorkouts,
    exercises: renderExercises,
    body: renderBody,
    progress: renderProgress,
    settings: renderSettings
  };
  if (!routes[ui.route]) ui.route = 'dashboard';
  app.innerHTML = renderDraftBanner() + routes[ui.route]();
  rememberViews();
  document.title = `${ui.route[0].toUpperCase()}${ui.route.slice(1)} · IronLog`;
  document.querySelectorAll('[data-route]').forEach(item => item.classList.toggle('active', item.dataset.route === ui.route));
  document.querySelector('.sidebar')?.classList.remove('open');
}

function openModal(title, body, { wide = false, footer = '', autoFocus = true, workout = false } = {}) {
  if (!modalPageScrollLocked) modalTrigger = document.activeElement;
  modalRoot.innerHTML = `<div class="modal-backdrop ${workout ? 'workout-modal-backdrop' : ''}" data-action="backdrop-close"><section class="modal ${wide ? 'wide' : ''} ${workout ? 'workout-modal' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">
    <header class="modal-header"><h2 id="modal-title">${escapeHtml(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="Close">x</button></header>
    <div class="modal-body"><p class="form-error" role="alert" hidden></p>${body}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}
  </section></div>`;
  if (!modalPageScrollLocked) {
    modalPageScrollY = window.scrollY;
    modalPageScrollLocked = true;
    document.body.style.position = 'fixed';
    document.body.style.inset = `${-modalPageScrollY}px 0 auto`;
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
  }
  for (const [index, field] of [...modalRoot.querySelectorAll('.field')].entries()) {
    const label = field.querySelector('label');
    const control = field.querySelector('input, select, textarea');
    if (label && control && !label.contains(control)) { control.id ||= `modal-field-${index}`; label.htmlFor = control.id; }
  }
  document.querySelector('.app-shell').inert = true;
  if (autoFocus) modalRoot.querySelector('.modal-body input, .modal-body select, .modal-body textarea, .modal')?.focus();
  else modalRoot.querySelector('.modal')?.focus();
}

function isTrackedBodyweightName(name) {
  return ['pull-up', 'chin-up', 'dip', 'dips'].includes(String(name || '').split(' (')[0].trim().toLowerCase());
}

function exerciseLoadMode(exercise) {
  const definition = state.exercises.find(e => e.id === (exercise.exerciseId || exercise.id));
  return definition?.loadMode || exercise.loadMode || (isTrackedBodyweightName(definition?.family || exercise.family || exercise.name) ? 'bodyweight' : 'external');
}
function tracksBodyweight(exercise) { return exerciseLoadMode(exercise) === 'bodyweight'; }

function latestMeasurementForDate(date) {
  return [...state.measurements]
    .filter(item => item.weight != null && (!date || item.date <= date))
    .sort((a, b) => b.date.localeCompare(a.date))[0]?.weight ?? '';
}

function latestSetForExercise(exercise) {
  const workouts = [...state.workouts].filter(w => w.id !== ui.workoutDraft?.id && w.date < (ui.workoutDraft?.date || todayIso())).sort((a, b) => b.date.localeCompare(a.date) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  for (const workout of workouts) {
    const match = workout.exercises.find(item => (exercise.id ? item.exerciseId === exercise.id : item.name.toLowerCase() === exercise.name.toLowerCase()));
    const set = match?.sets?.filter(item => item.completed !== false && Number(item.reps) > 0).at(-1);
    if (set) return { ...set, bodyweight: set.bodyweight ?? match.bodyweight ?? '', workoutDate: workout.date };
  }
  return null;
}

function persistWorkoutDraft(sync = true) {
  if (!ui.workoutDraft) return;
  if (sync) syncWorkoutDraft();
  const modal = modalRoot.querySelector('.modal');
  if (modal) ui.workoutDraft.scrollTop = modal.scrollTop;
  ui.workoutDraft.weightUnit = unit();
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 2, draft: ui.workoutDraft })); } catch {}
}

function loadWorkoutDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (saved?.version !== 2 || !saved.draft?.date || !Array.isArray(saved.draft.exercises)) return null;
    const draft = saved.draft;
    if (draft.weightUnit && draft.weightUnit !== unit()) {
      const factor = unit() === 'kg' ? .45359237 : 1 / .45359237;
      const convert = n => n === '' || n == null ? n : Math.round(Number(n) * factor * 1000) / 1000;
      for (const exercise of draft.exercises) {
        if (exercise.bodyweight != null) exercise.bodyweight = convert(exercise.bodyweight);
        for (const set of exercise.sets) for (const field of ['weight','bodyweight','addedWeight']) if (set[field] != null) set[field] = convert(set[field]);
      }
    }
    draft.weightUnit = unit();
    return draft;
  } catch {
    localStorage.removeItem(DRAFT_KEY);
    return null;
  }
}

function renderDraftBanner() {
  const draft = loadWorkoutDraft();
  return draft ? `<aside class="draft-banner"><div><strong>Unfinished workout</strong><span>${escapeHtml(draft.name || 'Training session')} · ${escapeHtml(shortDate(draft.date))}</span></div><button class="button primary" data-action="resume-workout">Resume workout</button><button class="link-button danger" data-action="discard-workout">Discard</button></aside>` : '';
}

function closeModal({ discard = false, sync = true, force = false } = {}) {
  if (ui.saving && !discard && !force) return;
  if (ui.workoutDraft) {
    if (discard) localStorage.removeItem(DRAFT_KEY);
    else persistWorkoutDraft(sync);
  }
  modalRoot.innerHTML = '';
  if (modalPageScrollLocked) {
    modalPageScrollLocked = false;
    document.body.style.position = '';
    document.body.style.inset = '';
    document.body.style.width = '';
    document.body.style.overflow = '';
    window.scrollTo(0, modalPageScrollY);
  }
  document.querySelector('.app-shell').inert = false;
  ui.workoutDraft = null;
  ui.exercisePickerQuery = '';
  ui.templateQuery = '';
  render();
  if (modalTrigger?.isConnected) modalTrigger.focus();
  else document.querySelector('#app button, #app a')?.focus();
}

function openWorkoutModal(workout = null, restoredDraft = null) {
  ui.workoutDraft = restoredDraft ? structuredClone(restoredDraft) : {
    id: workout?.id || null,
    name: workout?.name || '',
    date: workout?.date || todayIso(),
    duration: workout?.duration || '',
    notes: workout?.notes || '',
    exercises: workout ? structuredClone(workout.exercises) : [],
    _suggestedFields: []
  };
  ui.exercisePickerQuery = '';
  ui.templateQuery = '';
  openModal(ui.workoutDraft.id ? 'Edit workout' : 'Log workout', workoutForm(), {
    wide: true,
    workout: true,
    autoFocus: !restoredDraft && !window.matchMedia('(max-width: 520px)').matches,
    footer: `<button class="button" data-action="close-modal">Save for later</button><button class="link-button danger" data-action="discard-workout">Discard</button><button class="button primary" data-action="save-workout">${ui.workoutDraft.id ? 'Save changes' : 'Finish workout'}</button>`
  });
  renderWorkoutEntries();
  renderTemplateResults();
  renderExercisePickerResults();
  requestAnimationFrame(() => {
    const modal = modalRoot.querySelector('.modal');
    if (modal && restoredDraft?.scrollTop) modal.scrollTop = restoredDraft.scrollTop;
  });
  persistWorkoutDraft(false);
}

function workoutForm() {
  return `<div class="form-grid">
    <div class="field"><label for="workout-name">Session name</label><input id="workout-name" data-workout-field="name" value="${escapeHtml(ui.workoutDraft.name)}" placeholder="Upper strength"></div>
    <div class="field"><label for="workout-date">Date</label><input id="workout-date" data-workout-field="date" type="date" value="${escapeHtml(ui.workoutDraft.date)}" required></div>
  </div>
  ${!ui.workoutDraft.id ? `<details class="disclosure"><summary>Use a previous workout</summary><section class="template-picker">
    <label for="template-search">Search previous workouts</label><input id="template-search" type="search" aria-controls="template-results" placeholder="Push, pull, legs…" autocomplete="off"><div id="template-results" class="picker-results"></div>
  </section></details>` : ''}
  <div id="workout-exercises"></div>
  <section class="exercise-search-picker"><label for="exercise-picker-search">Add exercise</label><input id="exercise-picker-search" type="search" aria-controls="exercise-picker-results" placeholder="Search exercise, muscle, or equipment" autocomplete="off"><div id="exercise-picker-results" class="picker-results"></div></section>
  <details class="disclosure"><summary>Duration and notes</summary><div class="form-grid">
    <div class="field"><label for="workout-duration">Duration (minutes)</label><input id="workout-duration" data-workout-field="duration" type="number" min="0" step="1" value="${escapeHtml(ui.workoutDraft.duration)}"></div>
    <div class="field full"><label for="workout-notes">Notes</label><textarea id="workout-notes" data-workout-field="notes">${escapeHtml(ui.workoutDraft.notes)}</textarea></div>
  </div></details>`;
}

function matchingTemplates(query) {
  const term = String(query || '').trim().toLowerCase();
  const frequencies = new Map();
  for (const workout of state.workouts) frequencies.set(workout.name.toLowerCase(), (frequencies.get(workout.name.toLowerCase()) || 0) + 1);
  return [...state.workouts]
    .filter(workout => !term || `${workout.name} ${workout.exercises.map(item => item.name).join(' ')}`.toLowerCase().includes(term))
    .sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aScore = term && aName === term ? 3 : term && aName.startsWith(term) ? 2 : term && aName.includes(term) ? 1 : 0;
      const bScore = term && bName === term ? 3 : term && bName.startsWith(term) ? 2 : term && bName.includes(term) ? 1 : 0;
      return bScore - aScore || (frequencies.get(bName) || 0) - (frequencies.get(aName) || 0) || b.date.localeCompare(a.date);
    }).slice(0, 6);
}

function renderTemplateResults() {
  const root = document.querySelector('#template-results');
  if (!root) return;
  const matches = matchingTemplates(ui.templateQuery);
  root.innerHTML = matches.length ? matches.map(workout => `<button type="button" data-action="apply-workout-template" data-id="${workout.id}">
    <strong>${escapeHtml(workout.name)}</strong><span>${escapeHtml(shortDate(workout.date))} - ${escapeHtml(workout.exercises.map(item => item.name).join(', '))}</span>
  </button>`).join('') : '<p class="picker-empty">No matching previous workouts.</p>';
}

function familyName(exercise) { return exercise.family || exercise.name; }
function groupedExercises(items) {
  const seen = new Set();
  return items.filter(item => { const key = familyName(item); if (seen.has(key)) return false; seen.add(key); return true; });
}
function variationSelect(exercise, index) {
  const members = state.exercises.filter(e => familyName(e) === familyName(exercise));
  return members.length > 1 ? `<label>Variation<select data-variation-index="${index}">${members.map(e => `<option value="${e.id}" ${e.id === exercise.id ? 'selected' : ''}>${escapeHtml(e.variation || (e.name === familyName(e) ? 'Unspecified' : e.name))}</option>`).join('')}</select></label>` : '';
}
function renderExercisePickerResults() {
  const root = document.querySelector('#exercise-picker-results');
  if (!root) return;
  const term = ui.exercisePickerQuery.trim().toLowerCase();
  const matches = groupedExercises([...state.exercises]
    .filter(exercise => !term || `${exercise.name} ${exercise.muscle} ${exercise.equipment}`.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name))).slice(0, term ? 10 : 6);
  root.innerHTML = matches.length ? matches.map(exercise => `<button type="button" data-action="choose-workout-exercise" data-id="${exercise.id}">
    <strong>${escapeHtml(familyName(exercise))}</strong><span>${escapeHtml(exercise.muscle)} - ${escapeHtml(exercise.equipment)}</span>
  </button>`).join('') : '<p class="picker-empty">No matching exercises.</p>';
}

function createExerciseDraft(exercise) {
  const previous = latestSetForExercise(exercise);
  if (tracksBodyweight(exercise)) {
    const bodyweight = latestMeasurementForDate(ui.workoutDraft.date);
    const addedWeight = previous?.addedWeight ?? 0;
    return {
      exerciseId: exercise.id,
      family: familyName(exercise), variation: exercise.variation || '', loadMode: exerciseLoadMode(exercise),
      name: exercise.name,
      bodyweight,
      _suggestedFields: bodyweight === '' ? [] : ['bodyweight'],
      sets: [{
        bodyweight,
        addedWeight,
        weight: Number(bodyweight || 0) + Number(addedWeight || 0),
        reps: '',
        completed: true,
        _suggestedFields: previous ? ['addedWeight'] : []
      }]
    };
  }
  return {
    exerciseId: exercise.id,
    family: familyName(exercise), variation: exercise.variation || '', loadMode: exerciseLoadMode(exercise),
    name: exercise.name,
    sets: [{
      weight: previous?.weight ?? '',
      reps: '',
      completed: true,
      _suggestedFields: previous ? ['weight'] : []
    }]
  };
}

function applyWorkoutTemplate(workout) {
  if (!workout) return;
  const workoutDate = ui.workoutDraft?.date || todayIso();
  const exercises = structuredClone(workout.exercises).map(exercise => {
    const tracked = tracksBodyweight(exercise);
    const bodyweight = tracked ? latestMeasurementForDate(workoutDate) : '';
    return {
      ...exercise,
      ...(tracked ? { bodyweight, _suggestedFields: ['bodyweight'] } : {}),
      sets: exercise.sets.map(set => ({
        ...set,
        ...(tracked ? {
          bodyweight,
          weight: Number(bodyweight || 0) + Number(set.addedWeight || 0),
          addedWeight: set.addedWeight ?? ''
        } : {}),
        _suggestedFields: tracked ? ['addedWeight', 'reps'] : ['weight', 'reps']
      }))
    };
  });
  const draft = {
    id: null,
    name: workout.name,
    date: workoutDate,
    duration: '',
    notes: '',
    exercises,
    _suggestedFields: ['name'],
    templateWorkoutId: workout.id
  };
  openWorkoutModal(null, draft);
}

function renderWorkoutEntries() {
  const container = document.querySelector('#workout-exercises');
  if (!container || !ui.workoutDraft) return;
  container.innerHTML = ui.workoutDraft.exercises.map((exercise, exerciseIndex) => {
    const tracked = tracksBodyweight(exercise);
    const previous = latestSetForExercise({ id: exercise.exerciseId, name: exercise.name });
    const bodySuggested = exercise._suggestedFields?.includes('bodyweight') ? 'suggested-value' : '';
    return `<section class="exercise-entry" data-exercise-index="${exerciseIndex}">
      <div class="exercise-entry-header"><h3>${escapeHtml(exercise.family || exercise.name)}</h3><button class="link-button danger" data-action="remove-workout-exercise" data-exercise="${exerciseIndex}">Remove</button></div>
      ${previous ? `<p class="last-set">Last time: ${number(tracked ? previous.addedWeight ?? 0 : previous.weight, 1)} ${unit()}${tracked ? ' added' : ''} × ${previous.reps} · ${escapeHtml(shortDate(previous.workoutDate))}</p>` : '<p class="last-set">No earlier sets for this variation.</p>'}
      ${variationSelect(state.exercises.find(e => e.id === exercise.exerciseId) || { id: exercise.exerciseId, name: exercise.name }, exerciseIndex)}
      ${tracked && exercise.sets.some(set => set.bodyweight == null) ? '<p class="muted">Legacy load: confirm bodyweight and added weight before saving.</p>' : ''}
      ${tracked ? `<div class="bodyweight-input"><label>Bodyweight from check-in (${unit()})</label><input class="${bodySuggested}" aria-label="${escapeHtml(exercise.name)} bodyweight" type="number" inputmode="decimal" min="0" step="any" value="${escapeHtml(exercise.bodyweight ?? '')}" data-exercise-bodyweight="${exerciseIndex}"><small>Enter manually if no earlier check-in exists.</small></div>` : ''}
      <div class="sets-header"><span>Set</span><span>${tracked ? `Added (${unit()})` : `Weight (${unit()})`}</span><span>Reps</span><span></span></div>
      <div>${exercise.sets.map((set, setIndex) => {
        const loadField = tracked ? 'addedWeight' : 'weight';
        const loadSuggested = set._suggestedFields?.includes(loadField) ? 'suggested-value' : '';
        const repsSuggested = set._suggestedFields?.includes('reps') ? 'suggested-value' : '';
        return `<div class="set-row">
          <span class="set-number">${setIndex + 1}</span>
          <div class="load-input"><input class="${loadSuggested}" aria-label="Set ${setIndex + 1} ${tracked ? 'added weight' : 'weight'}" type="number" inputmode="decimal" min="0" step="any" value="${escapeHtml(set[loadField] ?? '')}" data-draft-field="${loadField}" data-exercise="${exerciseIndex}" data-set="${setIndex}">${tracked ? `<small>Total ${number(Number(exercise.bodyweight || 0) + Number(set.addedWeight || 0), 1)} ${unit()}</small>` : ''}</div>
          <input class="${repsSuggested}" aria-label="Set ${setIndex + 1} reps" type="number" inputmode="numeric" min="1" step="1" value="${escapeHtml(set.reps ?? '')}" data-draft-field="reps" data-exercise="${exerciseIndex}" data-set="${setIndex}">
          <button class="remove-set" data-action="remove-set" data-exercise="${exerciseIndex}" data-set="${setIndex}" aria-label="Remove set">x</button>
        </div>`;
      }).join('')}</div>
      <button class="link-button add-set" data-action="add-set" data-exercise="${exerciseIndex}">+ Add set</button>
    </section>`;
  }).join('');
}

function syncWorkoutDraft() {
  if (!ui.workoutDraft) return;
  ui.workoutDraft.name = document.querySelector('#workout-name')?.value || '';
  ui.workoutDraft.date = document.querySelector('#workout-date')?.value || '';
  ui.workoutDraft.duration = document.querySelector('#workout-duration')?.value || '';
  ui.workoutDraft.notes = document.querySelector('#workout-notes')?.value || '';
  document.querySelectorAll('[data-exercise-bodyweight]').forEach(input => {
    const exercise = ui.workoutDraft.exercises[Number(input.dataset.exerciseBodyweight)];
    if (!exercise) return;
    exercise.bodyweight = input.value;
    for (const set of exercise.sets) {
      set.bodyweight = input.value;
      set.weight = Number(input.value || 0) + Number(set.addedWeight || 0);
    }
  });
  document.querySelectorAll('[data-draft-field]').forEach(input => {
    const exercise = ui.workoutDraft.exercises[Number(input.dataset.exercise)];
    const set = exercise?.sets[Number(input.dataset.set)];
    if (!set) return;
    set[input.dataset.draftField] = input.value;
    if (tracksBodyweight(exercise)) set.weight = Number(exercise.bodyweight || 0) + Number(set.addedWeight || 0);
  });
  document.querySelectorAll('[data-exercise-index]').forEach(container => {
    const exercise = ui.workoutDraft.exercises[Number(container.dataset.exerciseIndex)];
    if (!exercise || !tracksBodyweight(exercise)) return;
    container.querySelectorAll('.load-input small').forEach((label,index) => {
      label.textContent = `Total ${number(Number(exercise.bodyweight || 0) + Number(exercise.sets[index]?.addedWeight || 0), 1)} ${unit()}`;
    });
  });
}

function refreshSuggestedBodyweights() {
  if (!ui.workoutDraft) return;
  const bodyweight = latestMeasurementForDate(ui.workoutDraft.date);
  for (const exercise of ui.workoutDraft.exercises) {
    const previous = latestSetForExercise({ id: exercise.exerciseId, name: exercise.name });
    for (const set of exercise.sets) {
      if (set._suggestedFields?.includes('weight')) set.weight = previous?.weight ?? '';
      if (set._suggestedFields?.includes('addedWeight')) set.addedWeight = previous?.addedWeight ?? 0;
    }
    if (!tracksBodyweight(exercise) || !exercise._suggestedFields?.includes('bodyweight')) continue;
    exercise.bodyweight = bodyweight;
    for (const set of exercise.sets) {
      set.bodyweight = bodyweight;
      set.weight = Number(bodyweight || 0) + Number(set.addedWeight || 0);
    }
  }
  renderWorkoutEntries();
}

function markDraftTouched(target) {
  target.classList.remove('suggested-value');
  if (target.dataset.workoutField) {
    ui.workoutDraft._suggestedFields = (ui.workoutDraft._suggestedFields || []).filter(field => field !== target.dataset.workoutField);
    return;
  }
  const exerciseIndex = Number(target.dataset.exerciseBodyweight ?? target.dataset.exercise);
  const exercise = ui.workoutDraft.exercises[exerciseIndex];
  if (!exercise) return;
  if (target.dataset.exerciseBodyweight != null) {
    exercise._suggestedFields = (exercise._suggestedFields || []).filter(field => field !== 'bodyweight');
    return;
  }
  const set = exercise.sets[Number(target.dataset.set)];
  if (set) set._suggestedFields = (set._suggestedFields || []).filter(field => field !== target.dataset.draftField);
}

async function saveWorkout() {
  syncWorkoutDraft();
  const wasEditing = Boolean(ui.workoutDraft.id);
  const validExercises = ui.workoutDraft.exercises.map(exercise => ({
    ...exercise,
    sets: exercise.sets.filter(set => Number(set.reps) > 0)
  })).filter(exercise => exercise.sets.length);
  if (!ui.workoutDraft.date || !validExercises.length) return toast('Add a date and at least one completed set.', 'error');
  if (validExercises.some(e => tracksBodyweight(e) && !(Number(e.bodyweight) > 0))) return toast('Enter bodyweight and confirm the added load for each bodyweight exercise.', 'error');
  const payload = { ...ui.workoutDraft, exercises: validExercises };
  try {
    await api(ui.workoutDraft.id ? `/api/workouts/${ui.workoutDraft.id}` : '/api/workouts', { method: ui.workoutDraft.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    closeModal({ discard: true, sync: false });
    await refresh();
    pollRecommendations().catch(() => {});
    toast(wasEditing ? 'Workout updated.' : 'Workout logged. Recommendations are analyzing in the background.');
  } catch (error) { toast(error.message, 'error'); }
}

function openMeasurementModal(measurement = null) {
  const inputUnit = localStorage.getItem('ironlog-measurement-input') || 'in';
  const value = key => {
    let n = measurement?.[key];
    if (n != null && LENGTH_FIELDS.includes(key)) n = n / (measureUnit() === 'cm' ? 2.54 : 1) * (inputUnit === 'cm' ? 2.54 : 1);
    return escapeHtml(n ?? '');
  };
  openModal(measurement ? 'Edit body check-in' : 'Add body check-in', `<form id="measurement-form" data-id="${measurement?.id || ''}"><div class="form-grid">
    <div class="field"><label for="measurement-date">Date</label><input id="measurement-date" name="date" type="date" value="${measurement?.date || todayIso()}" required></div>
    <div class="field"><label for="measurement-weight">Bodyweight (${unit()})</label><input id="measurement-weight" name="weight" type="number" step="any" min="0" value="${value('weight')}"></div>
    <div class="field"><label>Body fat (%)</label><input name="bodyFat" type="number" step="any" min="0" max="100" value="${value('bodyFat')}"></div>
    <div class="field full"><label>Enter circumferences in<select name="inputUnit" id="checkin-input-unit" data-previous="${inputUnit}"><option value="in" ${inputUnit === 'in' ? 'selected' : ''}>Inches</option><option value="cm" ${inputUnit === 'cm' ? 'selected' : ''}>Centimeters</option></select></label><small>Saved in inches; displayed using your settings.</small></div>
    <div class="field"><label>Waist (${inputUnit})</label><input name="waist" type="number" step="any" min="0" value="${value('waist')}"></div>
    <div class="field"><label>Chest (${inputUnit})</label><input name="chest" type="number" step="any" min="0" value="${value('chest')}"></div>
    <div class="field"><label>Neck (${inputUnit})</label><input name="neck" type="number" step="any" min="0" value="${value('neck')}"></div>
    <div class="field"><label>Hips (${inputUnit})</label><input name="hips" type="number" step="any" min="0" value="${value('hips')}"></div>
    <div class="field"><label>Left arm (${inputUnit})</label><input name="leftArm" type="number" step="any" min="0" value="${value('leftArm')}"></div>
    <div class="field"><label>Right arm (${inputUnit})</label><input name="rightArm" type="number" step="any" min="0" value="${value('rightArm')}"></div>
    <div class="field"><label>Left thigh (${inputUnit})</label><input name="leftThigh" type="number" step="any" min="0" value="${value('leftThigh')}"></div>
    <div class="field"><label>Right thigh (${inputUnit})</label><input name="rightThigh" type="number" step="any" min="0" value="${value('rightThigh')}"></div>
    <div class="field"><label>Resting heart rate (bpm)</label><input name="restingHeartRate" type="number" step="1" min="0" value="${value('restingHeartRate')}"></div>
    <div class="field"><label>Sleep (hours)</label><input name="sleep" type="number" step=".1" min="0" max="24" value="${value('sleep')}"></div>
    <div class="field full"><label>Notes</label><textarea name="notes">${value('notes')}</textarea></div>
  </div></form>`, { footer: `<button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-measurement">Save check-in</button>` });
}

async function saveMeasurement() {
  const form = document.querySelector('#measurement-form');
  const payload = Object.fromEntries(new FormData(form));
  const id = form.dataset.id;
  try {
    await api(id ? `/api/measurements/${id}` : '/api/measurements', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    closeModal({ force: true }); await refresh(); toast('Body check-in saved.');
  } catch (error) { toast(error.message, 'error'); }
}

function goalExerciseFields(selectedKey = '') {
  const options = strengthOptions();
  const selected = options.find(e => e.key === selectedKey) || options[0];
  const families = [...new Set(options.map(e => e.family))];
  const variants = options.filter(e => e.family === selected?.family);
  return `<div class="field"><label for="goal-family">Exercise</label><select id="goal-family">${families.map(f => `<option ${f === selected?.family ? 'selected' : ''}>${escapeHtml(f)}</option>`).join('')}</select></div>
    <div class="field"><label for="goal-variation">Variation</label><select name="exerciseId" id="goal-variation" required>${variants.map(e => `<option value="${escapeHtml(e.key)}" ${e.key === selected?.key ? 'selected' : ''}>${escapeHtml(e.variation)}</option>`).join('')}</select></div>`;
}

function openGoalModal(goal = null) {
  const key = goal?.exerciseId || strengthOptions().find(e => e.name === goal?.exerciseName)?.key || ui.strengthVariation;
  openModal(goal ? 'Edit goal' : 'Add goal', `<form id="goal-form" data-id="${goal?.id || ''}"><div class="form-grid">
    <div class="field full"><label>Goal name</label><input name="title" maxlength="120" value="${escapeHtml(goal?.title || '')}" placeholder="Bench estimated 1RM target" required></div>
    <div class="field"><label>Goal type</label><select name="type" id="goal-type">${[['strength','Estimated strength'],['bodyweight','Bodyweight'],['consistency','Weekly consistency']].map(([value,label]) => `<option value="${value}" ${(goal?.type || 'strength') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <div id="goal-exercise-fields" class="form-grid field full">${goalExerciseFields(key)}</div>
    <p id="goal-unit-help" class="field full muted"></p>
    <div class="field"><label>Starting value</label><input name="start" type="number" min="0" step="any" value="${escapeHtml(goal?.start ?? '')}" required></div>
    <div class="field"><label>Target value</label><input name="target" type="number" min="0" step="any" value="${escapeHtml(goal?.target ?? '')}" required></div>
    <div class="field"><label>Deadline</label><input name="deadline" type="date" value="${escapeHtml(goal?.deadline || '')}"></div>
    <div class="field"><label class="check-label"><input name="completed" type="checkbox" ${goal?.completed ? 'checked' : ''}> Mark complete</label></div>
    </div></form>`, { footer: `${goal ? `<button class="button danger" data-action="delete-goal" data-id="${goal.id}">Delete</button>` : ''}<button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-goal">Save goal</button>` });
  updateGoalType();
}

function updateGoalType() {
  const type = document.querySelector('#goal-type').value;
  const fields = document.querySelector('#goal-exercise-fields');
  fields.hidden = type !== 'strength';
  fields.querySelectorAll('select').forEach(input => { input.disabled = type !== 'strength'; });
  document.querySelector('#goal-unit-help').textContent = type === 'consistency' ? 'Values are sessions per calendar week.' : type === 'strength' ? `Values are estimated one-rep max in ${unit()}.` : `Values are bodyweight in ${unit()}.`;
}

async function saveGoal() {
  const form = document.querySelector('#goal-form');
  const payload = Object.fromEntries(new FormData(form));
  payload.completed = form.elements.completed.checked;
  const selected = strengthOptions().find(e => e.key === payload.exerciseId);
  payload.exerciseName = payload.type === 'strength' ? selected?.name || '' : '';
  if (payload.exerciseId?.startsWith('name:')) payload.exerciseId = '';
  const id = form.dataset.id;
  try {
    await api(id ? `/api/goals/${id}` : '/api/goals', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    closeModal({ force: true }); await refresh(); toast('Goal saved.');
  } catch (error) { toast(error.message, 'error'); }
}

function openVariationModal(exercise) {
  if (!exercise) return;
  const family = familyName(exercise);
  const existing = state.exercises.filter(e => familyName(e) === family).map(e => e.variation).filter(Boolean);
  const presets = /incline|bench/i.test(family) ? ['15°', '30°', '45°', '60°'] : ['Single arm', 'Double arm', 'Single leg', 'Double leg'];
  openModal('Add variation', `<form id="variation-form" data-parent-id="${escapeHtml(exercise.id)}">
    <p>For <strong>${escapeHtml(family)}</strong></p>
    <div class="field"><label for="new-variation-name">Variation name</label><input id="new-variation-name" name="variation" required maxlength="${Math.max(1, 97 - family.length)}" placeholder="e.g. 45° or Single arm" autocomplete="off"></div>
    <div class="variation-presets">${presets.filter(label => !existing.some(value => value.toLowerCase() === label.toLowerCase())).map(label => `<button class="button small" type="button" data-action="variation-preset" data-value="${escapeHtml(label)}">${escapeHtml(label)}</button>`).join('')}</div>
    <p class="muted">Uses the same equipment and muscle targets. You can edit these later.</p>
    ${existing.length ? `<p class="muted">Existing variations: ${existing.map(escapeHtml).join(', ')}</p>` : ''}
  </form>`, { footer: '<button class="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit" form="variation-form" id="save-variation-button">Add variation</button>' });
}

async function saveVariation() {
  const form = document.querySelector('#variation-form');
  if (!form || ui.savingVariation || !form.reportValidity()) return;
  const parent = state.exercises.find(e => e.id === form.dataset.parentId);
  if (!parent) return toast('The original exercise is no longer available.', 'error');
  const button = document.querySelector('#save-variation-button');
  try {
    const payload = variationPayload(parent, form.elements.variation.value);
    ui.savingVariation = true;
    button.disabled = true;
    const created = await api('/api/exercises', { method: 'POST', body: JSON.stringify(payload) });
    ui.strengthExercise = created.family;
    ui.strengthVariation = created.id;
    ui.strengthSelections[created.family] = created.id;
    ui.librarySelections[created.family] = created.id;
    ui.exerciseScope = 'all';
    closeModal();
    await refresh();
    toast(`${created.variation} added to ${created.family}.`);
  } catch (error) { toast(error.message, 'error'); }
  finally { ui.savingVariation = false; button.disabled = false; }
}

const TARGET_GROUPS = [
  ['Chest', [['chest-upper','Upper chest'],['chest-mid','Mid chest']]],
  ['Back', [['lats','Lats'],['back-upper','Upper back'],['lower-back','Lower back'],['posterior-chain','Posterior chain']]],
  ['Shoulders', [['shoulders-front','Front delts'],['shoulders-side','Side delts'],['shoulders-rear','Rear delts']]],
  ['Arms', [['biceps','Biceps'],['triceps-long','Triceps — long head'],['triceps-lateral','Triceps — lateral head'],['triceps-medial','Triceps — medial head']]],
  ['Legs and core', [['quads','Quads'],['hamstrings','Hamstrings'],['glutes','Glutes'],['calves','Calves'],['hip-adductors','Hip adductors'],['hip-abductors','Hip abductors'],['core','Core']]]
];
function targetLabel(key) { return TARGET_GROUPS.flatMap(([,items]) => items).find(([value]) => value === key)?.[1] || key; }
function targetCheckboxes(selected = []) {
  return `<div class="target-groups">${TARGET_GROUPS.map(([group,items]) => `<fieldset><legend>${group}</legend>${items.map(([value,label]) => `<label class="check-label"><input type="checkbox" name="targets" value="${value}" ${selected.includes(value) ? 'checked' : ''}>${label}</label>`).join('')}</fieldset>`).join('')}</div>`;
}

function openExerciseModal(exercise = null) {
  const muscles = ['Chest', 'Back', 'Shoulders', 'Legs', 'Quads', 'Hamstrings', 'Glutes', 'Arms', 'Lower back', 'Calves', 'Core', 'Other'];
  const equipment = ['Barbell', 'Dumbbell', 'Cable', 'Machine', 'Bodyweight', 'Kettlebell', 'Other'];
  openModal(exercise ? 'Edit exercise' : 'Add exercise', `<form id="exercise-form" data-id="${exercise?.id || ''}"><div class="form-grid">
    <div class="field full"><label>Exercise name</label><input name="name" maxlength="100" value="${escapeHtml(exercise?.name || '')}" required></div>
    <div class="field"><label>Muscle group</label><select name="muscle">${muscles.map(item => `<option>${item}</option>`).join('')}</select></div>
    <div class="field"><label>Equipment</label><select name="equipment">${equipment.map(item => `<option>${item}</option>`).join('')}</select></div>
    <div class="field"><label>Family (shared name)</label><input name="family" value="${escapeHtml(exercise?.family || exercise?.name || '')}" list="families"><datalist id="families">${groupedExercises(state.exercises).map(e => `<option>${escapeHtml(familyName(e))}</option>`).join('')}</datalist></div>
    <div class="field"><label>Variation (e.g. 15°, single arm)</label><input name="variation" list="variation-presets" value="${escapeHtml(exercise?.variation || '')}"><datalist id="variation-presets"><option>15°</option><option>30°</option><option>Single arm</option><option>Double arm</option></datalist></div>
    <div class="field"><label>How load is logged</label><select name="loadMode"><option value="external" ${!exercise || exerciseLoadMode(exercise) === 'external' ? 'selected' : ''}>Entered weight</option><option value="bodyweight" ${exercise && exerciseLoadMode(exercise) === 'bodyweight' ? 'selected' : ''}>Bodyweight + added weight</option></select></div>
    <div class="field full"><details class="disclosure" ${!exercise?.targets?.length ? 'open' : ''}><summary>Muscle targets (${exercise?.targets?.length || 0} selected)</summary>${targetCheckboxes(exercise?.targets || [])}</details></div>
  </div></form>`, { footer: '<button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-exercise">Save exercise</button>' });
  if (exercise) { document.querySelector('#exercise-form [name=muscle]').value = exercise.muscle; document.querySelector('#exercise-form [name=equipment]').value = exercise.equipment; }
}

async function saveExercise() {
  const form = document.querySelector('#exercise-form');
  const payload = Object.fromEntries(new FormData(form));
  try {
    payload.targets = new FormData(form).getAll('targets');
    await api(form.dataset.id ? `/api/exercises/${form.dataset.id}` : '/api/exercises', { method: form.dataset.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    ui.exerciseScope = 'all'; closeModal({ force: true }); await refresh(); toast('Exercise saved.');
  } catch (error) { toast(error.message, 'error'); }
}

async function deleteRecord(type, id, message) {
  if (!confirm(message)) return;
  try {
    await api(`/api/${type}/${id}`, { method: 'DELETE', body: '{}' });
    closeModal(); await refresh(); toast('Entry deleted.');
  } catch (error) { toast(error.message, 'error'); }
}

async function saveWithFeedback(selector, save) {
  if (ui.saving) return;
  const root = document.querySelector(selector);
  if (!root) return;
  const invalid = [...root.querySelectorAll('input, select, textarea')].find(input => !input.disabled && !input.checkValidity());
  if (invalid) {
    for (let ancestor = invalid.parentElement; ancestor; ancestor = ancestor.parentElement) if (ancestor.tagName === 'DETAILS') ancestor.open = true;
    invalid.reportValidity();
    toast(invalid.validationMessage || 'Check the highlighted field.', 'error');
    return;
  }
  ui.saving = true;
  const buttons = [...modalRoot.querySelectorAll('button'), ...root.querySelectorAll('button[type="submit"]')];
  buttons.forEach(button => { button.disabled = true; });
  const error = modalRoot.querySelector('.form-error'); if (error) error.hidden = true;
  try { await save(); }
  finally { ui.saving = false; buttons.forEach(button => { button.disabled = false; }); }
}

document.addEventListener('click', async event => {
  const point = event.target.closest('[data-chart-point]');
  if (point) point.closest('.interactive-chart').querySelector('.chart-readout').textContent = point.dataset.chartPoint;
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'show-all-exercises') { ui.exerciseScope = 'all'; render(); }
  if (action === 'body-tab') { ui.bodyTab = target.dataset.value; render(); }
  if (action === 'new-workout' || action === 'resume-workout') openWorkoutModal(null, loadWorkoutDraft());
  if (action === 'discard-workout' && confirm('Discard this unfinished workout?')) { localStorage.removeItem(DRAFT_KEY); if (ui.workoutDraft) closeModal({ discard: true }); else render(); }
  if (action === 'edit-workout') { const draft = loadWorkoutDraft(); if (!draft || draft.id === target.dataset.id || confirm('Discard the unfinished workout and edit this session?')) openWorkoutModal(state.workouts.find(item => item.id === target.dataset.id), draft?.id === target.dataset.id ? draft : null); }
  if (action === 'delete-workout') deleteRecord('workouts', target.dataset.id, 'Delete this workout?');
  if (action === 'new-measurement') openMeasurementModal();
  if (action === 'edit-measurement') openMeasurementModal(state.measurements.find(item => item.id === target.dataset.id));
  if (action === 'delete-measurement') deleteRecord('measurements', target.dataset.id, 'Delete this body check-in?');
  if (action === 'new-goal') openGoalModal();
  if (action === 'edit-goal') openGoalModal(state.goals.find(item => item.id === target.dataset.id));
  if (action === 'delete-goal') deleteRecord('goals', target.dataset.id, 'Delete this goal?');
  if (action === 'add-variation') openVariationModal(state.exercises.find(e => e.id === target.dataset.id));
  if (action === 'variation-preset') { const input = document.querySelector('#new-variation-name'); if (input) { input.value = target.dataset.value; input.focus(); } }
  if (action === 'edit-exercise') openExerciseModal(state.exercises.find(e => e.id === target.dataset.id));
  if (action === 'new-exercise') openExerciseModal();
  if (action === 'delete-exercise') {
    const exercise = state.exercises.find(item => item.id === target.dataset.id);
    if (exercise) deleteRecord('exercises', exercise.id, `Delete ${exercise.name} from your exercise library? Past workouts will be kept.`);
  }
  if (action === 'close-modal') closeModal();
  if (action === 'backdrop-close' && event.target === target) closeModal();
  if (action === 'save-workout') await saveWithFeedback('.workout-modal .modal-body', saveWorkout);
  if (action === 'save-measurement') await saveWithFeedback('#measurement-form', saveMeasurement);
  if (action === 'save-goal') await saveWithFeedback('#goal-form', saveGoal);
  if (action === 'save-exercise') await saveWithFeedback('#exercise-form', saveExercise);
  if (action === 'refresh-recommendations') {
    try {
      ui.recommendations = await api('/api/recommendations', { method: 'POST', body: '{}' });
      render();
      pollRecommendations().catch(() => {});
    } catch (error) { toast(error.message, 'error'); }
  }
  if (action === 'apply-workout-template') {
    syncWorkoutDraft();
    if (!ui.workoutDraft.exercises.length || confirm('Replace this draft with the previous workout?')) applyWorkoutTemplate(state.workouts.find(item => item.id === target.dataset.id));
  }
  if (action === 'choose-workout-exercise') {
    syncWorkoutDraft();
    const exercise = state.exercises.find(item => item.id === target.dataset.id);
    if (!exercise) return;
    ui.workoutDraft.exercises.push(createExerciseDraft(exercise));
    ui.exercisePickerQuery = '';
    const search = document.querySelector('#exercise-picker-search');
    if (search) search.value = '';
    renderWorkoutEntries();
    renderExercisePickerResults();
    persistWorkoutDraft(false);
  }
  if (action === 'remove-workout-exercise') {
    syncWorkoutDraft(); ui.workoutDraft.exercises.splice(Number(target.dataset.exercise), 1); renderWorkoutEntries(); persistWorkoutDraft(false);
  }
  if (action === 'add-set') {
    syncWorkoutDraft();
    const exercise = ui.workoutDraft.exercises[Number(target.dataset.exercise)];
    const previous = exercise.sets.at(-1) || {};
    if (tracksBodyweight(exercise)) {
      exercise.sets.push({ bodyweight: exercise.bodyweight, addedWeight: previous.addedWeight || 0, weight: Number(exercise.bodyweight || 0) + Number(previous.addedWeight || 0), reps: '', completed: true, _suggestedFields: ['addedWeight'] });
    } else {
      exercise.sets.push({ weight: previous.weight || '', reps: '', completed: true, _suggestedFields: previous.weight === '' ? [] : ['weight'] });
    }
    renderWorkoutEntries();
    persistWorkoutDraft(false);
  }
  if (action === 'remove-set') {
    syncWorkoutDraft();
    const exercise = ui.workoutDraft.exercises[Number(target.dataset.exercise)];
    exercise.sets.splice(Number(target.dataset.set), 1);
    renderWorkoutEntries();
    persistWorkoutDraft(false);
  }
  if (action === 'load-demo') {
    if (!confirm('Load example workouts, body check-ins, and goals?')) return;
    try { await api('/api/demo', { method: 'POST', body: '{}' }); await refresh(); toast('Demo data loaded.'); } catch (error) { toast(error.message, 'error'); }
  }
  if (action === 'reset-data') {
    if (!confirm('Permanently delete every IronLog entry?')) return;
    try { await api('/api/reset', { method: 'POST', body: '{}' }); await refresh(); toast('Database reset.'); } catch (error) { toast(error.message, 'error'); }
  }
});

document.addEventListener('input', event => {
  if (event.target.id === 'workout-search') { ui.workoutSearch = event.target.value; render(); document.querySelector('#workout-search')?.focus(); }
  if (event.target.id === 'exercise-search') { ui.exerciseSearch = event.target.value; render(); document.querySelector('#exercise-search')?.focus(); }
  if (event.target.id === 'template-search') { ui.templateQuery = event.target.value; renderTemplateResults(); }
  if (event.target.id === 'exercise-picker-search') { ui.exercisePickerQuery = event.target.value; renderExercisePickerResults(); }
  if (ui.workoutDraft && (event.target.matches('[data-workout-field]') || event.target.matches('[data-draft-field]') || event.target.matches('[data-exercise-bodyweight]'))) {
    markDraftTouched(event.target);
    syncWorkoutDraft();
    if (event.target.id === 'workout-date') refreshSuggestedBodyweights();
    persistWorkoutDraft(false);
  }
});

document.addEventListener('change', event => {
  if (event.target.id === 'goal-type') updateGoalType();
  if (event.target.id === 'goal-family') { const key = strengthOptions().find(e => e.family === event.target.value)?.key; document.querySelector('#goal-exercise-fields').innerHTML = goalExerciseFields(key); }
  if (event.target.id === 'exercise-scope') { ui.exerciseScope = event.target.value; render(); }
  if (event.target.id === 'strength-metric') { ui.strengthMetric = event.target.value; render(); }
  if (event.target.matches('[data-chart-range]')) { ui.chartRange = event.target.value; render(); }
  if (event.target.id === 'strength-exercise') { ui.strengthExercise = event.target.value; ui.strengthVariation = ''; render(); }
  if (event.target.id === 'strength-variation') { ui.strengthVariation = event.target.value; ui.strengthSelections[ui.strengthExercise] = ui.strengthVariation; render(); }
  if (event.target.id === 'muscle-filter') { ui.exerciseMuscle = event.target.value; render(); }
  for (const group of BODY_TREND_GROUPS) {
    if (event.target.id === group.id) { ui[group.stateKey] = event.target.value; render(); }
  }
  if (event.target.id === 'import-file' && event.target.files[0]) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const backup = JSON.parse(reader.result);
        if (!confirm('Replace the current database with this backup?')) return;
        await api('/api/import', { method: 'POST', body: JSON.stringify(backup) });
        await refresh(); toast('Backup imported.');
      } catch (error) { toast(error.message === 'Unexpected token' ? 'That file is not valid JSON.' : error.message, 'error'); }
    };
    reader.readAsText(event.target.files[0]);
  }
});

document.addEventListener('submit', async event => {
  if (event.target.id === 'variation-form') { event.preventDefault(); await saveVariation(); return; }
  const forms = { 'measurement-form': saveMeasurement, 'goal-form': saveGoal, 'exercise-form': saveExercise };
  if (forms[event.target.id]) { event.preventDefault(); await saveWithFeedback(`#${event.target.id}`, forms[event.target.id]); return; }
  if (event.target.id !== 'settings-form') return;
  if (ui.saving) { event.preventDefault(); return; }
  event.preventDefault();
  try {
    ui.saving = true;
    event.target.querySelector('button[type=submit]').disabled = true;
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    await refresh(); toast('Preferences saved.');
  } catch (error) { toast(error.message, 'error'); }
  finally { ui.saving = false; const button = document.querySelector('#settings-form button[type=submit]'); if (button) button.disabled = false; }
});

window.addEventListener('hashchange', () => {
  ui.route = location.hash.slice(1) || 'dashboard';
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

function updateMobileViewport() {
  const viewport = window.visualViewport;
  const height = viewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${height}px`);
  document.documentElement.style.setProperty('--visual-viewport-top', `${viewport?.offsetTop || 0}px`);
}

updateMobileViewport();
window.addEventListener('resize', updateMobileViewport);
let resizeRender;
window.addEventListener('resize', () => { clearTimeout(resizeRender); resizeRender = setTimeout(() => { if (state && !modalRoot.querySelector('.modal')) render(); }, 180); });
window.visualViewport?.addEventListener('resize', updateMobileViewport);
window.visualViewport?.addEventListener('scroll', updateMobileViewport);
window.addEventListener('pageshow', () => {
  updateMobileViewport();
  if (!ui.workoutDraft) {
    const draft = loadWorkoutDraft();
    if (draft) render();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistWorkoutDraft();
  else updateMobileViewport();
});
window.addEventListener('beforeunload', () => persistWorkoutDraft());
modalRoot.addEventListener('scroll', event => {
  if (event.target.classList?.contains('modal')) persistWorkoutDraft(false);
}, true);

document.querySelector('#mobile-menu-button').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
document.addEventListener('keydown', event => {
  const point = event.target.closest('[data-chart-point]');
  if (point && ['Enter', ' '].includes(event.key)) { event.preventDefault(); point.closest('.interactive-chart').querySelector('.chart-readout').textContent = point.dataset.chartPoint; }
  const modal = modalRoot.querySelector('.modal');
  if (!modal) return;
  if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
  if (event.key === 'Tab') {
    const focusable = [...modal.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex="0"]')].filter(e => !e.disabled && e.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === modal)) { event.preventDefault(); first?.focus(); }
  }
  if (['ArrowDown','ArrowUp'].includes(event.key)) {
    const picker = event.target.closest('.template-picker, .exercise-search-picker');
    if (picker) {
      const choices = [...picker.querySelectorAll('input, button')];
      const index = choices.indexOf(event.target), next = index + (event.key === 'ArrowDown' ? 1 : -1);
      event.preventDefault(); choices[(next + choices.length) % choices.length]?.focus();
    }
  }
});

render();
refresh().catch(error => {
  app.innerHTML = emptyState('IronLog could not start', error.message);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

document.addEventListener('change', event => {
  const target = event.target;
  if (target.dataset.libraryVariation) { ui.librarySelections[target.dataset.libraryVariation] = target.value; render(); }
  if (target.id === 'checkin-input-unit') {
    const previous = target.dataset.previous;
    for (const field of LENGTH_FIELDS) {
      const input = document.querySelector(`#measurement-form [name="${field}"]`);
      if (input.value !== '') input.value = Number(input.value) * (target.value === 'cm' ? 2.54 : 1 / 2.54);
      input.previousElementSibling.textContent = input.previousElementSibling.textContent.replace(/\((in|cm)\)/, `(${target.value})`);
    }
    target.dataset.previous = target.value;
    localStorage.setItem('ironlog-measurement-input', target.value);
  }
  if (target.dataset.variationIndex != null) {
    syncWorkoutDraft();
    const index = Number(target.dataset.variationIndex);
    const selected = state.exercises.find(e => e.id === target.value);
    if (selected && (!ui.workoutDraft.exercises[index].sets.some(s => Number(s.reps) > 0) || confirm('Changing variation replaces the entered sets. Continue?'))) { ui.workoutDraft.exercises[index] = createExerciseDraft(selected); renderWorkoutEntries(); persistWorkoutDraft(false); } else renderWorkoutEntries();
  }
});
