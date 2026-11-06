const TRACKED_BODYWEIGHT = new Set(['pull-up', 'chin-up', 'dip', 'dips']);

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
  return TRACKED_BODYWEIGHT.has(String(name || '').split(' (')[0].trim().toLowerCase());
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
  const fromCatalog = (catalog.find(item => item.id === exercise.exerciseId) || (!exercise.exerciseId ? catalog.find(item => item.name === exercise.name) : null))?.targets;
  if (Array.isArray(fromCatalog)) return fromCatalog;
  return TARGETS[exercise.name] || [];
}

function analyzeTraining(database, now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 56);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const workouts = [...database.workouts].filter(item => item.date >= cutoffIso && item.date <= now.toISOString().slice(0, 10)).sort((a, b) => a.date.localeCompare(b.date));
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
      const key = exercise.exerciseId || `name:${exercise.name}`;
      if (!exerciseHistory.has(key)) exerciseHistory.set(key, { name: exercise.name, sessions: new Map() });
      const entry = exerciseHistory.get(key);
      const sessionKey = workout.id || workout;
      if (!entry.sessions.has(sessionKey)) entry.sessions.set(sessionKey, { date: workout.date, sets: [] });
      entry.sessions.get(sessionKey).sets.push(...completed.filter(set => Number(set.weight) > 0));
    }
  }

  const items = [];
  for (const [key, { name, sessions }] of exerciseHistory) {
    const history = [...sessions.values()].filter(session => session.sets.length);
    if (history.length < 3) continue;
    const recent = history.slice(-3);
    // Compare actual sets within two reps, rather than combining maxima from different sets.
    const candidate = [...recent.at(-1).sets].filter(set => set.reps <= 12)
      .sort((a, b) => estimateOneRepMax(b.weight, b.reps) - estimateOneRepMax(a.weight, a.reps))[0];
    if (!candidate) continue;
    const comparison = recent.map(session => {
      const set = session.sets.filter(s => s.reps <= 12 && Math.abs(s.reps - candidate.reps) <= 2)
        .sort((a, b) => estimateOneRepMax(b.weight, b.reps) - estimateOneRepMax(a.weight, a.reps))[0];
      return set ? { date: session.date, weight: set.weight, reps: set.reps, estimated: estimateOneRepMax(set.weight, set.reps) } : null;
    });
    if (comparison.some(item => !item)) continue;
    const latest = comparison.at(-1);
    const priorBest = Math.max(...comparison.slice(0, -1).map(item => item.estimated));
    const base = { date: latest.date, type: 'progression', exercises: [name], exerciseId: key, comparison };
    if (latest.estimated > priorBest * 1.03 && latest.reps >= 8) {
      items.push({ ...base, score: latest.estimated / priorBest, id: `progress-${key}`,
        title: `Consider a small ${name} increase`,
        evidence: `The latest comparable set exceeds both previous sessions' estimated strength by more than 3%.`,
        recommendation: 'If technique and effort were consistent, try the smallest available load increase next time.' });
    } else if (latest.estimated <= priorBest * 0.99) {
      items.push({ ...base, score: priorBest / latest.estimated, id: `review-${key}`,
        title: `Review the latest ${name} session`,
        evidence: 'The latest comparable set is below the best of the previous two sessions. This alone does not establish a plateau.',
        recommendation: 'Check recovery, technique, and session intent before changing the load or rep target.' });
    }
  }
  items.sort((a, b) => b.date.localeCompare(a.date) || b.score - a.score);
  items.splice(2);
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
      const suggestions = [...new Set(database.exercises.filter(item => targetsFor({ exerciseId: item.id, name: item.name }, database.exercises).includes(weakTarget)).map(item => item.family || item.name))].slice(0, 3);
      const label = weakTarget.replaceAll('-', ' ');
      items.push({
        id: `balance-${weakTarget}`, type: 'balance', title: `Review logged ${label} emphasis`,
        evidence: `Logged set emphasis was ${weakSets} for ${label} versus ${strongSets} for the most-trained related region.`,
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
    coverage: { exercises: exerciseHistory.size, unmapped: [...new Set(workouts.flatMap(w => w.exercises.filter(e => !targetsFor(e, database.exercises).length).map(e => e.name)))] },
    targetSets: Object.fromEntries(targetSets),
    items: items.slice(0, 6)
  };
}

module.exports = {
  ALTERNATIVES,
  TARGETS,
  targetsFor,
  analyzeTraining,
  estimateOneRepMax,
  isTrackedBodyweight,
  latestCheckInWeight,
  latestExerciseSet
};
