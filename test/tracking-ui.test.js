const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function tracking() {
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  const context = vm.createContext({ document: { querySelector: () => ({}) }, location: { hash: '' } });
  vm.runInContext(source.slice(0, source.indexOf("document.addEventListener('click'")), context);
  vm.runInContext(`
    function lineChart(points) { return JSON.stringify(points); }
    state = {
      settings: { weightUnit: 'lb' },
      exercises: [
        { id: 'base', name: 'Incline Bench Press', family: 'Incline Bench Press' },
        { id: '15', name: 'Incline Bench Press (15°)', family: 'Incline Bench Press', variation: '15°' },
        { id: '30', name: 'Incline Bench Press (30°)', family: 'Incline Bench Press', variation: '30°' },
        { id: '45', name: 'Incline Bench Press (45°)', family: 'Incline Bench Press', variation: '45°' },
        { id: 'row', name: 'Row' }
      ],
      workouts: [
        { date: '2026-11-01', exercises: [{ exerciseId: 'base', name: 'Incline Bench Press', sets: [{ weight: 80, reps: 6 }] }] },
        { date: '2026-11-02', exercises: [{ exerciseId: '15', name: 'Old incline name', sets: [{ weight: 100, reps: 6 }, { weight: 999, reps: 6, completed: false }] }] },
        { date: '2026-11-03', exercises: [{ exerciseId: '30', name: 'Incline Bench Press (30°)', sets: [{ weight: 50, reps: 6 }] }] }
      ]
    };
  `, context);
  return code => vm.runInContext(code, context);
}

test('primary selector contains each family once and secondary selector includes unlogged variants', () => {
  const run = tracking();
  const html = run('strengthSelectors(selectStrengthTracking())');
  const primary = html.split('id="strength-exercise">')[1].split('</select>')[0];
  assert.equal((primary.match(/<option /g) || []).length, 2);
  assert.ok(!primary.includes('15°'));
  assert.ok(html.includes('15°'));
  assert.ok(html.includes('30°'));
  assert.ok(html.includes('45°'));
  assert.ok(html.includes('Unspecified'));
});

test('graphs and personal records filter by variant ID, excluding incomplete sets', () => {
  const run = tracking();
  assert.equal(run("strengthHistory('15')[0].value"), 120);
  assert.equal(run("strengthHistory('30')[0].value"), 60);
  assert.equal(run("strengthHistory('base')[0].value"), 96);
  assert.equal(run("selectedStrengthRecord('15').weight"), 100);
  assert.equal(run("strengthHistory('45').length"), 0);
  run("ui.strengthExercise = 'Incline Bench Press'; ui.strengthVariation = '45';");
  const html = run('renderStrengthPanel(true)');
  assert.match(html, /No weighted sets logged for this variation in this period/);
  assert.ok(!html.includes('Personal record ·'));
});

test('selection is preserved across renders and family changes', () => {
  const run = tracking();
  run("ui.strengthExercise = 'Incline Bench Press'; ui.strengthVariation = '15'; selectStrengthTracking();");
  assert.match(run('renderStrengthPanel(true)'), /Estimated 1RM: 120 lb/);
  run("ui.strengthExercise = 'Row'; ui.strengthVariation = ''; selectStrengthTracking();");
  run("ui.strengthExercise = 'Incline Bench Press'; ui.strengthVariation = ''; selectStrengthTracking();");
  assert.equal(run('ui.strengthVariation'), '15');
});

test('deleted catalog entries retain their saved family and independent history', () => {
  const run = tracking();
  run("state.exercises = state.exercises.filter(e => e.id !== '30'); state.workouts[2].exercises[0].family = 'Incline Bench Press'; state.workouts[2].exercises[0].variation = '30°';");
  assert.equal(run("strengthOptions().find(e => e.key === '30').family"), 'Incline Bench Press');
  assert.equal(run("strengthHistory('30')[0].value"), 60);
});

test('quick variations inherit metadata without copying the original ID or modifying it', () => {
  const run = tracking();
  run("state.exercises[1].muscle = 'Chest'; state.exercises[1].equipment = 'Barbell'; state.exercises[1].targets = ['chest-upper'];");
  const payload = JSON.parse(run("JSON.stringify(variationPayload(state.exercises[1], '  60°  '))"));
  assert.deepEqual(payload, {
    name: 'Incline Bench Press (60°)', family: 'Incline Bench Press', variation: '60°',
    muscle: 'Chest', equipment: 'Barbell', loadMode: 'external', targets: ['chest-upper']
  });
  run("variationPayload(state.exercises[1], '60°').targets.push('biceps');");
  assert.equal(run('state.exercises[1].targets.length'), 1);
  assert.equal(run('state.exercises[1].variation'), '15°');
});

test('quick variation rejects empty, duplicate and overlong names', () => {
  const run = tracking();
  assert.throws(() => run("variationPayload(state.exercises[0], '  ')"), /Enter a variation/);
  assert.throws(() => run("variationPayload(state.exercises[0], '  15° ' )"), /already exists/);
  assert.throws(() => run("variationPayload(state.exercises[0], 'a'.repeat(100))"), /shorter variation/);
  run("state.exercises.push({ id: 'single', name: 'Row (Single arm)', family: 'Row', variation: 'Single arm' });");
  assert.throws(() => run("variationPayload(state.exercises[4], ' SINGLE   ARM ')"), /already exists/);
});

test('quick variation dialog presents one name field with inherited context and angle presets', () => {
  const run = tracking();
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  run('let dialog; function familyName(e) { return e.family || e.name; } function openModal(title, body, options) { dialog = { title, body, options }; }');
  run('openVariationModal(state.exercises[1]);');
  const body = run('dialog.body');
  assert.match(body, /For <strong>Incline Bench Press<\/strong>/);
  assert.equal((body.match(/<input /g) || []).length, 1);
  assert.match(body, /data-action="variation-preset" data-value="60°"/);
  assert.ok(!body.includes('data-value="15°"'));
  assert.match(run('dialog.options.footer'), /form="variation-form"/);
});
