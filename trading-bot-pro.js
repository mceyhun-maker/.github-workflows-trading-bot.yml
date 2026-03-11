// ============================================================
//  trading-bot-pro.js  — v4.0  PRO
//
//  ✅ Multi-Timeframe (Aylık + Haftalık + Günlük)
//  ✅ RSI + MA (5/20/50/100/200/365)
//  ✅ BOS + FVG + S/R + Engulfing + Pin Bar
//  ✅ ATR Dinamik SL/TP
//  ✅ Hacim Analizi + Spike Tespiti
//  ✅ Çoklu Sembol Tarama
//  ✅ Trailing Stop
//  ✅ Telegram Detaylı Bildirim
//
//  YENİ — v4.0:
//  ✅ ADX Rejim Tespiti (Trend/Sideways filtresi)
//  ✅ Kelly Criterion (Matematiksel pozisyon boyutu)
//  ✅ Funding Rate Analizi (Futures piyasası sentiment)
//  ✅ Drawdown Limiti (Maksimum zarar koruması)
//  ✅ Out-of-Sample Validasyon (%70 train / %30 test)
//
//  Kullanım: node trading-bot-pro.js
// ============================================================

import fetch from "node-fetch";

// ─── AYARLAR ────────────────────────────────────────────────
const CONFIG = {
  exchange: "binance",

  // Çoklu sembol — hepsi taranır, özet rapor Telegram'a gönderilir
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "AVAXUSDT"],

  timeframes: {
    monthly: { limit: 120 },
    weekly:  { limit: 300 },
    daily:   { limit: 600 },
  },

  // İndikatörler
  rsiPeriod:     14,
  rsiOversold:   40,
  rsiOverbought: 60,
  shortMAPeriod: 5,
  longMAPeriod:  20,
  ma50Period:    50,
  ma100Period:   100,
  ma200Period:   200,
  ma365Period:   365,

  // ATR — Dinamik SL/TP
  atrPeriod:     14,
  atrSLMultiple: 2.0,   // SL = ATR × 2.0
  atrTPMultiple: 6.0,   // TP = ATR × 6.0  →  1:3 oran

  // Trailing Stop
  trailingStopPct: 2.5,

  // Hacim
  volumeMAPeriod:   20,
  volumeSpikeRatio: 1.5,

  // ── YENİ: ADX Rejim Tespiti ──────────────────────────────
  adxPeriod:        14,
  adxTrendMin:      25,  // ADX > 25 → Trend piyasası (sinyal üret)
                         // ADX < 25 → Sideways (sinyal üretme)
  adxStrongTrend:   40,  // ADX > 40 → Çok güçlü trend → +2 puan

  // ── YENİ: Kelly Criterion ────────────────────────────────
  kellyFraction:    0.5, // Yarım Kelly (güvenli mod — full Kelly çok agresif)
  maxPositionPct:   25,  // Portföyün maksimum %25'ini tek işleme koy
  minPositionPct:   5,   // Minimum %5 (çok küçük işlem açılmasın)

  // ── YENİ: Drawdown Limiti ────────────────────────────────
  maxDrawdownPct:   20,  // Başlangıç sermayesinin %20'si giderse bot durur
  drawdownResetPct: 10,  // Kurtarma eşiği: tepeden %10 geri çekilirse uyar

  // ── YENİ: Out-of-Sample Validasyon ──────────────────────
  trainRatio:       0.7, // %70 backtest (train), %30 validasyon (test)

  // ── YENİ: Funding Rate ───────────────────────────────────
  fundingRateExtreme: 0.01,  // %1 üzeri → aşırı long/short (dikkat)
  fundingRateNormal:  0.005, // %0.5 altı → nötr

  // Price Action
  srLookback:     100,
  srStrength:     3,
  srZonePct:      0.5,
  bosLookback:    20,
  fvgMinSizePct:  0.2,
  pinBarRatio:    2.0,
  engulfingRatio: 1.1,

  // MTF Bonus
  mtfBonusScore: 3,
  minScore:      5,

  // Telegram
  telegramToken:  process.env.TELEGRAM_TOKEN || "8755651198:AAE3TH-CBcbOwi3ExWmvoVBxxRzNhdMQfK8",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "1937147410",
};

// ─── TELEGRAM ───────────────────────────────────────────────
async function sendTelegram(message) {
  if (CONFIG.telegramToken === "BOT_TOKEN_BURAYA") {
    console.log(`📲 [Telegram]:\n${message.replace(/<[^>]+>/g, "")}\n`);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text: message, parse_mode: "HTML" }),
    });
  } catch (e) { console.error("Telegram hatası:", e.message); }
}

// ─── VERİ ÇEK ───────────────────────────────────────────────
async function fetchCandles(symbol, timeframeKey, limit) {
  const intervals = { monthly: "1M", weekly: "1w", daily: "1d" };
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${intervals[timeframeKey]}&limit=${limit}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`API hatası: ${JSON.stringify(data)}`);
  return data.map(c => ({
    time:   c[0],
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

// ── YENİ: Funding Rate çek (Binance Futures) ─────────────────
async function fetchFundingRate(symbol) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=3`;
    const res  = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const latest = parseFloat(data[data.length - 1].fundingRate);
    const avg    = data.reduce((s, d) => s + parseFloat(d.fundingRate), 0) / data.length;
    return { latest, avg, count: data.length };
  } catch { return null; }
}

// ─── İNDİKATÖRLER ───────────────────────────────────────────

function calculateRSI(prices, period = 14) {
  const rsi = new Array(period).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    d >= 0 ? gains += d : losses -= d;
  }
  let ag = gains / period, al = losses / period;
  rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return rsi;
}

function movingAverage(data, period) {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    return data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

function calculateATR(candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  const atr = new Array(period).fill(null);
  let sum = tr.slice(0, period).reduce((a, b) => a + b, 0);
  atr.push(sum / period);
  for (let i = period + 1; i < candles.length; i++)
    atr.push((atr[atr.length - 1] * (period - 1) + tr[i]) / period);
  return atr;
}

// ── YENİ: ADX (Average Directional Index) ───────────────────
// ADX trend gücünü ölçer. Yön bilgisi vermez, GÜÇ bilgisi verir.
// ADX < 25 → Sideways, sinyal üretme
// ADX > 25 → Trend var, sinyal geçerli
// ADX > 40 → Çok güçlü trend
function calculateADX(candles, period = 14) {
  const adx    = new Array(period * 2).fill(null);
  const plusDI = new Array(period * 2).fill(null);
  const minusDI= new Array(period * 2).fill(null);

  const trArr = [], plusDM = [], minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr  = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const pDM = (c.high - p.high > p.low - c.low) ? Math.max(c.high - p.high, 0) : 0;
    const mDM = (p.low - c.low > c.high - p.high) ? Math.max(p.low - c.low, 0)   : 0;
    trArr.push(tr); plusDM.push(pDM); minusDM.push(mDM);
  }

  // Wilder'ın smoothing yöntemi
  let smTR = trArr.slice(0, period).reduce((a, b) => a + b, 0);
  let smPDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smMDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dxArr = [];
  for (let i = period; i < trArr.length; i++) {
    smTR  = smTR  - smTR  / period + trArr[i];
    smPDM = smPDM - smPDM / period + plusDM[i];
    smMDM = smMDM - smMDM / period + minusDM[i];

    const pDI14 = smTR ? (smPDM / smTR) * 100 : 0;
    const mDI14 = smTR ? (smMDM / smTR) * 100 : 0;
    const diSum = pDI14 + mDI14;
    const dx    = diSum ? Math.abs(pDI14 - mDI14) / diSum * 100 : 0;
    dxArr.push({ dx, pDI14, mDI14 });
    plusDI.push(pDI14);
    minusDI.push(mDI14);
  }

  // ADX = DX'in smoothed ortalaması
  let smDX = dxArr.slice(0, period).reduce((s, d) => s + d.dx, 0) / period;
  adx.push(smDX);
  for (let i = period; i < dxArr.length; i++) {
    smDX = (smDX * (period - 1) + dxArr[i].dx) / period;
    adx.push(smDX);
  }

  return { adx, plusDI, minusDI };
}

function analyzeVolume(candles, period = 20, spikeRatio = 1.5) {
  const volumes = candles.map(c => c.volume);
  const volMA   = movingAverage(volumes, period);
  return candles.map((c, i) => ({
    volume:     c.volume,
    volMA:      volMA[i],
    isSpike:    volMA[i] ? c.volume > volMA[i] * spikeRatio : false,
    isAboveAvg: volMA[i] ? c.volume > volMA[i] : false,
  }));
}

// ─── PRICE ACTION ────────────────────────────────────────────

function findSRLevels(candles, lookback, strength, zonePct) {
  const levels = [];
  const highs = candles.map(c => c.high);
  const lows  = candles.map(c => c.low);
  const swings = [];
  for (let i = 2; i < candles.length - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2])
      swings.push({ price: highs[i], type: "resistance" });
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2])
      swings.push({ price: lows[i], type: "support" });
  }
  for (const sw of swings) {
    const zone = sw.price * (zonePct / 100);
    const ex = levels.find(l => Math.abs(l.price - sw.price) < zone);
    if (ex) { ex.touches++; ex.price = (ex.price + sw.price) / 2; }
    else levels.push({ price: sw.price, type: sw.type, touches: 1 });
  }
  return levels.filter(l => l.touches >= strength);
}

function isNearSRLevel(price, srLevels, zonePct) {
  const zone = price * (zonePct / 100);
  return srLevels.find(l => Math.abs(l.price - price) < zone) || null;
}

function detectBOS(candles, i, lookback) {
  if (i < lookback) return null;
  const slice  = candles.slice(i - lookback, i);
  const swingH = Math.max(...slice.map(c => c.high));
  const swingL = Math.min(...slice.map(c => c.low));
  if (candles[i].close > swingH) return "BULLISH_BOS";
  if (candles[i].close < swingL) return "BEARISH_BOS";
  return null;
}

function detectFVG(candles, i, minSizePct) {
  if (i < 2) return null;
  const prev2 = candles[i - 2], curr = candles[i];
  const minSize = curr.close * (minSizePct / 100);
  if (curr.low > prev2.high && (curr.low - prev2.high) >= minSize)
    return { type: "BULLISH_FVG", top: curr.low, bottom: prev2.high };
  if (curr.high < prev2.low && (prev2.low - curr.high) >= minSize)
    return { type: "BEARISH_FVG", top: prev2.low, bottom: curr.high };
  return null;
}

function isPriceInFVG(price, fvgList) {
  return fvgList.find(f => price >= f.bottom && price <= f.top) || null;
}

function detectEngulfing(candles, i, ratio) {
  if (i < 1) return null;
  const prev = candles[i - 1], curr = candles[i];
  const pb = Math.abs(prev.close - prev.open), cb = Math.abs(curr.close - curr.open);
  if (prev.close < prev.open && curr.close > curr.open &&
      curr.open < prev.close && curr.close > prev.open && cb > pb * ratio)
    return "BULLISH_ENGULFING";
  if (prev.close > prev.open && curr.close < curr.open &&
      curr.open > prev.close && curr.close < prev.open && cb > pb * ratio)
    return "BEARISH_ENGULFING";
  return null;
}

function detectPinBar(candle, ratio) {
  const body = Math.abs(candle.close - candle.open);
  if (body === 0) return null;
  const upper = candle.high - Math.max(candle.open, candle.close);
  const lower = Math.min(candle.open, candle.close) - candle.low;
  if (lower > body * ratio && upper < body * 0.5) return "BULLISH_PIN_BAR";
  if (upper > body * ratio && lower < body * 0.5) return "BEARISH_PIN_BAR";
  return null;
}

// ── YENİ: Kelly Criterion ────────────────────────────────────
// Matematiksel optimum pozisyon boyutu
// Kelly % = (win_rate * avg_win - loss_rate * avg_loss) / avg_win
// Yarım Kelly kullanıyoruz (daha güvenli)
function kellyPositionSize(tradeHistory, totalCash) {
  if (tradeHistory.length < 5) {
    // Yeterli veri yoksa sabit %10 kullan
    return Math.min(totalCash * 0.10, totalCash * CONFIG.maxPositionPct / 100);
  }

  const wins   = tradeHistory.filter(t => t.pnl > 0);
  const losses = tradeHistory.filter(t => t.pnl <= 0);

  if (wins.length === 0 || losses.length === 0) {
    return totalCash * (CONFIG.minPositionPct / 100);
  }

  const winRate  = wins.length / tradeHistory.length;
  const lossRate = 1 - winRate;
  const avgWin   = wins.reduce((s, t) => s + t.pnl, 0)   / wins.length;
  const avgLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length);

  if (avgLoss === 0) return totalCash * (CONFIG.maxPositionPct / 100);

  const kelly    = (winRate * avgWin - lossRate * avgLoss) / avgWin;
  const halfKelly = kelly * CONFIG.kellyFraction;

  // Min/Max limitler
  const pct = Math.max(
    CONFIG.minPositionPct / 100,
    Math.min(CONFIG.maxPositionPct / 100, halfKelly)
  );

  return totalCash * pct;
}

// ─── MTF ANALİZ ──────────────────────────────────────────────

function analyzeMonthly(candles) {
  const prices = candles.map(c => c.close);
  const ma12 = movingAverage(prices, 12);
  const ma6  = movingAverage(prices, 6);
  const rsi  = calculateRSI(prices, 14);
  const last = prices.length - 1;
  if (!ma12[last] || !ma6[last]) return null;
  const trend    = prices[last] > ma12[last] ? "BULL" : "BEAR";
  const momentum = ma6[last] > ma12[last]    ? "UP"   : "DOWN";
  const rsiState = rsi[last] > 50 ? "STRONG" : "WEAK";
  const swingH = Math.max(...prices.slice(last - 12, last));
  const swingL = Math.min(...prices.slice(last - 12, last));
  const bos    = prices[last] > swingH ? "BULLISH" : prices[last] < swingL ? "BEARISH" : "NEUTRAL";
  return { trend, momentum, rsiState, bos, ma12: ma12[last], ma6: ma6[last], rsi: rsi[last], price: prices[last],
    summary: `${trend} | MA6 ${momentum} | RSI: ${rsi[last]?.toFixed(1)}` };
}

function analyzeWeekly(candles) {
  const prices = candles.map(c => c.close);
  const ma20 = movingAverage(prices, 20);
  const ma50 = movingAverage(prices, 50);
  const rsi  = calculateRSI(prices, 14);
  const last = prices.length - 1;
  if (!ma20[last] || !ma50[last]) return null;
  const trend       = prices[last] > ma50[last] ? "BULL" : "BEAR";
  const momentum    = ma20[last] > ma50[last]   ? "UP"   : "DOWN";
  const goldenCross = ma20[last] > ma50[last] && ma20[last-1] <= ma50[last-1];
  const deathCross  = ma20[last] < ma50[last] && ma20[last-1] >= ma50[last-1];
  const swingH = Math.max(...prices.slice(last - 20, last));
  const swingL = Math.min(...prices.slice(last - 20, last));
  const bos    = prices[last] > swingH ? "BULLISH" : prices[last] < swingL ? "BEARISH" : "NEUTRAL";
  const rsiSignal = rsi[last] < 45 ? "OVERSOLD" : rsi[last] > 55 ? "OVERBOUGHT" : "NEUTRAL";
  return { trend, momentum, goldenCross, deathCross, bos, rsiSignal,
    ma20: ma20[last], ma50: ma50[last], rsi: rsi[last], price: prices[last],
    summary: `${trend} | ${momentum} | ${goldenCross ? "🌟 GOLDEN CROSS" : deathCross ? "💀 DEATH CROSS" : "Normal"}` };
}

function calcMTFScore(monthly, weekly, direction) {
  let score = 0;
  const reasons = [];
  if (!monthly || !weekly) return { score, reasons };
  if (direction === "BUY") {
    if (monthly.trend === "BULL")        { score += 2; reasons.push("📅 Aylık Trend: BOĞA"); }
    if (monthly.momentum === "UP")       { score++;    reasons.push("📅 Aylık MA6 > MA12"); }
    if (monthly.bos === "BULLISH")       { score++;    reasons.push("📅 Aylık BOS ↑"); }
    if (monthly.rsiState === "STRONG")   { score++;    reasons.push("📅 Aylık RSI Güçlü"); }
    if (weekly.trend === "BULL")         { score += 2; reasons.push("📆 Haftalık Trend: BOĞA"); }
    if (weekly.momentum === "UP")        { score++;    reasons.push("📆 Haftalık MA20 > MA50"); }
    if (weekly.goldenCross)              { score += 2; reasons.push("📆 Haftalık 🌟 GOLDEN CROSS"); }
    if (weekly.rsiSignal === "OVERSOLD") { score++;    reasons.push("📆 Haftalık RSI Aşırı Satış"); }
    if (weekly.bos === "BULLISH")        { score++;    reasons.push("📆 Haftalık BOS ↑"); }
    if (monthly.trend === "BULL" && weekly.trend === "BULL") {
      score += CONFIG.mtfBonusScore; reasons.push(`🎯 3 TF HİZALI BONUS (+${CONFIG.mtfBonusScore})`);
    }
  } else {
    if (monthly.trend === "BEAR")           { score += 2; reasons.push("📅 Aylık Trend: AYI"); }
    if (monthly.momentum === "DOWN")        { score++;    reasons.push("📅 Aylık MA6 < MA12"); }
    if (monthly.bos === "BEARISH")          { score++;    reasons.push("📅 Aylık BOS ↓"); }
    if (monthly.rsiState === "WEAK")        { score++;    reasons.push("📅 Aylık RSI Zayıf"); }
    if (weekly.trend === "BEAR")            { score += 2; reasons.push("📆 Haftalık Trend: AYI"); }
    if (weekly.momentum === "DOWN")         { score++;    reasons.push("📆 Haftalık MA20 < MA50"); }
    if (weekly.deathCross)                  { score += 2; reasons.push("📆 Haftalık 💀 DEATH CROSS"); }
    if (weekly.rsiSignal === "OVERBOUGHT")  { score++;    reasons.push("📆 Haftalık RSI Aşırı Alış"); }
    if (weekly.bos === "BEARISH")           { score++;    reasons.push("📆 Haftalık BOS ↓"); }
    if (monthly.trend === "BEAR" && weekly.trend === "BEAR") {
      score += CONFIG.mtfBonusScore; reasons.push(`🎯 3 TF HİZALI BONUS (+${CONFIG.mtfBonusScore})`);
    }
  }
  return { score, reasons };
}

// ─── SİNYAL MOTORU ───────────────────────────────────────────
function generateSignals(candles, monthly, weekly) {
  const prices   = candles.map(c => c.close);
  const rsi      = calculateRSI(prices, CONFIG.rsiPeriod);
  const shortMA  = movingAverage(prices, CONFIG.shortMAPeriod);
  const longMA   = movingAverage(prices, CONFIG.longMAPeriod);
  const ma50     = movingAverage(prices, CONFIG.ma50Period);
  const ma100    = movingAverage(prices, CONFIG.ma100Period);
  const ma200    = movingAverage(prices, CONFIG.ma200Period);
  const ma365    = movingAverage(prices, CONFIG.ma365Period);
  const atr      = calculateATR(candles, CONFIG.atrPeriod);
  const volData  = analyzeVolume(candles, CONFIG.volumeMAPeriod, CONFIG.volumeSpikeRatio);
  const srLevels = findSRLevels(candles, CONFIG.srLookback, CONFIG.srStrength, CONFIG.srZonePct);

  // ── YENİ: ADX hesapla ──
  const { adx, plusDI, minusDI } = calculateADX(candles, CONFIG.adxPeriod);

  const fvgList = [];
  for (let i = 2; i < candles.length; i++) {
    const fvg = detectFVG(candles, i, CONFIG.fvgMinSizePct);
    if (fvg) fvgList.push({ ...fvg, index: i });
  }

  const signals = [];
  const minIdx  = Math.max(CONFIG.bosLookback, CONFIG.ma365Period, CONFIG.adxPeriod * 2);

  for (let i = minIdx; i < candles.length; i++) {
    const candle = candles[i];
    const price  = candle.close;
    if (!rsi[i] || !shortMA[i] || !longMA[i] || !ma200[i] || !atr[i] || !adx[i]) continue;

    // ── YENİ: ADX Rejim Filtresi ──────────────────────────
    const adxVal    = adx[i];
    const isTrend   = adxVal >= CONFIG.adxTrendMin;    // Trend piyasası
    const isStrong  = adxVal >= CONFIG.adxStrongTrend;  // Çok güçlü trend
    const bullTrend = plusDI[i] > minusDI[i];           // +DI > -DI → yukarı baskı
    const bearTrend = minusDI[i] > plusDI[i];           // -DI > +DI → aşağı baskı

    // Sideways piyasada sinyal üretme
    if (!isTrend) continue;

    // RSI + MA
    const rsiSig    = rsi[i] < CONFIG.rsiOversold ? "BUY" : rsi[i] > CONFIG.rsiOverbought ? "SELL" : null;
    const prevCross = shortMA[i-1] - longMA[i-1];
    const currCross = shortMA[i]   - longMA[i];
    const maSig     = prevCross <= 0 && currCross > 0 ? "BUY" : prevCross >= 0 && currCross < 0 ? "SELL" : null;

    // MA Pozisyonları
    const aboveMA50  = price > ma50[i];
    const aboveMA100 = ma100[i] && price > ma100[i];
    const aboveMA200 = price > ma200[i];
    const aboveMA365 = ma365[i] && price > ma365[i];
    const goldenCrossD = ma50[i] > ma200[i] && ma50[i-1] <= ma200[i-1];
    const deathCrossD  = ma50[i] < ma200[i] && ma50[i-1] >= ma200[i-1];
    const touchMA50  = Math.abs(price - ma50[i])  / price < 0.003;
    const touchMA100 = ma100[i] && Math.abs(price - ma100[i]) / price < 0.003;
    const touchMA200 = Math.abs(price - ma200[i]) / price < 0.005;
    const touchMA365 = ma365[i] && Math.abs(price - ma365[i]) / price < 0.005;

    // ATR Dinamik SL/TP
    const atrValue = atr[i];
    const dynSL    = price - atrValue * CONFIG.atrSLMultiple;
    const dynTP    = price + atrValue * CONFIG.atrTPMultiple;
    const dynSLPct = ((price - dynSL) / price * 100).toFixed(2);
    const dynTPPct = ((dynTP - price) / price * 100).toFixed(2);

    // Hacim
    const vol = volData[i];

    // Price Action
    const bos       = detectBOS(candles, i, CONFIG.bosLookback);
    const inFVG     = isPriceInFVG(price, fvgList);
    const srLevel   = isNearSRLevel(price, srLevels, CONFIG.srZonePct * 2);
    const engulfing = detectEngulfing(candles, i, CONFIG.engulfingRatio);
    const pinBar    = detectPinBar(candle, CONFIG.pinBarRatio);

    // Trend Özeti
    const trendState = aboveMA365
      ? (aboveMA200 ? "📈 Güçlü Boğa (>MA365 & >MA200)" : "📈 Boğa (>MA365)")
      : (aboveMA200 ? "⚠️  Karışık (>MA200 ama <MA365)"  : "📉 Ayı (<MA365 & <MA200)");

    // ─── BUY SKORU ───────────────────────────────────────
    // ADX yönü BUY ile uyumlu değilse devam etme
    if (rsiSig === "BUY" || maSig === "BUY" || bos === "BULLISH_BOS") {
      if (!bullTrend) continue; // ADX aşağı gösteriyorsa BUY sinyali iptal
    }

    let buyScore = 0;
    const buyReasons = [];

    if (rsiSig === "BUY")                  { buyScore++;    buyReasons.push("RSI Aşırı Satış"); }
    if (maSig  === "BUY")                  { buyScore++;    buyReasons.push("MA5/20 Kesişimi ↑"); }
    if (bos === "BULLISH_BOS")             { buyScore++;    buyReasons.push("BOS Yukarı Kırılım"); }
    if (inFVG?.type === "BULLISH_FVG")     { buyScore++;    buyReasons.push("Bullish FVG Bölgesi"); }
    if (srLevel?.type === "support")       { buyScore++;    buyReasons.push(`S/R Destek $${srLevel.price.toFixed(0)}`); }
    if (engulfing === "BULLISH_ENGULFING") { buyScore++;    buyReasons.push("Bullish Engulfing"); }
    if (pinBar === "BULLISH_PIN_BAR")      { buyScore++;    buyReasons.push("Hammer / Pin Bar"); }
    if (aboveMA50)                         { buyScore++;    buyReasons.push("Fiyat > MA50"); }
    if (aboveMA100)                        { buyScore++;    buyReasons.push("Fiyat > MA100"); }
    if (aboveMA200)                        { buyScore++;    buyReasons.push("Fiyat > MA200 ✅"); }
    if (aboveMA365)                        { buyScore += 2; buyReasons.push("Fiyat > MA365 🏆"); }
    if (goldenCrossD)                      { buyScore += 2; buyReasons.push("🌟 Günlük Golden Cross"); }
    if (touchMA50  && aboveMA50)           { buyScore++;    buyReasons.push("MA50 Destek Testi"); }
    if (touchMA100 && aboveMA100)          { buyScore++;    buyReasons.push("MA100 Destek Testi"); }
    if (touchMA200 && aboveMA200)          { buyScore++;    buyReasons.push("MA200 Destek 💎"); }
    if (touchMA365 && aboveMA365)          { buyScore += 2; buyReasons.push("MA365 Destek 👑"); }
    if (vol.isAboveAvg)                    { buyScore++;    buyReasons.push("Hacim Ortalamanın Üstünde"); }
    if (vol.isSpike)                       { buyScore++;    buyReasons.push("🔥 Hacim Spike!"); }
    // ── YENİ: ADX puanları ──
    if (isStrong && bullTrend)             { buyScore += 2; buyReasons.push(`💪 Güçlü Trend (ADX: ${adxVal.toFixed(1)})`); }
    else if (isTrend && bullTrend)         { buyScore++;    buyReasons.push(`📈 Trend Aktif (ADX: ${adxVal.toFixed(1)})`); }
    // MTF
    const mtfBuy = calcMTFScore(monthly, weekly, "BUY");
    buyScore += mtfBuy.score;
    buyReasons.push(...mtfBuy.reasons);

    // ─── SELL SKORU ──────────────────────────────────────
    let sellScore = 0;
    const sellReasons = [];

    if (rsiSig === "SELL")                  { sellScore++;    sellReasons.push("RSI Aşırı Alış"); }
    if (maSig  === "SELL")                  { sellScore++;    sellReasons.push("MA5/20 Kesişimi ↓"); }
    if (bos === "BEARISH_BOS")              { sellScore++;    sellReasons.push("BOS Aşağı Kırılım"); }
    if (inFVG?.type === "BEARISH_FVG")      { sellScore++;    sellReasons.push("Bearish FVG Bölgesi"); }
    if (srLevel?.type === "resistance")     { sellScore++;    sellReasons.push(`S/R Direnç $${srLevel.price.toFixed(0)}`); }
    if (engulfing === "BEARISH_ENGULFING")  { sellScore++;    sellReasons.push("Bearish Engulfing"); }
    if (pinBar === "BEARISH_PIN_BAR")       { sellScore++;    sellReasons.push("Shooting Star"); }
    if (!aboveMA50)                         { sellScore++;    sellReasons.push("Fiyat < MA50"); }
    if (!aboveMA100)                        { sellScore++;    sellReasons.push("Fiyat < MA100"); }
    if (!aboveMA200)                        { sellScore++;    sellReasons.push("Fiyat < MA200 ⚠️"); }
    if (!aboveMA365)                        { sellScore += 2; sellReasons.push("Fiyat < MA365 ⛔"); }
    if (deathCrossD)                        { sellScore += 2; sellReasons.push("💀 Günlük Death Cross"); }
    if (touchMA50  && !aboveMA50)           { sellScore++;    sellReasons.push("MA50 Direnç Testi"); }
    if (touchMA100 && !aboveMA100)          { sellScore++;    sellReasons.push("MA100 Direnç Testi"); }
    if (touchMA200 && !aboveMA200)          { sellScore++;    sellReasons.push("MA200 Direnç ⚠️"); }
    if (touchMA365 && !aboveMA365)          { sellScore += 2; sellReasons.push("MA365 Direnç 👑"); }
    if (vol.isAboveAvg)                     { sellScore++;    sellReasons.push("Hacim Ortalamanın Üstünde"); }
    if (vol.isSpike)                        { sellScore++;    sellReasons.push("🔥 Hacim Spike!"); }
    if (isStrong && bearTrend)              { sellScore += 2; sellReasons.push(`💪 Güçlü Düşüş Trendi (ADX: ${adxVal.toFixed(1)})`); }
    else if (isTrend && bearTrend)          { sellScore++;    sellReasons.push(`📉 Trend Aktif (ADX: ${adxVal.toFixed(1)})`); }
    const mtfSell = calcMTFScore(monthly, weekly, "SELL");
    sellScore += mtfSell.score;
    sellReasons.push(...mtfSell.reasons);

    if (buyScore >= CONFIG.minScore) {
      signals.push({ index: i, price, rsi: rsi[i], action: "BUY",
                     score: buyScore, reasons: buyReasons, trendState,
                     atr: atrValue, dynSL, dynTP, dynSLPct, dynTPPct,
                     adx: adxVal, volume: vol.volume, volMA: vol.volMA });
    } else if (sellScore >= CONFIG.minScore) {
      signals.push({ index: i, price, rsi: rsi[i], action: "SELL",
                     score: sellScore, reasons: sellReasons, trendState,
                     atr: atrValue, dynSL, dynTP, dynSLPct, dynTPPct,
                     adx: adxVal, volume: vol.volume, volMA: vol.volMA });
    }
  }

  return { signals, srLevels };
}

// ─── BACKTEST (Train + Out-of-Sample) ────────────────────────
async function backtest(symbol, candles, signals, startCash = 1000, label = "BACKTEST") {
  const prices = candles.map(c => c.close);
  console.log(`\n📊 ${label} — ${symbol}  (${candles.length} mum, ${signals.length} sinyal)`);
  console.log("═".repeat(65));

  let cash         = startCash;
  const peakCash   = { val: startCash };
  let position     = 0;
  let entryPrice   = 0;
  let stopLoss     = 0;
  let takeProfit   = 0;
  let trailingHigh = 0;
  let trades       = 0, wins = 0, lossCount = 0;
  let drawdownHit  = false;
  const tradeHistory = [];

  for (let i = 0; i < prices.length; i++) {
    const price = prices[i];

    // ── YENİ: Drawdown Limiti ──────────────────────────────
    const currentTotal  = position > 0 ? position * price : cash;
    const drawdownFromPeak = (peakCash.val - currentTotal) / peakCash.val * 100;
    if (drawdownFromPeak >= CONFIG.maxDrawdownPct && !drawdownHit) {
      drawdownHit = true;
      console.log(`🚨 DRAWDOWN LİMİTİ — %${drawdownFromPeak.toFixed(1)} kayıp — Bot durdu!`);
      if (label === "BACKTEST") {
        await sendTelegram(
          `🚨 <b>DRAWDOWN LİMİTİ AŞILDI</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🪙 Sembol     : ${symbol}\n` +
          `📉 Drawdown   : -%${drawdownFromPeak.toFixed(1)}\n` +
          `💵 Mevcut     : $${currentTotal.toFixed(2)}\n` +
          `⛔ Bot durduruldu — manuel inceleme gerekli!`
        );
      }
      if (position > 0) { cash = position * price; position = 0; }
      break;
    }
    if (currentTotal > peakCash.val) peakCash.val = currentTotal;

    if (position > 0) {
      // Trailing Stop
      if (price > trailingHigh) {
        trailingHigh = price;
        const newSL = price * (1 - CONFIG.trailingStopPct / 100);
        if (newSL > stopLoss) stopLoss = newSL;
      }

      // Stop-Loss / Trailing Stop tetiklendi
      if (price <= stopLoss) {
        const pnl    = (price - entryPrice) / entryPrice * 100;
        const pnlStr = pnl.toFixed(2);
        cash         = position * price;
        const isTrailing = price > entryPrice;

        console.log(`${isTrailing ? "🔒 TRAILING" : "🛑 STOP-LOSS"} | $${price.toFixed(2)} | PnL: %${pnlStr} | Bakiye: $${cash.toFixed(2)}`);

        if (label === "BACKTEST") {
          await sendTelegram(
            `${isTrailing ? "🔒" : "🛑"} <b>${isTrailing ? "TRAILING STOP — KÂR KİLİTLENDİ" : "STOP-LOSS TETİKLENDİ"}</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🪙 Sembol      : ${symbol}\n` +
            `💰 Giriş       : $${entryPrice.toFixed(2)}\n` +
            `💸 Çıkış       : $${price.toFixed(2)}\n` +
            `${pnl >= 0 ? "📈" : "📉"} PnL          : %${pnlStr}\n` +
            `💵 Bakiye      : $${cash.toFixed(2)}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `${isTrailing ? "✅ Kâr korundu." : "⚠️ Zarar kesildi."} Yeni sinyal bekleniyor.`
          );
        }

        tradeHistory.push({ pnl });
        pnl >= 0 ? wins++ : lossCount++;
        position = 0; trades++;
        continue;
      }

      // Take-Profit
      if (price >= takeProfit) {
        const pnl    = (price - entryPrice) / entryPrice * 100;
        const pnlStr = pnl.toFixed(2);
        cash         = position * price;

        console.log(`🎯 TAKE-PROFIT | $${price.toFixed(2)} | PnL: %${pnlStr} | Bakiye: $${cash.toFixed(2)}`);

        if (label === "BACKTEST") {
          await sendTelegram(
            `🎯 <b>TAKE-PROFIT! KÂR ALINDI</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🪙 Sembol      : ${symbol}\n` +
            `💰 Giriş       : $${entryPrice.toFixed(2)}\n` +
            `✅ Çıkış       : $${price.toFixed(2)}\n` +
            `📈 PnL         : %${pnlStr}\n` +
            `💵 Bakiye      : $${cash.toFixed(2)}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🚀 Yeni sinyal bekleniyor.`
          );
        }

        tradeHistory.push({ pnl });
        position = 0; trades++; wins++;
        continue;
      }
    }

    const signal = signals.find(s => s.index === i);
    if (!signal || drawdownHit) continue;

    if (signal.action === "BUY" && cash > 0 && position === 0) {
      // ── YENİ: Kelly Criterion pozisyon boyutu ──
      const kellyCash = kellyPositionSize(tradeHistory, cash);
      entryPrice   = price;
      stopLoss     = signal.dynSL;
      takeProfit   = signal.dynTP;
      trailingHigh = price;
      position     = kellyCash / price;
      cash        -= kellyCash;

      const dailyR   = signal.reasons.filter(r => !r.startsWith("📅") && !r.startsWith("📆") && !r.startsWith("🎯"));
      const mtfR     = signal.reasons.filter(r => r.startsWith("📅") || r.startsWith("📆") || r.startsWith("🎯"));
      const volRatio = signal.volMA ? (signal.volume / signal.volMA).toFixed(1) : "?";
      const kellyPct = (kellyCash / (cash + kellyCash) * 100).toFixed(1);

      console.log(`\n🟢 AL  | $${price.toFixed(2)} | RSI: ${signal.rsi.toFixed(1)} | ADX: ${signal.adx.toFixed(1)} | Skor: ${signal.score} | Kelly: %${kellyPct}`);
      console.log(`   ${signal.trendState}`);

      if (label === "BACKTEST") {
        await sendTelegram(
          `🟢 <b>AL SİNYALİ</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🪙 Sembol       : ${symbol}\n` +
          `💰 Fiyat        : $${price.toFixed(2)}\n` +
          `📊 RSI          : ${signal.rsi.toFixed(1)}\n` +
          `📐 ADX          : ${signal.adx.toFixed(1)} (Trend gücü)\n` +
          `⭐ Sinyal Skoru  : ${signal.score} puan\n` +
          `🧭 Trend        : ${signal.trendState}\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `💼 Kelly Pozisyon: %${kellyPct} portföy\n` +
          `📉 ATR Volatilite: $${signal.atr.toFixed(0)}\n` +
          `📦 Hacim        : ${volRatio}x ortalama\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `📊 <b>Günlük Sinyaller:</b>\n` +
          `<i>${dailyR.map(r => `  • ${r}`).join("\n")}</i>\n` +
          `\n📅 <b>Multi-Timeframe:</b>\n` +
          `<i>${mtfR.map(r => `  • ${r}`).join("\n") || "  • Yok"}</i>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🛑 Stop-Loss    : $${stopLoss.toFixed(2)} (-%${signal.dynSLPct})\n` +
          `🎯 Take-Profit  : $${takeProfit.toFixed(2)} (+%${signal.dynTPPct})\n` +
          `🔒 Trailing     : -%${CONFIG.trailingStopPct} (aktif)\n` +
          `⚖️ Risk/Ödül    : 1:${(CONFIG.atrTPMultiple / CONFIG.atrSLMultiple).toFixed(1)}`
        );
      }

    } else if (signal.action === "SELL" && position > 0) {
      cash += position * price;
      const pnl  = (price - entryPrice) / entryPrice * 100;
      const pnlStr = pnl.toFixed(2);

      console.log(`\n🔴 SAT | $${price.toFixed(2)} | RSI: ${signal.rsi.toFixed(1)} | PnL: %${pnlStr} | Bakiye: $${cash.toFixed(2)}`);

      if (label === "BACKTEST") {
        const dailyR = signal.reasons.filter(r => !r.startsWith("📅") && !r.startsWith("📆") && !r.startsWith("🎯"));
        const mtfR   = signal.reasons.filter(r => r.startsWith("📅") || r.startsWith("📆") || r.startsWith("🎯"));
        await sendTelegram(
          `🔴 <b>SAT SİNYALİ</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🪙 Sembol       : ${symbol}\n` +
          `💰 Fiyat        : $${price.toFixed(2)}\n` +
          `📊 RSI          : ${signal.rsi.toFixed(1)}\n` +
          `📐 ADX          : ${signal.adx.toFixed(1)}\n` +
          `⭐ Sinyal Skoru  : ${signal.score} puan\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `📊 <b>Günlük Sinyaller:</b>\n` +
          `<i>${dailyR.map(r => `  • ${r}`).join("\n")}</i>\n` +
          `\n📅 <b>Multi-Timeframe:</b>\n` +
          `<i>${mtfR.map(r => `  • ${r}`).join("\n") || "  • Yok"}</i>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `💰 Giriş        : $${entryPrice.toFixed(2)}\n` +
          `${pnl >= 0 ? "📈" : "📉"} PnL           : %${pnlStr}\n` +
          `💵 Bakiye       : $${cash.toFixed(2)}`
        );
      }

      tradeHistory.push({ pnl });
      pnl >= 0 ? wins++ : lossCount++;
      position = 0; trades++;
    }
  }

  if (position > 0) cash += position * prices.at(-1);

  const finalValue = cash;
  const profitPct  = ((finalValue - startCash) / startCash * 100).toFixed(2);
  const winRate    = trades > 0 ? (wins / trades * 100).toFixed(1) : 0;

  console.log("\n" + "═".repeat(65));
  console.log(`💵 Başlangıç    : $${startCash.toFixed(2)}`);
  console.log(`💵 Sonuç        : $${finalValue.toFixed(2)}`);
  console.log(`📈 Kâr/Zarar    : %${profitPct}`);
  console.log(`🔄 Toplam İşlem : ${trades}  (✅${wins} / ❌${lossCount})`);
  console.log(`🏆 Kazanma Oranı: %${winRate}`);
  console.log(`🚨 Drawdown Dur : ${drawdownHit ? "EVET" : "Hayır"}`);

  return { symbol, finalValue, startCash, profitPct, winRate, trades, wins, lossCount, drawdownHit };
}

// ── YENİ: Out-of-Sample Validasyon ───────────────────────────
// Verinin %70'iyle backtest, %30'uyla bağımsız test yapılır.
// İkisi birbirine yakınsa strateji güvenilir.
async function outOfSampleValidation(symbol, candles, monthly, weekly) {
  const split  = Math.floor(candles.length * CONFIG.trainRatio);
  const trainC = candles.slice(0, split);
  const testC  = candles.slice(split);

  console.log(`\n🔬 OUT-OF-SAMPLE VALİDASYON — ${symbol}`);
  console.log(`   Train: ${trainC.length} mum | Test: ${testC.length} mum`);

  const { signals: trainSig } = generateSignals(trainC, monthly, weekly);
  const { signals: testSig  } = generateSignals(testC, monthly, weekly);

  const trainResult = await backtest(symbol, trainC, trainSig, 1000, "TRAIN");
  const testResult  = await backtest(symbol, testC,  testSig,  1000, "TEST");

  const trainPnl = parseFloat(trainResult.profitPct);
  const testPnl  = parseFloat(testResult.profitPct);
  const diff     = Math.abs(trainPnl - testPnl);

  // Değerlendirme
  let verdict, verdictEmoji;
  if (diff < 15 && testPnl > 0) {
    verdict = "GEÇERLİ ✅ Strateji gerçek veride de çalışıyor";
    verdictEmoji = "✅";
  } else if (testPnl > 0 && diff < 30) {
    verdict = "KABUL EDİLEBİLİR ⚠️ Küçük sapma var, takip et";
    verdictEmoji = "⚠️";
  } else if (testPnl <= 0) {
    verdict = "BAŞARISIZ ❌ Strateji out-of-sample'da kârsız";
    verdictEmoji = "❌";
  } else {
    verdict = "OVERFITTING ❌ Train/Test farkı çok büyük";
    verdictEmoji = "❌";
  }

  console.log(`\n   🔵 Train PnL : %${trainPnl}`);
  console.log(`   🟠 Test PnL  : %${testPnl}`);
  console.log(`   📏 Fark      : %${diff.toFixed(1)}`);
  console.log(`   ${verdict}`);

  await sendTelegram(
    `🔬 <b>OUT-OF-SAMPLE VALİDASYON — ${symbol}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔵 Train (%${Math.round(CONFIG.trainRatio * 100)}): %${trainPnl} | Kazanma: %${trainResult.winRate}\n` +
    `🟠 Test  (%${Math.round((1 - CONFIG.trainRatio) * 100)}): %${testPnl} | Kazanma: %${testResult.winRate}\n` +
    `📏 Train/Test Farkı : %${diff.toFixed(1)}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${verdictEmoji} <b>${verdict}</b>`
  );

  return { trainResult, testResult, verdict, diff };
}

// ─── ANA FONKSİYON ───────────────────────────────────────────
async function run() {
  console.log(`\n🤖 Multi-Timeframe Smart Money Bot — v4.0 PRO`);
  console.log(`🏦 BINANCE | Semboller: ${CONFIG.symbols.join(", ")}`);
  console.log(`⏱️  Aylık + Haftalık + Günlük`);
  console.log(`⚙️  ADX Min: ${CONFIG.adxTrendMin} | ATR SL:×${CONFIG.atrSLMultiple} | ATR TP:×${CONFIG.atrTPMultiple}`);
  console.log(`🛡️  Max Drawdown: -%${CONFIG.maxDrawdownPct} | Kelly: Yarım (×${CONFIG.kellyFraction})`);
  console.log(`📊 MA: 5/20/50/100/200/365 | Min Skor: ${CONFIG.minScore}\n`);

  const results     = [];
  const validations = [];

  for (const symbol of CONFIG.symbols) {
    try {
      console.log(`\n${"─".repeat(65)}`);
      console.log(`🔍 ${symbol} analiz ediliyor...`);

      // Veri çek
      const [monthlyC, weeklyC, dailyC] = await Promise.all([
        fetchCandles(symbol, "monthly", CONFIG.timeframes.monthly.limit),
        fetchCandles(symbol, "weekly",  CONFIG.timeframes.weekly.limit),
        fetchCandles(symbol, "daily",   CONFIG.timeframes.daily.limit),
      ]);

      const monthly = analyzeMonthly(monthlyC);
      const weekly  = analyzeWeekly(weeklyC);

      console.log(`📅 Aylık   : ${monthly?.summary || "Yetersiz veri"}`);
      console.log(`📆 Haftalık: ${weekly?.summary  || "Yetersiz veri"}`);

      // ── YENİ: Funding Rate ──
      const funding = await fetchFundingRate(symbol);
      if (funding) {
        const fr = (funding.latest * 100).toFixed(4);
        const frSentiment = funding.latest > CONFIG.fundingRateExtreme  ? "⚠️ AŞIRI LONG (düşüş riski)"
                          : funding.latest < -CONFIG.fundingRateExtreme ? "⚠️ AŞIRI SHORT (yükseliş olası)"
                          : Math.abs(funding.latest) < CONFIG.fundingRateNormal ? "✅ Nötr"
                          : "Normal";
        console.log(`💹 Funding Rate: %${fr} — ${frSentiment}`);
      }

      // Sinyal üret + Out-of-Sample validasyon
      const validation = await outOfSampleValidation(symbol, dailyC, monthly, weekly);
      validations.push({ symbol, ...validation });

      // Full backtest
      const { signals, srLevels } = generateSignals(dailyC, monthly, weekly);
      console.log(`📍 ${srLevels.length} S/R | 🔔 ${signals.length} sinyal`);

      if (signals.length === 0) {
        console.log(`⚠️  Sinyal yok — atlanıyor.`);
        continue;
      }

      const result = await backtest(symbol, dailyC, signals);
      results.push(result);

      await new Promise(r => setTimeout(r, 600)); // Rate limit

    } catch (err) {
      console.error(`❌ ${symbol} hatası:`, err.message);
    }
  }

  // ── Özet Rapor ───────────────────────────────────────────
  if (results.length > 0) {
    results.sort((a, b) => parseFloat(b.profitPct) - parseFloat(a.profitPct));
    const best = results[0];

    console.log(`\n${"═".repeat(65)}`);
    console.log(`🏆 ÖZET RAPOR — v4.0 PRO`);
    console.log(`${"═".repeat(65)}`);
    results.forEach(r => {
      const e = parseFloat(r.profitPct) >= 0 ? "✅" : "❌";
      const dd = r.drawdownHit ? " 🚨DD" : "";
      console.log(`${e} ${r.symbol.padEnd(10)} | %${r.profitPct.toString().padStart(7)} | Kazanma: %${r.winRate} | ${r.trades} işlem${dd}`);
    });

    // Validasyon özeti
    console.log(`\n🔬 VALİDASYON SONUÇLARI:`);
    validations.forEach(v => {
      const testPnl = parseFloat(v.testResult?.profitPct || 0);
      const e = testPnl > 0 ? "✅" : "❌";
      console.log(`${e} ${v.symbol.padEnd(10)} | Test PnL: %${testPnl} | Fark: %${v.diff?.toFixed(1)}`);
    });

    await sendTelegram(
      `🏆 <b>ÖZET RAPOR — v4.0 PRO</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 <b>Backtest Sonuçları:</b>\n` +
      results.map(r => {
        const e  = parseFloat(r.profitPct) >= 0 ? "✅" : "❌";
        const dd = r.drawdownHit ? " 🚨" : "";
        return `${e} ${r.symbol}: %${r.profitPct} | %${r.winRate} kazanma (${r.trades} işlem)${dd}`;
      }).join("\n") +
      `\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🔬 <b>Out-of-Sample Validasyon:</b>\n` +
      validations.map(v => {
        const testPnl = parseFloat(v.testResult?.profitPct || 0);
        const e = testPnl > 0 ? "✅" : "❌";
        return `${e} ${v.symbol}: Test %${testPnl} | Fark %${v.diff?.toFixed(1)}`;
      }).join("\n") +
      `\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🥇 En İyi: <b>${best.symbol}</b> — %${best.profitPct}\n` +
      `\n⚙️ ADX Filtresi: >${CONFIG.adxTrendMin} (Sideways engellendi)\n` +
      `🛡️ Max Drawdown: -%${CONFIG.maxDrawdownPct}\n` +
      `💼 Kelly: Yarım (×${CONFIG.kellyFraction})`
    );
  }
}

run().catch(console.error);
