const fetch = require('node-fetch');
const express = require('express');
const app = express();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TWELVE_KEY     = process.env.TWELVE_KEY     || '5effd4b99536477fa19f3dc37f5c9af1';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '7710816793:AAE0obDgajHgJ1EaDM6cDzWzGkij80ToaW0';
const CHAT_ID        = process.env.CHAT_ID        || '7974144973';
const SUPABASE_URL   = process.env.SUPABASE_URL   || 'https://cxjpbfzpvopykwxtqetn.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_KEY   || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4anBiZnpwdm9weWt3eHRxZXRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNzY5MTgsImV4cCI6MjA5NjY1MjkxOH0.JYFoXLJsbF_Ij_haj5IZQO9LCGnt839o7xpQRe17W8E';

const ASSET = 'EUR/USD';

const SESSIONS = [
  { name: 'London Open',   label: 'LON', start: 8,  end: 11 },
  { name: 'New York Open', label: 'NYO', start: 14, end: 17 },
];

// 4 minutes in milliseconds
const SIGNAL_COOLDOWN_MS = 4 * 60 * 1000;

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  lastSignalTime:    0,       // timestamp of last signal fired
  lastCandleTime:    null,    // datetime string of last candle that fired
  consecutiveLosses: 0,
  isLockedOut:       false,
  lockoutDate:       null,
};

// ─── TIME HELPERS ─────────────────────────────────────────────────────────────
function getWAT() {
  const now = new Date();
  return new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 3600000);
}
function getWATHour() { return getWAT().getHours(); }
function getWATTime() { return getWAT().toTimeString().slice(0, 8) + ' WAT'; }
function getToday()   { return getWAT().toDateString(); }

function getCurrentSession() {
  const h = getWATHour();
  return SESSIONS.find(s => h >= s.start && h < s.end) || null;
}

// ─── PRICE FEED ───────────────────────────────────────────────────────────────
async function fetchCandles() {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${ASSET}&interval=1min&outputsize=15&apikey=${TWELVE_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    if (!d.values || d.values.length < 12) return null;
    return d.values.map(v => ({
      datetime: v.datetime,
      open:     parseFloat(v.open),
      close:    parseFloat(v.close),
      volume:   parseFloat(v.volume) || 1000,
    })).reverse();
  } catch(e) {
    console.error('Fetch failed:', e.message);
    return null;
  }
}

// ─── 4 TRIGGERS ───────────────────────────────────────────────────────────────
function analyzeSignal(candles) {
  if (!candles || candles.length < 12) return null;

  const current = candles[candles.length - 1];
  const prev5   = candles.slice(-6, -1);
  const prev10  = candles.slice(-11, -1);
  const prevOne = candles[candles.length - 2];

  // TRIGGER 1: Strong candle body — 20% above 10-candle average
  const body     = Math.abs(current.close - current.open);
  const avgBody  = prev10.reduce((a, c) => a + Math.abs(c.close - c.open), 0) / prev10.length;
  const t1       = body > avgBody * 1.2;
  const dir      = current.close > current.open ? 'BUY' : 'SELL';

  // TRIGGER 2: Volume surge — 10% above 5-candle average
  const avgVol   = prev5.reduce((a, c) => a + c.volume, 0) / prev5.length;
  const t2       = current.volume > avgVol * 1.1;

  // TRIGGER 3: Trend dominance — 4 of last 5 candles agree
  const bullCount = prev5.filter(c => c.close > c.open).length;
  const bearCount = prev5.filter(c => c.close < c.open).length;
  let trendDir    = null;
  let t3          = false;
  if (bullCount >= 4) { trendDir = 'BUY';  t3 = true; }
  if (bearCount >= 4) { trendDir = 'SELL'; t3 = true; }

  // TRIGGER 4: No whipsaw — previous candle agrees with direction
  const prevDir  = prevOne.close > prevOne.open ? 'BUY' : 'SELL';
  const t4       = prevDir === dir;

  console.log(`  T1:${t1} T2:${t2} T3:${t3}(${trendDir}) T4:${t4} DIR:${dir}`);

  if (t1 && t2 && t3 && t4 && dir === trendDir) {
    return { direction: dir, price: current.close, candleTime: current.datetime };
  }
  return null;
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'HTML' }),
    });
  } catch(e) { console.error('Telegram error:', e.message); }
}

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
async function saveTrade(trade) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/trades`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify(trade),
    });
  } catch(e) { console.error('Supabase error:', e.message); }
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scanMarket() {
  // Reset on new day
  const today = getToday();
  if (state.lockoutDate && state.lockoutDate !== today) {
    state.consecutiveLosses = 0;
    state.isLockedOut       = false;
    state.lockoutDate       = null;
    console.log('New day — state reset');
  }

  const session = getCurrentSession();
  if (!session) {
    console.log(`[${getWATTime()}] Dead zone`);
    return;
  }

  if (state.isLockedOut) {
    console.log(`[${getWATTime()}] Locked out`);
    return;
  }

  // 4 minute cooldown check
  const now = Date.now();
  const timeSinceLast = now - state.lastSignalTime;
  if (state.lastSignalTime > 0 && timeSinceLast < SIGNAL_COOLDOWN_MS) {
    const waitSecs = Math.round((SIGNAL_COOLDOWN_MS - timeSinceLast) / 1000);
    console.log(`[${getWATTime()}] Cooldown — ${waitSecs}s remaining`);
    return;
  }

  console.log(`[${getWATTime()}] Scanning — ${session.name}`);

  const candles = await fetchCandles();
  if (!candles) return;

  const signal = analyzeSignal(candles);
  if (!signal) {
    console.log(`  No signal`);
    return;
  }

  // Block same candle firing twice
  if (state.lastCandleTime === signal.candleTime) {
    console.log(`  Same candle — blocked`);
    return;
  }

  // All clear — fire
  state.lastSignalTime = now;
  state.lastCandleTime = signal.candleTime;

  const arrow = signal.direction === 'BUY' ? '▲' : '▼';
  const emoji = signal.direction === 'BUY' ? '🟢' : '🔴';

  const message =
`${emoji} <b>WEBBLOCK SIGNAL</b>

<b>${arrow} ${signal.direction}</b> — EUR/USD
💰 Price: <code>${signal.price.toFixed(5)}</code>
⏱ Duration: <b>2 minutes</b>
📍 Session: ${session.name}
🕐 Time: ${getWATTime()}

<i>Enter within 10 seconds of candle open</i>`;

  await sendTelegram(message);
  await saveTrade({
    asset:      'EUR/USD',
    direction:  signal.direction,
    session:    session.label,
    entry_time: new Date().toISOString(),
    triggers:   { t1: true, t2: true, t3: true, t4: true },
    result:     null,
  });

  console.log(`  ✅ ${signal.direction} fired`);
}

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const now = Date.now();
  const cooldownLeft = Math.max(0, SIGNAL_COOLDOWN_MS - (now - state.lastSignalTime));
  res.json({
    status:        'WEBBLOCK Signal Bot — EUR/USD',
    time:          getWATTime(),
    session:       getCurrentSession()?.name || 'Dead Zone',
    lockedOut:     state.isLockedOut,
    losses:        state.consecutiveLosses,
    cooldownLeft:  `${Math.round(cooldownLeft / 1000)}s`,
  });
});

app.use(express.json());
app.post('/result', async (req, res) => {
  const { result } = req.body;
  if (!result) return res.status(400).json({ error: 'No result' });

  if (result === 'LOSS') {
    state.consecutiveLosses++;
    if (state.consecutiveLosses >= 3) {
      state.isLockedOut = true;
      state.lockoutDate = getToday();
      await sendTelegram(`🔒 <b>SESSION LOCKED</b>\n\n3 consecutive losses. Done for today.\n\nProtect your capital. Come back tomorrow.`);
    } else {
      await sendTelegram(`❌ Loss. Streak: ${state.consecutiveLosses}/3`);
    }
  } else if (result === 'WIN') {
    state.consecutiveLosses = 0;
    await sendTelegram(`✅ Win. Streak reset.`);
  }

  res.json({ ok: true, losses: state.consecutiveLosses, lockedOut: state.isLockedOut });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WEBBLOCK bot live — ${getWATTime()}`);
  console.log(`Session: ${getCurrentSession()?.name || 'Dead Zone'}`);
});

// Scan every 30 seconds — cooldown handles spacing, not the interval
scanMarket();
setInterval(scanMarket, 30 * 1000);

// Session alerts
setInterval(async () => {
  const h = getWATHour();
  const m = getWAT().getMinutes();
  if (m !== 0) return;
  if (h === 8)  await sendTelegram('🟡 <b>London Open</b> — Session live. Stay sharp.');
  if (h === 11) await sendTelegram('⏸ <b>London closed.</b> Dead zone until 2PM WAT.');
  if (h === 14) await sendTelegram('🟡 <b>New York Open</b> — Session live. Stay sharp.');
  if (h === 17) await sendTelegram('⏹ <b>All sessions closed.</b> Done for today.');
}, 60 * 1000);
