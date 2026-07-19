const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

process.env.DATA_FILE = path.join(os.tmpdir(), `ironlog-test-${process.pid}.json`);
const { createServer, normalizeWorkout } = require('../server');

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
  assert.equal(state.version, 1);
  assert.ok(state.exercises.length > 20);
  assert.deepEqual(state.workouts, []);
});

test('creates, updates, and deletes a workout', async () => {
  const payload = {
    date: '2026-07-19',
    name: 'Test session',
    duration: 45,
    exercises: [{ name: 'Bench Press', exerciseId: 'bench', sets: [{ weight: 185, reps: 5, rpe: 8 }] }]
  };
  const createdResponse = await fetch(`${baseUrl}/api/workouts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.exercises[0].sets[0].reps, 5);

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
