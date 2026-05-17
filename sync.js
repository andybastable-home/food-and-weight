// Google Sheets OAuth + sync
const CLIENT_ID = '58841586776-lbkpi48lsk19rb3e2d8icfcvammotacs.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const SHEET_ID_KEY = 'fw.spike.sheetId';
const EMAIL_KEY = 'fw.spike.email';

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
      sheets: [{ properties: { title: 'Entries' } }],
    }),
  });
  setSheetId(data.spreadsheetId);
  console.log('[sync] Sheet created:', data.spreadsheetId);
  await apiCall(
    `https://sheets.googleapis.com/v4/spreadsheets/${data.spreadsheetId}/values/Entries!A1:append?valueInputOption=RAW`,
    {
      method: 'POST',
      body: JSON.stringify({
        values: [['id', 'epoch', 'iso_date', 'type', 'value', 'notes', 'time_category', 'calories', 'synced_at']],
      }),
    }
  );
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

async function actionConnect() {
  try {
    console.log('[sync] Requesting token…');
    await requestToken({ silent: false });
    console.log('[sync] Token granted');
    await captureEmailIfNeeded();
    renderSyncUI();
    syncUnsyncedEntries().catch(() => {});
  } catch (err) {
    console.warn('[sync] Connect failed:', err.message);
  }
}

function actionForget() {
  clearSheetId();
  clearEmail();
  accessToken = null;
  tokenExpiresAt = 0;
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
        renderSyncUI();
        syncUnsyncedEntries().catch(() => {});
      })
      .catch((err) => console.warn('[sync] Silent re-auth failed:', err.message));
  }
}

initOnLoad();
