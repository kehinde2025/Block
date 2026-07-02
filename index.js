const fetch = require('node-fetch');
const express = require('express');
const app = express();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TWELVE_KEY     = process.env.TWELVE_KEY     || '5effd4b99536477fa19f3dc37f5c9af1';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '7710816793:AAE0obDgajHgJ1EaDM6cDzWzGkij80ToaW0';
const CHAT_ID        = process.env.CHAT_ID        || '7974144973';
const SUPABASE_URL   = process.env.SUPABASE_URL   || 'https://cxjpbfzpvopykwxtqetn.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_KEY   || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4anBiZnpwdm9weWt3eHRxZXRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNzY5MTgsImV4cCI6MjA5NjY1MjkxOH0.JYFoXLJsbF_Ij_haj5IZQO9LCGnt839o7xpQRe17W8E';

const ASSETS = ['EUR/USD', 'GBP/USD'];

const SESSIONS = [
  { name: 'London Open',   label: 'LON', start: 8,  end: 11 },
  { name: 'New York Open', label: 'NYO', start: 14, end: 17 },
];

// ─── STRICT SIGNAL STATE ──────────────────────────────────────────────────────
// Key insight: we track the CANDLE TIMESTAMP of the last signal per asset.
// If the candle hasn't changed, we cannot fire again. Period.
const state = {
  lastCandleTime: {},    // asset -> last candle datetime string that fired a signal
  sessionSignals: {},    // asset+session -> count of signals fired this session
  consecutiveLosses: 0,
  isLockedOut: false,
  lockoutDate: null,
  lastSessionLabel: null,
};

// Max signals per pair per session — HARD CAP
const MAX_SIGNALS_PER_SESSION = 2;

// ─── TIME HELPERS ─────────────────────────────────────────────────────────────
function getWAT() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 3600000); // UTC+1
}

function getWATHour()  { return getWAT().getHours(); }
function getWATTime()  { return getWAT().toTimeString().slice(0, 8) + ' WAT'; }
function getToday()    { return getWAT().toDateString(); }

function getCurrentSession() {
  const h = getWATHour();
  return SESSIONS.find(s => h >= s.start && h < s.end) || null;
}

// ─── PRICE FEED ───────────────────────────────────────────────────────────────
async function fetchCandles(symbol) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1min&outputsize=15&apikey=${TWELVE_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    if (!d.values || d.values.length < 8) return null;
    return d.values.map(v => ({
      datetime: v.datetime,
      open:     parseFloat(v.open),
      high:     parseFloat(v.high),
      low:      parseFloat(v.low),
      close:    parseFloat(v.close),
      volume:   parseFloat(v.volume) || 1000,
    })).reverse(); // oldest first
  } catch(e) {
    console.error(`Fetch failed ${symbol}:`, e.message);
    return null;
  }
}

// ─── SIGNAL LOGIC (STRICTER) ──────────────────────────────────────────────────
function analyzeSignal(candles) {
  if (!candles || candles.length < 8) return null;

  const current  = candles[candles.length - 1]; // current candle
  const prev5    = candles.slice(-6, -1);        // 5 candles before current
  const prev10   = candles.slice(-11, -1);       // 10 candles before current

  // ── TRIGGER 1: Strong momentum ───────────────────────────────────────────
  // Current candle body must be LARGER than average of last 10 candles
  const currentBody = Math.abs(current.close - current.open);
  const avgBody10   = prev10.reduce((a, c) => a + Math.abs(c.close - c.open), 0) / prev10.length;
  const momentumFired = currentBody > avgBody10 * 1.2; // 20% stronger than average
  const momentumDir   = current.close > current.open ? 'BUY' : 'SELL';

  // ── TRIGGER 2: Volume surge ───────────────────────────────────────────────
  const avgVol5     = prev5.reduce((a, c) => a + c.volume, 0) / prev5.length;
  const volumeFired = current.volume > avgVol5 * 1.1; // 10% above average

  // ── TRIGGER 3: Strong trend alignment ────────────────────────────────────
  // At least 4 of last 5 candles must agree with direction
  const bullCount = prev5.filter(c => c.close > c.open).length;
  const bearCount = prev5.filter(c => c.close < c.open).length;
  let trendDir    = null;
  let trendFired  = false;
  if (bullCount >= 4) { trendDir = 'BUY';  trendFired = true; }
  if (bearCount >= 4) { trendDir = 'SELL'; trendFired = true; }

  // ── TRIGGER 4: No whipsaw ─────────────────────────────────────────────────
  // Previous candle must agree with direction (not a reversal candle)
  const prevCandle     = prev5[prev5.length - 1];
  const prevDir        = prevCandle.close > prevCandle.open ? 'BUY' : 'SELL';
  const noWhipsawFired = prevDir === momentumDir;

  // All 4 must fire AND directions must agree
  const allFired = momentumFired && volumeFired && trendFired && noWhipsawFired;
  const dirAgree = momentumDir === trendDir;

  console.log(`    Momentum: ${momentumFired} (${momentumDir}) | Volume: ${volumeFired} | Trend: ${trendFired} (${trendDir}) | NoWhipsaw: ${noWhipsawFired}`);

  if (allFired && dirAgree) {
    return {
      direction:   momentumDir,
      price:       current.close,
      candleTime:  current.datetime,
      triggers:    { momentum: momentumDir, volume: true, trend: trendDir, noWhipsaw: true }
    };
  }
  return null;
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' }),
    });
  } catch(e) { console.error('Telegram failed:', e.message); }
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
  } catch(e) { console.error('Supabase failed:', e.message); }
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scanMarket() {
  // Reset on new day
  const today = getToday();
  if (state.lockoutDate && state.lockoutDate !== today) {
    state.consecutiveLosses = 0;
    state.isLockedOut       = false;
    state.lockoutDate       = null;
    state.sessionSignals    = {};
    console.log('New day — all state reset');
  }

  const session = getCurrentSession();
  if (!session) {
    // Reset session signal counts when dead zone starts
    if (state.lastSessionLabel) {
      state.sessionSignals  = {};
      state.lastSessionLabel = null;
    }
    console.log(`[${getWATTime()}] Dead zone`);
    return;
  }

  state.lastSessionLabel = session.label;

  if (state.isLockedOut) {
    console.log(`[${getWATTime()}] Locked out`);
    return;
  }

  console.log(`[${getWATTime()}] Scanning — ${session.name}`);

  for (const asset of ASSETS) {
    const sessionKey = `${asset}-${session.label}`;

    // Hard cap — max 2 signals per pair per session
    const sigCount = state.sessionSignals[sessionKey] || 0;
    if (sigCount >= MAX_SIGNALS_PER_SESSION) {
      console.log(`  ${asset}: Session cap reached (${sigCount}/${MAX_SIGNALS_PER_SESSION})`);
      continue;
    }

    const candles = await fetchCandles(asset);
    if (!candles) continue;

    const signal = analyzeSignal(candles);
    if (!signal) {
      console.log(`  ${asset}: No signal`);
      continue;
    }

    // CORE DUPLICATE PREVENTION: block if this exact candle already fired
    if (state.lastCandleTime[asset] === signal.candleTime) {
      console.log(`  ${asset}: Same candle already fired — blocked`);
      continue;
    }

    // All checks passed — fire signal
    state.lastCandleTime[asset]      = signal.candleTime;
    state.sessionSignals[sessionKey] = sigCount + 1;

    const arrow = signal.direction === 'BUY' ? '▲' : '▼';
    const emoji = signal.direction === 'BUY' ? '🟢' : '🔴';

    const message =
`${emoji} <b>WEBBLOCK SIGNAL</b>

<b>${arrow} ${signal.direction}</b> — ${asset}
💰 Price: <code>${signal.price.toFixed(5)}</code>
⏱ Duration: <b>2 minutes</b>
📍 Session: ${session.name} (${sigCount + 1}/${MAX_SIGNALS_PER_SESSION})
🕐 Time: ${getWATTime()}

<i>Enter within 10 seconds of candle open</i>`;

    await sendTelegram(message);
    await saveTrade({
      asset,
      direction:  signal.direction,
      session:    session.label,
      entry_time: new Date().toISOString(),
      triggers:   signal.triggers,
      result:     null,
    });

    console.log(`  ✅ ${asset}: ${signal.direction} fired (${sigCount + 1}/${MAX_SIGNALS_PER_SESSION} this session)`);
  }
}

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:    'WEBBLOCK Signal Bot',
    time:      getWATTime(),
    session:   getCurrentSession()?.name || 'Dead Zone',
    lockedOut: state.isLockedOut,
    losses:    state.consecutiveLosses,
    signals:   state.sessionSignals,
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
      await sendTelegram(`❌ Loss recorded. Streak: ${state.consecutiveLosses}/3`);
    }
  } else if (result === 'WIN') {
    state.consecutiveLosses = 0;
    await sendTelegram(`✅ Win recorded. Streak reset.`);
  }

  res.json({ ok: true, consecutiveLosses: state.consecutiveLosses, isLockedOut: state.isLockedOut });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WEBBLOCK bot running — ${getWATTime()}`);
  console.log(`Session: ${getCurrentSession()?.name || 'Dead Zone'}`);
});

// Scan every 90 seconds — not 60. Gives candles time to close properly.
scanMarket();
setInterval(scanMarket, 90 * 1000);

// Session alerts
setInterval(async () => {
  const h = getWATHour();
  const m = getWAT().getMinutes();
  if (m === 0) {
    if (h === 8)  await sendTelegram('🟡 <b>London Open</b> — Session live. Stay sharp.');
    if (h === 11) await sendTelegram('⏸ <b>London closed.</b> Dead zone until 2PM WAT. Rest.');
    if (h === 14) await sendTelegram('🟡 <b>New York Open</b> — Session live. Stay sharp.');
    if (h === 17) await sendTelegram('⏹ <b>All sessions closed.</b> Done for today. Review your log.');
  }
}, 60 * 1000);
