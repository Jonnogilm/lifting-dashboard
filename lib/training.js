const TRACKED_BODYWEIGHT = new Set(['pull-up', 'chin-up']);

const TARGETS = {
  'Back Squat': ['quads', 'glutes'],
  'Front Squat': ['quads', 'glutes'],
  'Bench Press': ['chest-mid', 'triceps-lateral'],
  'Incline Bench Press': ['chest-upper', 'triceps-lateral'],
  Deadlift: ['posterior-chain', 'back-upper'],
  'Romanian Deadlift': ['hamstrings', 'glutes'],
  'Overhead Press': ['shoulders-front', 'triceps-lateral'],
  'Barbell Row': ['back-upper', 'lats'],
  'Pull-up': ['lats', 'biceps'],
  'Chin-up': ['lats', 'biceps'],
  'Lat Pulldown': ['lats', 'biceps'],
  'Seated Cable Row': ['back-upper', 'lats'],
  'Dumbbell Bench Press': ['chest-mid', 'triceps-lateral'],
  'Dumbbell Row': ['lats', 'back-upper'],
  'Lateral Raise': ['shoulders-side'],
  'Face Pull': ['shoulders-rear', 'back-upper'],
  'Leg Press': ['quads', 'glutes'],
  'Leg Extension': ['quads'],
  'Leg Curl': ['hamstrings'],
  'Bulgarian Split Squat': ['quads', 'glutes'],
  'Hip Thrust': ['glutes'],
  'Calf Raise': ['calves'],
  'Biceps Curl': ['biceps'],
  'Triceps Pushdown': ['triceps-lateral', 'triceps-medial'],
  Dip: ['chest-mid', 'triceps-lateral'],
  Plank: ['core'],
  'Overhead Triceps Extension': ['triceps-long'],
  'Reverse-Grip Triceps Pushdown': ['triceps-medial'],
  'Skull Crusher': ['triceps-long', 'triceps-lateral']
};

const ALTERNATIVES = {
  'chest-upper': ['Incline Bench Press'],
  'chest-mid': ['Bench Press', 'Dumbbell Bench Press'],
  'shoulders-side': ['Lateral Raise'],
  'shoulders-rear': ['Face Pull'],
  lats: ['Pull-up', 'Chin-up', 'Lat Pulldown', 'Dumbbell Row'],
  'back-upper': ['Barbell Row', 'Seated Cable Row', 'Face Pull'],
  quads: ['Front Squat', 'Leg Press', 'Leg Extension', 'Bulgarian Split Squat'],
  hamstrings: ['Romanian Deadlift', 'Leg Curl'],
  glutes: ['Hip Thrust', 'Bulgarian Split Squat'],
  biceps: ['Biceps Curl', 'Chin-up'],
  'triceps-long': ['Overhead Triceps Extension', 'Skull Crusher'],
  'triceps-lateral': ['Triceps Pushdown', 'Dip', 'Skull Crusher'],
  'triceps-medial': ['Reverse-Grip Triceps Pushdown', 'Triceps Pushdown'],
  calves: ['Calf Raise'],
  core: ['Plank']
};

const BALANCE_GROUPS = [
  ['chest-upper', 'chest-mid'],
  ['shoulders-front', 'shoulders-side', 'shoulders-rear'],
  ['lats', 'back-upper'],
  ['quads', 'hamstrings', 'glutes'],
  ['triceps-long', 'triceps-lateral', 'triceps-medial']
];

function isTrackedBodyweight(name) {
  return TRACKED_BODYWEIGHT.has(String(name || '').trim().toLowerCase());
}

function estimateOneRepMax(weight, reps) {
  const load = Number(weight || 0);
  return load > 0 ? load * (1 + Number(reps || 0) / 30) : 0;
}

function latestCheckInWeight(measurements, date) {
  return [...(measurements || [])]
    .filter(item => item.weight != null && (!date || item.date <= date))
    .sort((a, b) => b.date.localeCompare(a.date))[0]?.weight ?? null;
}

function latestExerciseSet(workouts, exerciseId, name, beforeDate) {
  const sessions = [...(workouts || [])]
    .filter(workout => !beforeDate || workout.date <= beforeDate)
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  for (const workout of sessions) {
    const exercise = workout.exercises.find(item =>
      (exerciseId && item.exerciseId === exerciseId) || item.name.toLowerCase() === String(name || '').toLowerCase());
    const set = exercise?.sets?.filter(item => item.completed !== false && Number(item.reps) > 0).at(-1);
    if (set) return { ...set, bodyweight: set.bodyweight ?? exercise.bodyweight ?? null, workoutDate: workout.date };
  }
  return null;
}

function targetsFor(exercise, catalog = []) {
  const fromCatalog = catalog.find(item => item.id === exercise.exerciseId || item.name === exercise.name)?.targets;
  if (Array.isArray(fromCatalog) && fromCatalog.length) return fromCatalog;
  return TARGETS[exercise.name] || [];
}

function analyzeTraining(database, now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 56);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const workouts = [...database.workouts].filter(item => item.date >= cutoffIso).sort((a, b) => a.date.localeCompare(b.date));
  const targetSets = new Map();
  const repBands = { low: 0, moderate: 0, high: 0 };
  const exerciseHistory = new Map();

  for (const workout of workouts) {
    for (const exercise of workout.exercises) {
      const completed = exercise.sets.filter(set => set.completed !== false && Number(set.reps) > 0);
      for (const set of completed) {
        if (set.reps <= 5) repBands.low += 1;
        else if (set.reps <= 12) repBands.moderate += 1;
        else repBands.high += 1;
      }
      for (const target of targetsFor(exercise, database.exercises)) {
        targetSets.set(target, (targetSets.get(target) || 0) + completed.length);
      }
      if (!exerciseHistory.has(exercise.name)) exerciseHistory.set(exercise.name, []);
      exerciseHistory.get(exercise.name).push({
        date: workout.date,
        best: Math.max(0, ...completed.map(set => estimateOneRepMax(set.weight, set.reps))),
        load: Math.max(0, ...completed.map(set => Number(set.weight || 0))),
        reps: Math.max(0, ...completed.map(set => Number(set.reps || 0)))
      });
    }
  }

  const items = [];
  for (const [name, history] of exerciseHistory) {
    if (history.length < 3) continue;
    const recent = history.slice(-3);
    const latest = recent.at(-1);
    const priorBest = Math.max(...recent.slice(0, -1).map(item => item.best));
    if (latest.best > priorBest * 1.03 && latest.reps >= 8) {
      items.push({
        id: `progress-${items.length}`,
        type: 'progression',
        title: `Consider a small ${name} increase`,
        evidence: `${name} performance improved across the latest three sessions, with ${latest.reps} reps in the newest session.`,
        recommendation: `Try the smallest available weight increase while keeping the set in a productive hypertrophy rep range.`,
        exercises: [name]
      });
    } else if (latest.best <= priorBest * 0.99) {
      items.push({
        id: `plateau-${items.length}`,
        type: 'progression',
        title: `Vary the next ${name} session`,
        evidence: `${name} estimated strength has not increased across the latest three logged sessions.`,
        recommendation: `Keep the load manageable and change the rep target before adding more weight.`,
        exercises: [name]
      });
    }
    if (items.filter(item => item.type === 'progression').length >= 2) break;
  }

  const totalRepSets = repBands.low + repBands.moderate + repBands.high;
  if (totalRepSets >= 8) {
    const dominant = Object.entries(repBands).sort((a, b) => b[1] - a[1])[0];
    if (dominant[1] / totalRepSets >= 0.7) {
      const labels = { low: '1–5', moderate: '6–12', high: '13+' };
      const suggestion = dominant[0] === 'moderate' ? 'include some heavier 4–6 rep and lighter 12–20 rep work' : 'include more work in the 6–12 rep range';
      items.push({
        id: 'rep-range', type: 'rep-range', title: 'Use a wider mix of rep ranges',
        evidence: `${dominant[1]} of ${totalRepSets} recent sets were in the ${labels[dominant[0]]}-rep band.`,
        recommendation: `For balanced hypertrophy, ${suggestion} instead of keeping nearly every set in one band.`, exercises: []
      });
    }
  }

  for (const group of BALANCE_GROUPS) {
    const ranked = group.map(target => [target, targetSets.get(target) || 0]).sort((a, b) => a[1] - b[1]);
    const [weakTarget, weakSets] = ranked[0];
    const [, strongSets] = ranked.at(-1);
    if (strongSets >= 6 && strongSets >= weakSets + 4 && weakSets / strongSets < 0.55) {
      const suggestions = (ALTERNATIVES[weakTarget] || []).filter(name => database.exercises.some(item => item.name === name)).slice(0, 3);
      const label = weakTarget.replaceAll('-', ' ');
      items.push({
        id: `balance-${weakTarget}`, type: 'balance', title: `Add more ${label} emphasis`,
        evidence: `Recent direct-set emphasis was ${weakSets} for ${label} versus ${strongSets} for the most-trained related region.`,
        recommendation: suggestions.length ? `Consider rotating in ${suggestions.join(' or ')}. Muscle-head targeting is an emphasis, not isolation.` : `Add a movement that emphasizes ${label} while keeping total session size reasonable.`,
        exercises: suggestions
      });
    }
  }

  if (workouts.length >= 3) {
    const exerciseCounts = workouts.map(workout => workout.exercises.length).sort((a, b) => a - b);
    const median = exerciseCounts[Math.floor(exerciseCounts.length / 2)];
    const latestCount = workouts.at(-1).exercises.length;
    if (latestCount >= median + 3) {
      items.push({ id: 'session-size', type: 'volume', title: 'Keep the session focused', evidence: `The latest workout used ${latestCount} exercises versus a recent median of ${median}.`, recommendation: 'Consider removing the least-specific movement or moving it to another day so quality stays high.', exercises: [] });
    } else if (latestCount + 2 <= median) {
      items.push({ id: 'session-size', type: 'volume', title: 'Check whether the session was complete', evidence: `The latest workout used ${latestCount} exercises versus a recent median of ${median}.`, recommendation: 'If this was not an intentional short session, add one movement for an underrepresented region.', exercises: [] });
    }
  }

  if (!items.length) {
    items.push({
      id: 'baseline', type: 'consistency', title: workouts.length ? 'Keep building the trend' : 'Log a few workouts first',
      evidence: workouts.length ? `${workouts.length} workouts are available in the eight-week analysis window.` : 'There is not enough recent training data to compare patterns yet.',
      recommendation: workouts.length ? 'No strong imbalance or plateau signal is present. Keep logging consistently and refresh after the next workout.' : 'Log at least three workouts so progression and balance feedback can be evidence-based.', exercises: []
    });
  }

  return {
    windowDays: 56,
    workoutCount: workouts.length,
    repBands,
    targetSets: Object.fromEntries(targetSets),
    items: items.slice(0, 6)
  };
}

module.exports = {
  ALTERNATIVES,
  TARGETS,
  analyzeTraining,
  estimateOneRepMax,
  isTrackedBodyweight,
  latestCheckInWeight,
  latestExerciseSet
};
