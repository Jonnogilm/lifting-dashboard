const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { TARGETS, analyzeTraining, isTrackedBodyweight } = require('./lib/training');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(__dirname, 'data', 'lifting-data.json'));
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:1b';
const OLLAMA_TIMEOUT_MS = Math.max(10000, Number(process.env.OLLAMA_TIMEOUT_MS || 180000));
const OLLAMA_NUM_PREDICT = Math.max(80, Number(process.env.OLLAMA_NUM_PREDICT || 180));

const exerciseCatalog = [
  ['Back Squat', 'Legs', 'Barbell'], ['Front Squat', 'Legs', 'Barbell'],
  ['Bench Press', 'Chest', 'Barbell'], ['Incline Bench Press', 'Chest', 'Barbell'],
  ['Deadlift', 'Back', 'Barbell'], ['Romanian Deadlift', 'Hamstrings', 'Barbell'],
  ['Overhead Press', 'Shoulders', 'Barbell'], ['Barbell Row', 'Back', 'Barbell'],
  ['Pull-up', 'Back', 'Bodyweight'], ['Chin-up', 'Back', 'Bodyweight'],
  ['Lat Pulldown', 'Back', 'Cable'], ['Seated Cable Row', 'Back', 'Cable'],
  ['Dumbbell Bench Press', 'Chest', 'Dumbbell'], ['Dumbbell Row', 'Back', 'Dumbbell'],
  ['Lateral Raise', 'Shoulders', 'Dumbbell'], ['Face Pull', 'Shoulders', 'Cable'],
  ['Leg Press', 'Legs', 'Machine'], ['Leg Extension', 'Quads', 'Machine'],
  ['Leg Curl', 'Hamstrings', 'Machine'], ['Bulgarian Split Squat', 'Legs', 'Dumbbell'],
  ['Hip Thrust', 'Glutes', 'Barbell'], ['Calf Raise', 'Calves', 'Machine'],
  ['Biceps Curl', 'Arms', 'Dumbbell'], ['Triceps Pushdown', 'Arms', 'Cable'],
  ['Dip', 'Chest', 'Bodyweight'], ['Plank', 'Core', 'Bodyweight'],
  ['Overhead Triceps Extension', 'Arms', 'Cable'], ['Reverse-Grip Triceps Pushdown', 'Arms', 'Cable'],
  ['Skull Crusher', 'Arms', 'Barbell']
].map(([name, muscle, equipment]) => ({ id: randomUUID(), name, muscle, equipment, targets: TARGETS[name] || [], builtIn: true }));


const LENGTH_FIELDS = ['waist', 'chest', 'neck', 'leftArm', 'rightArm', 'hips', 'leftThigh', 'rightThigh'];
function inferredTargets(name) {
  if (TARGETS[name]) return TARGETS[name];
  const n = String(name).toLowerCase();
  if (/curl/.test(n) && !/leg/.test(n)) return ['biceps'];
  if (/calf/.test(n)) return ['calves'];
  if (/lateral raise/.test(n)) return ['shoulders-side'];
  if (/tricep.*ov|overhead tricep/.test(n)) return ['triceps-long'];
  if (/leg extension/.test(n)) return ['quads'];
  if (/leg curl/.test(n)) return ['hamstrings'];
  if (/incline bench/.test(n)) return TARGETS['Incline Bench Press'];
  return [];
}
function normalizeExercise(body, existing = {}) {
  const name = cleanText(body.name, 100);
  if (!name) throw Object.assign(new Error('Exercise name is required'), { status: 400 });
  const allowed = new Set(Object.values(TARGETS).flat().concat(['hip-adductors', 'hip-abductors', 'lower-back']));
  return { ...existing, id: existing.id || randomUUID(), name,
    muscle: cleanText(body.muscle, 60) || 'Other', equipment: cleanText(body.equipment, 60) || 'Other',
    family: cleanText(body.family, 100) || name, variation: cleanText(body.variation, 100),
    loadMode: ['bodyweight', 'external'].includes(body.loadMode) ? body.loadMode : existing.loadMode || (isTrackedBodyweight(body.family || name) ? 'bodyweight' : 'external'),
    targets: Array.isArray(body.targets) ? [...new Set(body.targets.filter(t => allowed.has(t)))] : inferredTargets(name),
    builtIn: existing.builtIn || false };
}

function emptyDatabase() {
  return {
    version: 4,
    settings: {
      athleteName: 'Athlete',
      weightUnit: 'lb',
      measurementUnit: 'in',
      weekStartsOn: 'monday'
    },
    exercises: [...exerciseCatalog, ...['15°', '30°'].map(angle => ({ ...exerciseCatalog.find(e => e.name === 'Incline Bench Press'), id: randomUUID(), name: `Incline Bench Press (${angle})`, family: 'Incline Bench Press', variation: angle, builtIn: false }))],
    deletedExercises: [],
    workouts: [],
    measurements: [],
    goals: [],
    recommendationRevision: 0,
    recommendations: null
  };
}

let writeQueue = Promise.resolve();

async function ensureDatabase() {
  await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    await fsp.access(DATA_FILE);
  } catch {
    await saveDatabase(emptyDatabase());
    return;
  }
  const raw = await fsp.readFile(DATA_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (Number(parsed?.version || 1) < 4) {
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const backup = path.join(path.dirname(DATA_FILE), `${path.basename(DATA_FILE, '.json')}.v${parsed.version || 1}-${stamp}.json`);
    await fsp.copyFile(DATA_FILE, backup, fs.constants.COPYFILE_EXCL);
    await saveDatabase(normalizeDatabase(parsed));
    console.log(`Database migrated to version 4. Backup: ${backup}`);
  }
}

async function loadDatabase() {
  await ensureDatabase();
  const raw = await fsp.readFile(DATA_FILE, 'utf8');
  return normalizeDatabase(JSON.parse(raw));
}

function saveDatabase(database) {
  const snapshot = JSON.stringify(database, null, 2);
  writeQueue = writeQueue.then(async () => {
    await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const temp = `${DATA_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(temp, snapshot, 'utf8');
    await fsp.rename(temp, DATA_FILE);
  });
  return writeQueue;
}

function updateRecommendations(recommendations) {
  writeQueue = writeQueue.then(async () => {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const latest = normalizeDatabase(JSON.parse(raw));
    latest.recommendations = recommendations;
    const snapshot = JSON.stringify(latest, null, 2);
    const temp = `${DATA_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(temp, snapshot, 'utf8');
    await fsp.rename(temp, DATA_FILE);
  });
  return writeQueue;
}

function normalizeDatabase(value) {
  const fallback = emptyDatabase();
  if (!value || typeof value !== 'object') return fallback;
  const deletedExercises = [...new Set((Array.isArray(value.deletedExercises) ? value.deletedExercises : [])
    .map(item => cleanText(item, 100)).filter(Boolean))];
  const deletedExerciseNames = new Set(deletedExercises);
  const suppliedExercises = Array.isArray(value.exercises) ? value.exercises : [];
  const byName = new Map(suppliedExercises.map(item => [item.name, item]));
  const exercises = suppliedExercises.map(item => ({
    ...item,
    targets: Array.isArray(item.targets) ? item.targets : inferredTargets(item.name),
    family: cleanText(item.family, 100) || item.name,
    variation: cleanText(item.variation, 100),
    loadMode: ['bodyweight', 'external'].includes(item.loadMode) ? item.loadMode : (isTrackedBodyweight(item.family || item.name) ? 'bodyweight' : 'external')
  }));
  for (const builtIn of exerciseCatalog) {
    if (!byName.has(builtIn.name) && !deletedExerciseNames.has(builtIn.name)) exercises.push(builtIn);
  }
  const incline = exercises.find(item => item.name === 'Incline Bench Press');
  if (incline && Number(value.version || 1) < 3) {
    incline.family = incline.name;
    for (const angle of ['15°', '30°']) {
      const name = `${incline.name} (${angle})`;
      if (!exercises.some(item => item.name === name)) exercises.push({ ...incline, id: randomUUID(), name, variation: angle, builtIn: false });
    }
  }
  const workouts = [];
  for (const workout of Array.isArray(value.workouts) ? value.workouts : []) {
    try { workouts.push(normalizeWorkout(workout, workout, exercises)); } catch (error) { console.warn(`Skipping invalid stored workout: ${error.message}`); }
  }
  return {
    version: 4,
    settings: { ...fallback.settings, ...(value.settings || {}) },
    exercises,
    deletedExercises,
    workouts,
    measurements: (Array.isArray(value.measurements) ? value.measurements : []).map(item => {
      const result = { ...item };
      if (Number(value.version || 1) < 3 && value.settings?.measurementUnit === 'cm') for (const field of LENGTH_FIELDS) if (result[field] != null) result[field] /= 2.54;
      return result;
    }),
    goals: (Array.isArray(value.goals) ? value.goals : []).map(goal => ({ ...goal, exerciseId: goal.exerciseId || exercises.find(e => e.name === goal.exerciseName)?.id || '' })),
    recommendationRevision: Number(value.recommendationRevision || 0),
    recommendations: value.recommendations && typeof value.recommendations === 'object' ? value.recommendations : null
  };
}

function json(res, status, value, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request is too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function finiteNumber(value, fallback = null) {
  if (value === '' || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function badInput(message) { return Object.assign(new Error(message), { status: 400 }); }
function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw badInput('Enter a valid date.');
}
function validateNumber(value, label, min, max = null, required = false, integer = false) {
  if (value === '' || value == null) { if (required) throw badInput(`${label} is required.`); return; }
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || (max != null && n > max) || (integer && !Number.isInteger(n))) throw badInput(`${label} is outside its valid range.`);
}

function normalizeWorkout(input, existing = {}, catalog = [], strict = false) {
  if (strict) validateDate(input.date);
  const exercises = Array.isArray(input.exercises) ? input.exercises : [];
  if (!cleanText(input.date) || !exercises.length) {
    throw Object.assign(new Error('A date and at least one exercise are required'), { status: 400 });
  }
  const normalizedExercises = exercises.map(item => {
    const definition = catalog.find(e => e.id === item.exerciseId);
    const name = cleanText(definition?.name || item.name, 100) || 'Exercise';
    const mode = (!strict && item.loadMode) || definition?.loadMode || item.loadMode || (isTrackedBodyweight(definition?.family || item.family || name) ? 'bodyweight' : 'external');
    const legacyPull = /^(pull-up|chin-up)$/i.test(name);
    const hasComponents = item.bodyweight != null || item.sets?.some(set => set.bodyweight != null);
    // Keep ambiguous historical loads unchanged until the user supplies components.
    const trackedBodyweight = mode === 'bodyweight' && (strict || hasComponents || legacyPull);
    if (strict) for (const set of item.sets || []) {
      validateNumber(set.reps, 'Reps', 1, null, true, true);
      validateNumber(trackedBodyweight ? set.addedWeight : set.weight, 'Weight', 0, null, true);
      if (trackedBodyweight) validateNumber(set.bodyweight ?? item.bodyweight, 'Bodyweight', 0.001, null, true);
    }
    const itemBodyweight = Math.max(0, finiteNumber(item.bodyweight, 0));
    const sets = (Array.isArray(item.sets) ? item.sets : []).map(set => {
      const base = {
        id: set.id || randomUUID(),
        reps: Math.max(0, Math.round(finiteNumber(set.reps, 0))),
        completed: set.completed !== false
      };
      if (!trackedBodyweight) return { ...base, weight: Math.max(0, finiteNumber(set.weight, 0)) };
      const legacyWeight = Math.max(0, finiteNumber(set.weight, itemBodyweight));
      const bodyweight = Math.max(0, finiteNumber(set.bodyweight, itemBodyweight || legacyWeight));
      const addedWeight = Math.max(0, finiteNumber(set.addedWeight, 0));
      return {
        ...base,
        bodyweight,
        addedWeight,
        weight: Math.round((bodyweight + addedWeight) * 1000) / 1000
      };
    }).filter(set => set.reps > 0);
    return {
      id: item.id || randomUUID(),
      exerciseId: cleanText(item.exerciseId, 80),
      name,
      family: cleanText(definition?.family || item.family, 100),
      variation: cleanText(definition?.variation || item.variation, 100),
      loadMode: trackedBodyweight ? 'bodyweight' : 'external',
      ...(trackedBodyweight ? { bodyweight: sets[0]?.bodyweight ?? itemBodyweight } : {}),
      sets
    };
  }).filter(item => item.sets.length);
  if (!normalizedExercises.length) {
    throw Object.assign(new Error('At least one exercise with completed reps is required'), { status: 400 });
  }
  return {
    ...existing,
    id: existing.id || randomUUID(),
    date: cleanText(input.date, 10),
    name: cleanText(input.name, 80) || 'Training session',
    duration: Math.max(0, finiteNumber(input.duration, 0)),
    notes: cleanText(input.notes, 2000),
    exercises: normalizedExercises,
    updatedAt: new Date().toISOString(),
    createdAt: existing.createdAt || new Date().toISOString()
  };
}

function normalizeMeasurement(input, existing = {}) {
  validateDate(input.date);
  if (input.inputUnit != null && !['in', 'cm'].includes(input.inputUnit)) throw badInput('Choose inches or centimeters.');
  if (!cleanText(input.date)) {
    throw Object.assign(new Error('A measurement date is required'), { status: 400 });
  }
  const fields = ['weight', 'bodyFat', 'waist', 'chest', 'neck', 'leftArm', 'rightArm', 'hips', 'leftThigh', 'rightThigh', 'restingHeartRate', 'sleep'];
  const result = {
    ...existing,
    id: existing.id || randomUUID(),
    date: cleanText(input.date, 10),
    notes: cleanText(input.notes, 1000),
    updatedAt: new Date().toISOString(),
    createdAt: existing.createdAt || new Date().toISOString()
  };
  for (const field of fields) {
    validateNumber(input[field], field, 0, field === 'bodyFat' ? 100 : field === 'sleep' ? 24 : null);
    result[field] = finiteNumber(input[field]);
  }
  if (input.inputUnit === 'cm') for (const field of LENGTH_FIELDS) if (result[field] != null) result[field] /= 2.54;
  return result;
}

function normalizeGoal(input, existing = {}) {
  validateNumber(input.target, 'Target', 0, null, true);
  validateNumber(input.start, 'Starting value', 0);
  if (input.deadline) validateDate(input.deadline);
  const title = cleanText(input.title, 120);
  const target = finiteNumber(input.target);
  if (!title || target === null) {
    throw Object.assign(new Error('A goal name and target are required'), { status: 400 });
  }
  return {
    ...existing,
    id: existing.id || randomUUID(),
    title,
    type: ['strength', 'bodyweight', 'consistency'].includes(input.type) ? input.type : 'strength',
    exerciseName: cleanText(input.exerciseName, 100),
    exerciseId: cleanText(input.exerciseId, 80),
    target,
    start: finiteNumber(input.start, 0),
    deadline: cleanText(input.deadline, 10),
    completed: Boolean(input.completed),
    createdAt: existing.createdAt || new Date().toISOString()
  };
}

function findIndexOrThrow(items, id) {
  const index = items.findIndex(item => item.id === id);
  if (index < 0) throw Object.assign(new Error('Record not found'), { status: 404 });
  return index;
}

function demoDatabase(current) {
  const db = normalizeDatabase(current);
  const today = new Date();
  const isoDaysAgo = days => {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return date.toISOString().slice(0, 10);
  };
  const find = name => db.exercises.find(item => item.name === name);
  const makeExercise = (name, sets) => {
    const exercise = find(name);
    return { exerciseId: exercise?.id || randomUUID(), name, sets: sets.map(([weight, reps]) => ({ weight, reps, completed: true })) };
  };
  db.settings.athleteName = db.settings.athleteName === 'Athlete' ? 'Alex' : db.settings.athleteName;
  db.workouts = [
    { date: isoDaysAgo(1), name: 'Upper strength', duration: 64, notes: 'Bench moved well.', exercises: [makeExercise('Bench Press', [[165,5,7],[175,5,8],[180,4,9]]), makeExercise('Barbell Row', [[145,8,7],[145,8,8],[145,7,9]]), makeExercise('Overhead Press', [[95,8,8],[95,7,9],[90,8,9]])] },
    { date: isoDaysAgo(4), name: 'Lower strength', duration: 72, notes: '', exercises: [makeExercise('Back Squat', [[225,5,7],[245,5,8],[255,3,9]]), makeExercise('Romanian Deadlift', [[185,8,7],[195,8,8],[195,7,9]]), makeExercise('Calf Raise', [[110,12,8],[110,12,8],[110,11,9]])] },
    { date: isoDaysAgo(7), name: 'Pull hypertrophy', duration: 58, notes: '', exercises: [makeExercise('Deadlift', [[275,4,7],[295,4,8],[315,2,9]]), makeExercise('Pull-up', [[0,8,7],[0,7,8],[0,6,9]]), makeExercise('Biceps Curl', [[30,10,8],[30,9,9],[25,12,9]])] },
    { date: isoDaysAgo(10), name: 'Push hypertrophy', duration: 61, notes: '', exercises: [makeExercise('Bench Press', [[155,8,7],[160,8,8],[160,7,9]]), makeExercise('Dumbbell Bench Press', [[55,10,8],[55,9,9],[50,11,9]]), makeExercise('Lateral Raise', [[15,15,8],[15,14,9],[12.5,16,9]])] },
    { date: isoDaysAgo(14), name: 'Lower volume', duration: 68, notes: '', exercises: [makeExercise('Back Squat', [[205,8,7],[215,8,8],[215,7,9]]), makeExercise('Leg Curl', [[80,12,8],[80,11,9],[70,14,9]]), makeExercise('Bulgarian Split Squat', [[40,10,8],[40,10,9],[35,12,9]])] },
    { date: isoDaysAgo(20), name: 'Full body', duration: 70, notes: '', exercises: [makeExercise('Back Squat', [[205,5,7],[225,5,8],[235,4,9]]), makeExercise('Bench Press', [[145,6,7],[160,6,8],[165,5,9]]), makeExercise('Deadlift', [[255,5,7],[275,4,8],[295,3,9]])] }
  ].map(item => normalizeWorkout(item));
  db.measurements = [
    { date: isoDaysAgo(42), weight: 181.8, bodyFat: 18.4, waist: 34.8, chest: 41.2, leftArm: 14.5, rightArm: 14.7, restingHeartRate: 62, sleep: 7.1 },
    { date: isoDaysAgo(28), weight: 180.6, bodyFat: 18.0, waist: 34.4, chest: 41.3, leftArm: 14.6, rightArm: 14.7, restingHeartRate: 60, sleep: 7.3 },
    { date: isoDaysAgo(14), weight: 179.9, bodyFat: 17.6, waist: 34.1, chest: 41.5, leftArm: 14.6, rightArm: 14.8, restingHeartRate: 59, sleep: 7.5 },
    { date: isoDaysAgo(1), weight: 179.2, bodyFat: 17.3, waist: 33.9, chest: 41.6, leftArm: 14.7, rightArm: 14.9, restingHeartRate: 58, sleep: 7.4 }
  ].map(item => normalizeMeasurement(item));
  db.goals = [
    normalizeGoal({ title: '225 lb bench press', type: 'strength', exerciseName: 'Bench Press', start: 190, target: 225, deadline: isoDaysAgo(-90) }),
    normalizeGoal({ title: 'Train 4x per week', type: 'consistency', start: 2, target: 4, deadline: isoDaysAgo(-60) }),
    normalizeGoal({ title: 'Reach 175 lb', type: 'bodyweight', start: 182, target: 175, deadline: isoDaysAgo(-120) })
  ];
  return db;
}

let recommendationStatus = { status: 'idle', error: '' };
let recommendationPromise = null;
let queuedRecommendationSource = null;

function recommendationPayload(database) {
  const cached = database.recommendations;
  const status = recommendationStatus.status === 'idle' && cached ? 'ready' : recommendationStatus.status;
  return { ...(cached || {}), status, stale: !cached || cached.analysisVersion !== 2 || cached.sourceRevision !== database.recommendationRevision, error: recommendationStatus.error || '' };
}

function applyNarratedRecommendation(payload, item) {
  if (payload?.done_reason === 'length') {
    throw new Error('Local model response was truncated; increase OLLAMA_NUM_PREDICT');
  }
  const content = cleanText(payload?.message?.content, 20000);
  if (!content) throw new Error('Local model returned an empty response');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Local model returned invalid JSON');
  }
  const rewrite = cleanText(parsed.recommendation, 700);
  if (!rewrite) throw new Error('Local model returned no recommendation');
  const duplicatesTitle = rewrite.toLowerCase() === item.title.toLowerCase();
  const recommendation = rewrite.length >= 60 && !duplicatesTitle ? rewrite : item.recommendation;
  return { ...item, aiExplanation: recommendation !== item.recommendation ? recommendation : null };
}

async function narrateRecommendations(analysis) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  const format = {
    type: 'object',
    properties: { recommendation: { type: 'string' } },
    required: ['recommendation']
  };
  try {
    const narrated = [];
    for (const [index, item] of analysis.items.entries()) {
      const facts = { title: item.title, evidence: item.evidence, draft: item.recommendation, allowedExercises: item.exercises };
      const prompt = [
        'Rewrite the draft recommendation in one sentence of no more than 35 words.',
        'Preserve its meaning. Use only the supplied evidence and allowed exercise names.',
        'Do not invent statistics, diagnoses, or extra exercises. Describe muscle-head targeting as emphasis, never isolation.',
        JSON.stringify(facts)
      ].join('\n');
      const response = await fetch(new URL('/api/chat', OLLAMA_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          stream: false,
          keep_alive: index === analysis.items.length - 1 ? 0 : '2m',
          format,
          options: { num_ctx: 1024, num_predict: OLLAMA_NUM_PREDICT, temperature: 0.1 },
          messages: [
            { role: 'system', content: 'You rewrite one verified workout recommendation. Return one concise sentence only.' },
            { role: 'user', content: prompt }
          ]
        })
      });
      if (!response.ok) throw new Error('Local model returned HTTP ' + response.status);
      narrated.push(applyNarratedRecommendation(await response.json(), item));
    }
    return narrated;
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleRecommendations(sourceWorkoutId = 'manual') {
  queuedRecommendationSource = sourceWorkoutId;
  if (recommendationPromise) return recommendationPromise;
  recommendationStatus = { status: 'running', error: '' };
  recommendationPromise = (async () => {
    while (queuedRecommendationSource) {
      const source = queuedRecommendationSource;
      queuedRecommendationSource = null;
      const database = await loadDatabase();
      const analysis = analyzeTraining(database);
      let items = analysis.items;
      let modelStatus = 'ready';
      let modelError = '';
      try {
        items = await narrateRecommendations(analysis);
      } catch (error) {
        modelStatus = 'unavailable';
        modelError = cleanText(error.name === 'AbortError' ? 'Local model timed out' : error.message, 180);
        console.warn('Recommendation model unavailable:', modelError);
      }
      const recommendations = {
        analysisVersion: 2,
        sourceRevision: database.recommendationRevision,
        targetSets: analysis.targetSets,
        coverage: analysis.coverage,
        generatedAt: new Date().toISOString(),
        sourceWorkoutId: source,
        model: OLLAMA_MODEL,
        modelStatus,
        modelError,
        windowDays: analysis.windowDays,
        workoutCount: analysis.workoutCount,
        items
      };
      await updateRecommendations(recommendations);
    }
    recommendationStatus = { status: 'ready', error: '' };
  })().catch(error => {
    console.error(error);
    recommendationStatus = { status: 'error', error: cleanText(error.message, 180) };
  }).finally(() => {
    recommendationPromise = null;
    if (queuedRecommendationSource) scheduleRecommendations(queuedRecommendationSource);
  });
  return recommendationPromise;
}
async function handleApi(req, res, pathname) {
  let db = await loadDatabase();
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/api/state') return json(res, 200, db);
  if (method === 'GET' && pathname === '/api/health') return json(res, 200, { status: 'ok' });
  if (method === 'GET' && pathname === '/api/recommendations') return json(res, 200, recommendationPayload(db));
  if (method === 'POST' && pathname === '/api/recommendations') {
    scheduleRecommendations('manual');
    return json(res, 202, recommendationPayload(db));
  }
  if (method === 'GET' && pathname === '/api/export') {
    return json(res, 200, db, { 'Content-Disposition': `attachment; filename="ironlog-backup-${new Date().toISOString().slice(0, 10)}.json"` });
  }

  const body = await readJson(req);
  let result;
  let queueRecommendation = false;

  if (method === 'POST' && pathname === '/api/workouts') {
    result = normalizeWorkout(body, {}, db.exercises, true);
    db.workouts.push(result);
    queueRecommendation = true;
  } else if (method === 'PUT' && pathname.startsWith('/api/workouts/')) {
    const index = findIndexOrThrow(db.workouts, pathname.split('/').pop());
    result = normalizeWorkout(body, db.workouts[index], db.exercises, true);
    db.workouts[index] = result;
    queueRecommendation = true;
  } else if (method === 'DELETE' && pathname.startsWith('/api/workouts/')) {
    const index = findIndexOrThrow(db.workouts, pathname.split('/').pop());
    [result] = db.workouts.splice(index, 1);
    queueRecommendation = true;
  } else if (method === 'POST' && pathname === '/api/measurements') {
    result = normalizeMeasurement({ ...body, inputUnit: body.inputUnit || db.settings.measurementUnit });
    db.measurements.push(result);
  } else if (method === 'PUT' && pathname.startsWith('/api/measurements/')) {
    const index = findIndexOrThrow(db.measurements, pathname.split('/').pop());
    result = normalizeMeasurement({ ...body, inputUnit: body.inputUnit || db.settings.measurementUnit }, db.measurements[index]);
    db.measurements[index] = result;
  } else if (method === 'DELETE' && pathname.startsWith('/api/measurements/')) {
    const index = findIndexOrThrow(db.measurements, pathname.split('/').pop());
    [result] = db.measurements.splice(index, 1);
  } else if (method === 'POST' && pathname === '/api/goals') {
    result = normalizeGoal(body);
    db.goals.push(result);
  } else if (method === 'PUT' && pathname.startsWith('/api/goals/')) {
    const index = findIndexOrThrow(db.goals, pathname.split('/').pop());
    result = normalizeGoal(body, db.goals[index]);
    db.goals[index] = result;
  } else if (method === 'DELETE' && pathname.startsWith('/api/goals/')) {
    const index = findIndexOrThrow(db.goals, pathname.split('/').pop());
    [result] = db.goals.splice(index, 1);
  } else if (method === 'POST' && pathname === '/api/exercises') {
    const name = cleanText(body.name, 100);
    if (!name) throw Object.assign(new Error('Exercise name is required'), { status: 400 });
    const parent = db.exercises.find(e => (e.family || e.name) === body.family);
    result = normalizeExercise({ ...body, loadMode: body.loadMode || parent?.loadMode });
    if (!result.targets.length) result.targets = db.exercises.find(e => (e.family || e.name) === result.family && e.targets?.length)?.targets || inferredTargets(result.name);
    queueRecommendation = true;
    db.exercises.push(result);
  } else if (method === 'PUT' && pathname.startsWith('/api/exercises/')) {
    const index = findIndexOrThrow(db.exercises, pathname.split('/').pop());
    result = normalizeExercise(body, db.exercises[index]);
    const oldName = db.exercises[index].name;
    db.exercises[index] = result;
    for (const workout of db.workouts) for (const entry of workout.exercises) if (entry.exerciseId === result.id) {
      entry.name = result.name; entry.family = result.family; entry.variation = result.variation;
    }
    for (const goal of db.goals) if (goal.exerciseId === result.id || (!goal.exerciseId && goal.exerciseName === oldName)) { goal.exerciseId = result.id; goal.exerciseName = result.name; }
    queueRecommendation = true;
  } else if (method === 'DELETE' && pathname.startsWith('/api/exercises/')) {
    queueRecommendation = true;
    const index = findIndexOrThrow(db.exercises, pathname.split('/').pop());
    [result] = db.exercises.splice(index, 1);
    if (result.builtIn && !db.deletedExercises.includes(result.name)) db.deletedExercises.push(result.name);
  } else if (method === 'PUT' && pathname === '/api/settings') {
    queueRecommendation = true;
    const nextWeightUnit = body.weightUnit === 'kg' ? 'kg' : 'lb';
    const nextMeasurementUnit = body.measurementUnit === 'cm' ? 'cm' : 'in';
    if (nextWeightUnit !== db.settings.weightUnit) {
      const factor = nextWeightUnit === 'kg' ? 0.45359237 : 2.20462262;
      const convert = value => value == null ? value : Math.round(value * factor * 1000) / 1000;
      db.workouts.forEach(workout => workout.exercises.forEach(exercise => {
        if (exercise.bodyweight != null) exercise.bodyweight = convert(exercise.bodyweight);
        exercise.sets.forEach(set => {
        if (set.bodyweight != null) set.bodyweight = convert(set.bodyweight);
        if (set.addedWeight != null) set.addedWeight = convert(set.addedWeight);
        set.weight = set.bodyweight != null ? Math.round((set.bodyweight + (set.addedWeight || 0)) * 1000) / 1000 : convert(set.weight);
        });
      }));
      db.measurements.forEach(measurement => { measurement.weight = convert(measurement.weight); });
      db.goals.filter(goal => goal.type === 'strength' || goal.type === 'bodyweight').forEach(goal => {
        goal.start = convert(goal.start);
        goal.target = convert(goal.target);
      });
    }
    db.settings = {
      athleteName: cleanText(body.athleteName, 80) || 'Athlete',
      weightUnit: nextWeightUnit,
      measurementUnit: nextMeasurementUnit,
      weekStartsOn: body.weekStartsOn === 'sunday' ? 'sunday' : 'monday'
    };
    result = db.settings;
  } else if (method === 'POST' && pathname === '/api/import') {
    db = normalizeDatabase(body);
    queueRecommendation = true;
    result = db;
  } else if (method === 'POST' && pathname === '/api/demo') {
    db = demoDatabase(db);
    queueRecommendation = true;
    result = db;
  } else if (method === 'POST' && pathname === '/api/reset') {
    db = emptyDatabase();
    queueRecommendation = true;
    result = db;
  } else {
    return json(res, 404, { error: 'Not found' });
  }

  if (queueRecommendation) db.recommendationRevision += 1;
  await saveDatabase(db);
  json(res, 200, result);
  if (queueRecommendation) scheduleRecommendations(result.id || 'data-change');
  return undefined;
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return json(res, 403, { error: 'Forbidden' });
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('Not a file');
    res.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    if (!path.extname(pathname)) return serveStatic(req, res, '/index.html');
    json(res, 404, { error: 'Not found' });
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url.pathname);
      else await serveStatic(req, res, url.pathname);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) json(res, error.status || 500, { error: error.message || 'Internal server error' });
    }
  });
}

if (require.main === module) {
  ensureDatabase().then(() => {
    createServer().listen(PORT, HOST, () => {
      console.log(`IronLog is running at http://${HOST}:${PORT}`);
      console.log(`Data file: ${DATA_FILE}`);
    });
  }).catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createServer, emptyDatabase, normalizeDatabase, normalizeWorkout, normalizeMeasurement, normalizeGoal, normalizeExercise, recommendationPayload, applyNarratedRecommendation };
