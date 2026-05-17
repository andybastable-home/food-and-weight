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

// ------------------------------------------------------------------
// Type config — single source of truth for per-type behavior
// ------------------------------------------------------------------
const TYPES = {
  food: {
    label: 'Food',
    placeholder: 'What did you eat?',
    inputKind: 'text',
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
  const entry = { type };

  if (config.inputKind === 'text') {
    const text = (formData.text || '').trim();
    if (!text) return false;
    entry.text = text;
  } else {
    const value = parseFloat(formData.value);
    if (Number.isNaN(value) || value <= 0) return false;
    entry.value = value;
  }

  if (isSameDay(currentDate, new Date())) {
    entry.timestamp = Date.now();
  } else {
    entry.timestamp = combineDayAndTime(currentDate, '12:00');
  }

  if (config.hasTimeCategory) {
    entry.timeCategory = formData.timeCategory || getTimeCategory(entry.timestamp);
  }

  if (type === 'food' && formData.calories) {
    const calories = parseFloat(formData.calories);
    if (!Number.isNaN(calories) && calories > 0) {
      entry.calories = calories;
    }
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
  await db.entries.delete(id);
  confirmingDeleteId = null;
  if (typeof deleteEntryFromSheet === 'function') {
    deleteEntryFromSheet(id).catch(() => {});
  }
  await refreshList();
}

function startDeleteConfirm(id) {
  confirmingDeleteId = id;
  refreshList();
}

function cancelDeleteConfirm() {
  confirmingDeleteId = null;
  refreshList();
}

function setDate(date) {
  currentDate = startOfDay(date);
  confirmingDeleteId = null;
  isFormOpen = false;
  refreshAll();
}

function setTab(tab) {
  if (currentTab === tab) return;
  currentTab = tab;
  confirmingDeleteId = null;
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text.slice(0, 120)}`);
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
}

function initSettingsPanel() {
  const btn = document.getElementById('settings-btn');
  const overlay = document.getElementById('settings-overlay');
  const closeBtn = document.getElementById('settings-close');
  const keyEl = document.getElementById('cfg-ai-key');
  const ctxEl = document.getElementById('cfg-ai-context');

  if (!btn || !overlay) return;

  btn.addEventListener('click', () => {
    loadSettingsValues();
    overlay.classList.remove('hidden');
  });

  function closePanel() {
    overlay.classList.add('hidden');
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
  const input = document.createElement('input');
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
  if (currentTab === 'food') {
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
        const result = await requestGeminiEstimation(text);
        if (result.title) input.value = result.title;
        if (result.calories) caloriesInput.value = result.calories;
        const conf = result.confidence || 'Low';
        const cls = conf === 'Excellent' ? 'confidence-excellent'
          : conf === 'Moderate' ? 'confidence-moderate' : 'confidence-low';
        aiStatusLog.className = `ai-status-log ${cls}`;
        aiStatusLog.textContent = `✨ Confidence: ${conf} — ${result.reasoning || ''}`;
      } catch (err) {
        aiStatusLog.className = 'ai-status-log confidence-error';
        const msg = err.message.includes('No API key') ? 'Set your Gemini key in the AI tab first.' : 'Request failed — check your API key or connection.';
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
    if (currentTab === 'food' && caloriesInput) {
      formData.calories = caloriesInput.value;
    }
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

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'entry-row';
  btn.setAttribute('aria-label', `Delete entry: ${config.formatDisplay(entry)}`);
  btn.addEventListener('click', () => startDeleteConfirm(entry.id));

  const display = document.createElement('span');
  display.className = config.inputKind === 'number' ? 'entry-value' : 'entry-text';
  display.textContent = config.formatDisplay(entry);

  btn.append(display);

  if (entry.type === 'food' && entry.calories) {
    const cal = document.createElement('span');
    cal.className = 'entry-calories';
    cal.textContent = `${Math.round(entry.calories)} kcal`;
    btn.append(cal);
  }

  li.append(btn);
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

  if (entry.type === 'food' && entry.calories) {
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
