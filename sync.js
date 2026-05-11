// ------------------------------------------------------------------
// Spike: Google Sheets OAuth + write
//
// This file is intentionally standalone — it does not touch app.js or
// the Dexie store. Once the OAuth + Sheets round-trip is proven on the
// phone, real sync logic gets wired into the entry save flow.
// ------------------------------------------------------------------

// Paste your OAuth Client ID from Google Cloud Console here.
const CLIENT_ID = '58841586776-lbkpi48lsk19rb3e2d8icfcvammotacs.apps.googleusercontent.com';

// drive.file: app can only see/edit files it created. Sheets API works
// against this scope without needing the broader 'spreadsheets' scope.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

// Survives reloads so we don't create a new sheet every time.
const SHEET_ID_KEY = 'fw.spike.sheetId';

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;

const ui = {
  panel: document.getElementById('spike-panel'),
  status: document.getElementById('spike-status'),
  log: document.getElementById('spike-log'),
  link: document.getElementById('spike-sheet-link'),
  connect: document.getElementById('spike-connect'),
  createSheet: document.getElementById('spike-create-sheet'),
  writeRow: document.getElementById('spike-write-row'),
  forget: document.getElementById('spike-forget'),
};

function log(msg) {
  const t = new Date().toLocaleTimeString();
  ui.log.textContent = `[${t}] ${msg}\n${ui.log.textContent}`;
}

function getSheetId() { return localStorage.getItem(SHEET_ID_KEY); }
function setSheetId(id) { localStorage.setItem(SHEET_ID_KEY, id); }
function clearSheetId() { localStorage.removeItem(SHEET_ID_KEY); }

function tokenValid() {
  return !!accessToken && Date.now() < tokenExpiresAt;
}

function render() {
  const sheetId = getSheetId();
  ui.status.textContent =
    `Token: ${tokenValid() ? '✓' : '—'}   ·   Sheet: ${sheetId ? '✓' : '—'}`;

  if (sheetId) {
    ui.link.hidden = false;
    ui.link.href = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
    ui.link.textContent = 'Open sheet';
  } else {
    ui.link.hidden = true;
  }

  ui.createSheet.disabled = !tokenValid() || !!sheetId;
  ui.writeRow.disabled = !tokenValid() || !sheetId;
}

function ensureClient() {
  if (tokenClient) return true;
  if (!window.google?.accounts?.oauth2) return false;
  if (!CLIENT_ID || CLIENT_ID.startsWith('PASTE_')) {
    log('CLIENT_ID not set — paste it into sync.js');
    return false;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: () => {},        // overridden per request
    error_callback: () => {},  // overridden per request
  });
  return true;
}

// prompt:
//   ''        — silent if prior consent exists; otherwise shows consent.
//   'consent' — always shows consent screen.
function requestToken({ silent }) {
  return new Promise((resolve, reject) => {
    if (!ensureClient()) {
      reject(new Error('GIS not ready'));
      return;
    }
    let settled = false;
    const settle = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      fn(...args);
    };

    tokenClient.callback = settle((resp) => {
      if (resp.error) {
        reject(new Error(`${resp.error}: ${resp.error_description || ''}`));
        return;
      }
      accessToken = resp.access_token;
      tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000;
      resolve(resp);
    });

    // GIS routes popup/FedCM failures here, not through `callback`.
    tokenClient.error_callback = settle((err) => {
      reject(new Error(`${err?.type || 'error'}: ${err?.message || JSON.stringify(err)}`));
    });

    // Hard timeout so a silent attempt that GIS just never responds to
    // surfaces as an error instead of leaving the UI hung.
    if (silent) {
      setTimeout(settle(() => reject(new Error('silent attempt timed out (8s)'))), 8000);
    }

    tokenClient.requestAccessToken({ prompt: silent ? '' : 'consent' });
  });
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

// ------------------------------------------------------------------
// Actions
// ------------------------------------------------------------------
async function actionConnect() {
  try {
    log('Requesting token…');
    await requestToken({ silent: false });
    log('Token granted');
    render();
  } catch (err) {
    log(`Connect failed: ${err.message}`);
  }
}

async function actionCreateSheet() {
  try {
    log('Creating sheet…');
    const data = await apiCall('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      body: JSON.stringify({
        properties: { title: 'Food & Weight log' },
        sheets: [{ properties: { title: 'Entries' } }],
      }),
    });
    setSheetId(data.spreadsheetId);
    log(`Sheet created: ${data.spreadsheetId}`);

    // Write a header row so we know writes are working too.
    await apiCall(
      `https://sheets.googleapis.com/v4/spreadsheets/${data.spreadsheetId}`
        + `/values/Entries!A1:append?valueInputOption=USER_ENTERED`,
      {
        method: 'POST',
        body: JSON.stringify({
          values: [['ISO timestamp', 'Type', 'Text', 'Value']],
        }),
      }
    );
    log('Header row written');
    render();
  } catch (err) {
    log(`Create failed: ${err.message}`);
  }
}

async function actionWriteRow() {
  const sheetId = getSheetId();
  if (!sheetId) { log('No sheet yet'); return; }
  try {
    const row = [new Date().toISOString(), 'spike', 'hello from the phone', ''];
    await apiCall(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`
        + `/values/Entries!A1:append?valueInputOption=USER_ENTERED`,
      { method: 'POST', body: JSON.stringify({ values: [row] }) }
    );
    log('Row appended');
  } catch (err) {
    log(`Write failed: ${err.message}`);
  }
}

function actionForget() {
  clearSheetId();
  accessToken = null;
  tokenExpiresAt = 0;
  log('Local state cleared (sheet still exists in your Drive)');
  render();
}

// ------------------------------------------------------------------
// Wiring
// ------------------------------------------------------------------
ui.connect.addEventListener('click', actionConnect);
ui.createSheet.addEventListener('click', actionCreateSheet);
ui.writeRow.addEventListener('click', actionWriteRow);
ui.forget.addEventListener('click', actionForget);

// On load: if we already have a sheet ID, try a silent token grant so
// the panel shows "Connected" without any UI. This is the behavior we
// want to prove — second-launch onwards should never show consent.
function initOnLoad() {
  if (!window.google?.accounts?.oauth2) {
    setTimeout(initOnLoad, 200);
    return;
  }
  render();
  if (getSheetId()) {
    log('Trying silent re-auth…');
    requestToken({ silent: true })
      .then(() => { log('Silent re-auth ok'); render(); })
      .catch((err) => log(`Silent re-auth failed: ${err.message}`));
  }
}

initOnLoad();
