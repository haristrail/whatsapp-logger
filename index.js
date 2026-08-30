const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const { google } = require('googleapis');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');

const SHEET_ID = process.env.SHEET_ID;
const AUTH_DIR = path.join(__dirname, 'auth_info');
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // e.g. "haristrail/wa-session"
const GITHUB_SESSION_FILE = 'session.json';
const PAIRING_PHONE = process.env.PAIRING_PHONE; // e.g. "923192257221" for headless pairing
const PORT = process.env.PORT || 8080;

let credentials = null;
try {
  credentials = process.env.GOOGLE_SERVICE_ACCOUNT_PATH
    ? JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_PATH, 'utf8'))
    : JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
} catch {
  console.error('WARNING: No Google credentials configured — sheet logging disabled');
}
const sheets = credentials
  ? google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] }) })
  : null;

const sheetTabs = new Set();
const sheetIds = new Map();
const tabForSender = new Map();
const tabOwners = new Map();
const tabRows = new Map();
const PAGE_SIZE = 300;

const contactNames = new Map();
let lastBlobHash = null;

// ---------- minimal HTTP server (health endpoint for Koyeb / keepalive ping) ----------
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  })
  .listen(PORT, '0.0.0.0', () => console.log('HTTP server listening on port ' + PORT));

// ---------- GitHub session backup ----------
function githubHeaders() {
  return {
    Authorization: 'Bearer ' + GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
  };
}

async function githubRequest(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: githubHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('GitHub ' + method + ' ' + url + ' -> ' + res.status + ': ' + text.slice(0, 200));
  }
  return res;
}

async function restoreFromGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_SESSION_FILE}`;
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) {
      console.log('GitHub session not found yet (fresh start expected): ' + res.status);
      return;
    }
    const data = await res.json();
    const blob = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.mkdirSync(path.join(AUTH_DIR, 'sessions'), { recursive: true });
    for (const [name, content] of Object.entries(blob.sessions || {})) {
      fs.writeFileSync(path.join(AUTH_DIR, 'sessions', name), content);
    }
    if (blob.creds) fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), blob.creds);
    if (blob.contacts) fs.writeFileSync(CONTACTS_FILE, blob.contacts);
    console.log('Restored WhatsApp session from GitHub (' + Object.keys(blob.sessions || {}).length + ' session files)');
  } catch (err) {
    console.error('GitHub restore error:', err.message);
  }
}

function readSessionBlob() {
  const blob = { creds: null, sessions: {}, contacts: null };
  try {
    blob.creds = fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8');
  } catch {}
  try {
    const sessDir = path.join(AUTH_DIR, 'sessions');
    for (const f of fs.readdirSync(sessDir)) {
      if (f.endsWith('.json')) blob.sessions[f] = fs.readFileSync(path.join(sessDir, f), 'utf8');
    }
  } catch {}
  try {
    blob.contacts = fs.readFileSync(CONTACTS_FILE, 'utf8');
  } catch {}
  return blob;
}

async function syncToGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  try {
    const blob = readSessionBlob();
    if (!blob.creds) return;
    const hash = crypto.createHash('sha1').update(JSON.stringify(blob)).digest('hex');
    if (hash === lastBlobHash) return;
    lastBlobHash = hash;
    const content = Buffer.from(JSON.stringify(blob), 'utf8').toString('base64');
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_SESSION_FILE}`;
    let sha = null;
    try {
      const res = await githubRequest('GET', url + '?ref=main');
      const data = await res.json();
      sha = data.sha;
    } catch {}
    await githubRequest('PUT', url, {
      message: 'session update ' + new Date().toISOString(),
      content,
      sha,
      branch: 'main',
    });
  } catch (err) {
    console.error('GitHub sync error:', err.message);
  }
}

function loadContactsFile() {
  try {
    const raw = fs.readFileSync(CONTACTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [k, v] of Object.entries(data)) contactNames.set(k, v);
    console.log('Loaded contacts.json: ' + contactNames.size + ' names');
  } catch {}
}

function saveContactsFile() {
  try {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(Object.fromEntries(contactNames)));
  } catch (err) {
    console.error('Save contacts.json error:', err.message);
  }
}

function sanitizeTabName(name) {
  let s = String(name || 'unknown')
    .replace(/[\\/?:*\[\]]/g, '')
    .trim();
  if (!s) s = 'unknown';
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}

function tabNameFor(key, displayName) {
  if (tabForSender.has(key)) return tabForSender.get(key);
  const base = sanitizeTabName(displayName || key);
  let candidate = base;
  let n = 2;
  while (tabOwners.has(candidate) && tabOwners.get(candidate) !== key) {
    candidate = base + ' ' + n++;
  }
  tabForSender.set(key, candidate);
  tabOwners.set(candidate, key);
  return candidate;
}

function nextPageName(current) {
  const m = current.match(/^(.*?) (\d+)$/);
  if (m) return m[1] + ' ' + (parseInt(m[2]) + 1);
  return current + ' 2';
}

async function loadSheetTabs() {
  if (!sheets) return;
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: 'sheets.properties.title,sheets.properties.sheetId,sheets.properties.gridProperties.rowCount',
    });
    for (const sh of meta.data.sheets) {
      sheetTabs.add(sh.properties.title);
      sheetIds.set(sh.properties.title, sh.properties.sheetId);
      tabRows.set(sh.properties.title, sh.properties.gridProperties.rowCount);
    }
  } catch (err) {
    console.error('Load sheet tabs error:', err.message);
  }
}

function buildFormatRequests(sheetId, withBanding) {
  const requests = [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, endColumnIndex: 5 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.13, green: 0.27, blue: 0.49 },
            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 10 },
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      },
    },
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 5 },
      },
    },
  ];
  if (withBanding) {
    requests.push({
      addBanding: {
        bandedRange: {
          range: { sheetId, startRowIndex: 1, endRowIndex: PAGE_SIZE + 1, endColumnIndex: 5 },
          rowProperties: {
            headerColor: { red: 0.9, green: 0.93, blue: 0.97 },
            firstBandColor: { red: 1, green: 1, blue: 1 },
            secondBandColor: { red: 0.95, green: 0.96, blue: 0.98 },
          },
        },
      },
    });
  }
  return requests;
}

async function formatSheet(sheetName) {
  const sheetId = sheetIds.get(sheetName);
  if (sheetId === undefined) return;
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: buildFormatRequests(sheetId, true) },
    });
    console.log('Formatted tab: ' + sheetName);
  } catch (err) {
    if (String(err.message || '').includes('already has alternating background colors')) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: { requests: buildFormatRequests(sheetId, false) },
        });
      } catch (err2) {
        console.error('Sheet format error (' + sheetName + '):', err2.message);
      }
      return;
    }
    console.error('Sheet format error (' + sheetName + '):', err.message);
  }
}

async function ensureSheet(sheetName) {
  if (sheetTabs.has(sheetName)) return;
  try {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    const id = res.data.replies[0].addSheet.properties.sheetId;
    sheetTabs.add(sheetName);
    sheetIds.set(sheetName, id);
    tabRows.set(sheetName, 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${sheetName}'!A1:E1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Date', 'Time', 'Name', 'Sender', 'Message']] },
    });
    await formatSheet(sheetName);
    console.log('Created sheet tab: ' + sheetName);
  } catch (err) {
    console.error('Sheet create error:', err.message);
  }
}

async function getTabRows(sheetName) {
  if (tabRows.has(sheetName)) return tabRows.get(sheetName);
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${sheetName}'!A1:A`,
    });
    const count = (res.data.values || []).length || 1;
    tabRows.set(sheetName, count);
    return count;
  } catch {
    tabRows.set(sheetName, 1);
    return 1;
  }
}

async function pickPage(key, displayName) {
  const base = tabNameFor(key, displayName);
  let current = tabForSender.get(key) || base;
  for (let i = 0; i < 20; i++) {
    await ensureSheet(current);
    let count = await getTabRows(current);
    if (count < PAGE_SIZE) return { tab: current, count };
    current = nextPageName(current);
    tabForSender.set(key, current);
  }
  return { tab: current, count: PAGE_SIZE };
}

async function appendToSheet(sheetName, date, time, name, sender, message) {
  if (!sheets) return false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `'${sheetName}'!A:E`,
        valueInputOption: 'RAW',
        requestBody: { values: [[date, time, name ?? '', sender ?? '', message]] },
      });
      return true;
    } catch (err) {
      console.error('Sheet write error (attempt ' + attempt + '):', err.message);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  return false;
}

function getMessageText(msg) {
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  if (msg.documentMessage?.fileName) return '[document: ' + msg.documentMessage.fileName + ']';
  if (msg.contactMessage?.displayName) return '[contact: ' + msg.contactMessage.displayName + ']';
  if (msg.locationMessage) return '[location]';
  if (msg.audioMessage) return '[audio message]';
  if (msg.imageMessage) return '[image message]';
  if (msg.videoMessage) return '[video message]';
  if (msg.stickerMessage) return '[sticker]';
  if (msg.pttMessage) return '[voice message]';
  return '[non-text message]';
}

function normalizeJid(jid) {
  return (jid || '').split('@')[0].split(':')[0];
}

function isValidName(name) {
  if (!name) return false;
  const s = String(name).trim();
  if (!s) return false;
  if (s.length > 60) return false;
  if (/^[.\s\-_@#*]+$/.test(s)) return false;
  if (/[\uFFFD]/.test(s)) return false;
  return true;
}

function storeContact(c) {
  if (!c || !c.id) return;
  const name = c.name;
  if (!isValidName(name)) return;
  for (const key of [c.id, c.lid, c.phoneNumber].filter(Boolean)) {
    contactNames.set(key, name);
    contactNames.set(normalizeJid(key), name);
  }
  saveContactsFile();
}

let pairingTimer = null;

async function startBot() {
  await restoreFromGitHub();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) storeContact(c);
  });

  sock.ev.on('messaging-history.set', ({ contacts, isLatest }) => {
    let saved = 0;
    for (const c of contacts || []) {
      if (c.name) {
        storeContact(c);
        saved++;
      }
    }
    console.log(`History contacts: ${contacts?.length || 0} total, ${saved} with saved names (isLatest: ${isLatest})`);
  });

  function resolveName(jid, sender) {
    const lid = normalizeJid(jid);
    if (contactNames.has(lid)) return contactNames.get(lid);
    if (sender && contactNames.has(sender)) return contactNames.get(sender);
    return sender || lid || 'unknown';
  }

  async function resolveSender(jid) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
      if (pn) return normalizeJid(pn);
    } catch {}
    return normalizeJid(jid);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      if (PAIRING_PHONE) {
        clearTimeout(pairingTimer);
        pairingTimer = setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(PAIRING_PHONE);
            console.log('PAIRING CODE: ' + code);
          } catch (err) {
            console.error('Pairing code error:', err.message);
          }
        }, 3000);
      } else {
        qrcode.generate(qr, { small: false });
        QRCode.toFile('qr.png', qr, { width: 300 }).then(() => console.log('QR saved to qr.png')).catch(console.error);
      }
    }
    if (connection === 'close') {
      clearTimeout(pairingTimer);
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('Connection closed, reconnecting in 8s...');
        setTimeout(() => startBot(), 8000);
      }
    } else if (connection === 'open') {
      clearTimeout(pairingTimer);
      syncToGitHub();
      syncTimer = setInterval(syncToGitHub, 30000);
      console.log('WhatsApp connected!');
      console.log('Logged in as: ' + sock.user?.id);
    }
  });

  sock.ev.on('creds.update', () => {
    saveCreds();
    syncToGitHub();
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      const jid = msg.key.remoteJid || '';
      const sender = await resolveSender(jid);
      const name = resolveName(jid, sender);
      const text = getMessageText(msg.message);
      const { tab, count } = await pickPage(sender, name);
      const now = new Date();
      const opts = { timeZone: 'Asia/Karachi' };
      const ok = await appendToSheet(
        tab,
        now.toLocaleDateString('en-PK', opts),
        now.toLocaleTimeString('en-PK', opts),
        name,
        sender,
        text
      );
      if (ok) tabRows.set(tab, count + 1);
      console.log(`Logged to "${tab}" from ${name} (${sender}) (sheet: ${ok ? 'ok' : 'FAILED'}): ${text}`);
    }
  });
}

let syncTimer = null;

(async () => {
  loadContactsFile();
  await loadSheetTabs();
  for (const t of sheetTabs) await formatSheet(t);
  startBot();
})();

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('SIGTERM', () => {
  console.log('SIGTERM received, syncing session...');
  syncToGitHub().then(() => process.exit(0)).catch(() => process.exit(0));
});