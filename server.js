// server.js — WhatsApp Key Validation Server with Telegram Bot Issuer
// Deployed on Render (free tier compatible, ephemeral DB)
// Features: GET/POST /validate, /health, Telegram /getkey command

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

// Config from Env (Render > Environment Variables)
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Must bind to 0.0.0.0 for Render port detection
const BOT_TOKEN = process.env.KEY_ISSUER_BOT_TOKEN;
const REQUIRED_CHAT_ID = process.env.REQUIRED_CHAT_ID;
const OPTIONAL_CHAT_IDS = (process.env.OPTIONAL_CHAT_IDS || '').split(',').filter(Boolean);
const BASE_PATH = process.env.BASE_PATH || '/seven'; // Fixed: Now defined

// Init SQLite DB (fallback to __dirname for free tier)
async function initDb() {
  let dbFile = process.env.DB_FILE;
  if (!dbFile) {
    dbFile = path.resolve(__dirname, 'keys.db'); // Ephemeral in free tier
  }
  console.log('[DB]', dbFile);

  const dir = path.dirname(dbFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = await open({ filename: dbFile, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE,
      telegram_user_id INTEGER,
      channels TEXT,
      created_at INTEGER,
      used INTEGER DEFAULT 0,
      consumed_by TEXT,
      consumed_at INTEGER
    );
  `);
  return db;
}

// Main IIFE
(async () => {
  const db = await initDb();
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());

  // Health Check Endpoint
  app.get(`${BASE_PATH}/health`, (req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // Shared Token Consume Logic
  async function consumeToken(token, machine_id) {
    const row = await db.get('SELECT * FROM keys WHERE token = ?', token);
    if (!row) return { ok: true, valid: false, reason: 'not_found' };
    if (row.used) return { ok: true, valid: false, reason: 'already_used' };

    const now = Date.now();
    const r = await db.run(
      `UPDATE keys SET used = 1, consumed_by = ?, consumed_at = ? WHERE token = ? AND used = 0`,
      machine_id || null,
      now,
      token
    );

    if (r.changes === 0) {
      return { ok: true, valid: false, reason: 'race_or_used' };
    }
    return { ok: true, valid: true, consumed_at: now };
  }

  // POST /seven/validate { token: "...", machine_id?: "..." }
  app.post(`${BASE_PATH}/validate`, async (req, res) => {
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

  // GET /seven/validate?key=...&mid=...
  app.get(`${BASE_PATH}/validate`, async (req, res) => {
    try {
      const token = req.query.key || req.query.token;
      const machine_id = req.query.mid || req.query.machine_id || null;
      if (!token) return res.status(400).json({ ok: false, error: 'no key' });
      const out = await consumeToken(token, machine_id);
      res.json(out);
    } catch (e) {
      console.error('GET /validate error', e);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // Start Server
  app.listen(PORT, HOST, () => {
    console.log(`Key server listening on http://${HOST}:${PORT}${BASE_PATH}`);
  });

  // Optional Telegram Bot for /getkey
  if (BOT_TOKEN && REQUIRED_CHAT_ID) {
    const bot = new TelegramBot(BOT_TOKEN, { polling: true });
    bot.onText(/\/getkey/, async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id;
      if (!userId) return bot.sendMessage(chatId, '❌ User ID not found.');

      try {
        // Check required channel membership
        const member = await bot.getChatMember(REQUIRED_CHAT_ID, userId).catch(() => null);
        if (!member || !['member', 'administrator', 'creator'].includes(member.status)) {
          return bot.sendMessage(chatId, `❌ You must join the required channel first!`);
        }

        // Generate & Save Key
        const token = crypto.randomBytes(24).toString('hex');
        const channels = JSON.stringify([REQUIRED_CHAT_ID, ...OPTIONAL_CHAT_IDS]);
        await db.run(
          'INSERT INTO keys (token, telegram_user_id, channels, created_at) VALUES (?, ?, ?, ?)',
          token,
          userId,
          channels,
          Date.now()
        );

        // Send Key
        await bot.sendMessage(
          chatId,
          `✅ Your key:\n\n<code>${token}</code>\n\nCopy and paste on Ws Checker Client to activate.`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.error('Bot /getkey error', err);
        bot.sendMessage(chatId, '❌ Failed to issue key. Try again later.');
      }
    });

    console.log('Telegram bot polling started (/getkey ready)');
  } else {
    console.warn('BOT_TOKEN or REQUIRED_CHAT_ID missing — bot disabled');
  }
})();
