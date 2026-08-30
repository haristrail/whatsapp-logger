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
const PAGE_SIZE = 20000;
const DM_TAB = 'Direct Messages';
const MEDIA_DIR = path.join(__dirname, 'media');
const groupNames = new Map();

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
  const COL = 6;
  const requests = [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, endColumnIndex: COL },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.18, green: 0.35, blue: 0.58 },
            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 10, fontFamily: 'Segoe UI' },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
      },
    },
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: COL },
      },
    },
  ];
  const widths = [110, 105, 170, 125, 95, 460];
  widths.forEach((w, i) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: w },
        fields: 'pixelSize',
      },
    });
  });
  if (withBanding) {
    requests.push({
      addBanding: {
        bandedRange: {
          range: { sheetId, startRowIndex: 1, endRowIndex: PAGE_SIZE + 1, endColumnIndex: COL },
          rowProperties: {
            headerColor: { red: 0.9, green: 0.93, blue: 0.97 },
            firstBandColor: { red: 1, green: 1, blue: 1 },
            secondBandColor: { red: 0.96, green: 0.97, blue: 0.99 },
          },
        },
      },
    });
  }
  requests.push({
    setBasicFilter: {
      filter: { range: { sheetId, startRowIndex: 0, endRowIndex: PAGE_SIZE + 1, endColumnIndex: COL } },
    },
  });
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
      range: `'${sheetName}'!A1:F1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Date', 'Time', 'Name', 'Sender', 'Type', 'Message']] },
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

function isGroupJid(jid) {
  return (jid || '').endsWith('@g.us');
}

async function groupTabName(sock, jid) {
  if (groupNames.has(jid)) return groupNames.get(jid);
  try {
    const meta = await sock.groupMetadata(jid);
    groupNames.set(jid, sanitizeTabName(meta.subject || 'Group ' + normalizeJid(jid)));
  } catch {
    groupNames.set(jid, 'Group ' + normalizeJid(jid));
  }
  return groupNames.get(jid);
}

async function pageFor(sock, jid) {
  let current = isGroupJid(jid) ? await groupTabName(sock, jid) : DM_TAB;
  for (let i = 0; i < 20; i++) {
    await ensureSheet(current);
    let count = await getTabRows(current);
    if (count < PAGE_SIZE) return { tab: current, count };
    current = nextPageName(current);
  }
  return { tab: current, count: PAGE_SIZE };
}

async function appendToSheet(sheetName, date, time, name, sender, type, message) {
  if (!sheets) return false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `'${sheetName}'!A:F`,
        valueInputOption: 'RAW',
        requestBody: { values: [[date, time, name ?? '', sender ?? '', type, message]] },
      });
      return true;
    } catch (err) {
      console.error('Sheet write error (attempt ' + attempt + '):', err.message);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  return false;
}

function capLen(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'audio/ogg': '.ogg', 'audio/opus': '.opus',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'application/pdf': '.pdf',
  'text/plain': '.txt', 'application/zip': '.zip',
};
function extFromMime(mime) {
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const part = (mime || '').split('/')[1];
  return part ? '.' + part.replace(/[^a-z0-9]/gi, '').toLowerCase() : '.bin';
}
function mediaBase() {
  return new Date().toISOString().slice(2, 19).replace(/[-:T]/g, '');
}
async function downloadAndSave(sock, msg, sub, mime, baseName) {
  try {
    const buf = await sock.downloadMediaMessage(msg, 'buffer');
    if (!buf || buf.length === 0) return null;
    fs.mkdirSync(path.join(MEDIA_DIR, sub), { recursive: true });
    const ext = extFromMime(mime);
    const name = (baseName ? String(baseName).replace(/[^\w.-]+/g, '_').slice(0, 50) : sub + '_' + mediaBase()) + '_' + Math.floor(Math.random() * 1000) + ext;
    fs.writeFileSync(path.join(MEDIA_DIR, sub, name), buf);
    return path.relative(__dirname, path.join(MEDIA_DIR, sub, name)).replace(/\\/g, '/');
  } catch (err) {
    console.error('Media save error (' + sub + '):', err.message);
    return null;
  }
}

function mediaContent(type, mediaPath, extra) {
  const tag = '[' + type + ']';
  if (mediaPath && extra) return tag + ' ' + mediaPath + ' · ' + capLen(extra, 500);
  if (mediaPath) return tag + ' ' + mediaPath;
  if (extra) return tag + ' ' + capLen(extra, 500);
  return tag;
}

function unwrapContent(m) {
  while (m && (m.viewOnceMessage?.message || m.ephemeralMessage?.message || m.documentWithCaptionMessage?.message || m.imageMessageWithContextInfo?.message || m.videoMessageWithContextInfo?.message || m.audioMessageWithContextInfo?.message)) {
    m = (m.viewOnceMessage || m.ephemeralMessage || m.documentWithCaptionMessage || m.imageMessageWithContextInfo || m.videoMessageWithContextInfo || m.audioMessageWithContextInfo)?.message || m;
  }
  return m;
}

function getMessageInfo(msg) {
  let m = unwrapContent(msg);
  if (!m) return { type: 'Other', text: '' };
  if (m.protocolMessage) {
    if (m.protocolMessage.type === 0) return { type: 'Deleted', text: '[deleted message]' };
    return null;
  }
  if (m.callingMessage) return { type: 'Call', text: '[call]' };
  if (m.conversation != null) return { type: 'Text', text: String(m.conversation) };
  if (m.extendedTextMessage) return { type: 'Text', text: m.extendedTextMessage.text || '' };
  if (m.imageMessage) return { type: 'Image', text: m.imageMessage.caption ? capLen(m.imageMessage.caption, 1000) : '' };
  if (m.videoMessage) return { type: 'Video', text: m.videoMessage.caption ? capLen(m.videoMessage.caption, 1000) : '' };
  if (m.pttMessage) return { type: 'Voice', text: '[' + (m.pttMessage.seconds || 0) + 's]' };
  if (m.audioMessage) return { type: 'Audio', text: '[' + (m.audioMessage.seconds || 0) + 's]' };
  if (m.stickerMessage) return { type: 'Sticker', text: m.stickerMessage.emoji ? '[' + m.stickerMessage.emoji + ']' : '' };
  if (m.documentMessage) {
    const d = m.documentMessage;
    return { type: 'Document', text: d.fileName ? '[' + capLen(d.fileName, 300) + ']' : '' };
  }
  if (m.contactMessage) {
    return { type: 'Contact', text: m.contactMessage.displayName ? '[' + capLen(m.contactMessage.displayName, 200) + ']' : '[contact card]' };
  }
  if (m.locationMessage) {
    const l = m.locationMessage;
    return { type: 'Location', text: '[' + (l.degreesLatitude || 0) + ', ' + (l.degreesLongitude || 0) + ']' };
  }
  if (m.groupInviteMessage) {
    return { type: 'Group invite', text: '[' + capLen(m.groupInviteMessage.groupName || 'invite', 200) + ']' };
  }
  if (m.pollCreationMessage) {
    return { type: 'Poll', text: '[' + capLen(m.pollCreationMessage.name || 'poll', 300) + ']' };
  }
  if (m.pollUpdateMessage) return { type: 'Poll vote', text: '' };
  if (m.reactionMessage) {
    return { type: 'Reaction', text: m.reactionMessage.text ? '[' + m.reactionMessage.text + ']' : '[reacted]' };
  }
  if (m.buttonsResponseMessage) {
    return { type: 'Button reply', text: '[' + capLen(m.buttonsResponseMessage.selectedDisplayText || 'reply', 200) + ']' };
  }
  if (m.listResponseMessage) {
    return { type: 'List reply', text: '[' + capLen(m.listResponseMessage.title || 'reply', 200) + ']' };
  }
  if (m.checkInMessage) return { type: 'Check-in', text: '' };
  if (m.keepMessage) return { type: 'Kept', text: '[kept message]' };
  if (m.editedMessage) {
    const inner = getMessageInfo(m.editedMessage.message);
    if (!inner) return null;
    return { type: inner.type + ' (edited)', text: inner.text };
  }
  return { type: 'Other', text: '[non-text message]' };
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
      const info = getMessageInfo(msg.message);
      if (!info) continue;
      const jid = msg.key.remoteJid || '';
      const isGroup = isGroupJid(jid);
      const senderJid = isGroup && msg.key.participant ? msg.key.participant : jid;
      const sender = await resolveSender(senderJid);
      const name = resolveName(senderJid, sender);

      const { type, text } = info;
      const mm = msg.message;
      let mediaPath = null;
      if (mm.imageMessage) mediaPath = await downloadAndSave(sock, msg, 'Images', mm.imageMessage.mimetype, null)
        .catch(() => null);
      else if (mm.videoMessage) mediaPath = await downloadAndSave(sock, msg, 'Videos', mm.videoMessage.mimetype, null)
        .catch(() => null);
      else if (mm.pttMessage) mediaPath = await downloadAndSave(sock, msg, 'Voices', 'audio/ogg', null).catch(() => null);
      else if (mm.audioMessage) mediaPath = await downloadAndSave(sock, msg, 'Audio', mm.audioMessage.mimetype, null)
        .catch(() => null);
      else if (mm.stickerMessage) mediaPath = await downloadAndSave(sock, msg, 'Stickers', 'image/webp', null)
        .catch(() => null);
      else if (mm.documentMessage) mediaPath = await downloadAndSave(sock, msg, 'Documents', mm.documentMessage.mimetype, mm.documentMessage.fileName).catch(() => null);
      else if (mm.contactMessage) mediaPath = await downloadAndSave(sock, msg, 'Contacts', 'text/vcard', (mm.contactMessage.displayName || 'contact') + '.vcf').catch(() => null);

      const isMedia = ['Image', 'Video', 'Voice', 'Audio', 'Sticker', 'Document', 'Contact'].includes(type);
      const content =
        type === 'Text'
          ? text || ''
          : isMedia
            ? mediaContent(type, mediaPath, text)
            : text.startsWith('[')
              ? text
              : text
                ? `[${type}] ${text}`
                : `[${type}]`;

      const { tab, count } = await pageFor(sock, jid);
      const now = new Date();
      const opts = { timeZone: 'Asia/Karachi' };
      const ok = await appendToSheet(
        tab,
        now.toLocaleDateString('en-PK', opts),
        now.toLocaleTimeString('en-PK', opts),
        name,
        sender,
        type,
        content
      );
      if (ok) tabRows.set(tab, count + 1);
      console.log(`Logged to "${tab}" [${type}] from ${name} (${sender}) (sheet: ${ok ? 'ok' : 'FAILED'}): ${content}`);
    }
  });

  const handledCalls = new Set();
  sock.ev.on('call', async ({ calls }) => {
    for (const call of calls) {
      if (handledCalls.has(call.id)) continue;
      handledCalls.add(call.id);
      if (handledCalls.size > 2000) handledCalls.delete(handledCalls.values().next().value);
      const sender = await resolveSender(call.from);
      const name = resolveName(call.from, sender);
      const statusText =
        { offer: 'incoming', ringing: 'ringing', accept: 'accepted', reject: 'rejected', timeout: 'missed (no answer)', ended: 'ended' }[call.status] || call.status;
      const content = `[call ${call.isVideo ? 'video' : 'audio'} · ${statusText}]`;
      const { tab, count } = await pageFor(sock, call.from);
      const now = new Date();
      const opts = { timeZone: 'Asia/Karachi' };
      const ok = await appendToSheet(
        tab,
        now.toLocaleDateString('en-PK', opts),
        now.toLocaleTimeString('en-PK', opts),
        name,
        sender,
        'Call',
        content
      );
      if (ok) tabRows.set(tab, count + 1);
      console.log(`CALL ${statusText} from ${name} (${sender}) -> ${tab} (sheet: ${ok ? 'ok' : 'FAILED'}): ${content}`);
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