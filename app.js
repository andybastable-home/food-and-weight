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
// Sedentary baseline: logged activity is added on top, so the baseline must assume
// no deliberate exercise (1.2). A higher factor would double-count logged activity.
const ACTIVITY_MULTIPLIER = 1.2;
const WEIGHT_STALENESS_LIMIT_DAYS = 14;

// kcal per kg of body weight — converts a calorie deficit into a weight-loss rate.
const KCAL_PER_KG = 7700;

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
// Resize an image File to a max-edge JPEG, returned as bare base64 (no data: prefix).
async function fileToResizedJpegBase64(file, maxEdge = 1024, quality = 0.85) {
  if (!file || !file.type.startsWith('image/')) throw new Error('not an image');
  if (file.size > 8 * 1024 * 1024) throw new Error('image too large (max 8MB)');

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('could not read file'));
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload  = () => resolve(im);
    im.onerror = () => reject(new Error('could not decode image'));
    im.src = dataUrl;
  });

  const scale  = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(img.width  * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const out = canvas.toDataURL('image/jpeg', quality);
  return out.slice(out.indexOf(',') + 1);
}

// Single Gemini call. Returns { calories, title, confidence, reasoning } regardless
// of whether the model replies with the array schema or (defensively) an object.
async function geminiGenerate(apiKey, model, parts) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json' } }),
  });
  if (!res.ok) {
    if (res.status >= 500) throw new Error('Gemini is busy right now — please try again in a moment.');
    if (res.status === 429 || res.status === 403) throw new Error('AI quota reached — please try again later.');
    throw new Error('Request failed — check your API key or connection.');
  }
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Empty response from Gemini');
  const out = JSON.parse(raw);
  const [calories, title, confidence, reasoning] = Array.isArray(out)
    ? out
    : [out.calories, out.title, out.confidence, out.reasoning]; // tolerate object form at this API boundary
  return { calories, title, confidence, reasoning };
}

async function requestGeminiEstimation(inputText, photoBase64) {
  const apiKey = (localStorage.getItem('fw_gemini_key') || '').trim();
  const contextText = (localStorage.getItem('fw_gemini_context') || '').trim();

  if (!apiKey) throw new Error('No API key configured — set it in the AI tab.');

  const prompt = `You are a personal diet assistant helping with weight loss. Estimate calories for the food as accurately as possible. Give your best central, most-likely estimate — do not deliberately bias the number high or low. When portion or recipe details are given, use them rather than assuming larger restaurant-style portions. If a photo is attached, use it as the primary signal — read any recipe text, packaging, portion size, or the plate — and treat the text as extra detail.\n\n[PERSONAL DIET PROFILE]\n${contextText || 'No personal profile set.'}\n\n[INPUT]\n${inputText}\n\nRespond with a JSON array matching this exact schema:\n[\n  <number_calories>,\n  "<emoji> <string_short_title>",\n  "<confidence_one_of: Excellent|Moderate|Low>",\n  "<reasoning_max_25_words_focus_only_on_raw_ingredients_weights_and_densities_no_methodology_filler>"\n]\n\nExample: [842, "🍳 Scrambled Eggs & Toast", "Excellent", "3 eggs (195 kcal), dash of milk, 20g Norpak spread, 55g homemade bread slice."]`;

  const parts = [{ text: prompt }];
  if (photoBase64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: photoBase64 } });

  const model = photoBase64 ? 'gemini-3.5-flash' : 'gemini-2.5-flash';
  return geminiGenerate(apiKey, model, parts);
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

  const prompt = `You are a conservative exercise calorie estimator helping with weight loss. Estimate calories burned as accurately as possible. Where there is genuine uncertainty, err on the side of underestimating (not overestimating) to support weight loss goals — but do not adjust estimates that already have high confidence. The user is a ${age}yo ${sex}, ${height}cm, ${weight}kg.\n\n[PERSONAL FITNESS PROFILE]\n${fitnessContext || 'No personal profile set.'}\n\n[ACTIVITY]\n${inputText}\n\n[EFFORT]\nUser-reported effort: ${effortKey} — ${effortLine}\nUse this to calibrate intensity assumptions (pace, heart-rate zone, work-to-rest ratio).\n\nRespond with a JSON array matching this exact schema:\n[\n  <number_calories_burned>,\n  "<emoji> <string_short_title>",\n  "<confidence_one_of: Excellent|Moderate|Low>",\n  "<reasoning_max_25_words_focus_only_on_raw_MET_values_durations_and_biometrics_no_methodology_filler>"\n]\n\nExample: [240, "🏃 Evening Run", "Excellent", "22.5 min weeding (3.0 METs) + 22.5 min vigorous raking (4.5 METs), medium effort, 115 bpm."]`;

  return geminiGenerate(apiKey, 'gemini-2.5-flash', [{ text: prompt }]);
}

// ------------------------------------------------------------------
// Frequent-items index (local fuzzy match for repeat foods)
// ------------------------------------------------------------------
let frequentFoods = [];
let frequentHaystack = [];
let frequentIndexBy = [];
const uf = new uFuzzy({ intraMode: 1, intraIns: 1, intraSub: 1, intraTrn: 1, intraDel: 1 });
const FREQUENT_THRESHOLD = 3;
const MIN_QUERY_LEN = 3;

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
}

async function updateCalTargetPreview() {
  const preview = document.getElementById('cfg-cal-preview');
  if (!preview) return;
  const info = await computeMaintenanceTarget();
  const target = info?.targetKcal;
  if (target) {
    preview.textContent = `Estimated maintenance: ${target} kcal/day (7-day weight average × 1.2 sedentary baseline; logged activity adds on top).`;
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

    // Transient photo for AI food estimation — lives only in this closure, never
    // persisted; resets on every re-render (including post-submit).
    let pendingPhotoBase64 = null;
    let photoPreview = null;
    if (currentTab === 'food') {
      const cameraBtn = document.createElement('button');
      cameraBtn.type = 'button';
      cameraBtn.className = 'camera-button';
      cameraBtn.textContent = '📷';
      cameraBtn.setAttribute('aria-label', 'Add a food photo');

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.capture = 'environment';
      fileInput.hidden = true;

      photoPreview = document.createElement('div');
      photoPreview.className = 'photo-preview hidden';
      const thumb = document.createElement('img');
      thumb.className = 'photo-preview-thumb';
      thumb.alt = 'Food photo';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'photo-preview-remove';
      removeBtn.textContent = '×';
      removeBtn.setAttribute('aria-label', 'Remove photo');
      photoPreview.append(thumb, removeBtn);

      cameraBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        try {
          pendingPhotoBase64 = await fileToResizedJpegBase64(file);
          thumb.src = `data:image/jpeg;base64,${pendingPhotoBase64}`;
          photoPreview.classList.remove('hidden');
        } catch (err) {
          aiStatusLog.className = 'ai-status-log confidence-error';
          aiStatusLog.textContent = `Couldn't use that photo: ${err.message}`;
        }
      });
      removeBtn.addEventListener('click', () => {
        pendingPhotoBase64 = null;
        fileInput.value = '';
        photoPreview.classList.add('hidden');
      });

      caloriesWrap.appendChild(cameraBtn);
      caloriesWrap.appendChild(fileInput);
    }

    const aiBtn = document.createElement('button');
    aiBtn.type = 'button';
    aiBtn.className = 'ai-button';
    aiBtn.textContent = '✨';
    aiBtn.setAttribute('aria-label', 'Estimate calories with AI');
    aiBtn.addEventListener('click', async () => {
      const text = input.value.trim();
      const blocked = currentTab === 'food' ? (!text && !pendingPhotoBase64) : !text;
      if (blocked) {
        aiStatusLog.className = 'ai-status-log confidence-error';
        aiStatusLog.textContent = 'Enter a description first.';
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
          result = await requestGeminiEstimation(text, pendingPhotoBase64);
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
        aiStatusLog.textContent = err.message.includes('No API key') ? 'Set your Gemini key in Settings first.' : err.message;
      } finally {
        aiBtn.disabled = false;
        aiBtn.textContent = '✨';
      }
    });
    caloriesWrap.appendChild(aiBtn);

    if (currentTab === 'food') {
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
      if (photoPreview) form.appendChild(photoPreview);
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
    // A past day with no food logged has no meaningful daily balance — hide the pane.
    const isToday = currentDate.getTime() === startOfDay(new Date()).getTime();
    if (!isToday && foodDay.length === 0) {
      els.calTotal.hidden = true;
      return;
    }
    const workoutDay = currentTab === 'workout' ? entries : await loadEntries(currentDate, 'workout');
    const foodTotal = Math.round(foodDay.reduce((sum, e) => sum + (e.calories || 0), 0));
    const workoutTotal = Math.round(workoutDay.reduce((sum, e) => sum + (e.calories || 0), 0));
    const targetInfo = await computeMaintenanceTarget(currentDate);
    const target = targetInfo?.targetKcal ?? null;
    const rolling = target ? await computeRollingDeficit(currentDate) : null;

    renderCalorieTotal({ foodTotal, workoutTotal, target, rolling });
    els.calTotal.hidden = false;
  } else {
    els.calTotal.hidden = true;
  }
}

// Average daily net deficit over the trailing `windowDays` complete days before
// `date` (positive = deficit). Days with no food logged are treated as unlogged
// and skipped. Returns { avgDaily, daysUsed } or null when there's nothing usable.
async function computeRollingDeficit(date, windowDays = 7) {
  const { days } = await loadProgressRange(addDays(date, -windowDays), addDays(date, -1));
  let sum = 0, used = 0;
  for (const d of days) {
    if (d.targetKcal == null || d.foodKcal === 0) continue;
    sum += d.targetKcal + d.workoutKcal - d.foodKcal;
    used++;
  }
  if (used === 0) return null;
  return { avgDaily: sum / used, daysUsed: used };
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

function renderCalorieTotal({ foodTotal, workoutTotal, target, rolling }) {
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
  const todayDeficit = remaining >= 0;

  // Two independent signals: the hero number reflects TODAY (caution colour when it
  // was a surplus, green when a deficit), while the ring, status and affirm line are
  // coloured off the 7-day rolling deficit — so the week's verdict frames today's
  // number without one heavy day repainting everything.
  // The rolling verdict is optimistic under partial data: until a near-complete week
  // is logged we assume the week is good (green) rather than judging it off a sparse
  // window, which early ramp-up days would otherwise show as a phantom surplus.
  const ROLLING_VERDICT_MIN_DAYS = 6;
  const r = rolling ? Math.round(rolling.avgDaily) : null; // +ve = banking a deficit
  const enoughForVerdict = rolling != null && rolling.daysUsed >= ROLLING_VERDICT_MIN_DAYS;
  const rollingGood = !enoughForVerdict || r >= 75; // optimistic when partial
  const rollingOver = enoughForVerdict && r <= -75;
  const weekBanking = enoughForVerdict && rollingGood; // enough data to cite a figure

  els.calTotal.classList.add(rollingGood ? 'is-under' : 'is-near');

  const progress = finalTarget > 0 ? foodTotal / finalTarget : 0;
  const { wrap, inner } = buildCalRing(progress);

  inner.classList.add(todayDeficit ? 'is-deficit' : 'is-surplus');
  const hero = document.createElement('div');
  hero.className = 'cal-hero';
  hero.textContent = Math.abs(remaining).toLocaleString();
  const unit = document.createElement('div');
  unit.className = 'cal-hero-unit';
  unit.textContent = todayDeficit ? 'under' : 'over';
  inner.append(hero, unit);

  const text = document.createElement('div');
  text.className = 'cal-text';
  const status = document.createElement('div');
  status.className = 'cal-status';
  status.textContent = rollingGood ? 'on track'
    : rollingOver ? 'over this week'
    : 'holding steady';

  const workoutPart = workoutTotal > 0 ? ` (+${workoutTotal.toLocaleString()} activity)` : '';
  const detail = document.createElement('div');
  detail.className = 'cal-detail';
  detail.textContent = `eaten ${foodTotal.toLocaleString()} · maintenance ${target.toLocaleString()}${workoutPart}`;
  text.append(status, detail);

  // Warm framing keyed off today + the week — what stops a big day feeling like failure.
  const affirm = document.createElement('div');
  affirm.className = 'cal-affirm';
  if (todayDeficit) {
    affirm.textContent = weekBanking
      ? `Banking ~${r.toLocaleString()} kcal/day this week — nice work.`
      : `Under today — keep stacking them up.`;
  } else if (rollingGood) {
    affirm.textContent = weekBanking
      ? `Over today, but you're well in the deficit this week — no harm done.`
      : `Over today — recent days have been solid, no harm done.`;
  } else if (rollingOver) {
    affirm.textContent = `A bit over today and for the week — a lighter day or two will bring it back.`;
  } else {
    affirm.textContent = `Over today — roughly even this week. Back at it tomorrow.`;
  }
  text.append(affirm);

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
// This week: outlook tile + weekly deficit chart
// ------------------------------------------------------------------

const WEEKLY_CHART_WEEKS = 10;

// Least-squares slope of y over x. Returns y-per-x, or null if undefined.
function linregSlope(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return (n * sxy - sx * sy) / denom;
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

// Weekly outlook: a forward-looking weight-loss rate (kg/wk) read two ways, framed
// optimistically. The conservative end (`low`) drives the verdict so it can only
// pleasantly surprise; the trend line is the proof beneath.
//  - forecastLoss: from the trailing 7 *complete* logged days' net deficit. Today's
//    partial day is deliberately excluded, so logging meals never moves the number.
//    Intake estimates are unbiased best-guesses, so this is a central estimate, not
//    a deliberately conservative one — the `low`-end verdict supplies the caution.
//  - trendLoss: from a regression of morning weight over ~14 days (the actual scale).
// Returns { forecastLoss, trendLoss, low, high, band, showNumber } or null.
function computeWeeklyOutlook(days, now) {
  // Match the day-record date convention (local startOfDay → ISO date) so today is
  // excluded correctly even in a +UTC timezone, where now.toISOString() is a day ahead.
  const todayStr = startOfDay(now).toISOString().slice(0, 10);
  const complete = days.filter(d => d.date < todayStr);

  // Forecast from the trailing 7 complete days that were actually logged.
  let forecastLoss = null;
  const last7 = complete.slice(-7).filter(d => d.targetKcal != null && d.foodKcal > 0);
  if (last7.length >= 3) {
    const avgDaily = last7.reduce((s, d) => s + (d.targetKcal + d.workoutKcal - d.foodKcal), 0) / last7.length;
    forecastLoss = (avgDaily * 7) / KCAL_PER_KG;
  }

  // Trend from a regression of morning weight over the trailing ~14 days (+ today).
  const trendPts = days
    .slice(-15)
    .filter(d => d.weight != null)
    .map(d => ({ x: new Date(d.date + 'T00:00:00').getTime() / 86400000, y: d.weight }));
  let trendLoss = null;
  if (trendPts.length >= 4) {
    const slope = linregSlope(trendPts); // kg/day
    if (slope != null) trendLoss = -slope * 7;
  }

  // Cap at 1 kg/wk — Andy isn't aiming beyond that, and it stops the upper end of
  // the range reading oddly specific (e.g. 1.1). Also why the ring is full at 1 kg/wk.
  const CAP_KG_PER_WK = 1.0;
  if (forecastLoss != null) forecastLoss = Math.min(forecastLoss, CAP_KG_PER_WK);
  if (trendLoss != null) trendLoss = Math.min(trendLoss, CAP_KG_PER_WK);

  const estimates = [forecastLoss, trendLoss].filter(v => v != null);
  if (!estimates.length) return null;
  const low = Math.min(...estimates);
  const high = Math.max(...estimates);

  // Two-layer guard: only call a gain when the effort says surplus AND the scale
  // confirms it's flat-or-up. Either alone is within noise.
  const gaining = forecastLoss != null && forecastLoss < -0.05
    && trendLoss != null && trendLoss <= 0.05;

  let band;
  if (gaining) band = 'gaining';
  else if (low >= 0.3) band = 'great';
  else if (low >= 0.1) band = 'steady';
  else band = 'holding';

  // Below ~0.2 kg/wk a number is inside scale noise — show words, not false precision.
  const showNumber = !gaining && low >= 0.2;

  return { forecastLoss, trendLoss, low, high, band, showNumber };
}

const OUTLOOK_WORD = {
  great: 'Great progress',
  steady: 'Steady drop',
  holding: 'Holding steady',
  gaining: 'Edging up',
};

function fmtKg(v) {
  return (Math.round(v * 10) / 10).toFixed(1);
}

function buildOutlookTile(outlook) {
  const tile = document.createElement('div');
  tile.className = 'pace-tile is-' + outlook.band;

  // Fill maps the conservative rate over 0..1 kg/wk, so the arc grows as you earn it.
  const fillVal = outlook.band === 'gaining'
    ? 0.06
    : Math.max(0.06, Math.min(1, outlook.low / 1.0));
  const { wrap, inner } = buildCalRing(fillVal);

  const hero = document.createElement('div');
  hero.className = 'cal-hero';
  const unit = document.createElement('div');
  unit.className = 'cal-hero-unit';
  if (outlook.showNumber) {
    hero.textContent = fmtKg(outlook.low);
    unit.textContent = 'kg/wk';
  } else if (outlook.band === 'gaining') {
    hero.textContent = '↑';
    unit.textContent = 'this week';
  } else if (outlook.band === 'holding') {
    hero.textContent = '≈';
    unit.textContent = 'holding';
  } else {
    hero.textContent = '↓';
    unit.textContent = 'this week';
  }
  inner.append(hero, unit);

  const text = document.createElement('div');
  text.className = 'cal-text';
  const status = document.createElement('div');
  status.className = 'cal-status';
  status.textContent = OUTLOOK_WORD[outlook.band];

  const detail = document.createElement('div');
  detail.className = 'cal-detail';
  if (outlook.band === 'gaining') {
    detail.textContent = 'Up a little this week — a lighter day or two will set it right.';
  } else if (!outlook.showNumber) {
    detail.textContent = outlook.band === 'holding'
      ? 'Holding steady — not gaining. Back at it tomorrow.'
      : 'Heading the right way — still early in the week.';
  } else {
    const lo = fmtKg(outlook.low);
    const hi = fmtKg(outlook.high);
    const range = (outlook.high - outlook.low >= 0.1) ? `${lo}–${hi}` : `~${lo}`;
    detail.textContent = outlook.band === 'great'
      ? `On track for ${range} kg this week — brilliant.`
      : `On track for ${range} kg this week — keep it rolling.`;
  }
  text.append(status, detail);

  tile.append(wrap, text);
  return tile;
}

function buildOutlookEmpty(reason) {
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
  status.textContent = 'This week';
  const detail = document.createElement('div');
  detail.className = 'cal-detail';
  detail.textContent = reason;
  text.append(status, detail);
  tile.append(wrap, text);
  return tile;
}

function buildWeeklyDeficitChart(weeks) {
  const { fig, svg } = makeChartWrap('Weekly Deficit (kcal)');

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

  // Y range covers actual data with symmetric headroom.
  const maxAbs = Math.max(
    Math.abs(Math.min(...vals, 0)),
    Math.abs(Math.max(...vals, 0)),
    1000,
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
    // Deficit positive = good (under maintenance) -> bar extends above the zero line.
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
  // startOfDay → ISO matches how day records are keyed, so the partial current day
  // is reliably dropped from the net-balance chart (avoids a phantom huge deficit).
  const todayStr = startOfDay(now).toISOString().slice(0, 10);
  const completeDays = rangeDays.filter(d => d.date !== todayStr);
  chartsEl.appendChild(buildWeightChart(rangeDays));
  chartsEl.appendChild(buildCaloriesChart(rangeDays));
  chartsEl.appendChild(buildNetBalanceChart(completeDays));

  // This-week section at the bottom — outlook tile + weekly bars.
  const weeks = groupDaysIntoWeeks(days, now);
  const lastWeeks = weeks.slice(-WEEKLY_CHART_WEEKS);

  const section = document.createElement('section');
  section.className = 'pace-section';
  const heading = document.createElement('h2');
  heading.className = 'pace-section-title';
  heading.textContent = 'This Week';
  section.appendChild(heading);

  const outlook = computeWeeklyOutlook(days, now);
  section.appendChild(outlook
    ? buildOutlookTile(outlook)
    : buildOutlookEmpty('Log a few days and your weight to see where this week is heading.'));
  section.appendChild(buildWeeklyDeficitChart(lastWeeks));
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
