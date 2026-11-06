const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDatabase, normalizeWorkout, normalizeMeasurement } = require('../server');
const { analyzeTraining, isTrackedBodyweight } = require('../lib/training');

test('dips use total load and preserve ambiguous legacy weights', () => {
  assert.equal(isTrackedBodyweight('Dips'), true);
  const workout = normalizeWorkout({ date: '2026-11-06', exercises: [
    { name: 'Dip', bodyweight: 160, sets: [{ addedWeight: 25, reps: 8 }] },
    { name: 'Dip', sets: [{ weight: 25, reps: 8 }] }
  ] });
  assert.equal(workout.exercises[0].sets[0].weight, 185);
  assert.equal(workout.exercises[1].sets[0].weight, 25);
  assert.equal(workout.exercises[1].sets[0].bodyweight, undefined);
});

test('cm conversion is exact and migration only converts once', () => {
  const measurement = normalizeMeasurement({ date: '2026-11-06', waist: 25.4, inputUnit: 'cm', chest: '', weight: 160 });
  assert.equal(measurement.waist, 10);
  assert.equal(measurement.chest, null);
  assert.equal(measurement.weight, 160);
  const db = normalizeDatabase({ version: 2, settings: { measurementUnit: 'cm' }, measurements: [{ waist: 25.4 }] });
  assert.equal(db.measurements[0].waist, 10);
  assert.equal(normalizeDatabase(db).measurements[0].waist, 10);
});

test('incline options seed once and preserve unspecified historical identity', () => {
  const db = normalizeDatabase({ version: 2, exercises: [{ id: 'incline', name: 'Incline Bench Press' }] });
  const family = db.exercises.filter(e => e.family === 'Incline Bench Press');
  assert.equal(family.length, 3);
  assert.equal(family.find(e => e.id === 'incline').variation, '');
  assert.equal(normalizeDatabase(db).exercises.length, db.exercises.length);
});

test('custom targets count and custom alternatives are recommended', () => {
  const db = { exercises: [
    { id: 'front', name: 'Custom Front', targets: ['shoulders-front'] },
    { id: 'side', name: 'Custom Side', targets: ['shoulders-side'] }
  ], workouts: [{ date: '2026-11-05', exercises: [{ exerciseId: 'front', name: 'Custom Front', sets: Array.from({ length: 8 }, () => ({ weight: 20, reps: 10 })) }] }] };
  const result = analyzeTraining(db, new Date('2026-11-06'));
  assert.equal(result.targetSets['shoulders-front'], 8);
  assert.ok(result.items.some(item => item.exercises.includes('Custom Side')));
});

test('progression selection considers later custom exercises and keeps variants separate', () => {
  const names = ['Original A', 'Original B', 'Incline 15', 'Incline 30'];
  const workouts = names.flatMap((name, i) => [1, 2, 3].map(day => ({
    date: `2026-11-0${day + (i > 1 ? 2 : 0)}`,
    exercises: [{ name, sets: [{ weight: day === 3 ? 120 : 100, reps: 10 }] }]
  })));
  const result = analyzeTraining({ exercises: [], workouts }, new Date('2026-11-06'));
  const progression = result.items.filter(i => i.type === 'progression');
  assert.equal(progression.length, 2);
  assert.ok(progression.every(i => i.exercises[0].startsWith('Incline')));
});
