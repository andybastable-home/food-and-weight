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
// Date helpers
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

// ------------------------------------------------------------------
// State + DOM refs
// ------------------------------------------------------------------
let currentDate = startOfDay(new Date());
let editingId = null;

const els = {
  dateLabel: document.getElementById('date-label'),
  dateSub: document.getElementById('date-sub'),
  prevBtn: document.getElementById('prev-day'),
  nextBtn: document.getElementById('next-day'),
  form: document.getElementById('entry-form'),
  input: document.getElementById('entry-input'),
  list: document.getElementById('entries-list'),
  empty: document.getElementById('empty-state'),
};

// ------------------------------------------------------------------
// Data access
// ------------------------------------------------------------------
async function loadEntriesForDate(date) {
  const start = startOfDay(date).getTime();
  const end = endOfDay(date).getTime();
  return db.entries
    .where('timestamp').between(start, end, true, true)
    .reverse()
    .sortBy('timestamp');
}

async function addEntry(text) {
  const isToday = isSameDay(currentDate, new Date());
  // When viewing a past day, anchor the entry to noon of that day so it lands on the correct date.
  const timestamp = isToday ? Date.now() : startOfDay(currentDate).getTime() + 12 * 3600 * 1000;
  await db.entries.add({ type: 'food', text, timestamp });
}

async function updateEntry(id, text) {
  await db.entries.update(id, { text });
}

async function deleteEntry(id) {
  await db.entries.delete(id);
}

// ------------------------------------------------------------------
// Actions
// ------------------------------------------------------------------
async function handleAdd(event) {
  event.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  await addEntry(text);
  els.input.value = '';
  els.input.focus();
  await refresh();
}

function startEdit(id) {
  editingId = id;
  refresh();
}

function cancelEdit() {
  editingId = null;
  refresh();
}

async function saveEdit(id, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  await updateEntry(id, trimmed);
  editingId = null;
  await refresh();
}

async function confirmAndDelete(id) {
  if (!confirm('Delete this entry?')) return;
  await deleteEntry(id);
  editingId = null;
  await refresh();
}

function setDate(date) {
  currentDate = startOfDay(date);
  editingId = null;
  refresh();
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------
function renderDateNav() {
  const { main, sub } = formatDateLabel(currentDate);
  els.dateLabel.textContent = main;
  els.dateSub.textContent = sub;
  els.dateSub.hidden = !sub;

  const onToday = isSameDay(currentDate, new Date());
  els.nextBtn.disabled = onToday;
  els.nextBtn.setAttribute('aria-disabled', onToday ? 'true' : 'false');

  els.input.placeholder = onToday
    ? 'What did you eat?'
    : `Add to ${formatFullDate(currentDate)}\u2026`;
}

function buildEntryRow(entry) {
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

  const text = document.createElement('span');
  text.className = 'entry-text';
  text.textContent = entry.text;

  btn.append(time, text);
  li.append(btn);
  return li;
}

function buildEditingRow(entry) {
  const li = document.createElement('li');
  li.className = 'entry entry-editing';
  li.dataset.id = String(entry.id);

  const form = document.createElement('form');
  form.className = 'edit-form';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'entry-input edit-input';
  input.value = entry.text;
  input.maxLength = 500;
  input.required = true;
  input.enterKeyHint = 'done';

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    saveEdit(entry.id, input.value);
  });

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
  form.append(input, actions);
  li.append(form);

  // Focus + place caret at end after the row mounts.
  queueMicrotask(() => {
    input.focus();
    const len = input.value.length;
    input.setSelectionRange(len, len);
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

async function refresh() {
  renderDateNav();
  const entries = await loadEntriesForDate(currentDate);
  renderEntries(entries);
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------
function init() {
  els.form.addEventListener('submit', handleAdd);
  els.prevBtn.addEventListener('click', () => setDate(addDays(currentDate, -1)));
  els.nextBtn.addEventListener('click', () => {
    if (isSameDay(currentDate, new Date())) return;
    setDate(addDays(currentDate, 1));
  });
  refresh();
}

init();
