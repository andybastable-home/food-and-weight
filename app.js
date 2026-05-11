// ------------------------------------------------------------------
// Service worker
// ------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.error('Service worker registration failed', err);
    });
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
    showTimeOnAdd: true,
    formatDisplay: (e) => e.text,
  },
  weight: {
    label: 'Weight',
    placeholder: '0.0',
    inputKind: 'number',
    inputStep: '0.1',
    inputMin: '0',
    unit: 'kg',
    showTimeOnAdd: false,
    formatDisplay: (e) => `${formatNumber(e.value)} kg`,
  },
  waist: {
    label: 'Waist',
    placeholder: '0.0',
    inputKind: 'number',
    inputStep: '0.1',
    inputMin: '0',
    unit: 'cm',
    showTimeOnAdd: false,
    formatDisplay: (e) => `${formatNumber(e.value)} cm`,
  },
  workout: {
    label: 'Workout',
    placeholder: 'What did you do?',
    inputKind: 'text',
    showTimeOnAdd: true,
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

// ------------------------------------------------------------------
// State + DOM refs
// ------------------------------------------------------------------
let currentDate = startOfDay(new Date());
let currentTab = 'food';
let editingId = null;

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

  if (config.showTimeOnAdd && formData.time) {
    entry.timestamp = combineDayAndTime(currentDate, formData.time);
  } else {
    entry.timestamp = isSameDay(currentDate, new Date())
      ? Date.now()
      : combineDayAndTime(currentDate, '12:00');
  }

  await db.entries.add(entry);
  await refreshList();
  return true;
}

async function handleEditSave(originalEntry, formData) {
  const config = TYPES[originalEntry.type];
  const fields = {};

  if (config.inputKind === 'text') {
    const text = (formData.text || '').trim();
    if (!text) return;
    fields.text = text;
  } else {
    const value = parseFloat(formData.value);
    if (Number.isNaN(value) || value <= 0) return;
    fields.value = value;
  }

  if (formData.time) {
    fields.timestamp = combineDayAndTime(new Date(originalEntry.timestamp), formData.time);
  }

  await db.entries.update(originalEntry.id, fields);
  editingId = null;
  await refreshList();
}

async function confirmAndDelete(id) {
  if (!confirm('Delete this entry?')) return;
  await db.entries.delete(id);
  editingId = null;
  await refreshList();
}

function startEdit(id) {
  editingId = id;
  refreshList();
}

function cancelEdit() {
  editingId = null;
  refreshList();
}

function setDate(date) {
  currentDate = startOfDay(date);
  editingId = null;
  refreshAll();
}

function setTab(tab) {
  if (currentTab === tab) return;
  currentTab = tab;
  editingId = null;
  refreshAll();
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

function buildTimeInput(value) {
  const input = document.createElement('input');
  input.className = 'time-input';
  input.type = 'time';
  input.name = 'time';
  input.value = value;
  input.required = true;
  input.setAttribute('aria-label', 'Time');
  return input;
}

function renderEntryForm() {
  const config = TYPES[currentTab];
  const form = document.createElement('form');
  form.className = 'entry-form';
  form.autocomplete = 'off';

  const input = buildPrimaryInput(config);
  const wrap = buildInputWrap(config, input);
  form.appendChild(wrap);

  let timeInput = null;
  if (config.showTimeOnAdd) {
    timeInput = buildTimeInput(defaultTimeStr());
    form.appendChild(timeInput);
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
      time: timeInput ? timeInput.value : undefined,
    };
    const ok = await handleAdd(currentTab, formData);
    if (ok) {
      input.value = '';
      if (timeInput) timeInput.value = defaultTimeStr();
      input.focus();
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
  btn.setAttribute('aria-label', `Edit entry from ${formatTime(entry.timestamp)}`);
  btn.addEventListener('click', () => startEdit(entry.id));

  const time = document.createElement('time');
  time.className = 'entry-time';
  time.dateTime = new Date(entry.timestamp).toISOString();
  time.textContent = formatTime(entry.timestamp);

  const display = document.createElement('span');
  display.className = config.inputKind === 'number' ? 'entry-value' : 'entry-text';
  display.textContent = config.formatDisplay(entry);

  btn.append(time, display);
  li.append(btn);
  return li;
}

function buildEditingRow(entry) {
  const config = TYPES[entry.type];
  const li = document.createElement('li');
  li.className = 'entry entry-editing';
  li.dataset.id = String(entry.id);

  const form = document.createElement('form');
  form.className = 'edit-form';

  const initialValue = config.inputKind === 'text' ? entry.text : String(entry.value);
  const input = buildPrimaryInput(config, initialValue);
  input.classList.add('edit-input');
  input.enterKeyHint = 'done';
  const wrap = buildInputWrap(config, input);
  form.appendChild(wrap);

  const timeInput = buildTimeInput(timeStrFromMs(entry.timestamp));
  form.appendChild(timeInput);

  const actions = document.createElement('div');
  actions.className = 'edit-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', cancelEdit);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => confirmAndDelete(entry.id));

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Save';

  actions.append(cancelBtn, deleteBtn, saveBtn);
  form.appendChild(actions);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    handleEditSave(entry, {
      text: input.name === 'text' ? input.value : undefined,
      value: input.name === 'value' ? input.value : undefined,
      time: timeInput.value,
    });
  });

  li.appendChild(form);

  queueMicrotask(() => {
    input.focus();
    if (config.inputKind === 'text') {
      const len = input.value.length;
      input.setSelectionRange(len, len);
    } else {
      input.select();
    }
  });

  return li;
}

function renderEntries(entries) {
  els.list.replaceChildren();
  if (entries.length === 0) {
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;
  for (const entry of entries) {
    els.list.appendChild(
      entry.id === editingId ? buildEditingRow(entry) : buildEntryRow(entry)
    );
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
  refreshAll();
}

init();
