const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { normalizeExercise, normalizeWorkout, normalizeDatabase, normalizeMeasurement, recommendationPayload } = require('../server');
const { analyzeTraining } = require('../lib/training');

function client() {
  const context = vm.createContext({ document: { querySelector: () => ({}) }, location: { hash: '' }, structuredClone });
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf("document.addEventListener('click'")), context);
  vm.runInContext("state={settings:{weightUnit:'lb',measurementUnit:'in',weekStartsOn:'monday'},exercises:[],workouts:[],measurements:[],goals:[]};",context);
  return code => vm.runInContext(code,context);
}

test('lower-back targets persist through exercise normalization and backup import', () => {
  const exercise = normalizeExercise({ name:'Back Extension', targets:['lower-back','lower-back','unknown'] });
  assert.deepEqual(exercise.targets,['lower-back']);
  const db = normalizeDatabase({ version:4, exercises:[exercise] });
  assert.deepEqual(normalizeDatabase(db).exercises.find(e=>e.id===exercise.id).targets,['lower-back']);
});

test('bodyweight mode follows metadata and preserves ambiguous historical variation loads', () => {
  const exercise = normalizeExercise({ name:'Wide grip', family:'Pull-up', loadMode:'bodyweight' });
  const input = {date:'2026-11-01',exercises:[{exerciseId:exercise.id,name:exercise.name,sets:[{weight:25,reps:8}]}]};
  assert.equal(normalizeWorkout(input,{},[exercise]).exercises[0].sets[0].weight,25);
  assert.throws(()=>normalizeWorkout(input,{},[exercise],true), /required/);
  input.exercises[0].bodyweight=160;input.exercises[0].sets[0].addedWeight=25;
  const result=normalizeWorkout(input,{},[exercise],true);
  assert.equal(result.exercises[0].loadMode,'bodyweight');
  assert.equal(result.exercises[0].sets[0].weight,185);
});

test('measurement API validation rejects impossible dates and invalid numeric ranges', () => {
  assert.throws(()=>normalizeMeasurement({date:'2026-02-30',weight:160}), /valid date/);
  assert.throws(()=>normalizeMeasurement({date:'2026-11-01',bodyFat:101}), /valid range/);
  assert.throws(()=>normalizeMeasurement({date:'2026-11-01',sleep:-1}), /valid range/);
  assert.throws(()=>normalizeMeasurement({date:'2026-11-01',weight:'abc'}), /valid range/);
});

test('recommendations never combine load from one set with reps from another', () => {
  const workouts=[1,2,3].map(day=>({id:String(day),date:`2026-11-0${day}`,exercises:[{name:'Bench',exerciseId:'bench',sets:day===3?[{weight:120,reps:1},{weight:5,reps:20}]:[{weight:100,reps:1}]}]}));
  const result=analyzeTraining({workouts,exercises:[]},new Date('2026-11-06'));
  assert.ok(!result.items.some(item=>item.id.startsWith('progress-')));
  workouts[2].exercises[0].sets=[{weight:120,reps:10}];
  assert.ok(!analyzeTraining({workouts,exercises:[]},new Date('2026-11-06')).items.some(item=>item.type==='progression'), 'incomparable rep ranges do not establish progression');
});

test('repeated entries in one workout do not count as three sessions', () => {
  const exercise={exerciseId:'a',name:'A',sets:[{weight:100,reps:10}]};
  const result=analyzeTraining({exercises:[],workouts:[{id:'one',date:'2026-11-01',exercises:[exercise,exercise,exercise]}]},new Date('2026-11-06'));
  assert.ok(!result.items.some(item=>item.type==='progression'));
});

test('dated evidence uses the exact comparable sets and grouped alternatives', () => {
  const exercises=[{id:'a',name:'A',targets:['chest-mid']},{id:'b15',name:'B (15)',family:'B',targets:['chest-upper']},{id:'b30',name:'B (30)',family:'B',targets:['chest-upper']}];
  const workouts=[1,2,3].map(day=>({id:String(day),date:`2026-11-0${day}`,exercises:[{exerciseId:'a',name:'A',sets:[{weight:day===3?120:100,reps:10},{weight:10,reps:20}]}]}));
  const result=analyzeTraining({exercises,workouts},new Date('2026-11-06'));
  const progression=result.items.find(item=>item.type==='progression');
  assert.deepEqual(progression.comparison.map(s=>s.weight),[100,100,120]);
  assert.ok(progression.comparison.every(s=>s.reps===10));
  assert.deepEqual(result.items.find(item=>item.id==='balance-chest-upper').exercises,['B']);
});

test('recommendation revision and analysis version expose stale results', () => {
  const db={recommendationRevision:2,recommendations:{analysisVersion:2,sourceRevision:2}};
  assert.equal(recommendationPayload(db).stale,false);
  db.recommendationRevision=3;
  assert.equal(recommendationPayload(db).stale,true);
});

test('per-metric latest values and goals skip blank check-ins', () => {
  const run=client();
  run("state.measurements=[{date:'2026-10-01',weight:160,waist:30},{date:'2026-10-02',weight:null,waist:31},{date:'2026-10-03',weight:162,sleep:8}]");
  assert.equal(run("latestMeasurement('weight').weight-previousMeasurement('weight').weight"),2);
  assert.equal(run("latestMeasurement('waist').waist"),31);
  assert.equal(run("getGoalCurrent({type:'bodyweight',start:150})"),162);
  assert.equal(run('estimateOneRepMax(0,10)'),0);
});

test('backdated workouts get suggestions strictly before their selected date', () => {
  const run=client();
  run("ui.workoutDraft={id:'editing',date:'2026-10-03'};state.workouts=[{id:'old',date:'2026-10-01',exercises:[{exerciseId:'a',name:'A',sets:[{weight:100,reps:8}]}]},{id:'future',date:'2026-10-04',exercises:[{exerciseId:'a',name:'A',sets:[{weight:200,reps:8}]}]}]");
  assert.equal(run("latestSetForExercise({id:'a',name:'A'}).weight"),100);
});

test('reusing a bodyweight workout refreshes weight while retaining added load', () => {
  const run=client();
  run("state.exercises=[{id:'dip',name:'Dip',loadMode:'bodyweight'}];state.measurements=[{date:'2026-10-01',weight:165}];ui.workoutDraft={date:'2026-10-02'};function openWorkoutModal(workout,draft){ui.workoutDraft=draft;}");
  run("applyWorkoutTemplate({name:'Push',exercises:[{exerciseId:'dip',name:'Dip',bodyweight:150,sets:[{bodyweight:150,addedWeight:10,weight:160,reps:8}]}]})");
  assert.equal(run('ui.workoutDraft.exercises[0].sets[0].bodyweight'),165);
  assert.equal(run('ui.workoutDraft.exercises[0].sets[0].weight'),175);
  assert.equal(run('ui.workoutDraft.date'),'2026-10-02');
});

test('charts position points by elapsed date and display a single observation', () => {
  const run=client();
  const html=run("lineChart([{date:'2026-10-01',value:10},{date:'2026-10-02',value:11},{date:'2026-10-11',value:12}],' lb')");
  const xs=[...html.matchAll(/class="chart-point" cx="([\d.]+)"/g)].map(m=>Number(m[1]));
  assert.ok(Math.abs((xs[2]-xs[1])/(xs[1]-xs[0])-9)<1e-8);
  assert.match(run("lineChart([{date:'2026-10-01',value:10}],' lb')"),/data-chart-point/);
  assert.match(html,/View data/);
});

test('library defaults to most recent variant and lower-back checkbox has readable label', () => {
  const run=client();
  run("state.workouts=[{date:'2026-10-01',exercises:[{exerciseId:'30'}]}]");
  assert.equal(run("librarySelection('Incline',[{id:'15'},{id:'30'}]).id"),'30');
  assert.match(run("targetCheckboxes(['lower-back'])"),/value="lower-back" checked>Lower back/);
});

test('new entry dates use the local calendar day rather than UTC', () => {
  const original=process.env.TZ;
  try {
    process.env.TZ='America/New_York';
    const run=client();
    assert.equal(run("localIso(new Date('2026-11-06T01:00:00Z'))"),'2026-11-05');
    assert.equal(run("localIso(new Date('2026-11-06T06:00:00Z'))"),'2026-11-06');
  } finally { if (original == null) delete process.env.TZ; else process.env.TZ=original; }
});

test('weekly counts honor configured calendar boundaries and exclude future entries', () => {
  const run=client();
  run("const start=weeksData(1)[0].start; const prior=new Date(start);prior.setDate(prior.getDate()-1);const next=new Date();next.setDate(next.getDate()+8);state.workouts=[{date:localIso(start),exercises:[]},{date:localIso(prior),exercises:[]},{date:localIso(next),exercises:[]}];");
  assert.equal(run('weeksData(1)[0].sessions'),1);
  assert.equal(run('weeksData(1)[0].start.getDay()'),1);
  run("state.settings.weekStartsOn='sunday'");
  assert.equal(run('weeksData(1)[0].start.getDay()'),0);
});

test('a resumed draft converts recorded load units without modifying its saved source', () => {
  const run=client();
  run("state.settings.weightUnit='kg'; const raw=JSON.stringify({version:2,draft:{date:'2026-10-01',weightUnit:'lb',exercises:[{bodyweight:160,sets:[{bodyweight:160,addedWeight:10,weight:170,reps:8}]}]}}); globalThis.localStorage={getItem:()=>raw,removeItem:()=>{}};");
  assert.ok(Math.abs(run('loadWorkoutDraft().exercises[0].sets[0].weight')-77.111)<.001);
  assert.ok(Math.abs(run('loadWorkoutDraft().exercises[0].sets[0].weight')-77.111)<.001);
  assert.equal(run("JSON.parse(localStorage.getItem()).draft.exercises[0].sets[0].weight"),170);
});

test('strength goals follow stable variation IDs after a rename', () => {
  const run=client();
  run("state.exercises=[{id:'a',name:'Renamed',family:'Bench',variation:'15°'}];state.workouts=[{date:'2026-10-01',id:'w',exercises:[{exerciseId:'a',name:'Old name',sets:[{weight:100,reps:6}]}]}]");
  assert.equal(run("getGoalCurrent({type:'strength',exerciseId:'a',exerciseName:'Old name'})"),120);
});
