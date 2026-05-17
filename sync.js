// Google Sheets OAuth + sync
const CLIENT_ID = '58841586776-lbkpi48lsk19rb3e2d8icfcvammotacs.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const SHEET_ID_KEY = 'fw.spike.sheetId';
const SHEET_GID_KEY = 'fw.spike.sheetGid';
const EMAIL_KEY = 'fw.spike.email';
const AI_CONTEXT_READY_KEY = 'fw.aiContext.ready';
const AI_CONTEXT_STORAGE_KEY = 'fw_gemini_context';

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;

const syncUI = {
  connect: document.getElementById('sync-connect'),
  forget: document.getElementById('sync-forget'),
  link: document.getElementById('sync-sheet-link'),
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

function renderSyncUI() {
  const sheetId = getSheetId();
  if (sheetId) {
    syncUI.link.hidden = false;
    syncUI.link.href = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
    syncUI.link.textContent = 'Open sheet';
    syncUI.forget.hidden = false;
  } else {
    syncUI.link.hidden = true;
    syncUI.forget.hidden = true;
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
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
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
      ],
    }),
  });
  setSheetId(data.spreadsheetId);
  setSheetGid(data.sheets[0].properties.sheetId);
  localStorage.setItem(AI_CONTEXT_READY_KEY, '1');
  console.log('[sync] Sheet created:', data.spreadsheetId);
  const sid = data.spreadsheetId;
  await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/Entries!A1:append?valueInputOption=RAW`,
    {
      method: 'POST',
      body: JSON.stringify({
        values: [['id', 'epoch', 'iso_date', 'type', 'value', 'notes', 'time_category', 'calories', 'synced_at']],
      }),
    }
  );
  await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/AI_Context!A1:append?valueInputOption=RAW`,
    { method: 'POST', body: JSON.stringify({ values: [['Diet Context Profile']] }) }
  );
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
    // Sheet already exists or other non-fatal error
    console.log('[sync] AI_Context sheet check:', err.message.slice(0, 80));
  }
  localStorage.setItem(AI_CONTEXT_READY_KEY, '1');
}

async function pushContextToSheet(contextString) {
  if (!getSheetId() || !tokenValid()) return;
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

async function pullEntriesFromSheet() {
  if (!getSheetId()) return;
  try {
    const sheetId = getSheetId();
    const data = await apiCall(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Entries!A:I`
    );
    const rows = data.values || [];
    if (rows.length <= 1) return; // header only
    let upserted = 0;
    for (const row of rows.slice(1)) {
      const id = Number(row[0]);
      if (!id) continue;
      const type = row[3] || 'food';
      const rawValue = row[4] || '';
      const entry = {
        id,
        timestamp: Number(row[1]) || Date.parse(row[2]) || Date.now(),
        type,
        notes: row[5] || '',
        timeCategory: row[6] || '',
        calories: row[7] ? Number(row[7]) : undefined,
        synced: true,
      };
      if (type === 'food') {
        entry.text = rawValue;
      } else {
        entry.value = rawValue !== '' ? Number(rawValue) : undefined;
      }
      await db.entries.put(entry);
      upserted++;
    }
    console.log('[sync] Pulled', upserted, 'entries from sheet');
    if (typeof refreshList === 'function') refreshList();
  } catch (err) {
    console.warn('[sync] pullEntriesFromSheet failed:', err.message);
  }
}

// Writes entries to the sheet. Throws on failure so callers can decide whether to mark synced.
async function syncEntriesToSheet(entriesArray) {
  if (!entriesArray.length) return;
  await ensureFreshToken();
  await ensureSheet();
  const sheetId = getSheetId();
  const now = new Date().toISOString();
  const rows = entriesArray.map(e => [
    e.id,
    e.timestamp,
    new Date(e.timestamp).toISOString(),
    e.type,
    e.value != null ? e.value : (e.text || ''),
    e.notes || '',
    e.timeCategory || '',
    e.calories || '',
    now,
  ]);
  await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Entries!A1:append?valueInputOption=RAW`,
    { method: 'POST', body: JSON.stringify({ values: rows }) }
  );
  renderSyncUI();
  console.log('[sync] Synced', rows.length, 'entries');
}

async function deleteEntryFromSheet(entryId) {
  if (!getSheetId()) return;
  try {
    await ensureFreshToken();
    const sheetId = getSheetId();
    // Find the row in column A that matches this entry's id
    const colA = await apiCall(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Entries!A:A`
    );
    const rows = colA.values || [];
    const rowIndex = rows.findIndex((r, i) => i > 0 && String(r[0]) === String(entryId));
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
  if (!getSheetId()) return;
  await ensureFreshToken();
  const sheetId = getSheetId();
  const colA = await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Entries!A:A`
  );
  const rows = colA.values || [];
  const rowIndex = rows.findIndex((r, i) => i > 0 && String(r[0]) === String(entry.id));
  if (rowIndex === -1) {
    console.log('[sync] updateEntryInSheet: entry not found in sheet');
    return;
  }
  const range = `Entries!A${rowIndex + 1}:I${rowIndex + 1}`;
  const now = new Date().toISOString();
  const row = [
    entry.id,
    entry.timestamp,
    new Date(entry.timestamp).toISOString(),
    entry.type,
    entry.value != null ? entry.value : (entry.text || ''),
    entry.notes || '',
    entry.timeCategory || '',
    entry.calories || '',
    now,
  ];
  await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=RAW`,
    { method: 'PUT', body: JSON.stringify({ values: [row] }) }
  );
  console.log('[sync] Row updated in sheet:', entry.id);
}

async function actionConnect() {
  try {
    console.log('[sync] Requesting token…');
    await requestToken({ silent: false });
    console.log('[sync] Token granted');
    await captureEmailIfNeeded();
    await ensureSheet();
    await ensureAIContextSheet();
    await pullContextFromSheet();
    await pullEntriesFromSheet();
    renderSyncUI();
    syncUnsyncedEntries().catch(() => {});
  } catch (err) {
    console.warn('[sync] Connect failed:', err.message);
  }
}

function actionForget() {
  clearSheetId();
  clearSheetGid();
  clearEmail();
  localStorage.removeItem(AI_CONTEXT_READY_KEY);
  accessToken = null;
  tokenExpiresAt = 0;
  // Reset synced flag so all entries re-sync on next connect
  db.entries.toCollection().modify({ synced: false }).catch(() => {});
  console.log('[sync] Local state cleared');
  renderSyncUI();
}

syncUI.connect.addEventListener('click', actionConnect);
syncUI.forget.addEventListener('click', actionForget);

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
