# Day Context Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unused skip-day feature with a per-day free-text context note, accessible via long press on the date header and displayed as a quiet annotation beneath the date on all tabs.

**Architecture:** Repurpose the existing `#skip-overlay` HTML element and its JS wiring — rename IDs/vars, update copy, add a Delete button, and change the entry type from `skip_food` to `day_context`. A new `<p id="day-context-label">` element in the date nav shows the note. The `day_context` entry lives in IndexedDB like any other entry and flows to the Google Sheet via existing sync functions unchanged.

**Tech Stack:** Vanilla JS (no build step), Dexie (IndexedDB), existing CSS custom properties, Google Sheets sync via existing `sync.js`.

---

## Files Modified

- `index.html` — overlay HTML (IDs, copy, add Delete button) + new context label element
- `app.js` — all logic changes in one commit (TYPES, state, els, data functions, rendering, overlay, dead-code removal)
- `styles.css` — `.date-nav-context` class
- `sync.js` — one-line type filter change

> **Note on app.js:** All app.js edits are in Task 2 and committed together. The renames are intertwined (`skipMarker` appears in TYPES, state, data functions, rendering, overlay, and two dead-code blocks) — committing them piecemeal would leave broken references. Complete all steps in Task 2 before committing.

---

## Task 1: Update HTML — overlay and context label

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Replace the skip overlay block**

Find and replace the entire `<!-- Skip-day overlay -->` comment and its `<div id="skip-overlay">` block with:

```html
  <!-- Day-context overlay -->
  <div id="context-overlay" class="settings-overlay hidden" role="dialog" aria-modal="true" aria-label="Day note">
    <div class="settings-panel">
      <div class="settings-header">
        <span class="settings-title" id="context-overlay-title">Add day note</span>
      </div>
      <div class="settings-body">
        <p class="ai-config-hint">Add context for this day — e.g. giving blood, travelling, big event.</p>
        <div class="ai-config-section">
          <label class="ai-config-label" for="context-input">Note</label>
          <input type="text" id="context-input" class="ai-config-input" maxlength="120" placeholder="e.g. giving blood" autocomplete="off">
        </div>
        <div class="settings-sync">
          <button id="context-save" type="button" class="btn btn-primary">Save</button>
          <button id="context-delete" type="button" class="btn btn-ghost hidden">Delete</button>
          <button id="context-cancel" type="button" class="btn btn-ghost">Cancel</button>
        </div>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Add the context label inside `.date-nav-label`**

Find:
```html
      <div class="date-nav-label">
        <h1 id="date-label" class="date-nav-main">Today</h1>
        <p id="date-sub" class="date-nav-sub"></p>
      </div>
```

Replace with:
```html
      <div class="date-nav-label">
        <h1 id="date-label" class="date-nav-main">Today</h1>
        <p id="date-sub" class="date-nav-sub"></p>
        <p id="day-context-label" class="date-nav-context hidden"></p>
      </div>
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "chore: repurpose skip overlay HTML as day-context overlay"
```

---

## Task 2: All app.js changes (do all steps before committing)

**Files:**
- Modify: `app.js`

All steps below must be completed before the commit at the end of this task. Do not commit intermediate states.

### 2a — TYPES map

- [ ] **Step 1: Replace `skip_food` with `day_context` in the TYPES map**

Find (in the `// ---- Type config ----` section):
```js
  skip_food: {
    label: 'Skip Day',
    inputKind: 'text',
    isCollapsible: false,
    formatDisplay: (e) => e.text,
  },
```

Replace with:
```js
  day_context: {
    label: 'Day Note',
    inputKind: 'text',
    isCollapsible: false,
    formatDisplay: (e) => e.text,
  },
```

### 2b — State variable

- [ ] **Step 2: Rename the state variable**

Find (in `// ---- State + DOM refs ----`):
```js
let skipMarker = null;
```

Replace with:
```js
let dayContext = null;
```

### 2c — `els` DOM references

- [ ] **Step 3: Update `els` DOM references**

Find in the `els` object:
```js
  skipOverlay: document.getElementById('skip-overlay'),
  skipReasonInput: document.getElementById('skip-reason-input'),
  skipCancelBtn: document.getElementById('skip-cancel'),
  skipConfirmBtn: document.getElementById('skip-confirm'),
```

Replace with:
```js
  contextOverlay: document.getElementById('context-overlay'),
  contextOverlayTitle: document.getElementById('context-overlay-title'),
  contextInput: document.getElementById('context-input'),
  contextSaveBtn: document.getElementById('context-save'),
  contextDeleteBtn: document.getElementById('context-delete'),
  contextCancelBtn: document.getElementById('context-cancel'),
  dayContextLabel: document.getElementById('day-context-label'),
```

### 2d — Data functions

- [ ] **Step 4: Replace `loadSkipMarker` with `loadDayContext`**

Find:
```js
async function loadSkipMarker(date) {
  const start = startOfDay(date).getTime();
  const end = endOfDay(date).getTime();
  const rows = await db.entries
    .where('timestamp').between(start, end, true, true)
    .and((e) => e.type === 'skip_food')
    .toArray();
  return rows[0] || null;
}
```

Replace with:
```js
async function loadDayContext(date) {
  const start = startOfDay(date).getTime();
  const end = endOfDay(date).getTime();
  const rows = await db.entries
    .where('timestamp').between(start, end, true, true)
    .and((e) => e.type === 'day_context')
    .toArray();
  return rows[0] || null;
}
```

- [ ] **Step 5: Replace `createSkipMarker` with `createDayContext`**

Find the entire `createSkipMarker` function and replace with:
```js
async function createDayContext(text) {
  const entry = {
    type: 'day_context',
    uuid: crypto.randomUUID(),
    text,
    rawInput: text,
    timestamp: combineDayAndTime(currentDate, '12:00'),
    synced: 0,
  };
  const id = await db.entries.add(entry);
  dayContext = { ...entry, id };
  if (typeof syncEntriesToSheet === 'function') {
    syncEntriesToSheet([dayContext])
      .then(() => db.entries.update(id, { synced: true }))
      .catch(() => {});
  }
  renderDayContextLabel();
}
```

- [ ] **Step 6: Replace `removeSkipMarker` with `updateDayContext` and `deleteDayContext`**

Find the entire `removeSkipMarker` function and replace with:
```js
async function updateDayContext(text) {
  if (!dayContext) return;
  await db.entries.update(dayContext.id, { text, rawInput: text, synced: 0 });
  dayContext = { ...dayContext, text, rawInput: text };
  if (typeof updateEntryInSheet === 'function') {
    updateEntryInSheet(dayContext).catch(() => {});
  }
  renderDayContextLabel();
}

async function deleteDayContext() {
  if (!dayContext) return;
  const { id, uuid } = dayContext;
  await db.entries.delete(id);
  dayContext = null;
  if (uuid && typeof deleteEntryFromSheet === 'function') {
    deleteEntryFromSheet(uuid).catch(() => {});
  }
  renderDayContextLabel();
}
```

### 2e — Rendering helper

- [ ] **Step 7: Add `renderDayContextLabel` in the Rendering section**

At the top of the `// ---- Rendering ----` section (just before `renderEntryForm`), add:

```js
function renderDayContextLabel() {
  if (dayContext && dayContext.text) {
    els.dayContextLabel.textContent = dayContext.text;
    els.dayContextLabel.hidden = false;
  } else {
    els.dayContextLabel.textContent = '';
    els.dayContextLabel.hidden = true;
  }
}
```

### 2f — Remove skip-food rendering dead code

- [ ] **Step 8: Remove the skip banner from `renderEntryForm`**

Find and delete this entire block (it is inside `renderEntryForm`, in the `// ---- Rendering ----` section):
```js
  if (currentTab === 'food' && skipMarker) {
    const banner = document.createElement('div');
    banner.className = 'empty-state';
    const msg = document.createElement('p');
    msg.textContent = skipMarker.text
      ? `Day off — ${skipMarker.text}`
      : 'Food logging skipped for today.';
    banner.appendChild(msg);
    \ TODO: restore today-only guard after testing
    // if (isSameDay(currentDate, new Date())) {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'btn btn-ghost';
    undoBtn.style.marginTop = '12px';
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', removeSkipMarker);
    banner.appendChild(undoBtn);
    // }
    els.formContainer.replaceChildren(banner);
    return;
  }
```

- [ ] **Step 9: Remove the calTotal skip guard from `refreshList`**

Find and delete this block (it is at the top of the calTotal section inside `refreshList`):
```js
  if (currentTab === 'food' && skipMarker) {
    els.calTotal.hidden = true;
    return;
  }
```

### 2g — `refreshAll`, `setDate`, `setTab`

- [ ] **Step 10: Update `refreshAll`**

Find:
```js
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
```

Replace with:
```js
async function refreshAll() {
  renderTabs();
  renderDateNav();
  dayContext = await loadDayContext(currentDate);
  renderDayContextLabel();
  renderEntryForm();
  await refreshList();
}
```

- [ ] **Step 11: Update `setDate` — replace `skipMarker = null`**

Find in `setDate`:
```js
  skipMarker = null;
```

Replace with:
```js
  dayContext = null;
```

- [ ] **Step 12: Update `setTab` — replace `skipMarker = null`**

Find in `setTab`:
```js
  skipMarker = null;
```

Replace with:
```js
  dayContext = null;
```

### 2h — Overlay logic

- [ ] **Step 13: Replace `openSkipPrompt` with `openContextPrompt`**

Find the entire `openSkipPrompt` function:
```js
function openSkipPrompt() {
  if (currentTab !== 'food') return;
  \ TODO: restore today-only guard after testing
  // if (!isSameDay(currentDate, new Date())) return;
  if (skipMarker) return;
  loadEntries(currentDate, 'food').then((entries) => {
    if (entries.length > 0) return;
    els.skipReasonInput.value = '';
    els.skipOverlay.classList.remove('hidden');
    els.skipReasonInput.focus();
  });
}
```

Replace with:
```js
function openContextPrompt() {
  const isEdit = !!dayContext;
  els.contextOverlayTitle.textContent = isEdit ? 'Edit day note' : 'Add day note';
  els.contextInput.value = isEdit ? (dayContext.text || '') : '';
  els.contextDeleteBtn.classList.toggle('hidden', !isEdit);
  els.contextOverlay.classList.remove('hidden');
  els.contextInput.focus();
}
```

- [ ] **Step 14: Update the `attachLongPress` call in `renderDateNav`**

Find:
```js
  attachLongPress(els.dateNavLabel, openSkipPrompt);
```

Replace with:
```js
  attachLongPress(els.dateNavLabel, openContextPrompt);
```

- [ ] **Step 15: Replace `initSkipOverlay` with `initContextOverlay`**

Find the entire `initSkipOverlay` function:
```js
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
```

Replace with:
```js
function initContextOverlay() {
  function closeContext() {
    els.contextOverlay.classList.add('hidden');
    els.contextInput.value = '';
  }
  els.contextCancelBtn.addEventListener('click', closeContext);
  els.contextOverlay.addEventListener('click', (e) => { if (e.target === els.contextOverlay) closeContext(); });
  els.contextSaveBtn.addEventListener('click', () => {
    const text = els.contextInput.value.trim();
    if (!text) return;
    closeContext();
    if (dayContext) {
      updateDayContext(text);
    } else {
      createDayContext(text);
    }
  });
  els.contextDeleteBtn.addEventListener('click', () => {
    closeContext();
    deleteDayContext();
  });
}
```

- [ ] **Step 16: Update the `init()` call**

Find in `init()`:
```js
  initSkipOverlay();
```

Replace with:
```js
  initContextOverlay();
```

### 2i — Verify and commit

- [ ] **Step 17: Grep for any remaining `skipMarker` or `skip_food` or `initSkipOverlay` or `openSkipPrompt` references in `app.js`**

Run:
```bash
grep -n "skipMarker\|skip_food\|skipOverlay\|skipReasonInput\|skipCancelBtn\|skipConfirmBtn\|initSkipOverlay\|openSkipPrompt\|createSkipMarker\|removeSkipMarker\|loadSkipMarker" app.js
```

Expected: no output. If any matches appear, fix them before committing.

- [ ] **Step 18: Open app in browser, check for JS errors**

Open `index.html` in a browser. Open DevTools console. Load the page — no errors should appear. Navigate between tabs and days. The date nav should render correctly.

- [ ] **Step 19: Commit**

```bash
git add app.js
git commit -m "feat: replace skip-day with day-context note (data, rendering, overlay)"
```

---

## Task 3: Add `.date-nav-context` CSS

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Add the style after `.date-nav-sub`**

Find in `styles.css`:
```css
.date-nav-sub {
  margin: 2px 0 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-muted);
```

Add the following block immediately after the closing `}` of `.date-nav-sub`:
```css

.date-nav-context {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--color-text-muted);
  font-style: italic;
}
```

- [ ] **Step 2: Commit**

```bash
git add styles.css
git commit -m "style: add date-nav-context label style"
```

---

## Task 4: Update `sync.js` type filter

**Files:**
- Modify: `sync.js`

- [ ] **Step 1: Update the type filter**

Find (inside the function that builds a set of dates from all entries — the line reads `if (e.type === 'skip_food') continue;`):
```js
    if (e.type === 'skip_food') continue;
```

Replace with:
```js
    if (e.type === 'day_context') continue;
```

- [ ] **Step 2: Commit**

```bash
git add sync.js
git commit -m "chore: exclude day_context entries from daily-targets date set"
```

---

## Task 5: End-to-end verification, version bump, push

**Files:**
- Modify: `index.html` (footer version pill)
- Modify: `service-worker.js` (`CACHE_VERSION`)

- [ ] **Step 1: Full smoke test**

Open the app in a browser. Work through this checklist:

- Navigate to today — no context label visible beneath the date
- Long press the date header (hold ~600ms) — overlay appears titled "Add day note" with empty input, no Delete button
- Type "Giving blood", press Save — overlay closes, "Giving blood" appears in italic beneath the date
- Switch to workout tab — context label still visible beneath the date
- Navigate to yesterday — context label hidden (no note for that day)
- Navigate back to today — "Giving blood" reappears
- Long press — overlay titled "Edit day note", input pre-filled with "Giving blood", Delete button visible
- Clear input, press Save — nothing changes (empty save is a no-op)
- Type "Giving blood today", press Save — label updates to "Giving blood today"
- Long press, press Cancel — nothing changes
- Long press, press Delete — overlay closes, context label disappears
- Long press again — overlay: "Add day note", empty input (confirms the entry is gone)

- [ ] **Step 2: Bump version in `service-worker.js`**

Find:
```js
const CACHE_VERSION = 'v1.4.3';
```

Replace with:
```js
const CACHE_VERSION = 'v1.5.0';
```

- [ ] **Step 3: Bump version in `index.html`**

Find:
```html
    <span class="brand-version" aria-label="App version">v1.4.3</span>
```

Replace with:
```html
    <span class="brand-version" aria-label="App version">v1.5.0</span>
```

- [ ] **Step 4: Commit and push**

```bash
git add index.html service-worker.js
git commit -m "Release v1.5.0: replace skip-day with day context notes"
git push
```
