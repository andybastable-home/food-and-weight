// Google Sheets OAuth + sync
const CLIENT_ID = '58841586776-lbkpi48lsk19rb3e2d8icfcvammotacs.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const SHEET_ID_KEY = 'fw.spike.sheetId';
const SHEET_GID_KEY = 'fw.spike.sheetGid';
const EMAIL_KEY = 'fw.spike.email';
const AI_CONTEXT_READY_KEY = 'fw.aiContext.ready';
const AI_CONTEXT_STORAGE_KEY = 'fw_gemini_context';

const ENTRIES_HEADER_V1 = ['id', 'epoch', 'iso_date', 'type', 'value', 'notes', 'time_category', 'calories', 'synced_at'];
const ENTRIES_HEADER_V2 = ['uuid', 'epoch', 'iso_date', 'type', 'value', 'notes', 'time_category', 'calories', 'synced_at'];
const ENTRIES_HEADER_V3 = [
  ...ENTRIES_HEADER_V2,
  'raw_input',              // pre-AI user text (== value when no AI involved)
  'ai_suggested_title',     // Gemini's canonical title (blank when source=user)
  'ai_suggested_calories',  // Gemini's calorie estimate (blank when source=user)
  'calorie_source',         // 'user' | 'gemini'
  'calorie_confidence',     // 'low' | 'med' | 'high' (only when source=gemini)
  'effort',                 // 'low' | 'med' | 'high' (workout entries only)
];
// Column-letter range covering the v3 header — bump if columns are added.
const ENTRIES_RANGE_ALL = 'Entries!A:O';
const ENTRIES_RANGE_HEADER = 'Entries!A1:O1';
const ENTRIES_ROW_RANGE = (rowNum) => `Entries!A${rowNum}:O${rowNum}`;

const ENTRY_CONVENTION_NOTE = 'time_category is canonical for meal/activity ordering; epoch/iso_date is moment-of-entry and may not match the real meal/activity time. Weight entries are AM-fasted by convention (time_category=Morning, timestamp=noon-of-day).';

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
// True until we detect a sheet whose schema_version is newer than this build understands.
// While false, no reads/writes of the Entries tab are attempted — stalls both directions to
// avoid corrupting a forward-versioned sheet.
let schemaCompatible = true;

const syncUI = {
  url: document.getElementById('sync-url'),
  connect: document.getElementById('sync-connect'),
  refresh: document.getElementById('sync-refresh'),
  forget: document.getElementById('sync-forget'),
  link: document.getElementById('sync-sheet-link'),
  status: document.getElementById('sync-status'),
};

function getSheetId() { return localStorage.getItem(SHEET_ID_KEY); }
function setSheetId(id) { localStorage.setItem(SHEET_ID_KEY, id); }
function clearSheetId() { localStorage.removeItem(SHEET_ID_KEY); }

function getSheetGid() { const v = localStorage.getItem(SHEET_GID_KEY); return v !== null ? Number(v) : 0; }
function setSheetGid(gid) { localStorage.setItem(SHEET_GID_KEY, String(gid)); }
function clearSheetGid() { localStorage.removeItem(SHEET_GID_KEY); }

function getEmail() { return localStorage.getItem(EMAIL_KEY); }
function setEmail(e) { localStorage.setItem(EMAIL_KEY, e); }
function clearEmail() { localStorage.removeItem(EMAIL_KEY); }

function tokenValid() {
  return !!accessToken && Date.now() < tokenExpiresAt;
}

function setSyncStatus(text, tone) {
  if (!syncUI.status) return;
  syncUI.status.textContent = text || '';
  syncUI.status.classList.remove('is-error', 'is-info', 'is-ok');
  if (tone) syncUI.status.classList.add(`is-${tone}`);
}

function renderSyncUI() {
  const sheetId = getSheetId();
  const connected = !!sheetId;
  if (syncUI.link) {
    syncUI.link.hidden = !connected;
    if (connected) {
      syncUI.link.href = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
      syncUI.link.textContent = 'Open sheet';
    }
  }
  if (syncUI.forget) syncUI.forget.hidden = !connected;
  if (syncUI.refresh) syncUI.refresh.disabled = !connected;
  // URL textbox + Connect button stay visible always — Connect adapts based on textbox content.
  if (syncUI.connect) {
    syncUI.connect.textContent = connected ? 'Reconnect' : 'Connect';
  }
}

function ensureClient() {
  if (tokenClient) return true;
  if (!window.google?.accounts?.oauth2) return false;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    use_fedcm_for_prompt: true,
    callback: () => {},
    error_callback: () => {},
  });
  return true;
}

function requestToken({ silent }) {
  return new Promise((resolve, reject) => {
    if (!ensureClient()) { reject(new Error('GIS not ready')); return; }
    let settled = false;
    const settle = (fn) => (...args) => { if (settled) return; settled = true; fn(...args); };

    tokenClient.callback = settle((resp) => {
      if (resp.error) { reject(new Error(`${resp.error}: ${resp.error_description || ''}`)); return; }
      accessToken = resp.access_token;
      tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000;
      resolve(resp);
    });
    tokenClient.error_callback = settle((err) => {
      reject(new Error(`${err?.type || 'error'}: ${err?.message || JSON.stringify(err)}`));
    });
    if (silent) {
      setTimeout(settle(() => reject(new Error('silent attempt timed out'))), 8000);
    }
    const params = { prompt: silent ? '' : 'consent' };
    const hint = getEmail();
    if (hint) params.hint = hint;
    tokenClient.requestAccessToken(params);
  });
}

async function captureEmailIfNeeded() {
  if (getEmail()) return;
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.email) {
      setEmail(data.email);
      console.log('[sync] Account pinned:', data.email);
    }
  } catch (err) {
    console.warn('[sync] Email capture failed:', err.message);
  }
}

async function ensureFreshToken() {
  if (tokenValid()) return accessToken;
  await requestToken({ silent: true });
  return accessToken;
}

async function apiCall(url, opts = {}) {
  const token = await ensureFreshToken();
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Best-effort read that returns null on 404/400 instead of throwing — used for "does this tab/cell exist".
async function apiTryRead(url) {
  try {
    return await apiCall(url);
  } catch (err) {
    if (err.status === 400 || err.status === 404) return null;
    throw err;
  }
}

// Recover the Entries tab's numeric sheetId (gid) needed for deleteDimension calls.
async function fetchEntriesGid(spreadsheetId) {
  const data = await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`
  );
  const sheet = (data.sheets || []).find(s => s.properties?.title === 'Entries');
  if (!sheet) throw new Error('No "Entries" tab found in spreadsheet');
  return sheet.properties.sheetId;
}

async function ensureSheet() {
  if (getSheetId()) return;
  console.log('[sync] Creating sheet…');
  const data = await apiCall('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: 'Food & Weight log' },
      sheets: [
        { properties: { title: 'Entries' } },
        { properties: { title: 'AI_Context' } },
        { properties: { title: 'Metadata' } },
      ],
    }),
  });
  setSheetId(data.spreadsheetId);
  const entriesSheet = data.sheets.find(s => s.properties.title === 'Entries');
  setSheetGid(entriesSheet.properties.sheetId);
  localStorage.setItem(AI_CONTEXT_READY_KEY, '1');
  console.log('[sync] Sheet created:', data.spreadsheetId);
  const sid = data.spreadsheetId;
  await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/Entries!A1:append?valueInputOption=RAW`,
    { method: 'POST', body: JSON.stringify({ values: [ENTRIES_HEADER_V3] }) }
  );
  await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/AI_Context!A1:append?valueInputOption=RAW`,
    { method: 'POST', body: JSON.stringify({ values: [['Diet Context Profile']] }) }
  );
  await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/Metadata!A1:B2?valueInputOption=RAW`,
    {
      method: 'PUT',
      body: JSON.stringify({
        values: [
          ['schema_version', SHEET_SCHEMA_VERSION],
          ['entry_conventions', ENTRY_CONVENTION_NOTE],
        ],
      }),
    }
  );
  schemaCompatible = true;
}

async function ensureAIContextSheet() {
  if (!getSheetId()) return;
  if (localStorage.getItem(AI_CONTEXT_READY_KEY)) return;
  const sheetId = getSheetId();
  try {
    await apiCall(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: 'AI_Context' } } }] }),
    });
    await apiCall(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/AI_Context!A1:append?valueInputOption=RAW`,
      { method: 'POST', body: JSON.stringify({ values: [['Diet Context Profile']] }) }
    );
    console.log('[sync] AI_Context sheet added');
  } catch (err) {
    console.log('[sync] AI_Context sheet check:', err.message.slice(0, 80));
  }
  localStorage.setItem(AI_CONTEXT_READY_KEY, '1');
}

async function pushContextToSheet(contextString) {
  if (!getSheetId() || !tokenValid() || !schemaCompatible) return;
  const sheetId = getSheetId();
  await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/AI_Context!A2?valueInputOption=RAW`,
    { method: 'PUT', body: JSON.stringify({ values: [[contextString]] }) }
  );
  console.log('[sync] AI context pushed to sheet');
}

async function pullContextFromSheet() {
  if (!getSheetId()) return;
  if (localStorage.getItem(AI_CONTEXT_STORAGE_KEY)) return;
  try {
    const sheetId = getSheetId();
    const data = await apiCall(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/AI_Context!A2`
    );
    const val = data.values?.[0]?.[0];
    if (val) {
      localStorage.setItem(AI_CONTEXT_STORAGE_KEY, val);
      const textarea = document.getElementById('cfg-ai-context');
      if (textarea) textarea.value = val;
      console.log('[sync] AI context pulled from sheet');
    }
  } catch (err) {
    console.warn('[sync] pullContextFromSheet failed:', err.message);
  }
}

// Returns the sheet's schema_version (number) or null if Metadata tab/cell missing.
async function readSheetSchemaVersion(sheetId) {
  const data = await apiTryRead(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Metadata!B1`
  );
  const raw = data?.values?.[0]?.[0];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function headersMatch(row, expected) {
  if (!row || row.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if ((row[i] || '').toLowerCase().trim() !== expected[i]) return false;
  }
  return true;
}

// One-shot v1 → v2 migration. Rewrites column A from int id to uuid for every data row,
// then creates the Metadata tab with schema_version=2. Returns true if migration ran.
async function migrateSheetV1ToV2() {
  const sheetId = getSheetId();
  if (!sheetId) return false;

  // Guard: only rewrite column A if the header is the exact legacy v1 shape.
  // If the header already reads "uuid" (a previous migration partially succeeded but
  // didn't get to create the Metadata tab), skip the rewrite and just finish the
  // Metadata step. Refuse on any other shape — we don't know what we're looking at.
  const headerRead = await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Entries!A1:I1`
  );
  const headerRow = headerRead.values?.[0] || [];
  const isV1 = headersMatch(headerRow, ENTRIES_HEADER_V1);
  const isV2 = headersMatch(headerRow, ENTRIES_HEADER_V2);
  if (!isV1 && !isV2) {
    throw new Error('Refusing to migrate: Entries header is neither v1 nor v2 shape');
  }

  if (!isV1) {
    console.log('[sync] Sheet already at v2 shape — just writing Metadata tab');
  } else {
    console.log('[sync] Migrating sheet v1→v2…');
  }
  if (isV1) {
  const all = await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Entries!A:I`
  );
  const rows = all.values || [];
  const dataRows = rows.slice(1);

  // Build a lookup of local entries by their old int id, so we can preserve uuid bindings.
  const localByOldId = new Map();
  const allLocal = await db.entries.toArray();
  for (const e of allLocal) {
    if (typeof e.id === 'number') localByOldId.set(e.id, e);
  }

  // Compute the new uuid for each row.
  const newUuids = dataRows.map((row) => {
    const oldId = Number(row[0]);
    if (Number.isFinite(oldId) && localByOldId.has(oldId)) {
      return localByOldId.get(oldId).uuid;
    }
    return crypto.randomUUID();
  });

  // Rewrite column A in one batch. Each row's range is Entries!A{n}.
  if (dataRows.length) {
    const updates = newUuids.map((uuid, i) => ({
      range: `Entries!A${i + 2}`,
      values: [[uuid]],
    }));
    // Also update the header cell A1 from "id" to "uuid".
    updates.unshift({ range: 'Entries!A1', values: [['uuid']] });
    await apiCall(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: updates,
        }),
      }
    );
  } else {
    // Empty sheet — just rewrite the header.
    await apiCall(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Entries!A1?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values: [['uuid']] }) }
    );
  }
  } // end if (isV1)

  // Create the Metadata tab (idempotent — ignore "already exists" errors).
  try {
    await apiCall(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: 'Metadata' } } }] }),
    });
  } catch (err) {
    if (!/already exists/i.test(err.message)) throw err;
  }
  // Hardcode 2 (not SHEET_SCHEMA_VERSION) so that if pull is interrupted between
  // migrations in a cascade, the next pull resumes at the correct point rather
  // than seeing a "v3" tag on a still-v2 header.
  await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Metadata!A1?valueInputOption=RAW`,
    { method: 'PUT', body: JSON.stringify({ values: [['schema_version', 2]] }) }
  );

  console.log('[sync] Sheet at v2');
  return true;
}

// v2 → v3: extend header with 6 new columns, backfill weight rows with
// time_category='Morning', backfill calorie_source='user' on rows with calories,
// backfill effort='low' on workout rows, and write the convention note + new
// schema_version to Metadata.
async function migrateSheetV2ToV3() {
  const sheetId = getSheetId();
  if (!sheetId) return false;

  const headerRead = await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${ENTRIES_RANGE_HEADER}`
  );
  const headerRow = headerRead.values?.[0] || [];
  const isV2 = headersMatch(headerRow, ENTRIES_HEADER_V2)
    && (headerRow.length === ENTRIES_HEADER_V2.length || !headerRow[ENTRIES_HEADER_V2.length]);
  const isV3 = headersMatch(headerRow, ENTRIES_HEADER_V3);
  if (!isV2 && !isV3) {
    throw new Error('Refusing to migrate: Entries header is neither v2 nor v3 shape');
  }

  if (!isV3) {
    console.log('[sync] Migrating sheet v2→v3…');

    // Read all v2 data so we can compute per-row backfills.
    const all = await apiCall(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Entries!A:I`
    );
    const dataRows = (all.values || []).slice(1);

    const updates = [
      // Header: write the full v3 header in one shot (overwrites existing A1:I1
      // identically, plus extends J1:O1).
      { range: ENTRIES_RANGE_HEADER, values: [ENTRIES_HEADER_V3] },
    ];

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowNum = i + 2; // 1-based, +1 for header
      const type = row[3] || '';
      const value = row[4] || '';
      const timeCategory = row[6] || '';
      const calories = row[7];

      // Weight rows get time_category='Morning' if blank.
      if (type === 'weight' && !timeCategory) {
        updates.push({ range: `Entries!G${rowNum}`, values: [['Morning']] });
      }

      // J:O — raw_input, ai_suggested_title, ai_suggested_calories,
      // calorie_source, calorie_confidence, effort.
      const calorieSource = (calories !== '' && calories != null) ? 'user' : '';
      const effort = type === 'workout' ? 'low' : '';
      updates.push({
        range: `Entries!J${rowNum}:O${rowNum}`,
        values: [[value, '', '', calorieSource, '', effort]],
      });
    }

    await apiCall(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
      }
    );
  } else {
    console.log('[sync] Sheet already at v3 shape — just bumping Metadata');
  }

  await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Metadata!A1:B2?valueInputOption=RAW`,
    {
      method: 'PUT',
      body: JSON.stringify({
        values: [
          ['schema_version', SHEET_SCHEMA_VERSION],
          ['entry_conventions', ENTRY_CONVENTION_NOTE],
        ],
      }),
    }
  );

  console.log('[sync] Sheet at v3');
  return true;
}

// Pull entries from sheet → local, with sheet-wins merge by uuid. Local-only rows are
// left alone (the syncUnsynced path pushes them up). Returns the count of rows processed.
async function pullEntriesFromSheet() {
  if (!getSheetId()) return 0;
  const sheetId = getSheetId();

  try {
    const version = await readSheetSchemaVersion(sheetId);

    if (version == null) {
      // No Metadata tab → either legacy v1 or a foreign sheet. Header check + cascade migrate.
      await migrateSheetV1ToV2();
      await migrateSheetV2ToV3();
    } else if (version > SHEET_SCHEMA_VERSION) {
      schemaCompatible = false;
      console.warn('[sync] Sheet schema v' + version + ' is newer than this app understands (v' + SHEET_SCHEMA_VERSION + '). Pull & push disabled.');
      setSyncStatus(`Sheet was written by a newer app version (v${version}). Update the PWA to sync.`, 'error');
      return 0;
    } else if (version < SHEET_SCHEMA_VERSION) {
      if (version < 2) await migrateSheetV1ToV2();
      if (version < 3) await migrateSheetV2ToV3();
    }
    schemaCompatible = true;

    const data = await apiCall(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${ENTRIES_RANGE_ALL}`
    );
    const rows = data.values || [];
    if (rows.length <= 1) return 0;

    const sheetUuids = new Set();
    let added = 0, updated = 0;
    for (const row of rows.slice(1)) {
      const uuid = row[0];
      if (!uuid) continue;
      sheetUuids.add(uuid);
      const type = row[3] || 'food';
      const rawValue = row[4] || '';
      const fields = {
        uuid,
        timestamp: Number(row[1]) || Date.parse(row[2]) || Date.now(),
        type,
        notes: row[5] || '',
        timeCategory: row[6] || '',
        calories: row[7] ? Number(row[7]) : undefined,
        rawInput: row[9] || '',
        aiSuggestedTitle: row[10] || '',
        aiSuggestedCalories: row[11] !== '' && row[11] != null ? Number(row[11]) : undefined,
        calorieSource: row[12] || '',
        calorieConfidence: row[13] || '',
        effort: row[14] || '',
        synced: true,
      };
      if (TYPES[type]?.inputKind === 'text') {
        fields.text = rawValue;
        fields.value = undefined;
      } else {
        fields.value = rawValue !== '' ? Number(rawValue) : undefined;
        fields.text = undefined;
      }

      const existing = await db.entries.where('uuid').equals(uuid).first();
      if (existing) {
        await db.entries.update(existing.id, fields);
        updated++;
      } else {
        await db.entries.add(fields);
        added++;
      }
    }
    // Propagate cross-device deletes: any local entry that was once in the sheet
    // (synced: true) but whose uuid is no longer in the sheet snapshot was deleted
    // on another device. Local-only entries (synced: false) are protected.
    const removed = await db.entries
      .filter((e) => e.synced === true && e.uuid && !sheetUuids.has(e.uuid))
      .delete();

    console.log(`[sync] Pulled ${added + updated} entries (${added} new, ${updated} updated, ${removed} removed)`);
    if (typeof refreshList === 'function') refreshList();
    return added + updated + removed;
  } catch (err) {
    console.warn('[sync] pullEntriesFromSheet failed:', err.message);
    setSyncStatus(`Pull failed: ${err.message.slice(0, 100)}`, 'error');
    return 0;
  }
}

function entryToRow(e) {
  const now = new Date().toISOString();
  return [
    e.uuid,
    e.timestamp,
    new Date(e.timestamp).toISOString(),
    e.type,
    e.value != null ? e.value : (e.text || ''),
    e.notes || '',
    e.timeCategory || '',
    e.calories || '',
    now,
    e.rawInput || '',
    e.aiSuggestedTitle || '',
    e.aiSuggestedCalories != null ? e.aiSuggestedCalories : '',
    e.calorieSource || '',
    e.calorieConfidence || '',
    e.effort || '',
  ];
}

async function syncEntriesToSheet(entriesArray) {
  if (!entriesArray.length) return;
  if (!schemaCompatible) { console.warn('[sync] push blocked: sheet schema incompatible'); return; }
  await ensureFreshToken();
  await ensureSheet();
  const sheetId = getSheetId();
  const rows = entriesArray.map(entryToRow);
  await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Entries!A1:append?valueInputOption=RAW`,
    { method: 'POST', body: JSON.stringify({ values: rows }) }
  );
  renderSyncUI();
  console.log('[sync] Synced', rows.length, 'entries');
}

async function findRowIndexByUuid(sheetId, uuid) {
  const colA = await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Entries!A:A`
  );
  const rows = colA.values || [];
  return rows.findIndex((r, i) => i > 0 && String(r[0]) === String(uuid));
}

async function deleteEntryFromSheet(uuid) {
  if (!getSheetId() || !schemaCompatible) return;
  try {
    await ensureFreshToken();
    const sheetId = getSheetId();
    const rowIndex = await findRowIndexByUuid(sheetId, uuid);
    if (rowIndex === -1) {
      console.log('[sync] Entry not found in sheet, skipping row delete');
      return;
    }
    await apiCall(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId: getSheetGid(),
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        }],
      }),
    });
    console.log('[sync] Row deleted from sheet');
  } catch (err) {
    console.warn('[sync] deleteEntryFromSheet failed:', err.message);
  }
}

async function updateEntryInSheet(entry) {
  if (!getSheetId() || !schemaCompatible) return;
  await ensureFreshToken();
  const sheetId = getSheetId();
  const rowIndex = await findRowIndexByUuid(sheetId, entry.uuid);
  if (rowIndex === -1) {
    console.log('[sync] updateEntryInSheet: entry not found in sheet');
    return;
  }
  const range = ENTRIES_ROW_RANGE(rowIndex + 1);
  await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=RAW`,
    { method: 'PUT', body: JSON.stringify({ values: [entryToRow(entry)] }) }
  );
  console.log('[sync] Row updated in sheet:', entry.uuid);
}

function extractSheetId(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;
  const m = trimmed.match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // Bare ID (Google sheet IDs are at least ~20 chars of base64url alphabet)
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

async function attachToSheet(input) {
  const sheetId = extractSheetId(input);
  if (!sheetId) throw new Error('Could not find a sheet ID in that URL');

  // Validate the target. We need a token before we can call anything.
  await ensureFreshToken();

  // Probe: does the sheet even open for us? Drive.file scope only grants files
  // this client previously created — a wrong-account or never-seen sheet 403s here.
  const meta = await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`
  );
  const entriesSheet = (meta.sheets || []).find(s => s.properties?.title === 'Entries');
  if (!entriesSheet) throw new Error('Sheet has no "Entries" tab — wrong file?');

  // Stash sheet ID + gid before any migration runs (migrateSheetV1ToV2 reads them).
  setSheetId(sheetId);
  setSheetGid(entriesSheet.properties.sheetId);

  // Validate schema. Missing Metadata → must be v1/v2 with a known header shape, or refuse.
  const version = await readSheetSchemaVersion(sheetId);
  if (version == null) {
    const headerRead = await apiCall(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${ENTRIES_RANGE_HEADER}`
    );
    const headerRow = headerRead.values?.[0] || [];
    if (!headersMatch(headerRow, ENTRIES_HEADER_V1)
      && !headersMatch(headerRow, ENTRIES_HEADER_V2)
      && !headersMatch(headerRow, ENTRIES_HEADER_V3)) {
      clearSheetId();
      clearSheetGid();
      throw new Error("Doesn't look like a Food & Weight sheet");
    }
  } else if (version > SHEET_SCHEMA_VERSION) {
    clearSheetId();
    clearSheetGid();
    throw new Error(`Sheet schema v${version} is newer than this app understands`);
  }

  // localStorage cookie so we won't try to add an AI_Context tab — assume the attached sheet has one
  // (legacy sheets do; ensureAIContextSheet handles the no-op case safely on its own).
  localStorage.setItem(AI_CONTEXT_READY_KEY, '1');
}

async function actionConnect() {
  setSyncStatus('');
  const inputVal = syncUI.url?.value || '';
  try {
    if (inputVal.trim()) {
      console.log('[sync] Attaching to existing sheet…');
      setSyncStatus('Attaching…', 'info');
      await requestToken({ silent: false });
      await captureEmailIfNeeded();
      await attachToSheet(inputVal);
      if (syncUI.url) syncUI.url.value = '';
      await ensureAIContextSheet();
      await pullContextFromSheet();
      const n = await pullEntriesFromSheet();
      renderSyncUI();
      syncUnsyncedEntries().catch(() => {});
      setSyncStatus(`Attached. Pulled ${n} entries.`, 'ok');
    } else {
      console.log('[sync] Creating new sheet…');
      setSyncStatus('Creating sheet…', 'info');
      await requestToken({ silent: false });
      await captureEmailIfNeeded();
      await ensureSheet();
      await ensureAIContextSheet();
      await pullContextFromSheet();
      await pullEntriesFromSheet();
      renderSyncUI();
      syncUnsyncedEntries().catch(() => {});
      setSyncStatus('Connected.', 'ok');
    }
  } catch (err) {
    console.warn('[sync] Connect failed:', err.message);
    setSyncStatus(`Connect failed: ${err.message.slice(0, 120)}`, 'error');
  }
}

async function actionRefresh() {
  if (!getSheetId()) { setSyncStatus('No sheet connected.', 'error'); return; }
  setSyncStatus('Refreshing…', 'info');
  try {
    await ensureFreshToken();
    const n = await pullEntriesFromSheet();
    setSyncStatus(`Refreshed ${n} entries.`, 'ok');
  } catch (err) {
    setSyncStatus(`Refresh failed: ${err.message.slice(0, 120)}`, 'error');
  }
}

function actionForget() {
  clearSheetId();
  clearSheetGid();
  clearEmail();
  localStorage.removeItem(AI_CONTEXT_READY_KEY);
  accessToken = null;
  tokenExpiresAt = 0;
  schemaCompatible = true;
  db.entries.toCollection().modify({ synced: false }).catch(() => {});
  console.log('[sync] Local state cleared');
  renderSyncUI();
  setSyncStatus('Disconnected.', 'info');
}

if (syncUI.connect) syncUI.connect.addEventListener('click', actionConnect);
if (syncUI.refresh) syncUI.refresh.addEventListener('click', actionRefresh);
if (syncUI.forget) syncUI.forget.addEventListener('click', actionForget);

function initOnLoad() {
  if (!window.google?.accounts?.oauth2) {
    setTimeout(initOnLoad, 200);
    return;
  }
  renderSyncUI();
  if (getSheetId()) {
    requestToken({ silent: true })
      .then(async () => {
        console.log('[sync] Silent re-auth ok');
        await captureEmailIfNeeded();
        await ensureAIContextSheet();
        await pullContextFromSheet();
        await pullEntriesFromSheet();
        renderSyncUI();
        syncUnsyncedEntries().catch(() => {});
      })
      .catch((err) => console.warn('[sync] Silent re-auth failed:', err.message));
  }
}

initOnLoad();
