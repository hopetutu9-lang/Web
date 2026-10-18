import { createHmac } from "node:crypto";
import {
  appendLog,
  getConfig,
  getData,
  normalizePairs,
  updateConfig,
  updateData,
} from "./store.js";

const marketCache = new Map();
const markPrices = new Map();
const exchangeInfoCache = new Map();
const incomeCache = new Map();
let scanPromise = null;
let workerTimer = null;
let ws;
let wsRetry = null;
let wsBackoff = 1000;
let workerBusy = false;

const now = () => new Date().toISOString();
const finite = (value) => Number.isFinite(Number(value));

function modeUrl(config) {
  return config.binance.urls[config.binance.mode];
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Binance returned an invalid response (${response.status})`);
  }
  if (!response.ok) {
    const message =
      payload && typeof payload.msg === "string"
        ? payload.msg.slice(0, 220)
        : `Binance request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.binanceCode = payload?.code;
    throw error;
  }
  return payload;
}

export async function binanceRequest(method, endpoint, params = {}, signed = false) {
  const config = await getConfig();
  const urlBase = modeUrl(config);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const headers = {};
  if (signed) {
    if (!config.binance.apiKey || !config.binance.apiSecret) {
      throw new Error("Binance API key and secret are not configured");
    }
    query.set("timestamp", String(Date.now()));
    query.set("recvWindow", "5000");
    const signature = createHmac("sha256", config.binance.apiSecret)
      .update(query.toString())
      .digest("hex");
    query.set("signature", signature);
    headers["X-MBX-APIKEY"] = config.binance.apiKey;
  }
  const queryString = query.toString();
  const url = `${urlBase}${endpoint}${queryString ? `?${queryString}` : ""}`;
  return fetchJson(url, { method, headers });
}

async function publicRequest(endpoint, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  return fetchJson(`${modeUrl(await getConfig())}${endpoint}?${query.toString()}`);
}

const fmt = (n, digits = 8) => Number(Number(n).toFixed(digits));
const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);

export function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = mean(values.slice(0, period));
  for (let i = period; i < values.length; i += 1) {
    value = values[i] * multiplier + value * (1 - multiplier);
  }
  return value;
}

export function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const difference = values[i] - values[i - 1];
    if (difference > 0) gain += difference;
    else loss -= difference;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const difference = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(difference, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-difference, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function macd(values) {
  if (values.length < 35) return null;
  const fast = [];
  const slow = [];
  for (let end = 25; end <= values.length; end += 1) {
    fast.push(ema(values.slice(0, end), 12));
    slow.push(ema(values.slice(0, end), 26));
  }
  const line = fast.map((v, i) => v - slow[i]);
  const signal = ema(line, 9);
  return { line: line.at(-1), signal, histogram: line.at(-1) - signal };
}

function calculateAtr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.slice(1).map((candle, index) => {
    const previous = candles[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous),
      Math.abs(candle.low - previous),
    );
  });
  return mean(ranges.slice(-period));
}

function pivotLevels(candles) {
  const recent = candles.slice(-36);
  const highs = [];
  const lows = [];
  for (let i = 2; i < recent.length - 2; i += 1) {
    const c = recent[i];
    if (
      c.high > recent[i - 1].high &&
      c.high > recent[i - 2].high &&
      c.high >= recent[i + 1].high &&
      c.high >= recent[i + 2].high
    ) highs.push(c.high);
    if (
      c.low < recent[i - 1].low &&
      c.low < recent[i - 2].low &&
      c.low <= recent[i + 1].low &&
      c.low <= recent[i + 2].low
    ) lows.push(c.low);
  }
  return { highs, lows };
}

function structureSignals(candles) {
  const { highs, lows } = pivotLevels(candles);
  const current = candles.at(-1);
  const previous = candles.at(-2);
  const lastHigh = highs.at(-1) ?? Math.max(...candles.slice(-20, -2).map((x) => x.high));
  const lastLow = lows.at(-1) ?? Math.min(...candles.slice(-20, -2).map((x) => x.low));
  const bullBos = current.close > lastHigh && previous.close <= lastHigh;
  const bearBos = current.close < lastLow && previous.close >= lastLow;
  const priorHigh = highs.at(-2);
  const priorLow = lows.at(-2);
  const bullChoch = Boolean(priorHigh && current.close > priorHigh && previous.close <= priorHigh);
  const bearChoch = Boolean(priorLow && current.close < priorLow && previous.close >= priorLow);
  const lookback = candles.slice(-12, -1);
  const liqSweepDown =
    current.low < Math.min(...lookback.map((x) => x.low)) && current.close > current.open;
  const liqSweepUp =
    current.high > Math.max(...lookback.map((x) => x.high)) && current.close < current.open;
  const a = candles.at(-3);
  const fairValueGapUp = a.high < current.low;
  const fairValueGapDown = a.low > current.high;
  const impulse = Math.abs(current.close - current.open) > (calculateAtr(candles) || 0) * 0.8;
  const orderBlockUp = impulse && current.close > current.open && previous.close < previous.open;
  const orderBlockDown = impulse && current.close < current.open && previous.close > previous.open;
  return {
    lastSwingHigh: highs.at(-1) ?? null,
    lastSwingLow: lows.at(-1) ?? null,
    bos: bullBos ? "BULLISH" : bearBos ? "BEARISH" : "NONE",
    choch: bullChoch ? "BULLISH" : bearChoch ? "BEARISH" : "NONE",
    liquiditySweep: liqSweepDown ? "SELL_SIDE" : liqSweepUp ? "BUY_SIDE" : "NONE",
    fairValueGap: fairValueGapUp ? "BULLISH" : fairValueGapDown ? "BEARISH" : "NONE",
    orderBlock: orderBlockUp ? "BULLISH" : orderBlockDown ? "BEARISH" : "NONE",
  };
}

function calculateAnalysis(candles, higherCandles, shortCandles) {
  const closes = candles.map((x) => x.close);
  const volume = candles.map((x) => x.volume);
  const close = closes.at(-1);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const currentRsi = rsi(closes);
  const currentMacd = macd(closes);
  const atr = calculateAtr(candles);
  const structure = structureSignals(candles);
  const volumeAverage = mean(volume.slice(-21, -1));
  const volumeRatio = volumeAverage > 0 ? volume.at(-1) / volumeAverage : null;
  const higherClose = higherCandles.map((x) => x.close).at(-1);
  const higherEma20 = ema(higherCandles.map((x) => x.close), 20);
  const shortRsi = rsi(shortCandles.map((x) => x.close));
  const bullishTrend = close > ema20 && ema20 > ema50 && ema50 > ema200;
  const bearishTrend = close < ema20 && ema20 < ema50 && ema50 < ema200;
  const higherBull = higherClose > higherEma20;
  const higherBear = higherClose < higherEma20;
  const bullishMacd = currentMacd?.histogram > 0;
  const bearishMacd = currentMacd?.histogram < 0;
  const bullishRsi = currentRsi >= 50 && currentRsi <= 72;
  const bearishRsi = currentRsi >= 28 && currentRsi <= 50;
  const volumeConfirmed = volumeRatio !== null && volumeRatio >= 1.1;
  const structureBull =
    structure.bos === "BULLISH" ||
    structure.choch === "BULLISH" ||
    structure.liquiditySweep === "SELL_SIDE";
  const structureBear =
    structure.bos === "BEARISH" ||
    structure.choch === "BEARISH" ||
    structure.liquiditySweep === "BUY_SIDE";
  const fvgBull =
    structure.fairValueGap === "BULLISH" || structure.orderBlock === "BULLISH";
  const fvgBear =
    structure.fairValueGap === "BEARISH" || structure.orderBlock === "BEARISH";
  const bullishChecks = [
    [bullishTrend, 22, "EMA 20/50/200 bullish alignment"],
    [higherBull, 12, "Higher-timeframe trend is bullish"],
    [bullishMacd, 12, "MACD momentum is positive"],
    [bullishRsi, 8, `RSI ${fmt(currentRsi, 1)} supports long momentum`],
    [volumeConfirmed, 8, `Volume is ${fmt(volumeRatio, 2)}× its 20-bar average`],
    [structureBull, 12, `${structure.bos !== "NONE" ? "BOS " + structure.bos : structure.choch !== "NONE" ? "CHOCH " + structure.choch : "Sell-side liquidity sweep"} confirmation`],
    [fvgBull, 8, "Bullish fair-value-gap or order-block context"],
    [shortRsi !== null && shortRsi > 45 && shortRsi < 75, 6, "15m momentum confirms direction"],
  ];
  const bearishChecks = [
    [bearishTrend, 22, "EMA 20/50/200 bearish alignment"],
    [higherBear, 12, "Higher-timeframe trend is bearish"],
    [bearishMacd, 12, "MACD momentum is negative"],
    [bearishRsi, 8, `RSI ${fmt(currentRsi, 1)} supports short momentum`],
    [volumeConfirmed, 8, `Volume is ${fmt(volumeRatio, 2)}× its 20-bar average`],
    [structureBear, 12, `${structure.bos !== "NONE" ? "BOS " + structure.bos : structure.choch !== "NONE" ? "CHOCH " + structure.choch : "Buy-side liquidity sweep"} confirmation`],
    [fvgBear, 8, "Bearish fair-value-gap or order-block context"],
    [shortRsi !== null && shortRsi > 25 && shortRsi < 55, 6, "15m momentum confirms direction"],
  ];
  const score = (checks) => Math.min(100, checks.reduce((sum, [ok, points]) => sum + (ok ? points : 0), 0));
  const longScore = score(bullishChecks);
  const shortScore = score(bearishChecks);
  let direction = "NONE";
  let signalScore = Math.max(longScore, shortScore);
  let reasons = [];
  if (bullishTrend && higherBull && longScore > shortScore) {
    direction = "LONG";
    reasons = bullishChecks.filter(([ok]) => ok).map(([, , text]) => text);
  } else if (bearishTrend && higherBear && shortScore > longScore) {
    direction = "SHORT";
    reasons = bearishChecks.filter(([ok]) => ok).map(([, , text]) => text);
  } else {
    signalScore = Math.max(longScore, shortScore);
  }
  const trend = bullishTrend && higherBull ? "BULLISH" : bearishTrend && higherBear ? "BEARISH" : "MIXED";
  let stopLoss = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;
  let riskReward = null;
  if (direction !== "NONE" && atr && atr > 0) {
    const fallbackDistance = atr * 1.5;
    const swing = direction === "LONG" ? structure.lastSwingLow : structure.lastSwingHigh;
    let distance = fallbackDistance;
    if (finite(swing)) {
      const structureDistance = direction === "LONG" ? close - swing : swing - close;
      if (structureDistance > atr * 0.35 && structureDistance < atr * 3) {
        distance = Math.max(fallbackDistance, structureDistance + atr * 0.12);
      }
    }
    const settings = getCachedConfig();
    const rr3 = Math.max(2, Number(settings?.risk?.riskReward) || 3);
    const sign = direction === "LONG" ? 1 : -1;
    stopLoss = close - sign * distance;
    tp1 = close + sign * distance * 0.75;
    tp2 = close + sign * distance * 1.5;
    tp3 = close + sign * distance * rr3;
    riskReward = rr3;
  }
  return {
    trend,
    direction,
    score: signalScore,
    longScore,
    shortScore,
    reasons,
    ema20: fmt(ema20),
    ema50: fmt(ema50),
    ema200: fmt(ema200),
    rsi: fmt(currentRsi, 2),
    macd: currentMacd ? fmt(currentMacd.histogram, 8) : null,
    volumeRatio: volumeRatio === null ? null : fmt(volumeRatio, 2),
    atr: fmt(atr),
    support: structure.lastSwingLow,
    resistance: structure.lastSwingHigh,
    ...structure,
    stopLoss: stopLoss === null ? null : fmt(stopLoss),
    tp1: tp1 === null ? null : fmt(tp1),
    tp2: tp2 === null ? null : fmt(tp2),
    tp3: tp3 === null ? null : fmt(tp3),
    riskReward,
  };
}

let lastConfig = null;
async function getCachedConfig() {
  if (!lastConfig) lastConfig = await getConfig();
  return lastConfig;
}

function parseKlines(rows) {
  if (!Array.isArray(rows)) throw new Error("Empty Binance candle response");
  return rows.map((row) => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
  })).filter((c) => [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite));
}

async function loadCandles(symbol, interval, limit = 250) {
  const rows = await publicRequest("/fapi/v1/klines", { symbol, interval, limit });
  return parseKlines(rows);
}

function signalPayload(symbol, price, analysis, ticker = {}) {
  return {
    symbol,
    direction: analysis.direction,
    entry: price,
    stopLoss: analysis.stopLoss,
    tp1: analysis.tp1,
    tp2: analysis.tp2,
    tp3: analysis.tp3,
    riskReward: analysis.riskReward,
    score: analysis.score,
    trend: analysis.trend,
    reasons: analysis.reasons,
    changePercent: finite(ticker.priceChangePercent) ? Number(ticker.priceChangePercent) : null,
    quoteVolume: finite(ticker.quoteVolume) ? Number(ticker.quoteVolume) : null,
    createdAt: now(),
  };
}

async function analyseConfiguredSymbol(symbol, ticker) {
  const [candles15, candles1h, candles4h] = await Promise.all([
    loadCandles(symbol, "15m", 100),
    loadCandles(symbol, "1h", 250),
    loadCandles(symbol, "4h", 250),
  ]);
  if (candles1h.length < 200 || candles4h.length < 50 || candles15.length < 25) {
    throw new Error("Not enough live candle history to calculate indicators");
  }
  const price = markPrices.get(symbol) || Number(ticker.lastPrice) || candles1h.at(-1).close;
  const analysis = calculateAnalysis(candles1h, candles4h, candles15);
  const qualified =
    analysis.direction !== "NONE" &&
    analysis.score >= (await getConfig()).trading.minSignalScore;
  const marketItem = {
    symbol,
    price,
    changePercent: Number(ticker.priceChangePercent),
    quoteVolume: Number(ticker.quoteVolume),
    trend: analysis.trend,
    rsi: analysis.rsi,
    signal: qualified ? analysis.direction : "NONE",
    signalScore: analysis.score,
    reasons: analysis.reasons,
    analysis,
    updatedAt: now(),
  };
  return {
    item: marketItem,
    signal: qualified ? signalPayload(symbol, price, analysis, ticker) : null,
    candles: { "15m": candles15, "1h": candles1h, "4h": candles4h },
  };
}

export async function scanMarkets(force = false) {
  if (!force && marketCache.size && Date.now() - (scanMarkets.updatedAt || 0) < 12000) {
    return [...marketCache.values()];
  }
  if (scanPromise) return scanPromise;
  scanPromise = (async () => {
    const config = await getConfig();
    lastConfig = config;
    const tickers = await publicRequest("/fapi/v1/ticker/24hr");
    if (!Array.isArray(tickers)) throw new Error("Binance market ticker response was empty");
    const tickerMap = new Map(
      tickers
        .filter((item) => typeof item.symbol === "string" && item.symbol.endsWith("USDT"))
        .map((item) => [item.symbol, item]),
    );
    const universe = [...tickerMap.values()].map((ticker) => ({
      symbol: ticker.symbol,
      price: markPrices.get(ticker.symbol) || Number(ticker.lastPrice),
      changePercent: Number(ticker.priceChangePercent),
      quoteVolume: Number(ticker.quoteVolume),
      trend: "UNANALYZED",
      rsi: null,
      signal: "NONE",
      signalScore: null,
      reasons: [],
      updatedAt: now(),
    }));
    const analyzed = await Promise.allSettled(
      config.trading.pairs.map(async (symbol) => {
        const ticker = tickerMap.get(symbol);
        if (!ticker) throw new Error(`${symbol} is not an active USDT Futures market`);
        return analyseConfiguredSymbol(symbol, ticker);
      }),
    );
    let latestSignal = null;
    const newSignals = [];
    const analysisErrors = [];
    for (let i = 0; i < analyzed.length; i += 1) {
      const result = analyzed[i];
      if (result.status === "rejected") {
        analysisErrors.push(`${config.trading.pairs[i]}: ${safeError(result.reason)}`);
        continue;
      }
      const { item, signal } = result.value;
      const index = universe.findIndex((x) => x.symbol === item.symbol);
      if (index >= 0) universe[index] = item;
      marketCache.set(item.symbol, item);
      if (signal) newSignals.push(signal);
    }
    universe.sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0));
    marketCache.clear();
    for (const item of universe) marketCache.set(item.symbol, item);
    const saved = await updateData((data) => {
      for (const signal of newSignals) {
        const duplicate = data.signals.find(
          (old) =>
            old.symbol === signal.symbol &&
            old.direction === signal.direction &&
            Date.now() - Date.parse(old.createdAt) < 15 * 60 * 1000,
        );
        if (!duplicate) {
          signal.id = `${signal.symbol}-${Date.now()}`;
          data.signals.unshift(signal);
          latestSignal = signal;
        } else {
          latestSignal = duplicate;
        }
      }
      data.signals = data.signals.slice(0, 500);
      data.bot.lastMarketScan = now();
      if (latestSignal) data.bot.lastSignal = latestSignal;
      if (analysisErrors.length) data.bot.lastError = analysisErrors.slice(0, 3).join("; ");
    });
    void saved;
    for (const signal of newSignals) {
      await appendLog("info", "Signal detected", `${signal.symbol} ${signal.direction} score ${signal.score}/100`);
    }
    if (analysisErrors.length) {
      await appendLog("warn", "Market analysis incomplete", analysisErrors.slice(0, 3).join("; "));
    }
    scanMarkets.updatedAt = Date.now();
    return universe;
  })()
    .catch(async (error) => {
      await appendLog("error", "Market scan failed", safeError(error));
      await updateData((data) => {
        data.bot.lastError = safeError(error);
      });
      throw error;
    })
    .finally(() => {
      scanPromise = null;
    });
  return scanPromise;
}

export async function getMarketDetail(rawSymbol) {
  const symbol = String(rawSymbol || "").toUpperCase();
  if (!/^[A-Z0-9]{4,20}USDT$/.test(symbol)) throw new Error("Invalid USDT Futures symbol");
  const markets = await scanMarkets();
  const market = markets.find((item) => item.symbol === symbol);
  if (!market) throw new Error("Symbol is not an available live USDT Futures market");
  const [candles15, candles1h, candles4h] = await Promise.all([
    loadCandles(symbol, "15m", 100),
    loadCandles(symbol, "1h", 250),
    loadCandles(symbol, "4h", 250),
  ]);
  const analysis = calculateAnalysis(candles1h, candles4h, candles15);
  const qualified =
    analysis.direction !== "NONE" &&
    analysis.score >= (await getConfig()).trading.minSignalScore;
  return {
    symbol,
    price: markPrices.get(symbol) || market.price,
    changePercent: market.changePercent,
    quoteVolume: market.quoteVolume,
    trend: analysis.trend,
    rsi: analysis.rsi,
    signal: qualified ? analysis.direction : "NONE",
    signalScore: analysis.score,
    analysis,
    candles: candles1h.slice(-80).map((c) => ({
      time: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
  };
}

function safeError(error) {
  const message = error instanceof Error ? error.message : "Unexpected Binance error";
  return message.replace(/(?:apiKey|apiSecret|signature)=([^&\s]+)/gi, "$1=[redacted]").slice(0, 300);
}

export async function testConnection() {
  try {
    const balances = await binanceRequest("GET", "/fapi/v2/balance", {}, true);
    if (!Array.isArray(balances)) throw new Error("Binance returned an invalid balance response");
    const usdt = balances.find((row) => row.asset === "USDT");
    const result = {
      connected: true,
      mode: (await getConfig()).binance.mode,
      message: "Signed Futures account check succeeded",
      walletBalance: usdt ? Number(usdt.balance) : null,
      availableBalance: usdt ? Number(usdt.availableBalance) : null,
      checkedAt: now(),
    };
    await updateData((data) => {
      data.bot.lastBalanceFetch = result.checkedAt;
      data.bot.lastError = null;
    });
    await appendLog("info", "Binance connected", `Signed account check succeeded on ${result.mode}`);
    return result;
  } catch (error) {
    await appendLog("error", "Binance API error", safeError(error));
    await updateData((data) => {
      data.bot.lastError = safeError(error);
    });
    return {
      connected: false,
      mode: (await getConfig()).binance.mode,
      message: safeError(error),
      walletBalance: null,
      availableBalance: null,
      checkedAt: now(),
    };
  }
}

export async function getAccountSnapshot() {
  const [balances, positions] = await Promise.all([
    binanceRequest("GET", "/fapi/v2/balance", {}, true),
    binanceRequest("GET", "/fapi/v2/positionRisk", {}, true),
  ]);
  if (!Array.isArray(balances) || !Array.isArray(positions)) {
    throw new Error("Binance returned incomplete Futures account data");
  }
  const usdt = balances.find((row) => row.asset === "USDT");
  const openPositions = positions.filter((row) => Math.abs(Number(row.positionAmt)) > 0);
  const walletBalance = usdt && finite(usdt.balance) ? Number(usdt.balance) : null;
  const availableBalance = usdt && finite(usdt.availableBalance) ? Number(usdt.availableBalance) : null;
  const unrealizedPnl = openPositions.reduce((sum, row) => sum + Number(row.unRealizedProfit || 0), 0);
  const timestamp = now();
  await updateData((data) => {
    data.bot.lastBalanceFetch = timestamp;
  });
  return {
    connected: true,
    mode: (await getConfig()).binance.mode,
    walletBalance,
    availableBalance,
    unrealizedPnl,
    positions: openPositions.map((row) => ({
      symbol: row.symbol,
      positionAmt: Number(row.positionAmt),
      entryPrice: Number(row.entryPrice),
      markPrice: Number(row.markPrice),
      unRealizedProfit: Number(row.unRealizedProfit),
      leverage: Number(row.leverage),
      positionInitialMargin: Number(row.positionInitialMargin),
    })),
    checkedAt: timestamp,
  };
}

export async function realizedPnl(startTime, symbol) {
  const cacheKey = `${startTime}:${symbol || "ALL"}`;
  const cached = incomeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  const rows = await binanceRequest(
    "GET",
    "/fapi/v1/income",
    { incomeType: "REALIZED_PNL", startTime, symbol, limit: 1000 },
    true,
  );
  if (!Array.isArray(rows)) throw new Error("Binance returned an invalid realized PNL response");
  const value = rows.reduce((sum, row) => sum + Number(row.income || 0), 0);
  incomeCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export async function getExchangeInfo() {
  const config = await getConfig();
  const cache = exchangeInfoCache.get(config.binance.mode);
  if (cache && Date.now() - cache.at < 60 * 60 * 1000) return cache.value;
  const value = await publicRequest("/fapi/v1/exchangeInfo");
  if (!Array.isArray(value?.symbols)) throw new Error("Binance exchange information was incomplete");
  exchangeInfoCache.set(config.binance.mode, { at: Date.now(), value });
  return value;
}

function precisionFloor(value, step) {
  if (!step || step <= 0) return value;
  const decimals = (String(step).split(".")[1] || "").length;
  return Number((Math.floor(value / step + 1e-10) * step).toFixed(decimals));
}

function precisionRound(value, tick) {
  if (!tick || tick <= 0) return value;
  const decimals = (String(tick).split(".")[1] || "").length;
  return Number((Math.round(value / tick) * tick).toFixed(decimals));
}

export async function executeSignal(signal, ownerId = null) {
  const config = await getConfig();
  if (!config.trading.enabled) throw new Error("Auto trading is disabled in config.json");
  if (config.binance.mode !== "testnet" && config.binance.mode !== "mainnet") {
    throw new Error("Invalid Binance mode");
  }
  if (!signal || !["LONG", "SHORT"].includes(signal.direction)) {
    throw new Error("No qualified direction for this signal");
  }
  const account = await getAccountSnapshot();
  if (!account.walletBalance || account.walletBalance <= 0 || !account.availableBalance) {
    throw new Error("Binance Futures USDT balance is empty or unavailable");
  }
  const state = await getData();
  const openTrades = state.trades.filter((trade) => trade.status === "OPEN");
  if (account.positions.length >= config.risk.maxOpenTrades) throw new Error("Maximum open trade limit reached");
  if (account.positions.some((position) => position.symbol === signal.symbol)) {
    throw new Error(`Binance already has an open position for ${signal.symbol}`);
  }
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const closedToday = state.trades.filter(
    (trade) => trade.closedAt && Date.parse(trade.closedAt) >= todayStart.getTime(),
  );
  if (closedToday.length + openTrades.length >= config.risk.maxDailyTrades) {
    throw new Error("Maximum daily trade limit reached");
  }
  let dailyPnl;
  try {
    dailyPnl = await realizedPnl(todayStart.getTime());
  } catch (error) {
    throw new Error(`Could not verify Binance daily realized PNL; trading is paused: ${safeError(error)}`);
  }
  if (dailyPnl <= -(account.walletBalance * config.risk.maxDailyLoss) / 100) {
    throw new Error("Daily loss limit reached; new orders are blocked");
  }
  if (
    !finite(signal.entry) ||
    !finite(signal.stopLoss) ||
    !finite(signal.tp1) ||
    !finite(signal.tp2) ||
    !finite(signal.tp3)
  ) throw new Error("Signal has invalid entry or protective prices");
  const isLong = signal.direction === "LONG";
  if (
    (isLong && !(signal.stopLoss < signal.entry && signal.entry < signal.tp1 && signal.tp1 < signal.tp2 && signal.tp2 < signal.tp3)) ||
    (!isLong && !(signal.stopLoss > signal.entry && signal.entry > signal.tp1 && signal.tp1 > signal.tp2 && signal.tp2 > signal.tp3))
  ) throw new Error("Stop loss or take-profit levels are not valid for this direction");
  const duplicate = openTrades.find((trade) => trade.symbol === signal.symbol);
  if (duplicate) throw new Error(`An open local trade already exists for ${signal.symbol}`);
  const info = await getExchangeInfo();
  const market = info.symbols.find((row) => row.symbol === signal.symbol && row.status === "TRADING");
  if (!market) throw new Error("Symbol is not currently tradable on Binance Futures");
  const lotFilter = market.filters.find((filter) => filter.filterType === "LOT_SIZE");
  const priceFilter = market.filters.find((filter) => filter.filterType === "PRICE_FILTER");
  const minNotionalFilter = market.filters.find((filter) => filter.filterType === "MIN_NOTIONAL");
  const stepSize = Number(lotFilter?.stepSize);
  const minQty = Number(lotFilter?.minQty);
  const tickSize = Number(priceFilter?.tickSize);
  const stopLoss = precisionRound(Number(signal.stopLoss), tickSize);
  const tp1 = precisionRound(Number(signal.tp1), tickSize);
  const tp2 = precisionRound(Number(signal.tp2), tickSize);
  const tp3 = precisionRound(Number(signal.tp3), tickSize);
  const entry = Number(signal.entry);
  const unitRisk = Math.abs(entry - stopLoss);
  if (!unitRisk || ![stopLoss, tp1, tp2, tp3].every((n) => n > 0)) {
    throw new Error("Invalid stop or take-profit precision for this market");
  }
  const riskBudget = account.walletBalance * (config.risk.riskPercent / 100);
  const quantity = precisionFloor(riskBudget / unitRisk, stepSize);
  const minNotional = Number(minNotionalFilter?.notional || 5);
  if (quantity < minQty || quantity * entry < minNotional) {
    throw new Error("Risk-based position size is below the exchange minimum");
  }
  if (quantity * entry / config.risk.leverage > account.availableBalance) {
    throw new Error("Insufficient available margin for the risk-sized position");
  }
  const side = isLong ? "BUY" : "SELL";
  const exitSide = isLong ? "SELL" : "BUY";
  await binanceRequest("POST", "/fapi/v1/leverage", {
    symbol: signal.symbol,
    leverage: config.risk.leverage,
  }, true);
  const entryOrder = await binanceRequest("POST", "/fapi/v1/order", {
    symbol: signal.symbol,
    side,
    type: "MARKET",
    quantity,
    newOrderRespType: "RESULT",
  }, true);
  const filledQty = Number(entryOrder.executedQty);
  let filledEntry = Number(entryOrder.avgPrice);
  if (!filledEntry) {
    try {
      const livePosition = await binanceRequest("GET", "/fapi/v2/positionRisk", { symbol: signal.symbol }, true);
      filledEntry = Number(livePosition?.find((row) => row.symbol === signal.symbol)?.entryPrice);
    } catch (error) {
      if (filledQty > 0) {
        await binanceRequest("POST", "/fapi/v1/order", {
          symbol: signal.symbol,
          side: isLong ? "SELL" : "BUY",
          type: "MARKET",
          quantity: filledQty,
          reduceOnly: "true",
          newOrderRespType: "RESULT",
        }, true).catch(async (closeError) => {
          await appendLog("error", "URGENT: entry fill unknown and emergency close failed", `${signal.symbol}: ${safeError(closeError)}`);
        });
      }
      throw new Error(`Could not verify the actual Binance entry price; emergency close attempted: ${safeError(error)}`);
    }
  }
  if (!filledQty || !filledEntry) {
    if (filledQty > 0) {
      await binanceRequest("POST", "/fapi/v1/order", {
        symbol: signal.symbol,
        side: isLong ? "SELL" : "BUY",
        type: "MARKET",
        quantity: filledQty,
        reduceOnly: "true",
        newOrderRespType: "RESULT",
      }, true).catch(async (closeError) => {
        await appendLog("error", "URGENT: invalid entry fill and emergency close failed", `${signal.symbol}: ${safeError(closeError)}`);
      });
    }
    throw new Error("Binance did not confirm the entry fill; emergency close attempted");
  }
  const qty1 = precisionFloor(filledQty * 0.4, stepSize);
  const qty2 = precisionFloor(filledQty * 0.3, stepSize);
  const qty3 = precisionFloor(filledQty - qty1 - qty2, stepSize);
  const protections = [];
  try {
    const stop = await binanceRequest("POST", "/fapi/v1/order", {
      symbol: signal.symbol,
      side: exitSide,
      type: "STOP_MARKET",
      stopPrice: stopLoss,
      closePosition: "true",
      workingType: "MARK_PRICE",
    }, true);
    protections.push(stop);
    for (const [target, qty] of [[tp1, qty1], [tp2, qty2], [tp3, qty3]]) {
      if (qty < minQty || qty <= 0) throw new Error("Position is too small to place all three take-profit orders");
      const order = await binanceRequest("POST", "/fapi/v1/order", {
        symbol: signal.symbol,
        side: exitSide,
        type: "TAKE_PROFIT_MARKET",
        stopPrice: target,
        quantity: qty,
        reduceOnly: "true",
        workingType: "MARK_PRICE",
      }, true);
      protections.push(order);
    }
    const liveOrders = await binanceRequest("GET", "/fapi/v1/openOrders", { symbol: signal.symbol }, true);
    if (!Array.isArray(liveOrders)) throw new Error("Could not verify protective orders on Binance");
    const active = protections.every((order) =>
      liveOrders.some((live) => String(live.orderId) === String(order.orderId)),
    );
    if (!active || protections.length !== 4) {
      throw new Error("Binance did not confirm all four protective orders");
    }
  } catch (error) {
    for (const order of protections) {
      await binanceRequest("DELETE", "/fapi/v1/order", {
        symbol: signal.symbol,
        orderId: order.orderId,
      }, true).catch(() => {});
    }
    try {
      await binanceRequest("POST", "/fapi/v1/order", {
        symbol: signal.symbol,
        side: exitSide,
        type: "MARKET",
        quantity: filledQty,
        reduceOnly: "true",
        newOrderRespType: "RESULT",
      }, true);
      await appendLog("error", "Protection failed; position emergency-closed", `${signal.symbol}: ${safeError(error)}`);
    } catch (closeError) {
      await appendLog("error", "URGENT: protection and emergency close failed", `${signal.symbol}: ${safeError(closeError)}`);
    }
    throw new Error(`Protective orders were not verified; emergency close attempted: ${safeError(error)}`);
  }
  const trade = {
    id: `${signal.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ownerId,
    symbol: signal.symbol,
    direction: signal.direction,
    entry: filledEntry,
    markPrice: markPrices.get(signal.symbol) || filledEntry,
    quantity: filledQty,
    remainingQuantity: filledQty,
    leverage: config.risk.leverage,
    stopLoss,
    tp1,
    tp2,
    tp3,
    upnl: 0,
    pnlPercent: 0,
    status: "OPEN",
    protected: true,
    protectionOrderIds: protections.map((order) => order.orderId),
    entryOrderId: entryOrder.orderId,
    tpHits: [],
    signalScore: signal.score,
    openedAt: now(),
    closedAt: null,
    closedReason: null,
    realizedPnl: null,
  };
  await updateData((data) => {
    data.trades.unshift(trade);
    data.bot.lastExecution = trade.openedAt;
  });
  await appendLog("info", "Trade opened", `${trade.symbol} ${trade.direction}; entry ${trade.entry}; protection confirmed`);
  await appendLog("info", "SL and TP orders placed", `${trade.symbol}; four protective orders verified by Binance`);
  return trade;
}

export async function closeTrade(tradeId) {
  const state = await getData();
  const trade = state.trades.find((item) => item.id === tradeId);
  if (!trade) throw new Error("Trade not found");
  if (trade.status !== "OPEN") return trade;
  const positions = await binanceRequest("GET", "/fapi/v2/positionRisk", { symbol: trade.symbol }, true);
  if (!Array.isArray(positions)) throw new Error("Could not verify the live Binance position");
  const position = positions.find((item) => item.symbol === trade.symbol);
  const positionAmt = Number(position?.positionAmt || 0);
  if (positionAmt !== 0) {
    await binanceRequest("POST", "/fapi/v1/order", {
      symbol: trade.symbol,
      side: positionAmt > 0 ? "SELL" : "BUY",
      type: "MARKET",
      quantity: Math.abs(positionAmt),
      reduceOnly: "true",
      newOrderRespType: "RESULT",
    }, true);
  }
  const openOrders = await binanceRequest("GET", "/fapi/v1/openOrders", { symbol: trade.symbol }, true);
  if (Array.isArray(openOrders)) {
    for (const order of openOrders) {
      if (trade.protectionOrderIds?.some((id) => String(id) === String(order.orderId))) {
        await binanceRequest("DELETE", "/fapi/v1/order", {
          symbol: trade.symbol,
          orderId: order.orderId,
        }, true).catch(() => {});
      }
    }
  }
  let pnl = null;
  try {
    pnl = await realizedPnl(Date.parse(trade.openedAt), trade.symbol);
  } catch {}
  const updated = await updateData((data) => {
    const local = data.trades.find((item) => item.id === tradeId);
    if (!local) return null;
    local.status = "CLOSED";
    local.protected = false;
    local.closedAt = now();
    local.closedReason = "MANUAL";
    local.realizedPnl = pnl;
    return local;
  });
  await appendLog("info", "Trade closed", `${trade.symbol} manually closed through Binance`);
  return updated;
}

export async function manageTrade(tradeId, levels) {
  const state = await getData();
  const trade = state.trades.find((item) => item.id === tradeId);
  if (!trade || trade.status !== "OPEN") throw new Error("Open trade not found");
  const values = [levels.stopLoss, levels.tp1, levels.tp2, levels.tp3].map(Number);
  if (!values.every((n) => Number.isFinite(n) && n > 0)) throw new Error("All protection levels must be positive prices");
  const isLong = trade.direction === "LONG";
  if (
    (isLong && !(values[0] < trade.markPrice && values[1] > trade.markPrice && values[1] < values[2] && values[2] < values[3])) ||
    (!isLong && !(values[0] > trade.markPrice && values[1] < trade.markPrice && values[1] > values[2] && values[2] > values[3]))
  ) throw new Error("Levels must be correctly ordered around the current mark price");
  const info = await getExchangeInfo();
  const symbolInfo = info.symbols.find((row) => row.symbol === trade.symbol);
  if (!symbolInfo) throw new Error("Live symbol rules unavailable");
  const tick = Number(symbolInfo.filters.find((f) => f.filterType === "PRICE_FILTER")?.tickSize);
  const lot = Number(symbolInfo.filters.find((f) => f.filterType === "LOT_SIZE")?.stepSize);
  const levelsRounded = values.map((n) => precisionRound(n, tick));
  const quantities = [
    precisionFloor(trade.remainingQuantity * 0.4, lot),
    precisionFloor(trade.remainingQuantity * 0.3, lot),
    precisionFloor(trade.remainingQuantity * 0.3, lot),
  ];
  const side = isLong ? "SELL" : "BUY";
  const created = [];
  try {
    created.push(await binanceRequest("POST", "/fapi/v1/order", {
      symbol: trade.symbol,
      side,
      type: "STOP_MARKET",
      stopPrice: levelsRounded[0],
      closePosition: "true",
      workingType: "MARK_PRICE",
    }, true));
    for (let i = 0; i < 3; i += 1) {
      created.push(await binanceRequest("POST", "/fapi/v1/order", {
        symbol: trade.symbol,
        side,
        type: "TAKE_PROFIT_MARKET",
        stopPrice: levelsRounded[i + 1],
        quantity: quantities[i],
        reduceOnly: "true",
        workingType: "MARK_PRICE",
      }, true));
    }
    const activeOrders = await binanceRequest("GET", "/fapi/v1/openOrders", { symbol: trade.symbol }, true);
    if (!Array.isArray(activeOrders) || !created.every((order) =>
      activeOrders.some((live) => String(live.orderId) === String(order.orderId)),
    )) throw new Error("Binance did not confirm the replacement protection set");
  } catch (error) {
    for (const order of created) {
      await binanceRequest("DELETE", "/fapi/v1/order", {
        symbol: trade.symbol,
        orderId: order.orderId,
      }, true).catch(() => {});
    }
    throw new Error(`New protection was not verified; existing protection was left unchanged where possible: ${safeError(error)}`);
  }
  for (const orderId of trade.protectionOrderIds || []) {
    await binanceRequest("DELETE", "/fapi/v1/order", { symbol: trade.symbol, orderId }, true).catch(() => {});
  }
  const saved = await updateData((data) => {
    const current = data.trades.find((item) => item.id === tradeId);
    if (!current) return null;
    [current.stopLoss, current.tp1, current.tp2, current.tp3] = levelsRounded;
    current.protectionOrderIds = created.map((order) => order.orderId);
    current.protected = true;
    return current;
  });
  await appendLog("info", "Trade protection updated", `${trade.symbol} protective levels re-verified`);
  return saved;
}

async function refreshOpenTrades() {
  const state = await getData();
  const open = state.trades.filter((trade) => trade.status === "OPEN");
  if (!open.length) return;
  const positions = await binanceRequest("GET", "/fapi/v2/positionRisk", {}, true);
  if (!Array.isArray(positions)) throw new Error("Could not refresh open positions");
  const bySymbol = new Map(positions.map((row) => [row.symbol, row]));
  const currentPrices = new Map();
  for (const trade of open) {
    if (!markPrices.has(trade.symbol)) {
      try {
        const mark = await publicRequest("/fapi/v1/premiumIndex", { symbol: trade.symbol });
        if (finite(mark?.markPrice)) markPrices.set(trade.symbol, Number(mark.markPrice));
      } catch {}
    }
    const position = bySymbol.get(trade.symbol);
    const price = markPrices.get(trade.symbol) || Number(position?.markPrice) || null;
    if (price) currentPrices.set(trade.id, price);
    const amount = Math.abs(Number(position?.positionAmt || 0));
    if (!position || amount === 0) {
      const hitStop = price && (trade.direction === "LONG" ? price <= trade.stopLoss : price >= trade.stopLoss);
      const hitTp3 = price && (trade.direction === "LONG" ? price >= trade.tp3 : price <= trade.tp3);
      let pnl = null;
      try {
        pnl = await realizedPnl(Date.parse(trade.openedAt), trade.symbol);
      } catch {}
      for (const orderId of trade.protectionOrderIds || []) {
        await binanceRequest("DELETE", "/fapi/v1/order", {
          symbol: trade.symbol,
          orderId,
        }, true).catch(() => {});
      }
      await updateData((data) => {
        const current = data.trades.find((item) => item.id === trade.id);
        if (!current || current.status !== "OPEN") return;
        current.status = hitStop ? "LOSS" : hitTp3 ? "TP3" : "CLOSED";
        current.protected = false;
        current.closedAt = now();
        current.closedReason = hitStop ? "STOP_LOSS" : hitTp3 ? "TP3" : "EXTERNAL";
        current.realizedPnl = pnl;
        current.remainingQuantity = 0;
      });
      await appendLog(
        hitStop ? "warn" : "info",
        hitStop ? "SL hit" : hitTp3 ? "TP3 hit" : "Trade closed externally",
        `${trade.symbol}; exchange position is flat`,
      );
      continue;
    }
    const oldRemaining = Number(trade.remainingQuantity ?? trade.quantity);
    const reduced = amount < oldRemaining - Math.max(oldRemaining * 0.0001, 1e-12);
    const mark = price || Number(position?.markPrice);
    const crossed = (level) =>
      trade.direction === "LONG" ? mark >= level : mark <= level;
    let hitTarget = null;
    if (reduced) {
      for (const [n, level] of [[1, trade.tp1], [2, trade.tp2], [3, trade.tp3]]) {
        if (!trade.tpHits?.includes(n) && crossed(level)) hitTarget = n;
      }
    }
    const initialMargin = Number(position?.positionInitialMargin) || 0;
    const upnl = Number(position?.unRealizedProfit);
    const entry = Number(position?.entryPrice) || trade.entry;
    await updateData((data) => {
      const current = data.trades.find((item) => item.id === trade.id);
      if (!current || current.status !== "OPEN") return;
      current.markPrice = Number(mark);
      current.remainingQuantity = amount;
      current.upnl = Number.isFinite(upnl) ? upnl : null;
      current.pnlPercent = initialMargin > 0 && Number.isFinite(upnl) ? (upnl / initialMargin) * 100 : null;
      if (hitTarget) current.tpHits = [...new Set([...(current.tpHits || []), hitTarget])];
      if (hitTarget === 1 && current.tpHits.includes(1) && current.moveStopToBreakEvenAfterTp1) {
        current.pendingBreakEven = true;
      }
      current.lastPositionCheck = now();
      current.entry = entry;
      return current;
    });
    if (hitTarget) await appendLog("info", `TP${hitTarget} hit`, `${trade.symbol}; Binance position quantity reduced`);
  }
  void currentPrices;
}

async function runWorkerCycle() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    await scanMarkets(true);
    const config = await getConfig();
    const before = await getData();
    const hasOpenTrades = before.trades.some((trade) => trade.status === "OPEN");
    await updateData((data) => {
      data.bot.workerStatus = config.trading.enabled
        ? "running"
        : hasOpenTrades
          ? "managing-open-positions"
          : data.bot.running
            ? "monitoring"
            : "stopped";
      data.bot.lastError = null;
    });
    if (config.trading.enabled) {
      const state = before;
      const openSymbols = new Set(state.trades.filter((trade) => trade.status === "OPEN").map((t) => t.symbol));
      const freshSignals = state.signals.filter(
        (signal) =>
          signal.score >= config.trading.minSignalScore &&
          Date.now() - Date.parse(signal.createdAt) < config.trading.scanIntervalSeconds * 1500 &&
          !openSymbols.has(signal.symbol),
      );
      for (const signal of freshSignals) {
        try {
          await executeSignal(signal, state.bot.ownerId || null);
          openSymbols.add(signal.symbol);
        } catch (error) {
          await appendLog("warn", "Trade skipped", `${signal.symbol}: ${safeError(error)}`);
        }
      }
    }
    if (hasOpenTrades && config.binance.apiKey && config.binance.apiSecret) {
      await refreshOpenTrades();
    }
    const after = await getData();
    if (!config.trading.enabled && !after.bot.running && !after.trades.some((trade) => trade.status === "OPEN")) {
      if (workerTimer) clearInterval(workerTimer);
      workerTimer = null;
      await updateData((data) => {
        data.bot.workerStatus = "stopped";
      });
    }
  } catch (error) {
    await appendLog("error", "Background worker error", safeError(error));
    await updateData((data) => {
      data.bot.lastError = safeError(error);
      data.bot.workerStatus = "error";
    });
  } finally {
    workerBusy = false;
  }
}

export async function startWorker(ownerId) {
  if (workerTimer) {
    await updateData((data) => {
      data.bot.running = true;
      data.bot.ownerId = ownerId || data.bot.ownerId || null;
      data.bot.workerStatus = "starting";
    });
    return;
  }
  const config = await getConfig();
  if (!config.binance.apiKey || !config.binance.apiSecret) {
    throw new Error("Add Binance API credentials in config.json before starting the trading worker");
  }
  const test = await testConnection();
  if (!test.connected) throw new Error(`Binance connection failed: ${test.message}`);
  await updateData((data) => {
    data.bot.running = true;
    data.bot.workerStatus = "starting";
    data.bot.lastError = null;
    data.bot.ownerId = ownerId || null;
  });
  await appendLog("info", "Background worker started", `Live ${config.binance.mode} market monitoring enabled`);
  workerTimer = setInterval(() => void runWorkerCycle(), config.trading.scanIntervalSeconds * 1000);
  workerTimer.unref?.();
  await runWorkerCycle();
}

export async function stopWorker() {
  await updateConfig((config) => {
    config.trading.enabled = false;
  });
  const current = await getData();
  const hasOpenTrades = current.trades.some((trade) => trade.status === "OPEN");
  await updateData((data) => {
    data.bot.running = false;
    data.bot.workerStatus = hasOpenTrades ? "managing-open-positions" : "stopped";
  });
  if (hasOpenTrades && !workerTimer) {
    workerTimer = setInterval(() => void runWorkerCycle(), (await getConfig()).trading.scanIntervalSeconds * 1000);
    workerTimer.unref?.();
  } else if (!hasOpenTrades && workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  await appendLog("info", "Auto trading stopped", hasOpenTrades
    ? "New entries disabled; backend continues monitoring open positions and exchange protections"
    : "New entries disabled; no open positions require monitoring");
}

function streamBase(config) {
  return config.binance.websocketUrls[config.binance.mode];
}

async function updateSocketStatus(status, message) {
  await updateData((data) => {
    data.bot.websocketStatus = status;
  });
  await appendLog(status === "CONNECTED" ? "info" : "warn", `WebSocket ${status.toLowerCase()}`, message);
}

function openMarketSocket() {
  void (async () => {
    const config = await getConfig();
    const WS = globalThis.WebSocket;
    if (typeof WS !== "function") {
      await updateSocketStatus("UNAVAILABLE", "This Node.js runtime does not provide a WebSocket client");
      return;
    }
    const streams = normalizePairs(config.trading.pairs)
      .map((symbol) => `${symbol.toLowerCase()}@markPrice@1s`)
      .join("/");
    try {
      ws = new WS(`${streamBase(config)}?streams=${streams}`);
      ws.addEventListener("open", () => {
        wsBackoff = 1000;
        void updateSocketStatus("CONNECTED", `Connected to ${config.binance.mode} mark-price stream`);
      });
      ws.addEventListener("message", (event) => {
        try {
          const packet = JSON.parse(String(event.data));
          const data = packet.data || packet;
          if (data.s && finite(data.p)) markPrices.set(data.s, Number(data.p));
        } catch {}
      });
      ws.addEventListener("error", () => {
        void updateSocketStatus("DISCONNECTED", "Binance market WebSocket reported an error");
      });
      ws.addEventListener("close", () => {
        void updateSocketStatus("DISCONNECTED", "Binance market WebSocket closed; reconnect scheduled");
        scheduleSocketReconnect();
      });
    } catch (error) {
      await updateSocketStatus("DISCONNECTED", safeError(error));
      scheduleSocketReconnect();
    }
  })();
}

function scheduleSocketReconnect() {
  if (wsRetry) return;
  wsRetry = setTimeout(() => {
    wsRetry = null;
    wsBackoff = Math.min(30000, wsBackoff * 2);
    openMarketSocket();
  }, wsBackoff);
  wsRetry.unref?.();
}

export async function restartMarketSocket() {
  if (wsRetry) clearTimeout(wsRetry);
  wsRetry = null;
  try {
    ws?.close();
  } catch {}
  ws = null;
  openMarketSocket();
}

export async function startBackgroundServices() {
  await import("./store.js").then((module) => module.ensureFiles());
  openMarketSocket();
  const state = await getData();
  if (state.bot.running || state.trades.some((trade) => trade.status === "OPEN")) {
    const config = await getConfig();
    workerTimer = setInterval(() => void runWorkerCycle(), config.trading.scanIntervalSeconds * 1000);
    workerTimer.unref?.();
    void runWorkerCycle();
  }
}

export async function setAdminSettings(input) {
  const data = await getData();
  const openTrades = data.trades.filter((trade) => trade.status === "OPEN").length;
  if (input.mode && input.mode !== (await getConfig()).binance.mode && openTrades > 0) {
    throw new Error("Close all tracked open trades before switching Binance environments");
  }
  const config = await updateConfig((current) => {
    if (input.mode) current.binance.mode = input.mode;
    for (const key of ["riskPercent", "maxOpenTrades", "leverage", "riskReward", "maxDailyLoss", "maxDailyTrades"]) {
      if (input[key] !== undefined) current.risk[key] = input[key];
    }
    for (const key of ["scanIntervalSeconds", "minSignalScore"]) {
      if (input[key] !== undefined) current.trading[key] = input[key];
    }
    if (input.autoTradingEnabled !== undefined) current.trading.enabled = input.autoTradingEnabled;
    if (input.pairs) current.trading.pairs = normalizePairs(input.pairs);
  });
  if (input.mode || input.pairs) {
    marketCache.clear();
    await restartMarketSocket();
  }
  if (workerTimer && input.scanIntervalSeconds !== undefined) {
    clearInterval(workerTimer);
    workerTimer = setInterval(() => void runWorkerCycle(), config.trading.scanIntervalSeconds * 1000);
    workerTimer.unref?.();
  }
  return config;
}

export function currentPrice(symbol) {
  return markPrices.get(symbol) || null;
}

