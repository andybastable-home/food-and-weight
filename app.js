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
const SHEET_SCHEMA_VERSION = 3;

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
    label: 'Workout',
    placeholder: 'What did you do?',
    inputKind: 'text',
    hasTimeCategory: true,
    hasEffort: true,
    isCollapsible: true,
    formatDisplay: (e) => e.text,
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
  if (diffDays === 0) return { main: 'Today', sub: full };
  if (diffDays === 1) return { main: 'Yesterday', sub: full };
  return { main: full, sub: '' };
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

const els = {
  dateLabel: document.getElementById('date-label'),
  dateSub: document.getElementById('date-sub'),
  prevBtn: document.getElementById('prev-day'),
  nextBtn: document.getElementById('next-day'),
  tabs: Array.from(document.querySelectorAll('.tab')),
  formContainer: document.getElementById('entry-form-container'),
  list: document.getElementById('entries-list'),
  empty: document.getElementById('empty-state'),
  calTotal: document.getElementById('calories-total'),
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
        entry.calorieSource = 'gemini';
      } else {
        entry.calorieSource = 'user';
      }
    }
  }

  if (config.hasEffort) {
    entry.effort = formData.effort || 'low';
  }

  const id = await db.entries.add(entry);
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
  refreshAll();
}

function setTab(tab) {
  if (currentTab === tab) return;
  currentTab = tab;
  confirmingDeleteId = null;
  retroConfirmState = null;
  isFormOpen = false;
  refreshAll();
}

// ------------------------------------------------------------------
// AI estimation
// ------------------------------------------------------------------
async function requestGeminiEstimation(inputText) {
  const apiKey = (localStorage.getItem('fw_gemini_key') || '').trim();
  const contextText = (localStorage.getItem('fw_gemini_context') || '').trim();

  if (!apiKey) throw new Error('No API key configured — set it in the AI tab.');

  const prompt = `You are a personal diet assistant tracker. Estimate calories for the food item using the following context guidelines:\n\n[CONTEXT]\n${contextText}\n\n[INPUT]\n${inputText}\n\nRespond with a JSON object matching this exact schema:\n{\n  "calories": <number>,\n  "title": "<string with a relevant food emoji prefix>",\n  "confidence": "<one of: Excellent, Moderate, Low>",\n  "reasoning": "<brief explanation>"\n}`;

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

  const prompt = `You are a conservative exercise calorie estimator. Err on the side of underestimating calories burned to maintain conservative diet goals. The user is a ${age}yo ${sex}, ${height}cm, ${weight}kg.\n\n[ACTIVITY]\n${inputText}\n\n[EFFORT]\nUser-reported effort: ${effortKey} — ${effortLine}\nUse this to calibrate intensity assumptions (pace, heart-rate zone, work-to-rest ratio).\n\nRespond with a JSON object matching this exact schema:\n{\n  "calories": <number>,\n  "title": "<string with a relevant activity emoji prefix>",\n  "confidence": "<one of: Excellent, Moderate, Low>",\n  "reasoning": "<brief explanation>"\n}`;

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
// Settings panel
// ------------------------------------------------------------------
function loadSettingsValues() {
  const keyEl = document.getElementById('cfg-ai-key');
  const ctxEl = document.getElementById('cfg-ai-context');
  if (keyEl) keyEl.value = localStorage.getItem('fw_gemini_key') || '';
  if (ctxEl) ctxEl.value = localStorage.getItem('fw_gemini_context') || '';

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
  const target = await computeMaintenanceTarget();
  if (target) {
    preview.textContent = `Estimated maintenance: ${target} kcal/day (sedentary ×1.2). Workout calories will be added in future.`;
  } else {
    preview.textContent = 'Weight is taken from your most recent logged entry. Target uses sedentary activity (×1.2); workout calories will be added in future.';
  }
}

async function computeMaintenanceTarget() {
  const sex = localStorage.getItem('fw_cal_sex') || '';
  const age = parseFloat(localStorage.getItem('fw_cal_age') || '');
  const height = parseFloat(localStorage.getItem('fw_cal_height') || '');
  if (!sex || !age || !height) return null;

  const latestWeight = await db.entries
    .where('type').equals('weight')
    .reverse().sortBy('timestamp')
    .then((rows) => rows[0]?.value ?? null);
  if (!latestWeight) return null;

  // Mifflin-St Jeor BMR
  const bmr = sex === 'male'
    ? 10 * latestWeight + 6.25 * height - 5 * age + 5
    : 10 * latestWeight + 6.25 * height - 5 * age - 161;
  return Math.round(bmr * 1.2);
}

function initSettingsPanel() {
  const btn = document.getElementById('settings-btn');
  const overlay = document.getElementById('settings-overlay');
  const closeBtn = document.getElementById('settings-close');
  const keyEl = document.getElementById('cfg-ai-key');
  const ctxEl = document.getElementById('cfg-ai-context');
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

  function saveCalField() {
    if (sexEl) localStorage.setItem('fw_cal_sex', sexEl.value);
    if (ageEl) localStorage.setItem('fw_cal_age', ageEl.value.trim());
    if (htEl) localStorage.setItem('fw_cal_height', htEl.value.trim());
    updateCalTargetPreview();
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

function renderDateNav() {
  const { main, sub } = formatDateLabel(currentDate);
  els.dateLabel.textContent = main;
  els.dateSub.textContent = sub;
  els.dateSub.hidden = !sub;

  const onToday = isSameDay(currentDate, new Date());
  els.nextBtn.disabled = onToday;
  els.nextBtn.setAttribute('aria-disabled', onToday ? 'true' : 'false');
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

function renderEntryForm() {
  const config = TYPES[currentTab];

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
        if (result.title) {
          form.dataset.aiSuggestedTitle = result.title;
          input.value = result.title;
        }
        if (result.calories != null) {
          form.dataset.aiSuggestedCalories = String(result.calories);
          caloriesInput.value = result.calories;
        }
        if (result.confidence) form.dataset.aiConfidence = result.confidence;
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

    form.appendChild(wrap);
    form.appendChild(aiStatusLog);
    form.appendChild(caloriesWrap);
  } else {
    form.appendChild(wrap);
  }

  if (config.hasTimeCategory) {
    const defaultCategory = getTimeCategory(Date.now());
    const pills = buildCategoryPills(defaultCategory);
    form.appendChild(pills);
  }

  if (config.hasEffort) {
    form.appendChild(buildEffortPills('low'));
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
  const entries = await loadEntries(currentDate, currentTab);
  renderEntries(entries);

  if (currentTab === 'food' || currentTab === 'workout') {
    const foodDay = currentTab === 'food' ? entries : await loadEntries(currentDate, 'food');
    const workoutDay = currentTab === 'workout' ? entries : await loadEntries(currentDate, 'workout');
    const foodTotal = Math.round(foodDay.reduce((sum, e) => sum + (e.calories || 0), 0));
    const workoutTotal = Math.round(workoutDay.reduce((sum, e) => sum + (e.calories || 0), 0));
    const target = await computeMaintenanceTarget();

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
  els.calTotal.classList.remove('is-under', 'is-over', 'is-muted');

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
    hint.textContent = 'Set weight & profile for a target';
    text.append(status, hint);

    els.calTotal.append(wrap, text);
    return;
  }

  const finalTarget = target + workoutTotal;
  const remaining = finalTarget - foodTotal;
  const isUnder = remaining >= 0;
  els.calTotal.classList.add(isUnder ? 'is-under' : 'is-over');

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
  status.textContent = isUnder ? 'under target' : 'over target';
  const detail = document.createElement('div');
  detail.className = 'cal-detail';
  const workoutPart = workoutTotal > 0 ? ` (+${workoutTotal.toLocaleString()} workout)` : '';
  detail.textContent = `eaten ${foodTotal.toLocaleString()} · target ${target.toLocaleString()}${workoutPart}`;
  text.append(status, detail);

  els.calTotal.append(wrap, text);
}

async function refreshAll() {
  renderTabs();
  renderDateNav();
  renderEntryForm();
  await refreshList();
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------
function init() {
  for (const btn of els.tabs) {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  }
  els.prevBtn.addEventListener('click', () => setDate(addDays(currentDate, -1)));
  els.nextBtn.addEventListener('click', () => {
    if (isSameDay(currentDate, new Date())) return;
    setDate(addDays(currentDate, 1));
  });
  initSettingsPanel();
  refreshAll();
}

init();
