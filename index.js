const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const { google } = require('googleapis');
const qrcode = require('qrcode-terminal');

const SHEET_ID = process.env.SHEET_ID;
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

async function appendToSheet(date, time, sender, message) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:D',
      valueInputOption: 'RAW',
      requestBody: { values: [[date, time, sender, message]] },
    });
  } catch (err) {
    console.error('Sheet write error:', err.message);
  }
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

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) qrcode.generate(qr, { small: false });
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('WhatsApp connected!');
      console.log('Logged in as: ' + sock.user?.id);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      const sender = (msg.key.remoteJid || '').split('@')[0];
      const text = getMessageText(msg.message);
      const now = new Date();
      await appendToSheet(
        now.toLocaleDateString('en-PK'),
        now.toLocaleTimeString('en-PK'),
        sender,
        text
      );
      console.log(`Logged message from ${sender}`);
    }
  });
}

startBot();