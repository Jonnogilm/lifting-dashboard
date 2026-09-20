const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

process.env.DATA_FILE = path.join(os.tmpdir(), `ironlog-test-${process.pid}.json`);
process.env.OLLAMA_URL = 'http://127.0.0.1:1';
const { createServer, normalizeDatabase, normalizeWorkout, applyNarratedRecommendation } = require('../server');

let server;
let baseUrl;

test.before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(process.env.DATA_FILE, { force: true });
});

test('serves the application and creates an empty database', async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /IRONLOG/);

  const state = await fetch(`${baseUrl}/api/state`).then(response => response.json());
  assert.equal(state.version, 2);
  assert.ok(state.exercises.length > 20);
  assert.deepEqual(state.workouts, []);
});

test('deletes custom and built-in exercises permanently', async () => {
  const custom = await fetch(`${baseUrl}/api/exercises`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Test Movement', muscle: 'Other', equipment: 'Other' })
  }).then(response => response.json());
  const beforeDelete = await fetch(`${baseUrl}/api/state`).then(response => response.json());
  const builtIn = beforeDelete.exercises.find(item => item.builtIn);
  assert.ok(builtIn);

  for (const exercise of [custom, builtIn]) {
    const response = await fetch(`${baseUrl}/api/exercises/${exercise.id}`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(response.status, 200);
  }

  const afterDelete = await fetch(`${baseUrl}/api/state`).then(response => response.json());
  assert.equal(afterDelete.exercises.some(item => item.id === custom.id), false);
  assert.equal(afterDelete.exercises.some(item => item.name === builtIn.name), false);
  assert.ok(afterDelete.deletedExercises.includes(builtIn.name));
});

test('creates, updates, and deletes a workout', async () => {
  const payload = {
    date: '2026-07-19',
    name: 'Test session',
    duration: 45,
    exercises: [{ name: 'Bench Press', exerciseId: 'bench', sets: [{ weight: 185, reps: 5 }] }]
  };
  const createdResponse = await fetch(`${baseUrl}/api/workouts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.exercises[0].sets[0].reps, 5);
  assert.equal('rpe' in created.exercises[0].sets[0], false);

  const updated = await fetch(`${baseUrl}/api/workouts/${created.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, name: 'Updated session' })
  }).then(response => response.json());
  assert.equal(updated.name, 'Updated session');

  const deletedResponse = await fetch(`${baseUrl}/api/workouts/${created.id}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(deletedResponse.status, 200);
  const currentState = await fetch(`${baseUrl}/api/state`).then(response => response.json());
  assert.equal(currentState.workouts.length, 0);
});

test('rejects workouts without exercises', () => {
  assert.throws(() => normalizeWorkout({ date: '2026-07-19', exercises: [] }), /at least one exercise/);
  assert.throws(() => normalizeWorkout({ date: '2026-07-19', exercises: [{ name: 'Bench Press', sets: [] }] }), /completed reps/);
});

test('migrates RPE and bodyweight exercise loads to schema version 2', () => {
  const migrated = normalizeDatabase({
    version: 1,
    settings: { weightUnit: 'lb' },
    exercises: [],
    workouts: [{
      id: 'old-workout',
      date: '2026-07-20',
      name: 'Pull',
      exercises: [{ name: 'Pull-up', exerciseId: 'pull-up', sets: [{ weight: 160, reps: 8, rpe: 9 }] }]
    }],
    measurements: [],
    goals: []
  });
  const exercise = migrated.workouts[0].exercises[0];
  assert.equal(migrated.version, 2);
  assert.equal(exercise.bodyweight, 160);
  assert.equal(exercise.sets[0].addedWeight, 0);
  assert.equal(exercise.sets[0].weight, 160);
  assert.equal('rpe' in exercise.sets[0], false);

  const weighted = normalizeWorkout({
    date: '2026-08-19',
    exercises: [{ name: 'Chin-up', sets: [{ bodyweight: 158, addedWeight: 20, weight: 999, reps: 6 }] }]
  });
  assert.equal(weighted.exercises[0].sets[0].weight, 178);
});

test('keeps blank measurements empty and converts unit changes', async () => {
  await fetch(`${baseUrl}/api/measurements`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: '2026-07-19', weight: 200, waist: '' })
  });
  await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ athleteName: 'Tester', weightUnit: 'kg', measurementUnit: 'cm', weekStartsOn: 'monday' })
  });
  const currentState = await fetch(`${baseUrl}/api/state`).then(response => response.json());
  const measurement = currentState.measurements.find(item => item.date === '2026-07-19');
  assert.equal(measurement.waist, null);
  assert.ok(Math.abs(measurement.weight - 90.718) < 0.001);
});

test('recommendation endpoint falls back cleanly when the local model is unavailable', async () => {
  const response = await fetch(`${baseUrl}/api/recommendations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(response.status, 202);
  let result = await response.json();
  for (let attempt = 0; result.status === 'running' && attempt < 100; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
    result = await fetch(`${baseUrl}/api/recommendations`).then(item => item.json());
  }
  assert.equal(result.status, 'ready');
  assert.ok(result.items.length > 0);
  assert.ok(['ready', 'unavailable'].includes(result.modelStatus));
});

test('reports truncated and malformed local model responses clearly', () => {
  const item = { id: 'balance', title: 'Add balance', recommendation: 'Original verified recommendation.' };
  assert.throws(
    () => applyNarratedRecommendation({ done_reason: 'length', message: { content: '{"recommendation":' } }, item),
    /response was truncated/
  );
  assert.throws(
    () => applyNarratedRecommendation({ done_reason: 'stop', message: { content: '{"recommendation":' } }, item),
    /invalid JSON/
  );
});

test('applies valid local model recommendation rewrites', () => {
  const item = { id: 'balance', title: 'Add balance', recommendation: 'Original verified recommendation.' };
  const rewritten = applyNarratedRecommendation({
    done_reason: 'stop',
    message: { content: JSON.stringify({ recommendation: 'Use a measured mix of movements across the week while preserving recovery and steadily progressing the loads you can complete with consistent technique.' }) }
  }, item);
  assert.match(rewritten.recommendation, /measured mix/);
});

test('loads demo data and exports a valid backup', async () => {
  const demo = await fetch(`${baseUrl}/api/demo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  }).then(response => response.json());
  assert.equal(demo.workouts.length, 6);
  assert.equal(demo.measurements.length, 4);

  const response = await fetch(`${baseUrl}/api/export`);
  assert.match(response.headers.get('content-disposition'), /ironlog-backup/);
  const backup = await response.json();
  assert.equal(backup.goals.length, 3);
});
