const fetch = require('node-fetch');
const express = require('express');
const app = express();

const TWELVE_KEY      = process.env.TWELVE_KEY     || '5effd4b99536477fa19f3dc37f5c9af1';
const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN || '7710816793:AAE0obDgajHgJ1EaDM6cDzWzGkij80ToaW0';
const CHAT_ID         = process.env.CHAT_ID        || '7974144973';
const GROUP_ID        = process.env.GROUP_ID       || '-1003924196084';
const SUPABASE_URL    = process.env.SUPABASE_URL   || 'https://cxjpbfzpvopykwxtqetn.supabase.co';
const SUPABASE_KEY    = process.env.SUPABASE_KEY   || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4anBiZnpwdm9weWt3eHRxZXRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNzY5MTgsImV4cCI6MjA5NjY1MjkxOH0.JYFoXLJsbF_Ij_haj5IZQO9LCGnt839o7xpQRe17W8E';

const ASSET          = 'EUR/USD';
const RSI_PERIOD     = 14;
const RSI_OVERSOLD   = 40;
const RSI_OVERBOUGHT = 60;
const COOLDOWN_MS    = 7 * 60 * 1000;

const SESSIONS = [
  { name: 'London Open',   label: 'LON', start: 8,  end: 11 },
  { name: 'New York Open', label: 'NYO', start: 14, end: 17 },
];

const state = {
  lastSignalTime:    0,
  lastCandleTime:    null,
  consecutiveLosses: 0,
  isLockedOut:       false,
  lockoutDate:       null,
  // Map of telegram message_id -> supabase trade id
  pendingTrades:     {},
};

// ─── TIME ─────────────────────────────────────────────────────────────────────
function getWAT() {
  const now = new Date();
  return new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 3600000);
}
function getWATHour() { return getWAT().getHours(); }
function getWATTime() { return getWAT().toTimeString().slice(0, 8) + ' WAT'; }
function getToday()   { return getWAT().toDateString(); }

function getCurrentSession() {
  const wat = getWAT();
  const day = wat.getDay();
  if (day === 0 || day === 6) return null;
  const h = wat.getHours();
  return SESSIONS.find(s => h >= s.start && h < s.end) || null;
}

// ─── PRICE FEED ───────────────────────────────────────────────────────────────
async function fetchCandles() {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${ASSET}&interval=5min&outputsize=30&apikey=${TWELVE_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    if (!d.values || d.values.length < RSI_PERIOD + 2) return null;
    return d.values.map(v => ({
      datetime: v.datetime,
      close:    parseFloat(v.close),
    })).reverse();
  } catch(e) {
    console.error('Fetch failed:', e.message);
    return null;
  }
}

// ─── RSI ──────────────────────────────────────────────────────────────────────
function calculateRSI(candles, period) {
  if (candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff >= 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// ─── SIGNAL LOGIC ─────────────────────────────────────────────────────────────
function analyzeSignal(candles) {
  if (!candles || candles.length < RSI_PERIOD + 2) return null;
  const closedCandles = candles.slice(0, -1);
  const currentRSI    = calculateRSI(closedCandles, RSI_PERIOD);
  if (currentRSI === null) return null;
  const prevRSI       = calculateRSI(closedCandles.slice(0, -1), RSI_PERIOD);
  const current       = closedCandles[closedCandles.length - 1];

  console.log(`  RSI: ${currentRSI.toFixed(2)} | Prev: ${prevRSI ? prevRSI.toFixed(2) : 'N/A'}`);

  // Label strength — STRONG if 5+ points past threshold, WEAK if borderline
  if (prevRSI && prevRSI >= RSI_OVERSOLD && currentRSI < RSI_OVERSOLD) {
    const strength = currentRSI < 35 ? 'STRONG' : 'WEAK';
    return { direction: 'BUY', price: current.close, candleTime: current.datetime, rsi: currentRSI, strength };
  }
  if (prevRSI && prevRSI <= RSI_OVERBOUGHT && currentRSI > RSI_OVERBOUGHT) {
    const strength = currentRSI > 65 ? 'STRONG' : 'WEAK';
    return { direction: 'SELL', price: current.close, candleTime: current.datetime, rsi: currentRSI, strength };
  }
  return null;
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendToChat(chatId, msg) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
    });
    const d = await r.json();
    return d.result?.message_id || null;
  } catch(e) { console.error('Telegram error:', e.message); return null; }
}

async function sendTelegram(msg) {
  await sendToChat(CHAT_ID, msg);
  await sendToChat(GROUP_ID, msg);
}

async function sendSignalWithButtons(msg, tradeId) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:      CHAT_ID,
        text:         msg,
        parse_mode:   'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ WIN',    callback_data: `WIN:${tradeId}` },
            { text: '❌ LOSS',   callback_data: `LOSS:${tradeId}` },
            { text: '⏭ MISSED', callback_data: `MISSED:${tradeId}` },
          ]]
        }
      }),
    });
    const d = await r.json();
    return d.result?.message_id || null;
  } catch(e) { console.error('Telegram button error:', e.message); return null; }
}

async function answerCallback(callbackQueryId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch(e) {}
}

async function editMessage(messageId, newText) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    CHAT_ID,
        message_id: messageId,
        text:       newText,
        parse_mode: 'HTML',
      }),
    });
  } catch(e) {}
}

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
async function saveTrade(trade) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/trades`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer':        'return=representation',
      },
      body: JSON.stringify(trade),
    });
    const d = await r.json();
    return d[0]?.id || null;
  } catch(e) { console.error('Supabase save error:', e.message); return null; }
}

async function getLastFingerprint() {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/signal_state?id=eq.1`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const d = await r.json();
    return d[0]?.fingerprint || null;
  } catch(e) { return null; }
}

async function saveFingerprint(fingerprint) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/signal_state`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ id: 1, fingerprint, updated_at: new Date().toISOString() }),
    });
  } catch(e) { console.error('Fingerprint save error:', e.message); }
}

async function updateTradeResult(tradeId, result) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/trades?id=eq.${tradeId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({ result }),
    });
  } catch(e) { console.error('Supabase update error:', e.message); }
}

// ─── TELEGRAM WEBHOOK ─────────────────────────────────────────────────────────
app.use(express.json());

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (!body.callback_query) return;

  const cb      = body.callback_query;
  const data    = cb.data; // e.g. "WIN:uuid" or "LOSS:uuid"
  const msgId   = cb.message.message_id;
  const cbId    = cb.id;
  const msgText = cb.message.text;

  const [result, tradeId] = data.split(':');
  if (!result || !tradeId) return;

  // Update Supabase
  await updateTradeResult(tradeId, result);

  // Update loss counter
  if (result === 'LOSS') {
    state.consecutiveLosses++;
    if (state.consecutiveLosses >= 3) {
      state.isLockedOut = true;
      state.lockoutDate = getToday();
      await sendTelegram(`🔒 <b>SESSION LOCKED</b>\n\n3 consecutive losses. Done for today.\nProtect your capital. Come back tomorrow.`);
    }
  } else if (result === 'WIN') {
    state.consecutiveLosses = 0;
  }

  // Answer the callback
  const emoji = result === 'WIN' ? '✅' : result === 'LOSS' ? '❌' : '⏭';
  await answerCallback(cbId, `${emoji} Logged as ${result}`);

  // Edit the message to remove buttons and show result
  const resultLine = `\n\n<b>Result: ${emoji} ${result}</b>`;
  await editMessage(msgId, msgText + resultLine);

  console.log(`  Result logged: ${result} for trade ${tradeId}`);
});

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scanMarket() {
  const today = getToday();
  if (state.lockoutDate && state.lockoutDate !== today) {
    state.consecutiveLosses = 0;
    state.isLockedOut = false;
    state.lockoutDate = null;
    console.log('New day — reset');
  }

  const session = getCurrentSession();
  if (!session) { console.log(`[${getWATTime()}] Dead zone`); return; }
  if (state.isLockedOut) { console.log(`[${getWATTime()}] Locked out`); return; }

  const now = Date.now();
  const timeSinceLast = now - state.lastSignalTime;
  if (state.lastSignalTime > 0 && timeSinceLast < COOLDOWN_MS) {
    console.log(`[${getWATTime()}] Cooldown — ${Math.round((COOLDOWN_MS - timeSinceLast)/1000)}s left`);
    return;
  }

  console.log(`[${getWATTime()}] Scanning — ${session.name}`);

  const candles = await fetchCandles();
  if (!candles) return;

  const signal = analyzeSignal(candles);
  if (!signal) { console.log(`  No signal`); return; }

  // Persistent duplicate block — check Supabase, not memory
  const signalFingerprint = `${signal.direction}-${signal.price.toFixed(5)}-${signal.rsi.toFixed(1)}`;
  const lastFingerprint = await getLastFingerprint();
  if (lastFingerprint === signalFingerprint) {
    console.log(`  Duplicate blocked (DB): ${signalFingerprint}`);
    return;
  }

  state.lastSignalTime = now;
  state.lastCandleTime = signalFingerprint;
  await saveFingerprint(signalFingerprint);

  const arrow = signal.direction === 'BUY' ? '▲' : '▼';
  const emoji = signal.direction === 'BUY' ? '🟢' : '🔴';
  const strengthEmoji = signal.strength === 'STRONG' ? '🔥 Strength: STRONG' : '⚡ Strength: WEAK';

  // Save to Supabase first to get trade ID
  const tradeId = await saveTrade({
    asset:      'EUR/USD',
    direction:  signal.direction,
    session:    session.label,
    entry_time: new Date().toISOString(),
    triggers:   { rsi: signal.rsi.toFixed(2), strength: signal.strength },
    result:     null,
  });

  const message =
`${emoji} <b>EDGEBLOCK SIGNAL</b>

<b>${arrow} ${signal.direction}</b> — EUR/USD
💰 Price: <code>${signal.price.toFixed(5)}</code>
📊 RSI: <code>${signal.rsi.toFixed(1)}</code>
${strengthEmoji}
⏱ Duration: <b>5 minutes</b>
📍 Session: ${session.name}
🕐 Time: ${getWATTime()}

<i>Enter within 30 seconds of signal</i>`;

  if (tradeId) {
    // Personal chat gets buttons for logging
    await sendSignalWithButtons(message, tradeId);
    // Group gets signal without buttons
    await sendToChat(GROUP_ID, message);
  } else {
    await sendTelegram(message);
  }

  console.log(`  ✅ ${signal.direction} fired — RSI: ${signal.rsi.toFixed(2)}`);
}

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const cooldownLeft = Math.max(0, COOLDOWN_MS - (Date.now() - state.lastSignalTime));
  res.json({
    status:    'EDGEBLOCK — EUR/USD 5min RSI',
    time:      getWATTime(),
    session:   getCurrentSession()?.name || 'Dead Zone',
    lockedOut: state.isLockedOut,
    losses:    state.consecutiveLosses,
    cooldown:  `${Math.round(cooldownLeft/1000)}s`,
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`EDGEBLOCK bot live — ${getWATTime()}`);
  console.log(`Strategy: RSI(14) crossover on 5min candles`);
  console.log(`Session: ${getCurrentSession()?.name || 'Dead Zone'}`);

  // Set webhook
  const webhookUrl = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/webhook`
    : `https://block-1-1m2a.onrender.com/webhook`;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    console.log(`Webhook set: ${webhookUrl}`);
  } catch(e) { console.error('Webhook setup failed:', e.message); }
});

scanMarket();
setInterval(scanMarket, 60 * 1000);

setInterval(async () => {
  const h = getWATHour();
  const m = getWAT().getMinutes();
  if (m !== 0) return;
  if (h === 8)  await sendTelegram('🟡 <b>London Open</b> — Session live. Stay sharp.');
  if (h === 11) await sendTelegram('⏸ <b>London closed.</b> Dead zone until 2PM WAT.');
  if (h === 14) await sendTelegram('🟡 <b>New York Open</b> — Session live. Stay sharp.');
  if (h === 17) await sendTelegram('⏹ <b>All sessions closed.</b> Done for today.');
}, 60 * 1000);
