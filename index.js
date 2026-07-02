const fetch = require('node-fetch');
const express = require('express');
const app = express();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TWELVE_KEY    = process.env.TWELVE_KEY    || '5effd4b99536477fa19f3dc37f5c9af1';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '7710816793:AAE0obDgajHgJ1EaDM6cDzWzGkij80ToaW0';
const CHAT_ID       = process.env.CHAT_ID       || '7974144973';
const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://cxjpbfzpvopykwxtqetn.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_KEY  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4anBiZnpwdm9weWt3eHRxZXRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNzY5MTgsImV4cCI6MjA5NjY1MjkxOH0.JYFoXLJsbF_Ij_haj5IZQO9LCGnt839o7xpQRe17W8E';

const ASSETS = ['EUR/USD', 'GBP/USD'];
const TWELVE_SYMBOLS = { 'EUR/USD': 'EUR/USD', 'GBP/USD': 'GBP/USD' };

// WAT = UTC+1
const SESSIONS = [
  { name: 'London Open',   label: 'LON', start: 8,  end: 11 },
  { name: 'New York Open', label: 'NYO', start: 14, end: 17 },
];

// ─── STATE ────────────────────────────────────────────────────────────────────
let priceCache = {};
let lastSignalTime = {}; // prevent signal spam — one signal per asset per 5 mins
let consecutiveLosses = 0;
let isLockedOut = false;
let lockoutDate = null;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getWATHour() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const wat = new Date(utc + 3600000);
  return wat.getHours();
}

function getCurrentSession() {
  const h = getWATHour();
  return SESSIONS.find(s => h >= s.start && h < s.end) || null;
}

function getWATTime() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const wat = new Date(utc + 3600000);
  return wat.toTimeString().slice(0, 8) + ' WAT';
}

function getToday() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const wat = new Date(utc + 3600000);
  return wat.toDateString();
}

// ─── PRICE FEED ───────────────────────────────────────────────────────────────
async function fetchCandles(symbol) {
  try {
    const sym = symbol.replace('/', '');
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1min&outputsize=10&apikey=${TWELVE_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    if (!d.values || d.values.length < 6) return null;
    return d.values.map(v => ({
      open:   parseFloat(v.open),
      high:   parseFloat(v.high),
      low:    parseFloat(v.low),
      close:  parseFloat(v.close),
      volume: parseFloat(v.volume) || Math.random() * 1000 + 500,
    })).reverse();
  } catch(e) {
    console.error(`Price fetch failed for ${symbol}:`, e.message);
    return null;
  }
}

// ─── SIGNAL LOGIC ─────────────────────────────────────────────────────────────
function analyzeSignal(candles) {
  if (!candles || candles.length < 6) return null;

  const current = candles[candles.length - 1];
  const recent  = candles.slice(-6, -1);

  // Trigger 1: Momentum
  const momentum    = current.close - current.open;
  const avgBody     = recent.reduce((a, c) => a + Math.abs(c.close - c.open), 0) / recent.length;
  const momentumFired = Math.abs(momentum) > avgBody * 0.6;
  const momentumDir   = momentum > 0 ? 'BUY' : 'SELL';

  // Trigger 2: Volume
  const avgVol    = recent.reduce((a, c) => a + c.volume, 0) / recent.length;
  const volumeFired = current.volume > avgVol * 0.8;

  // Trigger 3: Trend — last 5 candles
  const bullish   = recent.filter(c => c.close > c.open).length;
  const bearish   = recent.filter(c => c.close < c.open).length;
  let trendDir    = null;
  let trendFired  = false;
  if (bullish >= 3) { trendDir = 'BUY';  trendFired = true; }
  if (bearish >= 3) { trendDir = 'SELL'; trendFired = true; }

  const allFired  = momentumFired && volumeFired && trendFired;
  const dirAgree  = momentumDir === trendDir;

  if (allFired && dirAgree) {
    return {
      direction: momentumDir,
      price:     current.close,
      triggers:  { momentum: momentumDir, volume: true, trend: trendDir }
    };
  }
  return null;
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    CHAT_ID,
        text:       message,
        parse_mode: 'HTML',
      }),
    });
    console.log('Telegram sent:', message.slice(0, 60));
  } catch(e) {
    console.error('Telegram failed:', e.message);
  }
}

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
async function saveTrade(trade) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/trades`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify(trade),
    });
  } catch(e) {
    console.error('Supabase save failed:', e.message);
  }
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scanMarket() {
  // Reset lockout on new day
  const today = getToday();
  if (lockoutDate && lockoutDate !== today) {
    consecutiveLosses = 0;
    isLockedOut       = false;
    lockoutDate       = null;
    console.log('New day — lockout reset');
  }

  const session = getCurrentSession();
  if (!session) {
    console.log(`[${getWATTime()}] Dead zone — no scan`);
    return;
  }

  if (isLockedOut) {
    console.log(`[${getWATTime()}] Locked out — 3 losses hit`);
    return;
  }

  console.log(`[${getWATTime()}] Scanning — Session: ${session.name}`);

  for (const asset of ASSETS) {
    const candles = await fetchCandles(asset);
    if (!candles) continue;

    priceCache[asset] = candles;

    const signal = analyzeSignal(candles);
    if (!signal) {
      console.log(`  ${asset}: No signal`);
      continue;
    }

    // Cooldown — no repeat signal for same asset within 5 minutes
    const now     = Date.now();
    const lastSig = lastSignalTime[asset] || 0;
    if (now - lastSig < 5 * 60 * 1000) {
      console.log(`  ${asset}: Signal cooldown active`);
      continue;
    }

    lastSignalTime[asset] = now;

    const arrow = signal.direction === 'BUY' ? '▲' : '▼';
    const emoji = signal.direction === 'BUY' ? '🟢' : '🔴';

    const message = `${emoji} <b>WEBBLOCK SIGNAL</b>

<b>${arrow} ${signal.direction}</b> — ${asset}
💰 Price: <code>${signal.price.toFixed(5)}</code>
⏱ Duration: <b>2 minutes</b>
📍 Session: ${session.name}
🕐 Time: ${getWATTime()}

<i>Enter within 10 seconds of candle open</i>`;

    await sendTelegram(message);

    // Save to Supabase
    await saveTrade({
      asset,
      direction:  signal.direction,
      session:    session.label,
      entry_time: new Date().toISOString(),
      triggers:   signal.triggers,
      result:     null,
    });

    console.log(`  ${asset}: ${signal.direction} signal fired and sent`);
  }
}

// ─── EXPRESS HEALTH CHECK ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:    'WEBBLOCK Signal Bot running',
    time:      getWATTime(),
    session:   getCurrentSession()?.name || 'Dead Zone',
    lockedOut: isLockedOut,
    losses:    consecutiveLosses,
  });
});

// Webhook to receive WIN/LOSS from web app
app.use(express.json());
app.post('/result', async (req, res) => {
  const { result } = req.body;
  if (!result) return res.status(400).json({ error: 'No result provided' });

  if (result === 'LOSS') {
    consecutiveLosses++;
    if (consecutiveLosses >= 3) {
      isLockedOut = true;
      lockoutDate = getToday();
      await sendTelegram(`🔒 <b>SESSION LOCKED</b>\n\n3 consecutive losses. No more trades today.\n\nCome back tomorrow. Protect your capital.`);
    } else {
      await sendTelegram(`❌ Loss recorded. Consecutive losses: ${consecutiveLosses}/3`);
    }
  } else if (result === 'WIN') {
    consecutiveLosses = 0;
    await sendTelegram(`✅ Win recorded. Streak reset.`);
  }

  res.json({ ok: true, consecutiveLosses, isLockedOut });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WEBBLOCK bot running on port ${PORT}`);
  console.log(`WAT time: ${getWATTime()}`);
  console.log(`Session: ${getCurrentSession()?.name || 'Dead Zone'}`);
});

// Scan every 60 seconds
scanMarket();
setInterval(scanMarket, 60 * 1000);

// Session open alerts
setInterval(async () => {
  const h = getWATHour();
  const m = new Date().getMinutes();
  if (m === 0) {
    if (h === 8)  await sendTelegram('🟡 <b>London Open</b> — Session starting. Stay sharp.');
    if (h === 14) await sendTelegram('🟡 <b>New York Open</b> — Session starting. Stay sharp.');
    if (h === 11) await sendTelegram('⏸ London session closed. Dead zone until 2PM WAT.');
    if (h === 17) await sendTelegram('⏹ All sessions closed. Done for today.');
  }
}, 60 * 1000);
