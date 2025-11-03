// server.js — validate via GET ?key=... and POST body {token,...}
require('dotenv').config();
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const fs = require('fs');


const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.KEY_ISSUER_BOT_TOKEN;
const REQUIRED_CHAT_ID = process.env.REQUIRED_CHAT_ID;
const OPTIONAL_CHAT_IDS = (process.env.OPTIONAL_CHAT_IDS || '').split(',').filter(Boolean);
const BASE = process.env.BASE_PATH || '/seven';

async function initDb() {
  let dbFile = process.env.DB_FILE;
  if (!dbFile) {
    dbFile = path.resolve(__dirname, 'keys.db');  // ফ্রিতে এখানে সেভ
  }
  console.log('[DB]', dbFile);

  const dir = path.dirname(dbFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = await open({ filename: dbFile, driver: sqlite3.Database });
  await db.exec(`CREATE TABLE IF NOT EXISTS keys (
    id INTEGER PRIMARY KEY,
    token TEXT UNIQUE,
    telegram_user_id INTEGER,
    channels TEXT,
    created_at INTEGER,
    used INTEGER DEFAULT 0,
    consumed_by TEXT,
    consumed_at INTEGER
  );`);
  return db;
}
(async () => {
  const db = await initDb();
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());

  // Health
  app.get(BASE + '/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

  // Core consume function (shared by GET/POST)
  async function consumeToken(token, machine_id) {
    const row = await db.get('SELECT * FROM keys WHERE token = ?', token);
    if (!row) return { ok: true, valid: false, reason: 'not_found' };
    if (row.used) return { ok: true, valid: false, reason: 'already_used' };

    const now = Date.now();
    const r = await db.run(
      `UPDATE keys SET used=1, consumed_by=?, consumed_at=? WHERE token=? AND used=0`,
      machine_id || null, now, token
    );
    if (r.changes === 0) {
      return { ok: true, valid: false, reason: 'race_or_used' };
    }
    return { ok: true, valid: true, consumed_at: now };
  }

  // POST /seven/validate  { token, machine_id? }
  app.post(BASE + '/validate', async (req, res) => {
    try {
      const { token, machine_id } = req.body || {};
      if (!token) return res.status(400).json({ ok: false, error: 'no token' });
      const out = await consumeToken(token, machine_id);
      res.json(out);
    } catch (e) {
      console.error('POST /validate error', e);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ? GET /seven/validate?key=...&mid=...
  app.get(BASE + '/validate', async (req, res) => {
    try {
      const token = req.query.key || req.query.token;
      const machine_id = req.query.mid || req.query.machine_id || null;
      if (!token) return res.status(400).json({ ok: false, error: 'no key' });
      const out = await consumeToken(token, machine_id);
      res.json(out);                // JSON response
      // ????? Plain text ???? ????: res.type('text').send(out.valid ? 'OK' : 'INVALID');
    } catch (e) {
      console.error('GET /validate error', e);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // Start server (localhost — reverse proxy ???? ?????? ???)
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Key server listening http://127.0.0.1:${PORT}${BASE}`);
  });

  // (Optional) Telegram key issuer bot
  if (BOT_TOKEN) {
    const bot = new TelegramBot(BOT_TOKEN, { polling: true });

    bot.onText(/\/getkey/, async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      try {
        const member = await bot.getChatMember(REQUIRED_CHAT_ID, userId).catch(() => null);
        if (!member || ['left', 'kicked'].includes(member.status)) {
          return bot.sendMessage(chatId, `? Required channel ? join ???? ????`);
        }
        const token = crypto.randomBytes(24).toString('hex');
        const channels = JSON.stringify([REQUIRED_CHAT_ID, ...OPTIONAL_CHAT_IDS]);
        await db.run(
          'INSERT INTO keys (token, telegram_user_id, channels, created_at) VALUES (?,?,?,?)',
          token, userId, channels, Date.now()
        );
        await bot.sendMessage(
          chatId,
          `Your key:\n\n<code>${token}</code>\n\nCopy and paste on Ws Checker Client to activate.`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.error('issue err', err);
        bot.sendMessage(chatId, '? Key issue ???? ??? ?????? ??????');
      }
    });
  } else {
    console.warn('KEY_ISSUER_BOT_TOKEN missing — bot disabled');
  }
})();


