// ------------------------------------------------------------------
// Service worker
// ------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.error('Service worker registration failed', err);
    });
  });

  // Auto-reload when a new SW takes control, so users see the latest version
  // without a manual second refresh.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

// ------------------------------------------------------------------
// Database
// ------------------------------------------------------------------
const db = new Dexie('FoodAndWeight');
db.version(1).stores({
  entries: '++id, type, timestamp',
});
db.version(2).stores({
  entries: '++id, &uuid, type, timestamp',
}).upgrade(async (tx) => {
  await tx.table('entries').toCollection().modify((e) => {
    if (!e.uuid) e.uuid = crypto.randomUUID();
  });
});
db.version(3).stores({
  entries: '++id, &uuid, type, timestamp',
}).upgrade(async (tx) => {
  await tx.table('entries').toCollection().modify((e) => {
    // Weight entries: AM-fasted convention. Backfill timeCategory.
    if (e.type === 'weight' && !e.timeCategory) e.timeCategory = 'Morning';
    // Pre-feature entries: raw_input unknown, fall back to canonical text/value.
    if (e.rawInput == null) e.rawInput = e.text ?? (e.value != null ? String(e.value) : '');
    // Pre-feature entries with calories were user-typed (no AI provenance recorded).
    if ((e.type === 'food' || e.type === 'workout') && e.calories != null && !e.calorieSource) {
      e.calorieSource = 'user';
    }
    // Backfill conservative effort default for historic workouts.
    if (e.type === 'workout' && !e.effort) e.effort = 'low';
  });
});

// Sheet format version this build knows how to read/write.
const SHEET_SCHEMA_VERSION = 5;

const WEIGHT_AVG_WINDOW_DAYS = 7;
const ACTIVITY_MULTIPLIER = 1.3;
const WEIGHT_STALENESS_LIMIT_DAYS = 14;

// Weekly goal — kcal/kg conversion + defaults
const KCAL_PER_KG = 7700;
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_MON_FIRST = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DEFAULT_WEEKLY_LOSS_GOAL_KG = 0.6;
const DEFAULT_WEEKEND_RATIO = 0.5;
const DEFAULT_WEEKEND_DAYS = ['Fri', 'Sat', 'Sun'];

// Map Gemini's confidence labels to compact storage values.
function mapConfidence(geminiConf) {
  switch ((geminiConf || '').toLowerCase()) {
    case 'excellent': return 'high';
    case 'moderate': return 'med';
    case 'low': return 'low';
    default: return '';
  }
}

// ------------------------------------------------------------------
// Type config — single source of truth for per-type behavior
// ------------------------------------------------------------------
const TYPES = {
  food: {
    label: 'Food',
    placeholder: 'What did you eat?',
    inputKind: 'text',
    multiline: true,
    hasTimeCategory: true,
    isCollapsible: true,
    formatDisplay: (e) => e.text,
  },
  weight: {
    label: 'Weight',
    placeholder: '0.0',
    inputKind: 'number',
    inputStep: '0.1',
    inputMin: '0',
    unit: 'kg',
    hasTimeCategory: false,
    formatDisplay: (e) => `${formatNumber(e.value)} kg`,
  },
  waist: {
    label: 'Waist',
    placeholder: '0.0',
    inputKind: 'number',
    inputStep: '0.1',
    inputMin: '0',
    unit: 'cm',
    hasTimeCategory: false,
    formatDisplay: (e) => `${formatNumber(e.value)} cm`,
  },
  workout: {
    label: 'Activity',
    placeholder: 'What did you do?',
    inputKind: 'text',
    hasTimeCategory: true,
    hasEffort: true,
    isCollapsible: true,
    formatDisplay: (e) => e.text,
  },
  skip_food: {
    label: 'Skip Day',
    inputKind: 'text',
    isCollapsible: false,
    formatDisplay: (e) => e.text,
  },
  // Virtual tab: renders weight + waist forms stacked, and lists both kinds together.
  // Entries themselves are still stored with type 'weight' or 'waist'.
  measurements: {
    label: 'Measurements',
  },
};

// ------------------------------------------------------------------
// Date / number helpers
// ------------------------------------------------------------------
const DAY_MS = 86400000;

// Within ±this many kcal of maintenance, a deficit/surplus is "small" (calmer styling).
const SMALL_DELTA_KCAL = 150;

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatFullDate(date) {
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateLabel(date) {
  const today = startOfDay(new Date());
  const target = startOfDay(date);
  const diffDays = Math.round((today - target) / DAY_MS);
  const full = formatFullDate(date);
  if (diffDays === 0) return { main: 'Today', sub: full, kind: 'today' };
  if (diffDays === 1) return { main: 'Yesterday', sub: full, kind: 'yesterday' };
  return { main: full, sub: '', kind: 'past' };
}

function formatNumber(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  return n.toFixed(1).replace(/\.0$/, '');
}

function timeStrFromMs(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function nowTimeStr() {
  return timeStrFromMs(Date.now());
}

function defaultTimeStr() {
  return isSameDay(currentDate, new Date()) ? nowTimeStr() : '12:00';
}

function combineDayAndTime(day, timeStr) {
  const d = startOfDay(day);
  const [hh, mm] = timeStr.split(':').map(Number);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

function startOfWeek(date) {
  // ISO week: Monday is day 1.
  const d = startOfDay(date);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDays(d, offset);
}

function dowLabel(dateOrStr) {
  const d = typeof dateOrStr === 'string'
    ? new Date(dateOrStr + 'T12:00:00')
    : new Date(dateOrStr);
  return DOW_SHORT[d.getDay()];
}

const TIME_CATEGORIES = ['Breakfast', 'Morning', 'Lunch', 'Afternoon', 'Dinner', 'Evening'];

const CATEGORY_BOUNDARIES = {
  Breakfast: { start: 4, end: 10 },
  Morning: { start: 10, end: 12 },
  Lunch: { start: 12, end: 14 },
  Afternoon: { start: 14, end: 17 },
  Dinner: { start: 17, end: 21 },
  Evening: { start: 21, end: 4 },
};

function getTimeCategory(date) {
  const hour = new Date(date).getHours();
  for (const category of TIME_CATEGORIES) {
    const { start, end } = CATEGORY_BOUNDARIES[category];
    if (start <= end) {
      if (hour >= start && hour < end) return category;
    } else {
      if (hour >= start || hour < end) return category;
    }
  }
  return 'Evening';
}

// ------------------------------------------------------------------
// State + DOM refs
// ------------------------------------------------------------------
let currentDate = startOfDay(new Date());
let currentTab = 'food';
let confirmingDeleteId = null;
let retroConfirmState = null; // { id, aiResult } when retro-estimate review is open
let isFormOpen = false;
let skipMarker = null;
let longPressAttached = false;

const els = {
  main: document.querySelector('.container'),
  dateNav: document.querySelector('.date-nav'),
  dateLabel: document.getElementById('date-label'),
  dateSub: document.getElementById('date-sub'),
  prevBtn: document.getElementById('prev-day'),
  nextBtn: document.getElementById('next-day'),
  dateNavLabel: document.querySelector('.date-nav-label'),
  tabs: Array.from(document.querySelectorAll('.tab')),
  formContainer: document.getElementById('entry-form-container'),
  list: document.getElementById('entries-list'),
  empty: document.getElementById('empty-state'),
  calTotal: document.getElementById('calories-total'),
  skipOverlay: document.getElementById('skip-overlay'),
  skipReasonInput: document.getElementById('skip-reason-input'),
  skipCancelBtn: document.getElementById('skip-cancel'),
  skipConfirmBtn: document.getElementById('skip-confirm'),
};

// ------------------------------------------------------------------
// Data access
// ------------------------------------------------------------------
async function syncUnsyncedEntries() {
  if (!getSheetId()) return;
  try {
    const pending = await db.entries.filter(e => !e.synced).toArray();
    if (!pending.length) return;
    await syncEntriesToSheet(pending);
    await Promise.all(pending.map(e => db.entries.update(e.id, { synced: true })));
    console.log('[app] Historical sync complete');
  } catch (err) {
    console.warn('[app] syncUnsyncedEntries failed:', err.message);
  }
}

async function loadEntries(date, type) {
  const start = startOfDay(date).getTime();
  const end = endOfDay(date).getTime();
  return db.entries
    .where('timestamp').between(start, end, true, true)
    .and((e) => e.type === type)
    .reverse()
    .sortBy('timestamp');
}

async function loadSkipMarker(date) {
  const start = startOfDay(date).getTime();
  const end = endOfDay(date).getTime();
  const rows = await db.entries
    .where('timestamp').between(start, end, true, true)
    .and((e) => e.type === 'skip_food')
    .toArray();
  return rows[0] || null;
}

// ------------------------------------------------------------------
// Actions
// ------------------------------------------------------------------
async function handleAdd(type, formData) {
  const config = TYPES[type];
  const entry = { type, uuid: crypto.randomUUID() };

  if (config.inputKind === 'text') {
    const text = (formData.text || '').trim();
    if (!text) return false;
    entry.text = text;
    // Raw input = what the user originally typed, before AI canonicalisation.
    // If AI overwrote the input field, formData.rawInput holds the pre-AI string;
    // otherwise the typed text is itself the raw input.
    entry.rawInput = (formData.rawInput || '').trim() || text;
  } else {
    const value = parseFloat(formData.value);
    if (Number.isNaN(value) || value <= 0) return false;
    entry.value = value;
    entry.rawInput = String(value);
  }

  // Weight is AM-fasted by convention: store at noon-of-day, tag as Morning,
  // strip time-of-day noise so intra-day re-weighs can't pollute the trend.
  if (type === 'weight') {
    entry.timestamp = combineDayAndTime(currentDate, '12:00');
    entry.timeCategory = 'Morning';
  } else if (isSameDay(currentDate, new Date())) {
    entry.timestamp = Date.now();
  } else {
    entry.timestamp = combineDayAndTime(currentDate, '12:00');
  }

  if (config.hasTimeCategory && type !== 'weight') {
    entry.timeCategory = formData.timeCategory || getTimeCategory(entry.timestamp);
  }

  if ((type === 'food' || type === 'workout') && formData.calories) {
    const calories = parseFloat(formData.calories);
    if (!Number.isNaN(calories) && calories > 0) {
      entry.calories = calories;
      // Lineage: if Gemini was invoked, formData carries the AI's suggestion;
      // the source is 'gemini' even if the user revised the number afterwards.
      if (formData.aiSuggestedCalories != null) {
        entry.aiSuggestedTitle = formData.aiSuggestedTitle || '';
        entry.aiSuggestedCalories = Number(formData.aiSuggestedCalories);
        entry.calorieConfidence = mapConfidence(formData.aiConfidence);
        entry.aiReasoning = formData.aiReasoning || '';
        entry.calorieSource = 'gemini';
      } else if (formData.matchedTitle) {
        entry.aiSuggestedTitle = formData.matchedTitle;
        entry.aiSuggestedCalories = Number(formData.matchedCalories);
        entry.calorieConfidence = formData.matchedConfidence || '';
        entry.calorieSource = 'match';
      } else {
        entry.calorieSource = 'user';
      }
    }
  }

  if (config.hasEffort) {
    entry.effort = formData.effort || 'low';
  }

  const id = await db.entries.add(entry);
  if (type === 'food') rebuildFrequentFoods();
  const savedEntry = { ...entry, id };
  if (typeof syncEntriesToSheet === 'function') {
    syncEntriesToSheet([savedEntry])
      .then(() => db.entries.update(id, { synced: true }))
      .catch(() => {});
  }
  isFormOpen = false;
  await refreshList();
  return true;
}

async function confirmAndDelete(id) {
  const entry = await db.entries.get(id);
  await db.entries.delete(id);
  confirmingDeleteId = null;
  if (entry?.uuid && typeof deleteEntryFromSheet === 'function') {
    deleteEntryFromSheet(entry.uuid).catch(() => {});
  }
  await refreshList();
}

async function createSkipMarker(reason) {
  const entry = {
    type: 'skip_food',
    uuid: crypto.randomUUID(),
    text: reason || '',
    rawInput: reason || '',
    timestamp: combineDayAndTime(currentDate, '12:00'),
    synced: 0,
  };
  const id = await db.entries.add(entry);
  skipMarker = { ...entry, id };
  if (typeof syncEntriesToSheet === 'function') {
    syncEntriesToSheet([skipMarker])
      .then(() => db.entries.update(id, { synced: true }))
      .catch(() => {});
  }
  renderEntryForm();
  await refreshList();
}

async function removeSkipMarker() {
  if (!skipMarker) return;
  const { id, uuid } = skipMarker;
  await db.entries.delete(id);
  skipMarker = null;
  if (uuid && typeof deleteEntryFromSheet === 'function') {
    deleteEntryFromSheet(uuid).catch(() => {});
  }
  renderEntryForm();
  await refreshList();
}

function startDeleteConfirm(id) {
  confirmingDeleteId = id;
  retroConfirmState = null;
  refreshList();
}

function cancelDeleteConfirm() {
  confirmingDeleteId = null;
  refreshList();
}

function setDate(date) {
  currentDate = startOfDay(date);
  confirmingDeleteId = null;
  retroConfirmState = null;
  isFormOpen = false;
  skipMarker = null;
  refreshAll();
}

function setTab(tab) {
  if (currentTab === tab) return;
  currentTab = tab;
  confirmingDeleteId = null;
  retroConfirmState = null;
  isFormOpen = false;
  skipMarker = null;
  refreshAll();
}

// ------------------------------------------------------------------
// AI estimation
// ------------------------------------------------------------------
async function requestGeminiEstimation(inputText) {
  const apiKey = (localStorage.getItem('fw_gemini_key') || '').trim();
  const contextText = (localStorage.getItem('fw_gemini_context') || '').trim();

  if (!apiKey) throw new Error('No API key configured — set it in the AI tab.');

  const prompt = `You are a personal diet assistant helping with weight loss. Estimate calories for the food item as accurately as possible. Where there is genuine uncertainty, err on the side of overestimating calories (not underestimating) to support weight loss goals — but do not adjust estimates that already have high confidence.\n\n[PERSONAL DIET PROFILE]\n${contextText || 'No personal profile set.'}\n\n[INPUT]\n${inputText}\n\nRespond with a JSON object matching this exact schema:\n{\n  "calories": <number>,\n  "title": "<string with a relevant food emoji prefix>",\n  "confidence": "<one of: Excellent, Moderate, Low>",\n  "reasoning": "<brief explanation>"\n}`;

  const base = 'https://generativelanguage.googleapis.com/v1beta/models';
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' },
  });
  const fetchModel = (model) => fetch(`${base}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const isQuotaError = (status) => status === 429 || status === 403;

  let res = await fetchModel('gemini-2.5-flash');
  let modelUsed = 'gemini-2.5-flash';
  if (isQuotaError(res.status)) {
    console.warn(`[ai] ${modelUsed} quota hit (${res.status}), falling back to gemini-2.0-flash`);
    res = await fetchModel('gemini-2.0-flash');
    modelUsed = 'gemini-2.0-flash';
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status} (${modelUsed}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Empty response from Gemini');
  return JSON.parse(raw);
}

async function requestWorkoutEstimation(inputText, effort) {
  const apiKey = (localStorage.getItem('fw_gemini_key') || '').trim();
  if (!apiKey) throw new Error('No API key configured — set it in the AI tab.');

  const fitnessContext = (localStorage.getItem('fw_gemini_fitness_context') || '').trim();
  const age = localStorage.getItem('fw_cal_age') || 'unknown';
  const sex = localStorage.getItem('fw_cal_sex') || 'unknown';
  const height = localStorage.getItem('fw_cal_height') || 'unknown';

  const weight = await db.entries
    .where('type').equals('weight')
    .reverse().sortBy('timestamp')
    .then((rows) => rows[0]?.value ?? null);

  const EFFORT_DESCRIPTIONS = {
    low: 'Low — conversational pace, can hold a continuous conversation, RPE ~3-4/10.',
    med: 'Medium — breathing harder, short sentences only, RPE ~5-6/10.',
    high: 'High — near-maximal, can barely speak, RPE ~7-9/10.',
  };
  const effortKey = (effort || 'low').toLowerCase();
  const effortLine = EFFORT_DESCRIPTIONS[effortKey] || EFFORT_DESCRIPTIONS.low;

  const prompt = `You are a conservative exercise calorie estimator helping with weight loss. Estimate calories burned as accurately as possible. Where there is genuine uncertainty, err on the side of underestimating (not overestimating) to support weight loss goals — but do not adjust estimates that already have high confidence. The user is a ${age}yo ${sex}, ${height}cm, ${weight}kg.\n\n[PERSONAL FITNESS PROFILE]\n${fitnessContext || 'No personal profile set.'}\n\n[ACTIVITY]\n${inputText}\n\n[EFFORT]\nUser-reported effort: ${effortKey} — ${effortLine}\nUse this to calibrate intensity assumptions (pace, heart-rate zone, work-to-rest ratio).\n\nRespond with a JSON object matching this exact schema:\n{\n  "calories": <number>,\n  "title": "<string with a relevant activity emoji prefix>",\n  "confidence": "<one of: Excellent, Moderate, Low>",\n  "reasoning": "<brief explanation>"\n}`;

  const base = 'https://generativelanguage.googleapis.com/v1beta/models';
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' },
  });
  const fetchModel = (model) => fetch(`${base}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const isQuotaError = (status) => status === 429 || status === 403;

  let res = await fetchModel('gemini-2.5-flash');
  let modelUsed = 'gemini-2.5-flash';
  if (isQuotaError(res.status)) {
    console.warn(`[ai] ${modelUsed} quota hit (${res.status}), falling back to gemini-2.0-flash`);
    res = await fetchModel('gemini-2.0-flash');
    modelUsed = 'gemini-2.0-flash';
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status} (${modelUsed}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Empty response from Gemini');
  return JSON.parse(raw);
}

// ------------------------------------------------------------------
// Frequent-items index (local fuzzy match for repeat foods)
// ------------------------------------------------------------------
let frequentFoods = [];
let frequentHaystack = [];
let frequentIndexBy = [];
const uf = new uFuzzy({ intraMode: 1, intraIns: 1, intraSub: 1, intraTrn: 1, intraDel: 1 });
const FREQUENT_THRESHOLD = 3;
const MIN_QUERY_LEN = 2;

async function rebuildFrequentFoods() {
  const all = await db.entries.where('type').equals('food').toArray();
  const groups = new Map();
  for (const entry of all) {
    const canonicalTitle = (entry.aiSuggestedTitle || entry.text || '').trim();
    const canonicalKcal = entry.aiSuggestedCalories ?? entry.calories;
    if (!canonicalTitle || canonicalKcal == null) continue;
    if (!groups.has(canonicalTitle)) groups.set(canonicalTitle, []);
    groups.get(canonicalTitle).push(entry);
  }

  const items = [];
  for (const [title, grpEntries] of groups) {
    if (grpEntries.length < FREQUENT_THRESHOLD) continue;
    grpEntries.sort((a, b) => b.timestamp - a.timestamp);
    const latest = grpEntries[0];
    const canonicalKcal = latest.aiSuggestedCalories ?? latest.calories;
    const rawSet = new Set();
    for (const e of grpEntries) {
      if (e.rawInput) rawSet.add(e.rawInput.toLowerCase());
      if (e.text) rawSet.add(e.text.toLowerCase());
      if (rawSet.size >= 6) break;
    }
    items.push({
      title,
      calories: canonicalKcal,
      confidence: latest.calorieConfidence || '',
      count: grpEntries.length,
      lastTs: latest.timestamp,
      rawInputs: Array.from(rawSet),
    });
  }

  items.sort((a, b) => b.lastTs - a.lastTs);
  frequentFoods = items;
  frequentHaystack = items.map((item) => item.title.toLowerCase() + ' | ' + item.rawInputs.join(' | '));
  frequentIndexBy = items.map((_, i) => i);
}

function matchFrequent(query) {
  if (!query || query.length < MIN_QUERY_LEN || !frequentFoods.length) return null;
  const [idxs] = uf.search(frequentHaystack, query, 0, 1000);
  if (!idxs || idxs.length === 0) return null;
  return frequentFoods[frequentIndexBy[idxs[0]]];
}

// ------------------------------------------------------------------
// Weekly goal (settings, persisted to localStorage)
// ------------------------------------------------------------------
function getGoal() {
  const kgRaw = localStorage.getItem('fw_goal_kg_per_week');
  const ratioRaw = localStorage.getItem('fw_goal_weekend_ratio');
  const daysRaw = localStorage.getItem('fw_goal_weekend_days');
  const kg = parseFloat(kgRaw);
  const ratio = parseFloat(ratioRaw);
  const days = daysRaw
    ? daysRaw.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_WEEKEND_DAYS;
  return {
    weeklyKg: Number.isFinite(kg) ? kg : DEFAULT_WEEKLY_LOSS_GOAL_KG,
    weekendRatio: Number.isFinite(ratio) ? ratio : DEFAULT_WEEKEND_RATIO,
    weekendDays: new Set(days),
  };
}

function setGoal({ weeklyKg, weekendRatio, weekendDays } = {}) {
  if (weeklyKg != null && Number.isFinite(weeklyKg)) {
    localStorage.setItem('fw_goal_kg_per_week', String(weeklyKg));
  }
  if (weekendRatio != null && Number.isFinite(weekendRatio)) {
    localStorage.setItem('fw_goal_weekend_ratio', String(weekendRatio));
  }
  if (weekendDays != null) {
    localStorage.setItem('fw_goal_weekend_days', Array.from(weekendDays).join(','));
  }
}

// ------------------------------------------------------------------
// Settings panel
// ------------------------------------------------------------------
function loadSettingsValues() {
  const keyEl = document.getElementById('cfg-ai-key');
  const ctxEl = document.getElementById('cfg-ai-context');
  const fitnessCtxEl = document.getElementById('cfg-ai-fitness-context');
  if (keyEl) keyEl.value = localStorage.getItem('fw_gemini_key') || '';
  if (ctxEl) ctxEl.value = localStorage.getItem('fw_gemini_context') || '';
  if (fitnessCtxEl) fitnessCtxEl.value = localStorage.getItem('fw_gemini_fitness_context') || '';

  const sexEl = document.getElementById('cfg-cal-sex');
  const ageEl = document.getElementById('cfg-cal-age');
  const htEl = document.getElementById('cfg-cal-height');
  if (sexEl) sexEl.value = localStorage.getItem('fw_cal_sex') || '';
  if (ageEl) ageEl.value = localStorage.getItem('fw_cal_age') || '';
  if (htEl) htEl.value = localStorage.getItem('fw_cal_height') || '';
  updateCalTargetPreview();

  const goal = getGoal();
  const kgEl = document.getElementById('cfg-goal-kg');
  const ratioEl = document.getElementById('cfg-goal-weekend-ratio');
  if (kgEl) kgEl.value = goal.weeklyKg;
  if (ratioEl) ratioEl.value = goal.weekendRatio;
  renderWeekendDayPicker(goal.weekendDays);
  updateGoalPreview();
}

function renderWeekendDayPicker(selectedSet) {
  const host = document.getElementById('cfg-goal-weekend-days');
  if (!host) return;
  host.replaceChildren();
  for (const label of DOW_MON_FIRST) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'goal-day-chip' + (selectedSet.has(label) ? ' is-active' : '');
    btn.dataset.day = label;
    btn.textContent = label;
    btn.setAttribute('aria-pressed', String(selectedSet.has(label)));
    btn.addEventListener('click', () => {
      const active = btn.classList.toggle('is-active');
      btn.setAttribute('aria-pressed', String(active));
      saveGoalFields();
    });
    host.appendChild(btn);
  }
}

function readGoalFromForm() {
  const kgEl = document.getElementById('cfg-goal-kg');
  const ratioEl = document.getElementById('cfg-goal-weekend-ratio');
  const host = document.getElementById('cfg-goal-weekend-days');
  const kg = kgEl ? parseFloat(kgEl.value) : NaN;
  const ratio = ratioEl ? parseFloat(ratioEl.value) : NaN;
  const days = host
    ? Array.from(host.querySelectorAll('.goal-day-chip.is-active')).map(b => b.dataset.day)
    : Array.from(DEFAULT_WEEKEND_DAYS);
  return {
    weeklyKg: Number.isFinite(kg) ? kg : DEFAULT_WEEKLY_LOSS_GOAL_KG,
    weekendRatio: Number.isFinite(ratio) ? ratio : DEFAULT_WEEKEND_RATIO,
    weekendDays: new Set(days),
  };
}

function saveGoalFields() {
  setGoal(readGoalFromForm());
  updateGoalPreview();
  if (typeof pushProfileAndGoalToSheet === 'function') {
    pushProfileAndGoalToSheet().catch(() => {});
  }
}

function updateGoalPreview() {
  const preview = document.getElementById('cfg-goal-preview');
  if (!preview) return;
  const goal = readGoalFromForm();
  if (!(goal.weeklyKg > 0)) {
    preview.textContent = 'Set a goal above 0 to see your daily deficit budget.';
    return;
  }
  const weeklyDeficit = goal.weeklyKg * KCAL_PER_KG;
  const weekendCount = DOW_MON_FIRST.filter(d => goal.weekendDays.has(d)).length;
  const weekdayCount = 7 - weekendCount;
  const divisor = weekdayCount + goal.weekendRatio * weekendCount;
  if (divisor <= 0) {
    preview.textContent = 'Pick at least one weekday so the goal can be split.';
    return;
  }
  const weekday = Math.round(weeklyDeficit / divisor);
  const weekend = Math.round(weekday * goal.weekendRatio);
  preview.textContent =
    `Weekly deficit ${Math.round(weeklyDeficit).toLocaleString()} kcal · ` +
    `weekday −${weekday.toLocaleString()} · weekend −${weekend.toLocaleString()}.`;
}

async function updateCalTargetPreview() {
  const preview = document.getElementById('cfg-cal-preview');
  if (!preview) return;
  const info = await computeMaintenanceTarget();
  const target = info?.targetKcal;
  if (target) {
    preview.textContent = `Estimated maintenance: ${target} kcal/day (7-day weight average × 1.3 baseline activity; logged activity adds on top).`;
  } else {
    preview.textContent = 'Set your profile fields above to see an estimated maintenance target.';
  }
}

function targetFromWeight(weightAvg, sex, age, height) {
  const bmr = sex === 'male'
    ? 10 * weightAvg + 6.25 * height - 5 * age + 5
    : 10 * weightAvg + 6.25 * height - 5 * age - 161;
  return Math.round(bmr * ACTIVITY_MULTIPLIER);
}

// Returns { targetKcal, weightAvg, source } or null.
// source: 'avg' (≥1 weight in window) | 'single-stale' (fallback) | null (no data).
async function computeMaintenanceTarget(date = new Date()) {
  const sex = localStorage.getItem('fw_cal_sex') || '';
  const age = parseFloat(localStorage.getItem('fw_cal_age') || '');
  const height = parseFloat(localStorage.getItem('fw_cal_height') || '');
  if (!sex || !age || !height) return null;

  // Single query covering the full look-back range (window + staleness buffer).
  const rangeStart = startOfDay(addDays(date, -(WEIGHT_AVG_WINDOW_DAYS + WEIGHT_STALENESS_LIMIT_DAYS))).getTime();
  const rangeEnd = endOfDay(addDays(date, -1)).getTime();
  const candidates = await db.entries
    .where('timestamp').between(rangeStart, rangeEnd, true, true)
    .and(e => e.type === 'weight')
    .sortBy('timestamp');

  // LOCF: for each window day (date-7 through date-1), take the last weight within
  // the staleness limit for that day.
  const representatives = [];
  for (let offset = WEIGHT_AVG_WINDOW_DAYS; offset >= 1; offset--) {
    const day = addDays(date, -offset);
    const dayEnd = endOfDay(day).getTime();
    const staleLimit = startOfDay(addDays(day, -WEIGHT_STALENESS_LIMIT_DAYS)).getTime();
    for (let i = candidates.length - 1; i >= 0; i--) {
      const ts = candidates[i].timestamp;
      if (ts <= dayEnd && ts >= staleLimit) {
        representatives.push(candidates[i].value);
        break;
      }
    }
  }

  let weightAvg, source;
  if (representatives.length > 0) {
    weightAvg = representatives.reduce((s, v) => s + v, 0) / representatives.length;
    source = 'avg';
  } else {
    // Fallback: most recent weight ever logged before the target date.
    const targetStart = startOfDay(date).getTime();
    const fallback = await db.entries
      .where('type').equals('weight')
      .and(e => e.timestamp < targetStart)
      .reverse()
      .sortBy('timestamp')
      .then(rows => rows[0] ?? null);
    if (!fallback) return null;
    weightAvg = fallback.value;
    source = 'single-stale';
    console.log('[app] computeMaintenanceTarget: stale fallback weight', fallback.value, 'from', new Date(fallback.timestamp).toISOString());
  }

  return { targetKcal: targetFromWeight(weightAvg, sex, age, height), weightAvg, source };
}

function initSettingsPanel() {
  const btn = document.getElementById('settings-btn');
  const overlay = document.getElementById('settings-overlay');
  const closeBtn = document.getElementById('settings-close');
  const keyEl = document.getElementById('cfg-ai-key');
  const ctxEl = document.getElementById('cfg-ai-context');
  const fitnessCtxEl = document.getElementById('cfg-ai-fitness-context');
  const sexEl = document.getElementById('cfg-cal-sex');
  const ageEl = document.getElementById('cfg-cal-age');
  const htEl = document.getElementById('cfg-cal-height');

  if (!btn || !overlay) return;

  btn.addEventListener('click', () => {
    loadSettingsValues();
    overlay.classList.remove('hidden');
  });

  function closePanel() {
    // Save cal fields on close so mobile tap-dismiss doesn't lose data
    if (sexEl) localStorage.setItem('fw_cal_sex', sexEl.value);
    if (ageEl) localStorage.setItem('fw_cal_age', ageEl.value.trim());
    if (htEl) localStorage.setItem('fw_cal_height', htEl.value.trim());
    saveGoalFields();
    if (typeof pushProfileAndGoalToSheet === 'function') {
      pushProfileAndGoalToSheet().catch(() => {});
    }
    overlay.classList.add('hidden');
    // Refresh totals in case the target changed
    if (currentTab === 'food' || currentTab === 'workout') refreshList();
  }

  closeBtn.addEventListener('click', closePanel);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });

  keyEl.addEventListener('change', () => {
    localStorage.setItem('fw_gemini_key', keyEl.value.trim());
  });

  ctxEl.addEventListener('blur', () => {
    localStorage.setItem('fw_gemini_context', ctxEl.value);
    if (typeof pushContextToSheet === 'function') {
      pushContextToSheet(ctxEl.value).catch(() => {});
    }
  });

  if (fitnessCtxEl) {
    fitnessCtxEl.addEventListener('blur', () => {
      localStorage.setItem('fw_gemini_fitness_context', fitnessCtxEl.value);
      if (typeof pushFitnessContextToSheet === 'function') {
        pushFitnessContextToSheet(fitnessCtxEl.value).catch(() => {});
      }
    });
  }

  function saveCalField() {
    if (sexEl) localStorage.setItem('fw_cal_sex', sexEl.value);
    if (ageEl) localStorage.setItem('fw_cal_age', ageEl.value.trim());
    if (htEl) localStorage.setItem('fw_cal_height', htEl.value.trim());
    updateCalTargetPreview();
    if (typeof pushProfileAndGoalToSheet === 'function') {
      pushProfileAndGoalToSheet().catch(() => {});
    }
  }

  if (sexEl) sexEl.addEventListener('change', saveCalField);
  if (ageEl) ageEl.addEventListener('blur', saveCalField);
  if (htEl) htEl.addEventListener('blur', saveCalField);

  const goalKgEl = document.getElementById('cfg-goal-kg');
  const goalRatioEl = document.getElementById('cfg-goal-weekend-ratio');
  if (goalKgEl) goalKgEl.addEventListener('blur', saveGoalFields);
  if (goalKgEl) goalKgEl.addEventListener('input', updateGoalPreview);
  if (goalRatioEl) goalRatioEl.addEventListener('blur', saveGoalFields);
  if (goalRatioEl) goalRatioEl.addEventListener('input', updateGoalPreview);
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------
function renderTabs() {
  for (const btn of els.tabs) {
    const isActive = btn.dataset.tab === currentTab;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
}

function attachLongPress(el, handler) {
  if (longPressAttached) return;
  longPressAttached = true;
  let timer = null;
  let startX = 0;
  let startY = 0;
  // {passive:false} + preventDefault stops Chrome's long-press text-selection gesture
  el.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    timer = setTimeout(() => { timer = null; handler(); }, 600);
  }, { passive: false });
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (timer && (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10)) cancel();
  });
}

function openSkipPrompt() {
  if (currentTab !== 'food') return;
  // TODO: restore today-only guard after testing
  // if (!isSameDay(currentDate, new Date())) return;
  if (skipMarker) return;
  loadEntries(currentDate, 'food').then((entries) => {
    if (entries.length > 0) return;
    els.skipReasonInput.value = '';
    els.skipOverlay.classList.remove('hidden');
    els.skipReasonInput.focus();
  });
}

function renderDateNav() {
  const { main, sub, kind } = formatDateLabel(currentDate);
  els.dateLabel.textContent = main;
  els.dateSub.textContent = sub;
  els.dateSub.hidden = !sub;
  if (els.dateNav) els.dateNav.dataset.daytype = kind;

  const onToday = isSameDay(currentDate, new Date());
  els.nextBtn.disabled = onToday;
  els.nextBtn.setAttribute('aria-disabled', onToday ? 'true' : 'false');

  attachLongPress(els.dateNavLabel, openSkipPrompt);
}

function buildPrimaryInput(config, initialValue) {
  let input;

  if (config.multiline) {
    input = document.createElement('textarea');
    input.className = 'entry-input entry-input--multiline';
    input.required = true;
    input.maxLength = 500;
    input.name = 'text';
    input.rows = 2;
    input.value = initialValue ?? '';
    input.placeholder = config.placeholder;
    return input;
  }

  input = document.createElement('input');
  input.className = 'entry-input';
  input.required = true;
  input.maxLength = 500;
  input.enterKeyHint = 'send';

  if (config.inputKind === 'text') {
    input.type = 'text';
    input.name = 'text';
    input.value = initialValue ?? '';
    input.placeholder = config.placeholder;
  } else {
    input.type = 'number';
    input.name = 'value';
    input.value = initialValue ?? '';
    input.placeholder = config.placeholder;
    input.step = config.inputStep || '0.1';
    if (config.inputMin) input.min = config.inputMin;
    input.inputMode = 'decimal';
  }
  return input;
}

function buildInputWrap(config, input) {
  const wrap = document.createElement('div');
  wrap.className = 'entry-input-wrap';
  wrap.appendChild(input);

  if (config.unit) {
    wrap.classList.add('has-unit');
    const unit = document.createElement('span');
    unit.className = 'entry-input-unit';
    unit.textContent = config.unit;
    unit.setAttribute('aria-hidden', 'true');
    wrap.appendChild(unit);
  }
  return wrap;
}

function buildCategoryPills(selectedCategory) {
  const container = document.createElement('div');
  container.className = 'category-pills';

  for (const category of TIME_CATEGORIES) {
    const label = document.createElement('label');
    label.className = 'category-pill';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'timeCategory';
    radio.value = category;
    radio.checked = category === selectedCategory;
    radio.className = 'category-radio';

    const span = document.createElement('span');
    span.textContent = category;

    label.appendChild(radio);
    label.appendChild(span);
    container.appendChild(label);
  }

  return container;
}

const EFFORT_LEVELS = [
  { value: 'low', label: 'Low' },
  { value: 'med', label: 'Med' },
  { value: 'high', label: 'High' },
];

function buildEffortPills(selectedValue) {
  const container = document.createElement('div');
  container.className = 'category-pills effort-pills';

  for (const { value, label: labelText } of EFFORT_LEVELS) {
    const label = document.createElement('label');
    label.className = 'category-pill';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'effort';
    radio.value = value;
    radio.checked = value === selectedValue;
    radio.className = 'category-radio';

    const span = document.createElement('span');
    span.textContent = labelText;

    label.appendChild(radio);
    label.appendChild(span);
    container.appendChild(label);
  }

  return container;
}

function renderMeasurementsForms({ hideWeight = false, hideWaist = false } = {}) {
  const container = document.createElement('div');
  container.className = 'measurements-forms';

  const hideMap = { weight: hideWeight, waist: hideWaist };
  for (const type of ['weight', 'waist']) {
    if (hideMap[type]) continue;
    const config = TYPES[type];

    const form = document.createElement('form');
    form.className = 'measurement-form';
    form.autocomplete = 'off';

    const label = document.createElement('label');
    label.className = 'measurement-label';
    label.textContent = config.label;

    const input = buildPrimaryInput(config);
    const wrap = buildInputWrap(config, input);
    label.htmlFor = `m-${type}-input`;
    input.id = `m-${type}-input`;

    const row = document.createElement('div');
    row.className = 'measurement-row';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save';

    row.append(wrap, saveBtn);
    form.append(label, row);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      await handleAdd(type, { value: input.value });
    });

    container.appendChild(form);
  }

  els.formContainer.replaceChildren(container);
}

function renderEntryForm() {
  if (currentTab === 'measurements') {
    // Forms are populated by refreshList (which knows what's already logged today).
    // Clear here so a previous tab's form doesn't linger during the async fetch.
    els.formContainer.replaceChildren();
    return;
  }

  const config = TYPES[currentTab];

  if (currentTab === 'food' && skipMarker) {
    const banner = document.createElement('div');
    banner.className = 'empty-state';
    const msg = document.createElement('p');
    msg.textContent = skipMarker.text
      ? `Day off — ${skipMarker.text}`
      : 'Food logging skipped for today.';
    banner.appendChild(msg);
    // TODO: restore today-only guard after testing
    // if (isSameDay(currentDate, new Date())) {
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'btn btn-ghost';
    undoBtn.style.marginTop = '12px';
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', removeSkipMarker);
    banner.appendChild(undoBtn);
    // }
    els.formContainer.replaceChildren(banner);
    return;
  }

  if (config.isCollapsible && !isFormOpen) {
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-primary';
    toggleBtn.style.width = '100%';
    toggleBtn.textContent = `Log ${config.label}`;
    toggleBtn.addEventListener('click', () => {
      isFormOpen = true;
      renderEntryForm();
    });
    els.formContainer.replaceChildren(toggleBtn);
    return;
  }

  const form = document.createElement('form');
  form.className = 'entry-form';
  form.autocomplete = 'off';

  const input = buildPrimaryInput(config);
  const wrap = buildInputWrap(config, input);

  let caloriesInput;
  if (currentTab === 'food' || currentTab === 'workout') {
    let hideChip = () => {};

    const aiStatusLog = document.createElement('div');
    aiStatusLog.className = 'ai-status-log hidden';

    const caloriesWrap = document.createElement('div');
    caloriesWrap.className = 'entry-input-wrap';

    caloriesInput = document.createElement('input');
    caloriesInput.type = 'number';
    caloriesInput.name = 'calories';
    caloriesInput.placeholder = 'Calories (optional)';
    caloriesInput.min = '0';
    caloriesInput.className = 'entry-input';
    caloriesWrap.appendChild(caloriesInput);

    const aiBtn = document.createElement('button');
    aiBtn.type = 'button';
    aiBtn.className = 'ai-button';
    aiBtn.textContent = '✨';
    aiBtn.setAttribute('aria-label', 'Estimate calories with AI');
    aiBtn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) {
        aiStatusLog.className = 'ai-status-log confidence-error';
        aiStatusLog.textContent = 'Enter a food description first.';
        return;
      }
      aiBtn.disabled = true;
      aiBtn.textContent = '⏳';
      aiStatusLog.className = 'ai-status-log';
      aiStatusLog.textContent = 'Estimating…';
      try {
        let result;
        if (currentTab === 'workout') {
          const effortSelected = form.querySelector('input[name="effort"]:checked');
          const effort = effortSelected ? effortSelected.value : 'low';
          result = await requestWorkoutEstimation(text, effort);
        } else {
          result = await requestGeminiEstimation(text);
        }
        // Stash lineage on the form so submit can pick it up. The user's
        // pre-AI text is captured before we overwrite the input.
        form.dataset.rawInput = text;
        hideChip();
        if (result.title) {
          form.dataset.aiSuggestedTitle = result.title;
          input.value = result.title;
        }
        if (result.calories != null) {
          form.dataset.aiSuggestedCalories = String(result.calories);
          caloriesInput.value = result.calories;
        }
        if (result.confidence) form.dataset.aiConfidence = result.confidence;
        if (result.reasoning) form.dataset.aiReasoning = result.reasoning;
        const conf = result.confidence || 'Low';
        const cls = conf === 'Excellent' ? 'confidence-excellent'
          : conf === 'Moderate' ? 'confidence-moderate' : 'confidence-low';
        aiStatusLog.className = `ai-status-log ${cls}`;
        aiStatusLog.textContent = `✨ Confidence: ${conf} — ${result.reasoning || ''}`;
      } catch (err) {
        aiStatusLog.className = 'ai-status-log confidence-error';
        const msg = err.message.includes('No API key') ? 'Set your Gemini key in Settings first.' : 'Request failed — check your API key or connection.';
        aiStatusLog.textContent = msg;
      } finally {
        aiBtn.disabled = false;
        aiBtn.textContent = '✨';
      }
    });
    caloriesWrap.appendChild(aiBtn);

    if (currentTab === 'food') {
      const cameraBtn = document.createElement('button');
      cameraBtn.type = 'button';
      cameraBtn.className = 'camera-button';
      cameraBtn.textContent = '📷';
      cameraBtn.setAttribute('aria-label', 'Take a photo');

      const hiddenFileInput = document.createElement('input');
      hiddenFileInput.type = 'file';
      hiddenFileInput.accept = 'image/*';
      hiddenFileInput.capture = 'environment';
      hiddenFileInput.hidden = true;
      hiddenFileInput.addEventListener('change', () => {
        console.log('Photo captured but not yet processed');
      });

      cameraBtn.addEventListener('click', () => {
        hiddenFileInput.click();
      });

      caloriesWrap.appendChild(cameraBtn);
      caloriesWrap.appendChild(hiddenFileInput);

      const chipRow = document.createElement('div');
      chipRow.className = 'match-chip-row hidden';
      const chipBtn = document.createElement('button');
      chipBtn.type = 'button';
      chipBtn.className = 'match-chip';
      const chipTitle = document.createElement('span');
      chipTitle.className = 'match-chip-title';
      const chipKcal = document.createElement('span');
      chipKcal.className = 'match-chip-kcal';
      chipBtn.append(chipTitle, chipKcal);
      chipRow.appendChild(chipBtn);

      hideChip = () => chipRow.classList.add('hidden');

      let chipDebounce = null;
      function matchAndRenderChip() {
        const query = input.value.trim().toLowerCase();
        if (query.length < MIN_QUERY_LEN || form.dataset.aiSuggestedTitle) {
          hideChip();
          return;
        }
        const match = matchFrequent(query);
        if (!match) { hideChip(); return; }
        chipTitle.textContent = match.title;
        chipKcal.textContent = `${match.calories} kcal`;
        chipRow._match = match;
        chipRow.classList.remove('hidden');
      }

      input.addEventListener('input', () => {
        clearTimeout(chipDebounce);
        chipDebounce = setTimeout(matchAndRenderChip, 200);
      });

      chipBtn.addEventListener('click', () => {
        const match = chipRow._match;
        if (!match) return;
        form.dataset.rawInput = input.value.trim();
        form.dataset.matchedTitle = match.title;
        form.dataset.matchedCalories = String(match.calories);
        form.dataset.matchedConfidence = match.confidence;
        input.value = match.title;
        caloriesInput.value = match.calories;
        hideChip();
        aiStatusLog.className = 'ai-status-log confidence-match';
        aiStatusLog.textContent = `↩ Matched past entry (${match.count}×)`;
      });

      form.appendChild(wrap);
      form.appendChild(aiStatusLog);
      form.appendChild(caloriesWrap);
      form.appendChild(chipRow);
    } else {
      // workout branch
      form.appendChild(wrap);
      form.appendChild(aiStatusLog);
      form.appendChild(caloriesWrap);
    }

  } else {
    form.appendChild(wrap);
  }

  if (config.hasEffort) {
    form.appendChild(buildEffortPills('low'));
  }

  if (config.hasTimeCategory) {
    const defaultCategory = getTimeCategory(Date.now());
    const pills = buildCategoryPills(defaultCategory);
    if (config.hasEffort) pills.style.marginTop = '12px';
    form.appendChild(pills);
  }

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Save';
  form.appendChild(saveBtn);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const formData = {
      text: input.name === 'text' ? input.value : undefined,
      value: input.name === 'value' ? input.value : undefined,
    };
    if (config.hasTimeCategory) {
      const selected = form.querySelector('input[name="timeCategory"]:checked');
      formData.timeCategory = selected ? selected.value : undefined;
    }
    if (config.hasEffort) {
      const selected = form.querySelector('input[name="effort"]:checked');
      formData.effort = selected ? selected.value : 'low';
    }
    if ((currentTab === 'food' || currentTab === 'workout') && caloriesInput) {
      formData.calories = caloriesInput.value;
    }
    // AI lineage stashed by the ✨ handler on the form's dataset.
    if (form.dataset.rawInput) formData.rawInput = form.dataset.rawInput;
    if (form.dataset.aiSuggestedTitle) formData.aiSuggestedTitle = form.dataset.aiSuggestedTitle;
    if (form.dataset.aiSuggestedCalories) formData.aiSuggestedCalories = form.dataset.aiSuggestedCalories;
    if (form.dataset.aiConfidence) formData.aiConfidence = form.dataset.aiConfidence;
    if (form.dataset.aiReasoning) formData.aiReasoning = form.dataset.aiReasoning;
    if (form.dataset.matchedTitle) formData.matchedTitle = form.dataset.matchedTitle;
    if (form.dataset.matchedCalories) formData.matchedCalories = form.dataset.matchedCalories;
    if (form.dataset.matchedConfidence) formData.matchedConfidence = form.dataset.matchedConfidence;
    const ok = await handleAdd(currentTab, formData);
    if (ok) {
      renderEntryForm();
    }
  });

  els.formContainer.replaceChildren(form);
}

function buildEntryRow(entry) {
  const config = TYPES[entry.type];
  const li = document.createElement('li');
  li.className = 'entry';
  li.dataset.id = String(entry.id);

  const row = document.createElement('div');
  row.className = 'entry-row';
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.setAttribute('aria-label', `Delete entry: ${config.formatDisplay(entry)}`);
  row.addEventListener('click', (ev) => {
    if (ev.target.closest('button')) return;
    startDeleteConfirm(entry.id);
  });
  row.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') startDeleteConfirm(entry.id);
  });

  const display = document.createElement('span');
  display.className = config.inputKind === 'number' ? 'entry-value' : 'entry-text';
  display.textContent = config.formatDisplay(entry);
  row.append(display);

  if ((entry.type === 'food' || entry.type === 'workout') && entry.calories) {
    const cal = document.createElement('span');
    cal.className = 'entry-calories';
    cal.textContent = `${Math.round(entry.calories)} kcal`;
    row.append(cal);
  } else if ((entry.type === 'food' || entry.type === 'workout') && !entry.calories) {
    const retroBtn = document.createElement('button');
    retroBtn.type = 'button';
    retroBtn.className = 'retro-ai-btn';
    retroBtn.setAttribute('aria-label', 'Estimate calories');
    retroBtn.textContent = '✨';
    retroBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      retroBtn.textContent = '⏳';
      retroBtn.disabled = true;
      try {
        const result = entry.type === 'workout'
          ? await requestWorkoutEstimation(entry.text, entry.effort || 'low')
          : await requestGeminiEstimation(entry.text);
        const newLi = buildRetroConfirmRow(entry, result);
        li.replaceWith(newLi);
      } catch (err) {
        retroBtn.textContent = '✨';
        retroBtn.disabled = false;
        alert(`Estimation failed: ${err.message}`);
      }
    });
    row.append(retroBtn);
  }

  li.append(row);
  return li;
}

function buildDeleteConfirmRow(entry) {
  const config = TYPES[entry.type];
  const li = document.createElement('li');
  li.className = 'entry entry-deleting';
  li.dataset.id = String(entry.id);

  const label = document.createElement('span');
  label.className = config.inputKind === 'number' ? 'entry-value' : 'entry-text';
  label.textContent = config.formatDisplay(entry);

  if ((entry.type === 'food' || entry.type === 'workout') && entry.calories) {
    const cal = document.createElement('span');
    cal.className = 'entry-calories';
    cal.textContent = `${Math.round(entry.calories)} kcal`;
    label.insertAdjacentElement('afterend', cal);
  }

  const actions = document.createElement('div');
  actions.className = 'edit-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', cancelDeleteConfirm);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => confirmAndDelete(entry.id));

  actions.append(cancelBtn, deleteBtn);
  li.append(label, actions);
  return li;
}

function buildRetroConfirmRow(entry, aiResult) {
  const li = document.createElement('li');
  li.className = 'entry entry-deleting';
  li.dataset.id = String(entry.id);

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'edit-input';
  titleInput.value = aiResult.title || entry.text;

  const calInput = document.createElement('input');
  calInput.type = 'number';
  calInput.step = '1';
  calInput.className = 'edit-input edit-input-cal';
  calInput.value = aiResult.calories;

  const actions = document.createElement('div');
  actions.className = 'edit-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => refreshList());

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () =>
    saveEntryUpdate(entry, titleInput.value.trim(), calInput.value, aiResult)
  );

  const conf = aiResult.confidence || 'Low';
  const confCls = conf === 'Excellent' ? 'confidence-excellent'
    : conf === 'Moderate' ? 'confidence-moderate' : 'confidence-low';
  const statusLog = document.createElement('div');
  statusLog.className = `ai-status-log ${confCls}`;
  statusLog.textContent = `✨ Confidence: ${conf} — ${aiResult.reasoning || ''}`;

  actions.append(cancelBtn, saveBtn);
  li.append(titleInput, calInput, statusLog, actions);
  return li;
}

async function saveEntryUpdate(entry, newText, newCalories, aiResult) {
  const timeCategory = entry.timeCategory || getTimeCategory(entry.timestamp);
  const updates = {
    text: newText,
    calories: Number(newCalories),
    timeCategory,
  };
  if (aiResult) {
    // entry.text is what the user originally typed (pre-AI). Preserve as raw_input
    // unless an earlier estimation already recorded one.
    if (!entry.rawInput) updates.rawInput = entry.text;
    updates.aiSuggestedTitle = aiResult.title || '';
    if (aiResult.calories != null) updates.aiSuggestedCalories = Number(aiResult.calories);
    updates.calorieConfidence = mapConfidence(aiResult.confidence);
    updates.aiReasoning = aiResult.reasoning || '';
    updates.calorieSource = 'gemini';
  }
  await db.entries.update(entry.id, updates);
  if (typeof updateEntryInSheet === 'function') {
    updateEntryInSheet({ ...entry, ...updates }).catch(console.warn);
  }
  await refreshList();
}

function renderEntries(entries) {
  els.list.replaceChildren();
  if (entries.length === 0) {
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;

  const config = TYPES[currentTab];

  if (config.hasTimeCategory) {
    const grouped = {};
    for (const category of TIME_CATEGORIES) {
      grouped[category] = [];
    }
    for (const entry of entries) {
      const category = entry.timeCategory || getTimeCategory(entry.timestamp);
      if (grouped[category]) {
        grouped[category].push(entry);
      }
    }

    for (const category of TIME_CATEGORIES) {
      const categoryEntries = grouped[category];
      if (categoryEntries.length === 0) continue;

      const header = document.createElement('h3');
      header.className = 'category-header';
      header.textContent = category;
      els.list.appendChild(header);

      for (const entry of categoryEntries) {
        const li = entry.id === confirmingDeleteId ? buildDeleteConfirmRow(entry) : buildEntryRow(entry);
        li.classList.add(`category-${category.toLowerCase()}`);
        els.list.appendChild(li);
      }
    }
  } else {
    for (const entry of entries) {
      els.list.appendChild(
        entry.id === confirmingDeleteId ? buildDeleteConfirmRow(entry) : buildEntryRow(entry)
      );
    }
  }
}

async function refreshList() {
  let entries;
  if (currentTab === 'measurements') {
    const [weights, waists] = await Promise.all([
      loadEntries(currentDate, 'weight'),
      loadEntries(currentDate, 'waist'),
    ]);
    entries = [...weights, ...waists].sort((a, b) => a.timestamp - b.timestamp);
    renderMeasurementsForms({
      hideWeight: weights.length > 0,
      hideWaist: waists.length > 0,
    });
  } else {
    entries = await loadEntries(currentDate, currentTab);
  }
  renderEntries(entries);

  if (currentTab === 'food' && skipMarker) {
    els.calTotal.hidden = true;
    return;
  }

  if (currentTab === 'food' || currentTab === 'workout') {
    const foodDay = currentTab === 'food' ? entries : await loadEntries(currentDate, 'food');
    const workoutDay = currentTab === 'workout' ? entries : await loadEntries(currentDate, 'workout');
    const foodTotal = Math.round(foodDay.reduce((sum, e) => sum + (e.calories || 0), 0));
    const workoutTotal = Math.round(workoutDay.reduce((sum, e) => sum + (e.calories || 0), 0));
    const targetInfo = await computeMaintenanceTarget(currentDate);
    const target = targetInfo?.targetKcal ?? null;

    renderCalorieTotal({ foodTotal, workoutTotal, target });
    els.calTotal.hidden = false;
  } else {
    els.calTotal.hidden = true;
  }
}

function buildCalRing(progress) {
  // progress: 0..1 of ring filled. Returns the .cal-ring wrapper.
  const RADIUS = 44;
  const CIRC = 2 * Math.PI * RADIUS;
  const clamped = Math.max(0, Math.min(1, progress));
  const offset = CIRC * (1 - clamped);

  const wrap = document.createElement('div');
  wrap.className = 'cal-ring';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 104 104');
  svg.setAttribute('aria-hidden', 'true');

  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  track.setAttribute('class', 'cal-ring-track');
  track.setAttribute('cx', '52');
  track.setAttribute('cy', '52');
  track.setAttribute('r', String(RADIUS));

  const fill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  fill.setAttribute('class', 'cal-ring-fill');
  fill.setAttribute('cx', '52');
  fill.setAttribute('cy', '52');
  fill.setAttribute('r', String(RADIUS));
  fill.setAttribute('stroke-dasharray', String(CIRC));
  fill.setAttribute('stroke-dashoffset', String(offset));

  svg.append(track, fill);

  const inner = document.createElement('div');
  inner.className = 'cal-ring-inner';

  wrap.append(svg, inner);
  return { wrap, inner };
}

function renderCalorieTotal({ foodTotal, workoutTotal, target }) {
  els.calTotal.replaceChildren();
  els.calTotal.classList.remove('is-under', 'is-over', 'is-muted', 'is-near');

  if (!target) {
    els.calTotal.classList.add('is-muted');
    const { wrap, inner } = buildCalRing(0);
    const hero = document.createElement('div');
    hero.className = 'cal-hero';
    hero.textContent = foodTotal.toLocaleString();
    const unit = document.createElement('div');
    unit.className = 'cal-hero-unit';
    unit.textContent = 'kcal';
    inner.append(hero, unit);

    const text = document.createElement('div');
    text.className = 'cal-text';
    const status = document.createElement('div');
    status.className = 'cal-status';
    status.textContent = 'eaten today';
    const hint = document.createElement('div');
    hint.className = 'cal-detail';
    hint.textContent = 'Set weight & profile for a maintenance estimate';
    text.append(status, hint);

    els.calTotal.append(wrap, text);
    return;
  }

  const finalTarget = target + workoutTotal;
  const remaining = finalTarget - foodTotal;
  const isUnder = remaining >= 0;
  const isNear = Math.abs(remaining) <= SMALL_DELTA_KCAL;
  els.calTotal.classList.add(isUnder ? 'is-under' : 'is-over');
  if (isNear) els.calTotal.classList.add('is-near');

  const progress = finalTarget > 0 ? foodTotal / finalTarget : 0;
  const { wrap, inner } = buildCalRing(progress);

  const hero = document.createElement('div');
  hero.className = 'cal-hero';
  hero.textContent = Math.abs(remaining).toLocaleString();
  const unit = document.createElement('div');
  unit.className = 'cal-hero-unit';
  unit.textContent = isUnder ? 'left' : 'over';
  inner.append(hero, unit);

  const text = document.createElement('div');
  text.className = 'cal-text';
  const status = document.createElement('div');
  status.className = 'cal-status';
  status.textContent = isUnder
    ? (isNear ? 'small deficit' : 'deficit')
    : (isNear ? 'small surplus' : 'surplus');
  const detail = document.createElement('div');
  detail.className = 'cal-detail';
  const workoutPart = workoutTotal > 0 ? ` (+${workoutTotal.toLocaleString()} activity)` : '';
  detail.textContent = `eaten ${foodTotal.toLocaleString()} · maintenance ${target.toLocaleString()}${workoutPart}`;
  text.append(status, detail);

  els.calTotal.append(wrap, text);
}

async function refreshAll() {
  renderTabs();
  renderDateNav();
  if (currentTab === 'food') {
    skipMarker = await loadSkipMarker(currentDate);
  } else {
    skipMarker = null;
  }
  renderEntryForm();
  await refreshList();
}

// ------------------------------------------------------------------
// Progress charts
// ------------------------------------------------------------------

async function loadProgressRange(startDate, endDate) {
  const sex = localStorage.getItem('fw_cal_sex') || '';
  const age = parseFloat(localStorage.getItem('fw_cal_age') || '');
  const height = parseFloat(localStorage.getItem('fw_cal_height') || '');
  const hasProfile = !!(sex && age && height);

  // Single query extending back far enough for rolling-avg look-back.
  const lookbackStart = startOfDay(addDays(startDate, -(WEIGHT_AVG_WINDOW_DAYS + WEIGHT_STALENESS_LIMIT_DAYS)));
  const allEntries = await db.entries
    .where('timestamp').between(lookbackStart.getTime(), endOfDay(endDate).getTime(), true, true)
    .toArray();

  // All weight entries for rolling-avg target (matches computeMaintenanceTarget).
  // Morning-only for raw chart dots — excludes evening outliers from the displayed line.
  const weightEntries = allEntries
    .filter(e => e.type === 'weight')
    .sort((a, b) => a.timestamp - b.timestamp);
  const morningWeightEntries = weightEntries.filter(e => e.timeCategory === 'Morning');
  const foodEntries = allEntries.filter(e => e.type === 'food');
  const workoutEntries = allEntries.filter(e => e.type === 'workout');

  const days = [];
  let d = startOfDay(new Date(startDate));
  const endTs = startOfDay(endDate).getTime();
  while (d.getTime() <= endTs) {
    const dayStart = startOfDay(d).getTime();
    const dayEnd = endOfDay(d).getTime();

    const foodKcal = foodEntries
      .filter(e => e.timestamp >= dayStart && e.timestamp <= dayEnd)
      .reduce((sum, e) => sum + (e.calories || 0), 0);

    const workoutKcal = workoutEntries
      .filter(e => e.timestamp >= dayStart && e.timestamp <= dayEnd)
      .reduce((sum, e) => sum + (e.calories || 0), 0);

    const dayWeights = morningWeightEntries.filter(e => e.timestamp >= dayStart && e.timestamp <= dayEnd);
    const weight = dayWeights.length > 0 ? dayWeights[dayWeights.length - 1].value : null;

    let weightAvg7 = null;
    let targetKcal = null;
    if (hasProfile) {
      const reps = [];
      for (let offset = WEIGHT_AVG_WINDOW_DAYS; offset >= 1; offset--) {
        const refDay = addDays(d, -offset);
        const refDayEnd = endOfDay(refDay).getTime();
        const staleLimit = startOfDay(addDays(refDay, -WEIGHT_STALENESS_LIMIT_DAYS)).getTime();
        for (let i = weightEntries.length - 1; i >= 0; i--) {
          const ts = weightEntries[i].timestamp;
          if (ts <= refDayEnd && ts >= staleLimit) {
            reps.push(weightEntries[i].value);
            break;
          }
        }
      }
      if (reps.length > 0) {
        weightAvg7 = reps.reduce((s, v) => s + v, 0) / reps.length;
        targetKcal = targetFromWeight(weightAvg7, sex, age, height);
      }
    }

    days.push({ date: d.toISOString().slice(0, 10), foodKcal, workoutKcal, weight, weightAvg7, targetKcal });
    d = addDays(d, 1);
  }
  return { days };
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const CHART_W = 360, CHART_H = 190;
const CP = { l: 40, r: 10, t: 14, b: 28 };
const PW = CHART_W - CP.l - CP.r;
const PH = CHART_H - CP.t - CP.b;

function chartXPos(i, total) {
  return total <= 1 ? CP.l + PW / 2 : CP.l + (i / (total - 1)) * PW;
}

function chartYPos(val, min, max) {
  return CP.t + PH - ((val - min) / (max - min)) * PH;
}

function barXPos(i, total) {
  return CP.l + i * (PW / total);
}

function barWidth(total) {
  return Math.max(1, PW / total - 1);
}

function niceGridStep(range, maxSteps) {
  const rawStep = (range || 1) / maxSteps;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  for (const f of [1, 2, 5, 10]) {
    if (f * magnitude >= rawStep) return f * magnitude;
  }
  return magnitude * 10;
}

function addChartGrid(svg, min, max) {
  const step = niceGridStep(max - min, 4);
  const gridMin = Math.ceil(min / step) * step;
  for (let v = gridMin; v <= max + step * 0.01; v += step) {
    const y = chartYPos(v, min, max);
    if (y < CP.t - 2 || y > CP.t + PH + 2) continue;
    svg.appendChild(svgEl('line', { x1: CP.l, y1: y.toFixed(1), x2: CHART_W - CP.r, y2: y.toFixed(1), class: 'chart-grid-line' }));
    const lbl = svgEl('text', { x: CP.l - 4, y: (y + 4).toFixed(1), class: 'chart-axis-label', 'text-anchor': 'end' });
    const absV = Math.abs(v);
    lbl.textContent = absV >= 100 ? Math.round(v).toLocaleString() : (v % 1 === 0 ? String(v) : v.toFixed(1));
    svg.appendChild(lbl);
  }
}

function addChartXLabels(svg, days, labelEvery, getX) {
  const n = days.length;
  const xFn = getX || ((i) => chartXPos(i, n));
  const MIN_GAP = 30;
  let lastX = -Infinity;
  days.forEach((day, i) => {
    if (i % labelEvery !== 0 && i !== n - 1) return;
    const x = xFn(i);
    if (x - lastX < MIN_GAP) return;
    lastX = x;
    const d = new Date(day.date + 'T00:00:00');
    const lbl = svgEl('text', { x: x.toFixed(1), y: CHART_H - 4, class: 'chart-axis-label', 'text-anchor': 'middle' });
    lbl.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    svg.appendChild(lbl);
  });
}

function xLabelEvery(n) {
  if (n <= 8) return 1;
  if (n <= 35) return 7;
  if (n <= 100) return 14;
  return 30;
}

function makeChartWrap(title) {
  const fig = document.createElement('figure');
  fig.className = 'chart';
  const svg = svgEl('svg', { viewBox: `0 0 ${CHART_W} ${CHART_H}`, 'aria-hidden': 'true' });
  const cap = document.createElement('figcaption');
  cap.className = 'chart-label';
  cap.textContent = title;
  fig.append(svg, cap);
  return { fig, svg };
}

function buildWeightChart(days) {
  const { fig, svg } = makeChartWrap('Weight (kg)');
  const pts = days.map((d, i) => ({ i, w: d.weight, a: d.weightAvg7 }));
  const vals = pts.flatMap(p => [p.w, p.a].filter(v => v != null));
  if (!vals.length) {
    const t = svgEl('text', { x: CHART_W / 2, y: CHART_H / 2, class: 'chart-empty', 'text-anchor': 'middle' });
    t.textContent = 'No weight data in range';
    svg.appendChild(t);
    return fig;
  }
  const actualMin = Math.min(...vals);
  const actualMax = Math.max(...vals);
  const wStep = niceGridStep(Math.max(actualMax - actualMin, 0.5), 4);
  const min = Math.floor(actualMin / wStep) * wStep;
  const max = Math.ceil(actualMax / wStep) * wStep;
  addChartGrid(svg, min, max);
  addChartXLabels(svg, days, xLabelEvery(days.length));

  const avgPts = pts.filter(p => p.a != null);
  if (avgPts.length >= 2) {
    const xy = avgPts.map(p => `${chartXPos(p.i, days.length).toFixed(1)},${chartYPos(p.a, min, max).toFixed(1)}`);
    const baseY = (CP.t + PH).toFixed(1);
    const firstX = chartXPos(avgPts[0].i, days.length).toFixed(1);
    const lastX = chartXPos(avgPts[avgPts.length - 1].i, days.length).toFixed(1);
    svg.appendChild(svgEl('polygon', { points: `${firstX},${baseY} ${xy.join(' ')} ${lastX},${baseY}`, class: 'chart-area' }));
    svg.appendChild(svgEl('polyline', { points: xy.join(' '), class: 'chart-line chart-line-avg' }));
  }

  const wPts = pts.filter(p => p.w != null);
  if (wPts.length >= 2) {
    const polyPts = wPts.map(p => `${chartXPos(p.i, days.length).toFixed(1)},${chartYPos(p.w, min, max).toFixed(1)}`).join(' ');
    svg.appendChild(svgEl('polyline', { points: polyPts, class: 'chart-line chart-line-weight' }));
  }
  for (const p of wPts) {
    svg.appendChild(svgEl('circle', {
      cx: chartXPos(p.i, days.length).toFixed(1),
      cy: chartYPos(p.w, min, max).toFixed(1),
      r: '3', class: 'chart-dot',
    }));
  }
  return fig;
}

function buildCaloriesChart(days) {
  const { fig, svg } = makeChartWrap('Calories vs Target (kcal)');
  const n = days.length;
  const bw = barWidth(n);
  const getBarX = (i) => barXPos(i, n) + bw / 2;
  const maxFood = Math.max(...days.map(d => d.foodKcal), 0);
  const maxTarget = Math.max(...days.map(d => (d.targetKcal ?? 0) + d.workoutKcal), 0);
  const yMin = 1000;
  const yMax = Math.max(maxFood, maxTarget, yMin + 200) * 1.1;
  addChartGrid(svg, yMin, yMax);
  addChartXLabels(svg, days, xLabelEvery(n), getBarX);

  for (let i = 0; i < n; i++) {
    const d = days[i];
    if (!d.foodKcal) continue;
    const effectiveTarget = d.targetKcal != null ? d.targetKcal + d.workoutKcal : null;
    const barClass = effectiveTarget == null ? 'is-neutral'
      : d.foodKcal > effectiveTarget ? 'is-over' : 'is-under';
    const bh = Math.max(1, PH * (d.foodKcal - yMin) / (yMax - yMin));
    const by = CP.t + PH - bh;
    svg.appendChild(svgEl('rect', {
      x: barXPos(i, n).toFixed(1), y: by.toFixed(1),
      width: bw.toFixed(1), height: bh.toFixed(1),
      rx: '2', class: `chart-bar ${barClass}`,
    }));
  }

  const tPts = days
    .map((d, i) => d.targetKcal != null ? { i, v: d.targetKcal + d.workoutKcal } : null)
    .filter(Boolean);
  if (tPts.length >= 2) {
    const polyPts = tPts.map(p => `${getBarX(p.i).toFixed(1)},${chartYPos(p.v, yMin, yMax).toFixed(1)}`).join(' ');
    svg.appendChild(svgEl('polyline', { points: polyPts, class: 'chart-target-line' }));
  }
  return fig;
}

function buildNetBalanceChart(days) {
  const { fig, svg } = makeChartWrap('Net Balance (kcal)');
  const n = days.length;
  const bw = barWidth(n);
  const nets = days.map(d => (d.targetKcal != null && d.foodKcal) ? d.foodKcal - d.workoutKcal - d.targetKcal : null);
  const vals = nets.filter(v => v != null);
  if (!vals.length) {
    const t = svgEl('text', { x: CHART_W / 2, y: CHART_H / 2, class: 'chart-empty', 'text-anchor': 'middle' });
    t.textContent = 'Set your profile to see net balance';
    svg.appendChild(t);
    return fig;
  }

  const maxAbs = Math.max(Math.abs(Math.min(...vals)), Math.abs(Math.max(...vals)), 100);
  const yMin = -maxAbs * 1.15;
  const yMax = maxAbs * 1.15;
  const zeroY = chartYPos(0, yMin, yMax);
  addChartGrid(svg, yMin, yMax);
  svg.appendChild(svgEl('line', { x1: CP.l, y1: zeroY.toFixed(1), x2: CHART_W - CP.r, y2: zeroY.toFixed(1), class: 'chart-zero-line' }));
  addChartXLabels(svg, days, xLabelEvery(n), (i) => barXPos(i, n) + bw / 2);

  for (let i = 0; i < n; i++) {
    const net = nets[i];
    if (net == null || net === 0) continue;
    const isOver = net > 0;
    const yNet = chartYPos(net, yMin, yMax);
    const by = isOver ? yNet : zeroY;
    const bh = Math.max(1, Math.abs(zeroY - yNet));
    svg.appendChild(svgEl('rect', {
      x: barXPos(i, n).toFixed(1), y: by.toFixed(1),
      width: bw.toFixed(1), height: bh.toFixed(1),
      rx: '2', class: `chart-bar ${isOver ? 'is-over' : 'is-under'}`,
    }));
  }
  return fig;
}

// ------------------------------------------------------------------
// Weekly goal: pace tile + weekly deficit chart
// ------------------------------------------------------------------

const WEEKLY_CHART_WEEKS = 10;

// Typical cumulative fraction of a day's food eaten by hour-of-day. Used to
// scale today's partial-day contribution to the pace ring so pre-meal hours
// don't look falsely banked. Linear interpolation between control points.
// Curve aims to track Andy's eating: breakfast 8–10, lunch ~12–14, dinner ~17–21.
const MEAL_CURVE_POINTS = [
  [0,  0.0],
  [4,  0.0],
  [8,  0.05],
  [10, 0.25],
  [12, 0.30],
  [14, 0.55],
  [17, 0.65],
  [21, 0.95],
  [24, 1.0],
];

function mealCurveAt(hourOfDay) {
  const h = Math.max(0, Math.min(24, hourOfDay));
  for (let i = 1; i < MEAL_CURVE_POINTS.length; i++) {
    const [h1, p1] = MEAL_CURVE_POINTS[i - 1];
    const [h2, p2] = MEAL_CURVE_POINTS[i];
    if (h <= h2) {
      const t = h2 === h1 ? 0 : (h - h1) / (h2 - h1);
      return p1 + t * (p2 - p1);
    }
  }
  return 1;
}

// Group day records (from loadProgressRange) into ISO weeks (Mon..Sun).
// Each week's `days` is always exactly 7 entries; days outside the fetched range
// are padded as placeholders (targetKcal=null) so day-type counts stay correct.
function groupDaysIntoWeeks(days, now) {
  const byDate = new Map(days.map(d => [d.date, d]));
  const weekStarts = new Set();
  for (const day of days) {
    const wkStart = startOfWeek(new Date(day.date + 'T12:00:00'));
    weekStarts.add(wkStart.toISOString().slice(0, 10));
  }
  const currentWeekKey = startOfWeek(now).toISOString().slice(0, 10);
  weekStarts.add(currentWeekKey);

  const weeks = Array.from(weekStarts).map(key => {
    const weekStart = new Date(key + 'T00:00:00');
    const fullDays = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const dateStr = d.toISOString().slice(0, 10);
      fullDays.push(byDate.get(dateStr) || {
        date: dateStr, foodKcal: 0, workoutKcal: 0,
        weight: null, weightAvg7: null, targetKcal: null,
      });
    }
    return {
      weekStart,
      weekEnd: addDays(weekStart, 6),
      days: fullDays,
      isCurrent: key === currentWeekKey,
    };
  });
  weeks.sort((a, b) => a.weekStart - b.weekStart);
  return weeks;
}

// Sum of (target + workout - food) over days in a week (positive = deficit).
// Days without targetKcal are skipped entirely. Returns { deficit, missingFoodDays }
// where missingFoodDays counts target-known days that had zero food logged — a
// heuristic for "I forgot to log that day" since a real fasted day is rare.
function weeklyNetDeficitStats(weekDays) {
  let sum = 0;
  let usableDays = 0;
  let missingFoodDays = 0;
  for (const d of weekDays) {
    if (d.targetKcal == null) continue;
    sum += d.targetKcal + d.workoutKcal - d.foodKcal;
    usableDays++;
    if (d.foodKcal === 0) missingFoodDays++;
  }
  if (usableDays === 0) return null;
  return { deficit: sum, missingFoodDays };
}

// Pace calculation for the current week.
// Returns { actual, expected, ratio, state, weeklyDeficitGoal, dayIndex, weekDays }
// or null if the goal/profile can't produce a meaningful number.
function computeWeeklyPace(weekDays, goal, now) {
  const weeklyDeficitGoal = goal.weeklyKg * KCAL_PER_KG;
  if (!(weeklyDeficitGoal > 0)) return null;

  // Day-type counts over the full Mon-Sun structure.
  let weekendCount = 0, weekdayCount = 0;
  for (const d of weekDays) {
    if (goal.weekendDays.has(dowLabel(d.date))) weekendCount++;
    else weekdayCount++;
  }
  const R = goal.weekendRatio;
  const divisor = weekdayCount + R * weekendCount;
  if (divisor <= 0) return null;
  const dayDeficitWeekday = weeklyDeficitGoal / divisor;
  const dayDeficitWeekend = dayDeficitWeekday * R;

  let expected = 0, actual = 0;
  let usableDays = 0;
  for (const d of weekDays) {
    const dayStart = new Date(d.date + 'T00:00:00');
    if (now < dayStart) break;
    const dayEndMs = endOfDay(dayStart).getTime();
    // Use the meal curve (not linear time) so today's partial contribution scales
    // with how much food a typical day has consumed by now, avoiding the
    // false-banked signal in the pre-meal hours. Past days collapse to 1.
    let mealFrac = 1;
    if (now.getTime() <= dayEndMs) {
      const hoursIntoDay = (now.getTime() - dayStart.getTime()) / (60 * 60 * 1000);
      mealFrac = mealCurveAt(hoursIntoDay);
    }
    if (d.targetKcal == null) continue;
    const isWe = goal.weekendDays.has(dowLabel(d.date));
    const D_today = isWe ? dayDeficitWeekend : dayDeficitWeekday;
    expected += D_today * mealFrac;
    actual += d.targetKcal * mealFrac + d.workoutKcal - d.foodKcal;
    usableDays++;
  }
  if (usableDays === 0 || expected <= 0) return null;

  const ratio = actual / expected;
  let state;
  if (ratio < 0.85) state = 'behind';
  else if (ratio <= 1.15) state = 'on_pace';
  else if (ratio <= 1.5) state = 'ahead';
  else state = 'way_ahead';

  // 1..7, counts days that have started (including today partial)
  const dayIndex = Math.min(7,
    weekDays.filter(d => now >= new Date(d.date + 'T00:00:00')).length || 1);

  return { actual, expected, ratio, state, weeklyDeficitGoal, dayIndex };
}

function buildPaceTile(pace) {
  const tile = document.createElement('div');
  tile.className = 'pace-tile is-' + pace.state.replace('_', '-');

  // Ring fill: cap visual fill at 1.0 so the arc stays inside the ring.
  const fill = Math.max(0, Math.min(1, pace.ratio));
  const { wrap, inner } = buildCalRing(fill);

  const hero = document.createElement('div');
  hero.className = 'cal-hero';
  hero.textContent = Math.round(pace.ratio * 100) + '%';
  const unit = document.createElement('div');
  unit.className = 'cal-hero-unit';
  unit.textContent = 'of pace';
  inner.append(hero, unit);

  const text = document.createElement('div');
  text.className = 'cal-text';
  const status = document.createElement('div');
  status.className = 'cal-status';
  status.textContent = {
    behind: 'Behind pace',
    on_pace: 'On pace',
    ahead: 'Ahead',
    way_ahead: 'Way ahead',
  }[pace.state];

  const detail = document.createElement('div');
  detail.className = 'cal-detail';
  const actual = Math.round(pace.actual);
  const expected = Math.round(pace.expected);
  const diff = actual - expected;
  const banked = Math.abs(diff);
  detail.textContent = (() => {
    if (pace.state === 'way_ahead') {
      return `Banked ${banked.toLocaleString()} kcal — eat more, this isn't sustainable.`;
    }
    if (pace.state === 'ahead') {
      return `Banked ${banked.toLocaleString()} kcal — room to spare.`;
    }
    if (pace.state === 'behind') {
      return `Short ${banked.toLocaleString()} kcal · ${actual.toLocaleString()} of ${expected.toLocaleString()} expected.`;
    }
    return `${actual.toLocaleString()} of ${expected.toLocaleString()} kcal · day ${pace.dayIndex} of 7.`;
  })();
  text.append(status, detail);

  tile.append(wrap, text);
  return tile;
}

function buildPaceEmpty(reason) {
  const tile = document.createElement('div');
  tile.className = 'pace-tile is-muted';
  const { wrap, inner } = buildCalRing(0);
  const hero = document.createElement('div');
  hero.className = 'cal-hero';
  hero.textContent = '—';
  inner.append(hero);
  const text = document.createElement('div');
  text.className = 'cal-text';
  const status = document.createElement('div');
  status.className = 'cal-status';
  status.textContent = 'Weekly pace';
  const detail = document.createElement('div');
  detail.className = 'cal-detail';
  detail.textContent = reason;
  text.append(status, detail);
  tile.append(wrap, text);
  return tile;
}

function buildWeeklyDeficitChart(weeks, goal) {
  const { fig, svg } = makeChartWrap('Weekly Deficit vs Goal (kcal)');
  const weeklyDeficitGoal = goal.weeklyKg * KCAL_PER_KG;

  const bars = weeks.map(w => {
    const stats = weeklyNetDeficitStats(w.days);
    // Past weeks with 2+ unlogged days are dropped — they show wildly inflated
    // deficits because target credit applies even when food wasn't logged.
    // The current week is always rendered (it's incomplete by definition).
    let deficit = stats?.deficit ?? null;
    if (stats && !w.isCurrent && stats.missingFoodDays >= 2) deficit = null;
    return { label: w.weekStart, isCurrent: w.isCurrent, deficit };
  });
  const vals = bars.map(b => b.deficit).filter(v => v != null);
  if (!vals.length) {
    const t = svgEl('text', { x: CHART_W / 2, y: CHART_H / 2, class: 'chart-empty', 'text-anchor': 'middle' });
    t.textContent = 'Set your profile to see weekly deficits';
    svg.appendChild(t);
    return fig;
  }

  // Goal line is always positive (deficit). Y range covers actual data + goal + symmetric headroom.
  const maxAbs = Math.max(
    Math.abs(Math.min(...vals, 0)),
    Math.abs(Math.max(...vals, weeklyDeficitGoal)),
    weeklyDeficitGoal > 0 ? weeklyDeficitGoal * 1.2 : 1000,
  );
  const yMin = -maxAbs * 1.1;
  const yMax = maxAbs * 1.15;
  const zeroY = chartYPos(0, yMin, yMax);
  const n = bars.length;
  const bw = barWidth(n);

  addChartGrid(svg, yMin, yMax);
  svg.appendChild(svgEl('line', {
    x1: CP.l, y1: zeroY.toFixed(1),
    x2: CHART_W - CP.r, y2: zeroY.toFixed(1),
    class: 'chart-zero-line',
  }));

  // Goal reference line (dashed).
  if (weeklyDeficitGoal > 0) {
    const goalY = chartYPos(weeklyDeficitGoal, yMin, yMax);
    svg.appendChild(svgEl('line', {
      x1: CP.l, y1: goalY.toFixed(1),
      x2: CHART_W - CP.r, y2: goalY.toFixed(1),
      class: 'chart-target-line',
    }));
  }

  // X-axis labels: week-start dates, sparse so they fit.
  const labelEvery = n <= 6 ? 1 : 2;
  for (let i = 0; i < n; i++) {
    if (i % labelEvery !== 0 && i !== n - 1) continue;
    const x = barXPos(i, n) + bw / 2;
    const lbl = svgEl('text', { x: x.toFixed(1), y: CHART_H - 4, class: 'chart-axis-label', 'text-anchor': 'middle' });
    lbl.textContent = bars[i].label.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    svg.appendChild(lbl);
  }

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    if (b.deficit == null) continue;
    // Deficit positive = good (under target) -> render as a bar ABOVE zero in the chart
    // (visually: bar height extends from zeroY upward toward the goal line).
    const yVal = chartYPos(b.deficit, yMin, yMax);
    const by = b.deficit > 0 ? yVal : zeroY;
    const bh = Math.max(1, Math.abs(zeroY - yVal));
    const klass = b.isCurrent
      ? 'chart-bar is-current'
      : 'chart-bar ' + (b.deficit >= 0 ? 'is-under' : 'is-over');
    svg.appendChild(svgEl('rect', {
      x: barXPos(i, n).toFixed(1), y: by.toFixed(1),
      width: bw.toFixed(1), height: bh.toFixed(1),
      rx: '2', class: klass,
    }));
  }

  return fig;
}

let currentProgressRange = 30;

async function renderProgress() {
  const chartsEl = document.getElementById('progress-charts');
  chartsEl.textContent = '';
  const loading = document.createElement('p');
  loading.className = 'progress-loading';
  loading.textContent = 'Loading…';
  chartsEl.appendChild(loading);

  const now = new Date();
  const endDate = now;
  let startDate;
  if (currentProgressRange === 0) {
    const first = await db.entries.orderBy('timestamp').first();
    startDate = first ? startOfDay(new Date(first.timestamp)) : startOfDay(addDays(endDate, -29));
  } else {
    startDate = startOfDay(addDays(endDate, -(currentProgressRange - 1)));
  }

  // For the weekly deficit chart we want a stable look-back of ~10 weeks regardless of
  // the user-selected range. Fetch the wider span if the active range is shorter.
  const weeklyStart = startOfWeek(addDays(now, -(WEEKLY_CHART_WEEKS - 1) * 7));
  const fetchStart = weeklyStart < startDate ? weeklyStart : startDate;

  const { days } = await loadProgressRange(fetchStart, endDate);
  chartsEl.textContent = '';

  // Days inside the user-selected range only (for the top three charts).
  const rangeStartTs = startOfDay(startDate).getTime();
  const rangeDays = days.filter(d => new Date(d.date + 'T00:00:00').getTime() >= rangeStartTs);
  const todayStr = now.toISOString().slice(0, 10);
  const completeDays = rangeDays.filter(d => d.date !== todayStr);
  chartsEl.appendChild(buildWeightChart(rangeDays));
  chartsEl.appendChild(buildCaloriesChart(rangeDays));
  chartsEl.appendChild(buildNetBalanceChart(completeDays));

  // Weekly goal section at the bottom — pace tile + weekly bars.
  const goal = getGoal();
  const weeks = groupDaysIntoWeeks(days, now);
  const lastWeeks = weeks.slice(-WEEKLY_CHART_WEEKS);

  const section = document.createElement('section');
  section.className = 'pace-section';
  const heading = document.createElement('h2');
  heading.className = 'pace-section-title';
  heading.textContent = 'Weekly Goal';
  section.appendChild(heading);

  const currentWeek = weeks.find(w => w.isCurrent);
  if (!(goal.weeklyKg > 0)) {
    section.appendChild(buildPaceEmpty('Set a goal in Settings to see your weekly pace.'));
  } else if (!currentWeek) {
    section.appendChild(buildPaceEmpty('No data this week yet.'));
  } else {
    const pace = computeWeeklyPace(currentWeek.days, goal, now);
    section.appendChild(pace
      ? buildPaceTile(pace)
      : buildPaceEmpty('Set your profile so a maintenance target is available.'));
  }
  section.appendChild(buildWeeklyDeficitChart(lastWeeks, goal));
  chartsEl.appendChild(section);
}

function initProgressPanel() {
  const btn = document.getElementById('progress-btn');
  const overlay = document.getElementById('progress-overlay');
  const closeBtn = document.getElementById('progress-close');
  const chipRow = document.getElementById('progress-range-chips');
  if (!btn || !overlay) return;

  btn.addEventListener('click', () => {
    overlay.classList.remove('hidden');
    renderProgress();
  });
  closeBtn.addEventListener('click', () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });

  for (const chip of chipRow.querySelectorAll('.range-chip')) {
    chip.addEventListener('click', () => {
      for (const c of chipRow.querySelectorAll('.range-chip')) c.classList.remove('is-active');
      chip.classList.add('is-active');
      currentProgressRange = parseInt(chip.dataset.range, 10);
      renderProgress();
    });
  }
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------
function initSkipOverlay() {
  function closeSkip() {
    els.skipOverlay.classList.add('hidden');
    els.skipReasonInput.value = '';
  }
  els.skipCancelBtn.addEventListener('click', closeSkip);
  els.skipOverlay.addEventListener('click', (e) => { if (e.target === els.skipOverlay) closeSkip(); });
  els.skipConfirmBtn.addEventListener('click', () => {
    const reason = els.skipReasonInput.value.trim();
    closeSkip();
    createSkipMarker(reason);
  });
}

function init() {
  for (const btn of els.tabs) {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  }
  els.prevBtn.addEventListener('click', () => setDate(addDays(currentDate, -1)));
  els.nextBtn.addEventListener('click', () => {
    if (isSameDay(currentDate, new Date())) return;
    setDate(addDays(currentDate, 1));
  });

  // Swipe left/right on the day surface to change day. Don't preventDefault so
  // native vertical scrolling stays intact; only horizontal-dominant swipes count.
  let swipeStartX = 0;
  let swipeStartY = 0;
  els.main.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    swipeStartX = t.clientX;
    swipeStartY = t.clientY;
  }, { passive: true });
  els.main.addEventListener('touchend', (e) => {
    if (e.target.closest('input, textarea, select, button, .tabs')) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipeStartX;
    const dy = t.clientY - swipeStartY;
    if (Math.abs(dx) <= 60 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
    if (dx > 0) {
      setDate(addDays(currentDate, -1));
    } else if (!isSameDay(currentDate, new Date())) {
      setDate(addDays(currentDate, 1));
    }
  }, { passive: true });
  initSettingsPanel();
  initProgressPanel();
  initSkipOverlay();
  rebuildFrequentFoods();
  refreshAll();
}

init();
