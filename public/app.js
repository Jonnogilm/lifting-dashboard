const app = document.querySelector('#app');
const modalRoot = document.querySelector('#modal-root');
const DRAFT_KEY = 'ironlog-workout-draft-v2';
const toastRoot = document.querySelector('#toast-root');

const ui = {
  route: location.hash.slice(1) || 'dashboard',
  workoutSearch: '',
  exerciseSearch: '',
  exerciseMuscle: 'All',
  strengthExercise: '',
  bodyCompositionMetric: 'weight',
  circumferenceMetric: 'waist',
  recoveryMetric: 'restingHeartRate',
  workoutDraft: null,
  recommendations: null,
  initialDraftChecked: false,
  exercisePickerQuery: '',
  templateQuery: ''
};

let state = null;
let modalPageScrollY = 0;
let modalPageScrollLocked = false;

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const number = (value, maximumFractionDigits = 0) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits });
const todayIso = () => new Date().toISOString().slice(0, 10);
const dateFromIso = value => new Date(`${value}T12:00:00`);
const daysBetween = (later, earlier) => Math.floor((later - earlier) / 86400000);
const shortDate = value => dateFromIso(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDate = value => dateFromIso(value).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const monthName = value => dateFromIso(value).toLocaleDateString(undefined, { month: 'short' });
const unit = () => state?.settings?.weightUnit || 'lb';
const measureUnit = () => state?.settings?.measurementUnit || 'in';
const estimateOneRepMax = (weight, reps) => Number(weight) > 0 ? Number(weight) * (1 + Number(reps) / 30) : Number(reps);

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
  render();
  refreshRecommendations(false).catch(() => {});
  if (!ui.initialDraftChecked) {
    ui.initialDraftChecked = true;
    const draft = loadWorkoutDraft();
    if (draft) openWorkoutModal(null, draft);
  }
}

function toast(message, type = '') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  toastRoot.append(element);
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
    const current = records.get(set.exerciseName);
    if (!current || estimated > current.estimated) records.set(set.exerciseName, { ...set, estimated });
  }
  return [...records.values()].sort((a, b) => b.estimated - a.estimated);
}

function strengthHistory(exerciseName) {
  return [...state.workouts]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(workout => {
      const exerciseSets = workout.exercises.filter(item => item.name === exerciseName).flatMap(item => item.sets);
      if (!exerciseSets.length) return null;
      return {
        date: workout.date,
        value: Math.max(...exerciseSets.map(set => estimateOneRepMax(set.weight, set.reps)))
      };
    }).filter(Boolean);
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
      return date >= start && date < end;
    });
    return {
      start,
      label: start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      sessions: workouts.length,
      volume: workouts.reduce((sum, workout) => sum + workoutVolume(workout), 0)
    };
  });
}

function latestMeasurement() {
  return [...state.measurements].sort((a, b) => b.date.localeCompare(a.date))[0] || null;
}

function previousMeasurement() {
  return [...state.measurements].sort((a, b) => b.date.localeCompare(a.date))[1] || null;
}

function getGoalCurrent(goal) {
  if (goal.type === 'strength') return personalRecords().find(item => item.exerciseName === goal.exerciseName)?.estimated || 0;
  if (goal.type === 'bodyweight') return latestMeasurement()?.weight || goal.start || 0;
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

function lineChart(points, suffix = '', colorClass = '') {
  if (points.length < 2) return `<div class="empty-chart">Add at least two entries to see a trend.</div>`;
  const width = 700;
  const height = 245;
  const padding = { top: 18, right: 18, bottom: 30, left: 42 };
  const values = points.map(point => Number(point.value));
  let min = Math.min(...values);
  let max = Math.max(...values);
  const spread = max - min || Math.max(max * .1, 1);
  min = Math.max(0, min - spread * .18);
  max += spread * .18;
  const x = index => padding.left + (index / (points.length - 1)) * (width - padding.left - padding.right);
  const y = value => padding.top + ((max - value) / (max - min)) * (height - padding.top - padding.bottom);
  const line = points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ');
  const area = `${padding.left},${height - padding.bottom} ${line} ${x(points.length - 1)},${height - padding.bottom}`;
  const grid = Array.from({ length: 4 }, (_, index) => {
    const gridY = padding.top + index * ((height - padding.top - padding.bottom) / 3);
    const label = max - index * ((max - min) / 3);
    return `<line class="chart-grid-line" x1="${padding.left}" y1="${gridY}" x2="${width - padding.right}" y2="${gridY}" />
      <text class="chart-axis-label" x="${padding.left - 7}" y="${gridY + 3}" text-anchor="end">${number(label, 1)}</text>`;
  }).join('');
  const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  return `<svg class="line-chart ${colorClass}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Trend chart">
    ${grid}
    <polygon class="chart-area" points="${area}" />
    <polyline class="chart-line" points="${line}" />
    ${points.map((point, index) => `<circle class="chart-point" cx="${x(index)}" cy="${y(point.value)}" r="4"><title>${escapeHtml(shortDate(point.date))}: ${number(point.value, 1)}${escapeHtml(suffix)}</title></circle>`).join('')}
    ${labelIndexes.map(index => `<text class="chart-axis-label" x="${x(index)}" y="${height - 8}" text-anchor="middle">${escapeHtml(shortDate(points[index].date))}</text>`).join('')}
  </svg>`;
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
  const pastWeek = new Date(now);
  pastWeek.setDate(now.getDate() - 7);
  const recent = state.workouts.filter(workout => dateFromIso(workout.date) >= pastWeek);
  const recentVolume = recent.reduce((sum, workout) => sum + workoutVolume(workout), 0);
  const latest = latestMeasurement();
  const previous = previousMeasurement();
  const weightDelta = latest && previous ? latest.weight - previous.weight : null;
  const prs = personalRecords();
  const recentPrs = prs.filter(pr => daysBetween(now, dateFromIso(pr.date)) <= 30);
  const exerciseNames = [...new Set(allSets().filter(set => set.weight > 0).map(set => set.exerciseName))];
  if (!ui.strengthExercise || !exerciseNames.includes(ui.strengthExercise)) ui.strengthExercise = exerciseNames[0] || '';
  const history = ui.strengthExercise ? strengthHistory(ui.strengthExercise) : [];
  const latestSessions = [...state.workouts].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const greetingHour = new Date().getHours();
  const greeting = greetingHour < 12 ? 'Good morning' : greetingHour < 18 ? 'Good afternoon' : 'Good evening';

  return `${pageHeader(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), `${greeting}, ${state.settings.athleteName}`, `<button class="button primary" data-action="new-workout">+ Log workout</button>`)}
    <section class="stat-grid">
      ${statCard('Sessions this week', number(recent.length), recent.length ? `${number(recent.reduce((sum, workout) => sum + workout.duration, 0))} training minutes` : 'No sessions in the last 7 days', '7D', 'green')}
      ${statCard('Volume this week', `${number(recentVolume / 1000, 1)}k`, recentVolume ? `${unit()} moved across ${number(recent.reduce((sum, workout) => sum + workoutSetCount(workout), 0))} sets` : `0 ${unit()} logged`, 'VOL', 'blue')}
      ${statCard('Bodyweight', latest?.weight != null ? `${number(latest.weight, 1)} <small>${unit()}</small>` : '--', weightDelta == null ? 'No trend yet' : `<span class="${weightDelta <= 0 ? 'trend-up' : 'trend-down'}">${weightDelta > 0 ? '+' : ''}${number(weightDelta, 1)} ${unit()}</span> since ${shortDate(previous.date)}`, 'BW', 'coral')}
      ${statCard('Current records', number(prs.length), recentPrs.length ? `<span class="trend-up">${recentPrs.length} set in the last 30 days</span>` : 'Keep building the baseline', 'PR', 'acid')}
    </section>
    <section class="dashboard-grid">
      <article class="panel">
        <div class="panel-header"><div><h2>Strength trend</h2><p class="panel-subtitle">Estimated one-rep max</p></div>
          ${exerciseNames.length ? `<select class="select-compact" id="strength-exercise" aria-label="Strength chart exercise">${exerciseNames.map(name => `<option ${name === ui.strengthExercise ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select>` : ''}
        </div>
        <div class="chart-wrap">${history.length ? lineChart(history, ` ${unit()}`) : `<div class="empty-chart">Log weighted sets to build your strength chart.</div>`}</div>
      </article>
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
        ${state.goals.length ? `<div class="goal-list">${state.goals.filter(goal => !goal.completed).slice(0, 3).map(goalCard).join('')}</div>` : emptyState('No active goals', 'Set a strength, bodyweight, or consistency target.', '<button class="button small" data-action="new-goal">Add goal</button>')}
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

function renderExercises() {
  const muscles = ['All', ...new Set(state.exercises.map(item => item.muscle).sort())];
  const records = new Map(personalRecords().map(record => [record.exerciseName, record]));
  const exercises = state.exercises.filter(exercise =>
    (ui.exerciseMuscle === 'All' || exercise.muscle === ui.exerciseMuscle) &&
    (!ui.exerciseSearch || `${exercise.name} ${exercise.muscle} ${exercise.equipment}`.toLowerCase().includes(ui.exerciseSearch.toLowerCase()))
  );
  return `${pageHeader('Movement library', 'Exercises', `<button class="button primary" data-action="new-exercise">+ Add exercise</button>`)}
    <div class="toolbar"><div class="search-field"><input id="exercise-search" type="search" value="${escapeHtml(ui.exerciseSearch)}" placeholder="Search exercises" aria-label="Search exercises"></div>
      <select class="select-compact" id="muscle-filter" aria-label="Filter by muscle group">${muscles.map(muscle => `<option ${muscle === ui.exerciseMuscle ? 'selected' : ''}>${escapeHtml(muscle)}</option>`).join('')}</select></div>
    ${exercises.length ? `<div class="exercise-grid">${exercises.map(exercise => {
      const record = records.get(exercise.name);
      const sessions = state.workouts.filter(workout => workout.exercises.some(item => item.name === exercise.name)).length;
      return `<article class="exercise-card"><div class="exercise-card-top"><div><h3>${escapeHtml(exercise.name)}</h3><p class="exercise-meta">${escapeHtml(exercise.muscle)} · ${escapeHtml(exercise.equipment)}</p></div><span class="exercise-monogram">${escapeHtml(exercise.name.split(/\s+/).map(word => word[0]).slice(0, 2).join(''))}</span></div>
        <div class="exercise-record"><span><span class="muted">Best e1RM</span><br><strong>${record && record.weight > 0 ? `${number(record.estimated, 1)} ${unit()}` : '--'}</strong></span><span><span class="muted">Sessions</span><br><strong>${sessions}</strong></span><button class="link-button danger" data-action="delete-exercise" data-id="${exercise.id}" aria-label="Delete ${escapeHtml(exercise.name)}">Delete</button></div></article>`;
    }).join('')}</div>` : emptyState('No matching exercises', 'Adjust your search or add a custom movement.')}`;
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
    </div><div class="chart-wrap">${lineChart(points, metric.suffix(), group.color)}</div></article>`;
}

function renderBody() {
  const latest = latestMeasurement();
  const previous = previousMeasurement();
  const sorted = [...state.measurements].sort((a, b) => a.date.localeCompare(b.date));

  const fields = [
    ['Waist', 'waist'], ['Chest', 'chest'], ['Neck', 'neck'], ['Hips', 'hips'],
    ['Left arm', 'leftArm'], ['Right arm', 'rightArm'], ['Left thigh', 'leftThigh'], ['Right thigh', 'rightThigh']
  ];
  return `${pageHeader('Health and measurements', 'Body', `<button class="button primary" data-action="new-measurement">+ Add check-in</button>`)}
    <section class="body-overview">
      ${statCard('Bodyweight', latest?.weight != null ? `${number(latest.weight, 1)} <small>${unit()}</small>` : '--', latest ? `Updated ${shortDate(latest.date)}` : 'No check-ins yet', 'BW', 'coral')}
      ${statCard('Body fat', latest?.bodyFat != null ? `${number(latest.bodyFat, 1)}<small>%</small>` : '--', latest?.bodyFat != null && previous?.bodyFat != null ? `${latest.bodyFat - previous.bodyFat > 0 ? '+' : ''}${number(latest.bodyFat - previous.bodyFat, 1)}% since previous` : 'No trend yet', 'BF', 'green')}
      ${statCard('Resting heart rate', latest?.restingHeartRate != null ? `${number(latest.restingHeartRate)} <small>bpm</small>` : '--', latest?.restingHeartRate != null ? 'Latest check-in' : 'No data yet', 'HR', 'blue')}
      ${statCard('Sleep', latest?.sleep != null ? `${number(latest.sleep, 1)} <small>hrs</small>` : '--', latest?.sleep != null ? 'Latest nightly average' : 'No data yet', 'ZZ', 'acid')}
    </section>
    <section class="body-trend-grid">${BODY_TREND_GROUPS.map(group => bodyTrendPanel(group, sorted)).join('')}</section>
    <article class="panel latest-measurements"><div class="panel-header"><div><h2>Latest measurements</h2><p class="panel-subtitle">${latest ? longDate(latest.date) : 'No check-ins'}</p></div></div>
      ${latest ? `<div class="measurement-grid">${fields.map(([label, key]) => `<div class="measurement-tile"><span>${label}</span><strong>${measurementValue(latest[key], measureUnit())}</strong></div>`).join('')}</div>` : emptyState('No measurements', 'Add a body check-in to establish your baseline.')}</article>
    <article class="panel table-panel"><div class="panel-header"><div><h2>Check-in history</h2><p class="panel-subtitle">Body and recovery markers</p></div></div>
      ${state.measurements.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Date</th><th>Weight</th><th>Body fat</th><th>Waist</th><th>RHR</th><th>Sleep</th><th></th></tr></thead><tbody>${[...state.measurements].sort((a,b) => b.date.localeCompare(a.date)).map(item => `<tr><td>${longDate(item.date)}</td><td>${measurementValue(item.weight, unit())}</td><td>${measurementValue(item.bodyFat, '%')}</td><td>${measurementValue(item.waist, measureUnit())}</td><td>${measurementValue(item.restingHeartRate, 'bpm', 0)}</td><td>${measurementValue(item.sleep, 'hrs')}</td><td><div class="row-actions"><button class="link-button" data-action="edit-measurement" data-id="${item.id}">Edit</button><button class="link-button danger" data-action="delete-measurement" data-id="${item.id}">Delete</button></div></td></tr>`).join('')}</tbody></table></div>` : emptyState('No check-ins yet', 'Body measurements and recovery stats will appear here.', '<button class="button primary" data-action="new-measurement">Add check-in</button>')}
    </article>`;
}

function goalCard(goal) {
  const current = getGoalCurrent(goal);
  const progress = getGoalProgress(goal);
  const suffix = goal.type === 'consistency' ? ' sessions' : ` ${unit()}`;
  return `<article class="goal-card"><div class="goal-top"><div><div class="goal-title">${escapeHtml(goal.title)}</div><div class="goal-deadline">${goal.deadline ? `Target ${shortDate(goal.deadline)}` : 'Open deadline'}</div></div><button class="link-button" data-action="edit-goal" data-id="${goal.id}">Edit</button></div>
    <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div><div class="goal-range"><span>${number(current, 1)}${suffix}</span><span>${number(goal.target, 1)}${suffix}</span></div></article>`;
}

function renderRecommendations() {
  const result = ui.recommendations || state.recommendations || { status: 'idle', items: [] };
  const running = result.status === 'running';
  const items = Array.isArray(result.items) ? result.items : [];
  return `<article class="panel recommendation-panel">
    <div class="panel-header"><div><h2>Training recommendations</h2><p class="panel-subtitle">Local balanced-hypertrophy analysis</p></div>
      <button class="button small" data-action="refresh-recommendations" ${running ? 'disabled' : ''}>${running ? 'Analyzing...' : items.length ? 'Refresh' : 'Generate'}</button>
    </div>
    ${running ? `<div class="recommendation-loading"><span class="status-dot"></span><span>The Pi is analyzing your latest workouts. You can keep using IronLog.</span></div>` : ''}
    ${result.modelStatus === 'unavailable' ? `<p class="model-notice">The local model is unavailable (${escapeHtml(result.modelError || 'unknown error')}); verified analysis is shown without AI rewriting.</p>` : ''}
    ${result.status === 'error' ? `<p class="model-notice error">${escapeHtml(result.error || 'Recommendation generation failed.')}</p>` : ''}
    ${items.length ? `<div class="recommendation-grid">${items.map(item => `<section class="recommendation-card">
      <span class="pill">${escapeHtml(item.type)}</span><h3>${escapeHtml(item.title)}</h3>
      <p class="recommendation-evidence">${escapeHtml(item.evidence)}</p>
      <p>${escapeHtml(item.recommendation)}</p>
      ${item.exercises?.length ? `<div class="recommendation-exercises">${item.exercises.map(name => `<span>${escapeHtml(name)}</span>`).join('')}</div>` : ''}
    </section>`).join('')}</div>` : !running ? emptyState('No recommendations yet', 'Save a workout or generate an analysis to get evidence-backed feedback.') : ''}
    ${result.generatedAt ? `<p class="recommendation-meta">Updated ${escapeHtml(new Date(result.generatedAt).toLocaleString())} - ${number(result.workoutCount)} workouts analyzed</p>` : ''}
    <p class="recommendation-disclaimer">Training guidance only - not medical advice. Muscle-head suggestions describe emphasis, not isolation.</p>
  </article>`;
}

async function refreshRecommendations(shouldRender = true) {
  ui.recommendations = await api('/api/recommendations');
  if (shouldRender && ui.route === 'progress') render();
  return ui.recommendations;
}

async function pollRecommendations(attempt = 0) {
  const result = await refreshRecommendations();
  if (result.status === 'running' && attempt < 120) setTimeout(() => pollRecommendations(attempt + 1).catch(() => {}), 2000);
}

function renderProgress() {
  const records = personalRecords();
  const topRecords = records.filter(item => item.weight > 0);
  const weeks = weeksData(12);
  const maxSessions = Math.max(...weeks.map(week => week.sessions), 1);
  const totalVolume = state.workouts.reduce((sum, workout) => sum + workoutVolume(workout), 0);
  const totalSets = state.workouts.reduce((sum, workout) => sum + workoutSetCount(workout), 0);
  return `${pageHeader('Performance analysis', 'Progress', `<button class="button" data-action="new-goal">+ Add goal</button><button class="button primary" data-action="new-workout">+ Log workout</button>`)}
    <section class="stat-grid">
      ${statCard('Lifetime volume', `${number(totalVolume / 1000, 1)}k`, `${unit()} moved`, 'VOL', 'blue')}
      ${statCard('Training sessions', number(state.workouts.length), `${number(totalSets)} working sets`, 'ALL', 'green')}
      ${statCard('Exercise records', number(records.length), 'Estimated one-rep max leaders', 'PR', 'coral')}
      ${statCard('Last 12 weeks', `${number(weeks.reduce((sum, week) => sum + week.sessions, 0))}`, 'Completed sessions', '12W', 'acid')}
    </section>
    <article class="panel"><div class="panel-header"><div><h2>Personal records</h2><p class="panel-subtitle">Best estimated one-rep max by movement</p></div></div>
      ${topRecords.length ? `<div class="pr-scroll"><div class="pr-grid">${topRecords.map(record => `<div class="pr-card"><div class="pr-name">${escapeHtml(record.exerciseName)}</div><div class="pr-value">${number(record.estimated, 1)} <small>${unit()}</small></div><div class="pr-meta">${number(record.weight, 1)} ${unit()} x ${record.reps} · ${shortDate(record.date)}</div></div>`).join('')}</div></div>` : emptyState('No records yet', 'Weighted working sets will populate your personal records.')}
    </article>
    ${renderRecommendations()}
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
  app.innerHTML = routes[ui.route]();
  document.title = `${ui.route[0].toUpperCase()}${ui.route.slice(1)} · IronLog`;
  document.querySelectorAll('[data-route]').forEach(item => item.classList.toggle('active', item.dataset.route === ui.route));
  document.querySelector('.sidebar')?.classList.remove('open');
}

function openModal(title, body, { wide = false, footer = '', autoFocus = true, workout = false } = {}) {
  modalRoot.innerHTML = `<div class="modal-backdrop ${workout ? 'workout-modal-backdrop' : ''}" data-action="backdrop-close"><section class="modal ${wide ? 'wide' : ''} ${workout ? 'workout-modal' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <header class="modal-header"><h2 id="modal-title">${escapeHtml(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="Close">x</button></header>
    <div class="modal-body">${body}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}
  </section></div>`;
  if (!modalPageScrollLocked) {
    modalPageScrollY = window.scrollY;
    modalPageScrollLocked = true;
    document.body.style.position = 'fixed';
    document.body.style.inset = `${-modalPageScrollY}px 0 auto`;
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
  }
  if (autoFocus) modalRoot.querySelector('input, select, textarea, button')?.focus();
}

function isTrackedBodyweightName(name) {
  return ['pull-up', 'chin-up'].includes(String(name || '').trim().toLowerCase());
}

function latestMeasurementForDate(date) {
  return [...state.measurements]
    .filter(item => item.weight != null && (!date || item.date <= date))
    .sort((a, b) => b.date.localeCompare(a.date))[0]?.weight ?? '';
}

function latestSetForExercise(exercise) {
  const workouts = [...state.workouts].sort((a, b) => b.date.localeCompare(a.date) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  for (const workout of workouts) {
    const match = workout.exercises.find(item => item.exerciseId === exercise.id || item.name.toLowerCase() === exercise.name.toLowerCase());
    const set = match?.sets?.filter(item => item.completed !== false && Number(item.reps) > 0).at(-1);
    if (set) return { ...set, bodyweight: set.bodyweight ?? match.bodyweight ?? '' };
  }
  return null;
}

function persistWorkoutDraft(sync = true) {
  if (!ui.workoutDraft) return;
  if (sync) syncWorkoutDraft();
  const modal = modalRoot.querySelector('.modal');
  if (modal) ui.workoutDraft.scrollTop = modal.scrollTop;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 2, draft: ui.workoutDraft })); } catch {}
}

function loadWorkoutDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
    return saved?.version === 2 && saved.draft?.date && Array.isArray(saved.draft.exercises) ? saved.draft : null;
  } catch {
    localStorage.removeItem(DRAFT_KEY);
    return null;
  }
}

function closeModal() {
  modalRoot.innerHTML = '';
  if (modalPageScrollLocked) {
    modalPageScrollLocked = false;
    document.body.style.position = '';
    document.body.style.inset = '';
    document.body.style.width = '';
    document.body.style.overflow = '';
    window.scrollTo(0, modalPageScrollY);
  }
  ui.workoutDraft = null;
  ui.exercisePickerQuery = '';
  ui.templateQuery = '';
  localStorage.removeItem(DRAFT_KEY);
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
    footer: `<button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-workout">${ui.workoutDraft.id ? 'Save changes' : 'Finish workout'}</button>`
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
  const suggestedName = ui.workoutDraft._suggestedFields?.includes('name') ? 'suggested-value' : '';
  return `${!ui.workoutDraft.id ? `<section class="template-picker">
    <label for="template-search">Use a previous workout</label>
    <input id="template-search" type="search" role="combobox" aria-controls="template-results" aria-expanded="true" placeholder="Search push, pull, legs..." autocomplete="off">
    <div id="template-results" class="picker-results" role="listbox"></div>
  </section>` : ''}
  <div class="form-grid">
    <div class="field"><label for="workout-name">Session name</label><input id="workout-name" data-workout-field="name" class="${suggestedName}" value="${escapeHtml(ui.workoutDraft.name)}" placeholder="Upper strength"></div>
    <div class="field"><label for="workout-date">Date</label><input id="workout-date" data-workout-field="date" type="date" value="${escapeHtml(ui.workoutDraft.date)}"></div>
    <div class="field"><label for="workout-duration">Duration (minutes)</label><input id="workout-duration" data-workout-field="duration" type="number" min="0" step="1" value="${escapeHtml(ui.workoutDraft.duration)}" placeholder="60"></div>
    <div class="field full"><label for="workout-notes">Notes</label><textarea id="workout-notes" data-workout-field="notes" placeholder="Session notes">${escapeHtml(ui.workoutDraft.notes)}</textarea></div>
  </div>
  <div id="workout-exercises"></div>
  <section class="exercise-search-picker">
    <label for="exercise-picker-search">Add exercise</label>
    <input id="exercise-picker-search" type="search" role="combobox" aria-controls="exercise-picker-results" aria-expanded="true" placeholder="Search exercise, muscle, or equipment" autocomplete="off">
    <div id="exercise-picker-results" class="picker-results" role="listbox"></div>
  </section>`;
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
  root.innerHTML = matches.length ? matches.map(workout => `<button type="button" role="option" data-action="apply-workout-template" data-id="${workout.id}">
    <strong>${escapeHtml(workout.name)}</strong><span>${escapeHtml(shortDate(workout.date))} - ${escapeHtml(workout.exercises.map(item => item.name).join(', '))}</span>
  </button>`).join('') : '<p class="picker-empty">No matching previous workouts.</p>';
}

function renderExercisePickerResults() {
  const root = document.querySelector('#exercise-picker-results');
  if (!root) return;
  const term = ui.exercisePickerQuery.trim().toLowerCase();
  const matches = [...state.exercises]
    .filter(exercise => !term || `${exercise.name} ${exercise.muscle} ${exercise.equipment}`.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, term ? 10 : 6);
  root.innerHTML = matches.length ? matches.map(exercise => `<button type="button" role="option" data-action="choose-workout-exercise" data-id="${exercise.id}">
    <strong>${escapeHtml(exercise.name)}</strong><span>${escapeHtml(exercise.muscle)} - ${escapeHtml(exercise.equipment)}</span>
  </button>`).join('') : '<p class="picker-empty">No matching exercises.</p>';
}

function createExerciseDraft(exercise) {
  const previous = latestSetForExercise(exercise);
  if (isTrackedBodyweightName(exercise.name)) {
    const bodyweight = latestMeasurementForDate(ui.workoutDraft.date);
    const addedWeight = previous?.addedWeight ?? 0;
    return {
      exerciseId: exercise.id,
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
  const exercises = structuredClone(workout.exercises).map(exercise => {
    const tracked = isTrackedBodyweightName(exercise.name);
    const bodyweight = exercise.bodyweight ?? exercise.sets[0]?.bodyweight ?? '';
    return {
      ...exercise,
      ...(tracked ? { bodyweight, _suggestedFields: ['bodyweight'] } : {}),
      sets: exercise.sets.map(set => ({
        ...set,
        ...(tracked ? {
          bodyweight: set.bodyweight ?? bodyweight,
          addedWeight: set.addedWeight ?? Math.max(0, Number(set.weight || 0) - Number(bodyweight || 0))
        } : {}),
        _suggestedFields: tracked ? ['addedWeight', 'reps'] : ['weight', 'reps']
      }))
    };
  });
  const draft = {
    id: null,
    name: workout.name,
    date: todayIso(),
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
    const tracked = isTrackedBodyweightName(exercise.name);
    const bodySuggested = exercise._suggestedFields?.includes('bodyweight') ? 'suggested-value' : '';
    return `<section class="exercise-entry" data-exercise-index="${exerciseIndex}">
      <div class="exercise-entry-header"><h3>${escapeHtml(exercise.name)}</h3><button class="link-button danger" data-action="remove-workout-exercise" data-exercise="${exerciseIndex}">Remove</button></div>
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
    if (isTrackedBodyweightName(exercise.name)) set.weight = Number(exercise.bodyweight || 0) + Number(set.addedWeight || 0);
  });
}

function refreshSuggestedBodyweights() {
  if (!ui.workoutDraft) return;
  const bodyweight = latestMeasurementForDate(ui.workoutDraft.date);
  for (const exercise of ui.workoutDraft.exercises) {
    if (!isTrackedBodyweightName(exercise.name) || !exercise._suggestedFields?.includes('bodyweight')) continue;
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
  const payload = { ...ui.workoutDraft, exercises: validExercises };
  try {
    await api(ui.workoutDraft.id ? `/api/workouts/${ui.workoutDraft.id}` : '/api/workouts', { method: ui.workoutDraft.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    closeModal();
    await refresh();
    pollRecommendations().catch(() => {});
    toast(wasEditing ? 'Workout updated.' : 'Workout logged. Recommendations are analyzing in the background.');
  } catch (error) { toast(error.message, 'error'); }
}

function openMeasurementModal(measurement = null) {
  const value = key => escapeHtml(measurement?.[key] ?? '');
  openModal(measurement ? 'Edit body check-in' : 'Add body check-in', `<form id="measurement-form" data-id="${measurement?.id || ''}"><div class="form-grid">
    <div class="field"><label for="measurement-date">Date</label><input id="measurement-date" name="date" type="date" value="${measurement?.date || todayIso()}" required></div>
    <div class="field"><label for="measurement-weight">Bodyweight (${unit()})</label><input id="measurement-weight" name="weight" type="number" step="any" min="0" value="${value('weight')}"></div>
    <div class="field"><label>Body fat (%)</label><input name="bodyFat" type="number" step="any" min="0" max="100" value="${value('bodyFat')}"></div>
    <div class="field"><label>Waist (${measureUnit()})</label><input name="waist" type="number" step="any" min="0" value="${value('waist')}"></div>
    <div class="field"><label>Chest (${measureUnit()})</label><input name="chest" type="number" step="any" min="0" value="${value('chest')}"></div>
    <div class="field"><label>Neck (${measureUnit()})</label><input name="neck" type="number" step="any" min="0" value="${value('neck')}"></div>
    <div class="field"><label>Hips (${measureUnit()})</label><input name="hips" type="number" step="any" min="0" value="${value('hips')}"></div>
    <div class="field"><label>Left arm (${measureUnit()})</label><input name="leftArm" type="number" step="any" min="0" value="${value('leftArm')}"></div>
    <div class="field"><label>Right arm (${measureUnit()})</label><input name="rightArm" type="number" step="any" min="0" value="${value('rightArm')}"></div>
    <div class="field"><label>Left thigh (${measureUnit()})</label><input name="leftThigh" type="number" step="any" min="0" value="${value('leftThigh')}"></div>
    <div class="field"><label>Right thigh (${measureUnit()})</label><input name="rightThigh" type="number" step="any" min="0" value="${value('rightThigh')}"></div>
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
    closeModal(); await refresh(); toast('Body check-in saved.');
  } catch (error) { toast(error.message, 'error'); }
}

function openGoalModal(goal = null) {
  openModal(goal ? 'Edit goal' : 'Add goal', `<form id="goal-form" data-id="${goal?.id || ''}"><div class="form-grid">
    <div class="field full"><label>Goal name</label><input name="title" maxlength="120" value="${escapeHtml(goal?.title || '')}" placeholder="225 lb bench press" required></div>
    <div class="field"><label>Goal type</label><select name="type" id="goal-type"><option value="strength" ${goal?.type === 'strength' ? 'selected' : ''}>Strength</option><option value="bodyweight" ${goal?.type === 'bodyweight' ? 'selected' : ''}>Bodyweight</option><option value="consistency" ${goal?.type === 'consistency' ? 'selected' : ''}>Weekly consistency</option></select></div>
    <div class="field"><label>Exercise</label><select name="exerciseName"><option value="">None</option>${state.exercises.map(exercise => `<option ${goal?.exerciseName === exercise.name ? 'selected' : ''}>${escapeHtml(exercise.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Starting value</label><input name="start" type="number" step="any" value="${escapeHtml(goal?.start ?? '')}" required></div>
    <div class="field"><label>Target value</label><input name="target" type="number" step="any" value="${escapeHtml(goal?.target ?? '')}" required></div>
    <div class="field"><label>Deadline</label><input name="deadline" type="date" value="${escapeHtml(goal?.deadline || '')}"></div>
    <div class="field"><label><input name="completed" type="checkbox" ${goal?.completed ? 'checked' : ''}> Mark complete</label></div>
  </div></form>`, { footer: `${goal ? `<button class="button danger" data-action="delete-goal" data-id="${goal.id}">Delete</button>` : ''}<button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-goal">Save goal</button>` });
}

async function saveGoal() {
  const form = document.querySelector('#goal-form');
  const payload = Object.fromEntries(new FormData(form));
  payload.completed = form.elements.completed.checked;
  const id = form.dataset.id;
  try {
    await api(id ? `/api/goals/${id}` : '/api/goals', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    closeModal(); await refresh(); toast('Goal saved.');
  } catch (error) { toast(error.message, 'error'); }
}

function openExerciseModal() {
  const muscles = ['Chest', 'Back', 'Shoulders', 'Legs', 'Quads', 'Hamstrings', 'Glutes', 'Arms', 'Calves', 'Core', 'Other'];
  const equipment = ['Barbell', 'Dumbbell', 'Cable', 'Machine', 'Bodyweight', 'Kettlebell', 'Other'];
  openModal('Add exercise', `<form id="exercise-form"><div class="form-grid">
    <div class="field full"><label>Exercise name</label><input name="name" maxlength="100" required></div>
    <div class="field"><label>Muscle group</label><select name="muscle">${muscles.map(item => `<option>${item}</option>`).join('')}</select></div>
    <div class="field"><label>Equipment</label><select name="equipment">${equipment.map(item => `<option>${item}</option>`).join('')}</select></div>
  </div></form>`, { footer: '<button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-exercise">Add exercise</button>' });
}

async function saveExercise() {
  const form = document.querySelector('#exercise-form');
  const payload = Object.fromEntries(new FormData(form));
  try {
    await api('/api/exercises', { method: 'POST', body: JSON.stringify(payload) });
    closeModal(); await refresh(); toast('Exercise added.');
  } catch (error) { toast(error.message, 'error'); }
}

async function deleteRecord(type, id, message) {
  if (!confirm(message)) return;
  try {
    await api(`/api/${type}/${id}`, { method: 'DELETE', body: '{}' });
    closeModal(); await refresh(); toast('Entry deleted.');
  } catch (error) { toast(error.message, 'error'); }
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'new-workout') openWorkoutModal();
  if (action === 'edit-workout') openWorkoutModal(state.workouts.find(item => item.id === target.dataset.id));
  if (action === 'delete-workout') deleteRecord('workouts', target.dataset.id, 'Delete this workout?');
  if (action === 'new-measurement') openMeasurementModal();
  if (action === 'edit-measurement') openMeasurementModal(state.measurements.find(item => item.id === target.dataset.id));
  if (action === 'delete-measurement') deleteRecord('measurements', target.dataset.id, 'Delete this body check-in?');
  if (action === 'new-goal') openGoalModal();
  if (action === 'edit-goal') openGoalModal(state.goals.find(item => item.id === target.dataset.id));
  if (action === 'delete-goal') deleteRecord('goals', target.dataset.id, 'Delete this goal?');
  if (action === 'new-exercise') openExerciseModal();
  if (action === 'delete-exercise') {
    const exercise = state.exercises.find(item => item.id === target.dataset.id);
    if (exercise) deleteRecord('exercises', exercise.id, `Delete ${exercise.name} from your exercise library? Past workouts will be kept.`);
  }
  if (action === 'close-modal') closeModal();
  if (action === 'backdrop-close' && event.target === target) closeModal();
  if (action === 'save-workout') saveWorkout();
  if (action === 'save-measurement') saveMeasurement();
  if (action === 'save-goal') saveGoal();
  if (action === 'save-exercise') saveExercise();
  if (action === 'refresh-recommendations') {
    try {
      ui.recommendations = await api('/api/recommendations', { method: 'POST', body: '{}' });
      render();
      pollRecommendations().catch(() => {});
    } catch (error) { toast(error.message, 'error'); }
  }
  if (action === 'apply-workout-template') {
    syncWorkoutDraft();
    applyWorkoutTemplate(state.workouts.find(item => item.id === target.dataset.id));
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
    if (isTrackedBodyweightName(exercise.name)) {
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
  if (event.target.id === 'strength-exercise') { ui.strengthExercise = event.target.value; render(); }
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
  if (event.target.id !== 'settings-form') return;
  event.preventDefault();
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    await refresh(); toast('Preferences saved.');
  } catch (error) { toast(error.message, 'error'); }
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
window.visualViewport?.addEventListener('resize', updateMobileViewport);
window.visualViewport?.addEventListener('scroll', updateMobileViewport);
window.addEventListener('pageshow', () => {
  updateMobileViewport();
  if (!ui.workoutDraft) {
    const draft = loadWorkoutDraft();
    if (draft) openWorkoutModal(null, draft);
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
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });

render();
refresh().catch(error => {
  app.innerHTML = emptyState('IronLog could not start', error.message);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
