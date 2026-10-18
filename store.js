import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const current = process.cwd();
const APP_DIR = existsSync(path.join(current, "config.json"))
  ? current
  : path.resolve(current, "../binance-futures");
const CONFIG_PATH = path.join(APP_DIR, "config.json");
const DATA_PATH = path.join(APP_DIR, "data.json");
const CONFIG_TEMPLATE = path.join(APP_DIR, "config.example.json");
const DATA_TEMPLATE = path.join(APP_DIR, "data.example.json");

const defaultConfig = {
  binance: {
    apiKey: "",
    apiSecret: "",
    mode: "testnet",
    urls: {
      testnet: "https://testnet.binancefuture.com",
      mainnet: "https://fapi.binance.com",
    },
    websocketUrls: {
      testnet: "wss://stream.binancefuture.com/stream",
      mainnet: "wss://fstream.binance.com/stream",
    },
  },
  admin: { email: "" },
  risk: {
    riskPercent: 0.5,
    maxOpenTrades: 2,
    leverage: 3,
    riskReward: 3,
    maxDailyLoss: 2,
    maxDailyTrades: 5,
  },
  trading: {
    enabled: false,
    scanIntervalSeconds: 60,
    minSignalScore: 70,
    moveStopToBreakEvenAfterTp1: false,
    pairs: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"],
    timeframes: ["15m", "1h", "4h"],
  },
};

const defaultState = () => ({
  version: 1,
  users: [],
  sessions: [],
  trades: [],
  signals: [],
  logs: [],
  bot: {
    running: false,
    workerStatus: "stopped",
    websocketStatus: "DISCONNECTED",
    lastMarketScan: null,
    lastSignal: null,
    lastBalanceFetch: null,
    lastExecution: null,
    lastError: null,
  },
});

let dataQueue = Promise.resolve();
let configQueue = Promise.resolve();
let initialized = false;

function isValidBinanceUrl(value, websocket = false) {
  try {
    const url = new URL(value);
    return (
      url.protocol === (websocket ? "wss:" : "https:") &&
      (url.hostname === "binance.com" ||
        url.hostname.endsWith(".binance.com") ||
        url.hostname === "binancefuture.com" ||
        url.hostname.endsWith(".binancefuture.com")) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function mergeConfig(input) {
  const config = structuredClone(defaultConfig);
  if (!input || typeof input !== "object") return config;
  Object.assign(config.binance, input.binance || {});
  Object.assign(config.binance.urls, input.binance?.urls || {});
  Object.assign(config.binance.websocketUrls, input.binance?.websocketUrls || {});
  Object.assign(config.admin, input.admin || {});
  Object.assign(config.risk, input.risk || {});
  Object.assign(config.trading, input.trading || {});
  config.binance.apiKey = String(config.binance.apiKey || "").trim();
  config.binance.apiSecret = String(config.binance.apiSecret || "").trim();
  config.binance.mode = config.binance.mode === "mainnet" ? "mainnet" : "testnet";
  config.admin.email = String(config.admin.email || "").trim().toLowerCase();
  for (const mode of ["testnet", "mainnet"]) {
    if (!isValidBinanceUrl(config.binance.urls[mode])) {
      throw new Error(`Invalid Binance ${mode} Futures URL`);
    }
    if (!isValidBinanceUrl(config.binance.websocketUrls[mode], true)) {
      throw new Error(`Invalid Binance ${mode} WebSocket URL`);
    }
  }
  config.risk.riskPercent = clampNumber(config.risk.riskPercent, 0.1, 5, 0.5);
  config.risk.maxOpenTrades = Math.round(clampNumber(config.risk.maxOpenTrades, 1, 20, 2));
  config.risk.leverage = Math.round(clampNumber(config.risk.leverage, 1, 20, 3));
  config.risk.riskReward = clampNumber(config.risk.riskReward, 1, 10, 3);
  config.risk.maxDailyLoss = clampNumber(config.risk.maxDailyLoss, 0.1, 20, 2);
  config.risk.maxDailyTrades = Math.round(clampNumber(config.risk.maxDailyTrades, 1, 100, 5));
  config.trading.scanIntervalSeconds = Math.round(
    clampNumber(config.trading.scanIntervalSeconds, 15, 3600, 60),
  );
  config.trading.minSignalScore = Math.round(
    clampNumber(config.trading.minSignalScore, 60, 100, 70),
  );
  config.trading.enabled = config.trading.enabled === true;
  config.trading.moveStopToBreakEvenAfterTp1 =
    config.trading.moveStopToBreakEvenAfterTp1 === true;
  config.trading.pairs = normalizePairs(config.trading.pairs);
  config.trading.timeframes = ["15m", "1h", "4h"];
  return config;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function normalizePairs(value) {
  if (!Array.isArray(value)) return ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"];
  return [...new Set(value.map((x) => String(x).trim().toUpperCase()))]
    .filter((x) => /^[A-Z0-9]{4,20}$/.test(x))
    .slice(0, 50);
}

async function atomicWrite(file, content) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => {});
}

export async function ensureFiles() {
  if (initialized) return;
  await fs.mkdir(APP_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(CONFIG_PATH)) {
    let initial = defaultConfig;
    try {
      initial = JSON.parse(await fs.readFile(CONFIG_TEMPLATE, "utf8"));
    } catch {}
    await atomicWrite(CONFIG_PATH, `${JSON.stringify(mergeConfig(initial), null, 2)}\n`);
  }
  if (!existsSync(DATA_PATH)) {
    let initial = defaultState();
    try {
      initial = JSON.parse(await fs.readFile(DATA_TEMPLATE, "utf8"));
    } catch {}
    await atomicWrite(DATA_PATH, `${JSON.stringify(normalizeState(initial), null, 2)}\n`);
  }
  initialized = true;
}

function normalizeState(state) {
  const fresh = defaultState();
  if (!state || typeof state !== "object") return fresh;
  for (const key of ["users", "sessions", "trades", "signals", "logs"]) {
    fresh[key] = Array.isArray(state[key]) ? state[key] : [];
  }
  fresh.version = 1;
  fresh.bot = { ...fresh.bot, ...(state.bot || {}) };
  return fresh;
}

async function readRawData() {
  await ensureFiles();
  try {
    return normalizeState(JSON.parse(await fs.readFile(DATA_PATH, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return defaultState();
    const damaged = `${DATA_PATH}.corrupt-${Date.now()}`;
    await fs.rename(DATA_PATH, damaged).catch(() => {});
    await atomicWrite(DATA_PATH, `${JSON.stringify(defaultState(), null, 2)}\n`);
    return defaultState();
  }
}

export async function getData() {
  return readRawData();
}

export async function updateData(mutator) {
  const next = dataQueue.then(async () => {
    const state = await readRawData();
    const result = await mutator(state);
    await atomicWrite(DATA_PATH, `${JSON.stringify(normalizeState(state), null, 2)}\n`);
    return result;
  });
  dataQueue = next.then(() => undefined, () => undefined);
  return next;
}

export async function getConfig() {
  await ensureFiles();
  try {
    return mergeConfig(JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(defaultConfig);
    const damaged = `${CONFIG_PATH}.corrupt-${Date.now()}`;
    await fs.rename(CONFIG_PATH, damaged).catch(() => {});
    await atomicWrite(CONFIG_PATH, `${JSON.stringify(defaultConfig, null, 2)}\n`);
    return structuredClone(defaultConfig);
  }
}

export async function updateConfig(mutator) {
  const next = configQueue.then(async () => {
    const config = await getConfig();
    await mutator(config);
    const normalized = mergeConfig(config);
    await atomicWrite(CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  });
  configQueue = next.then(() => undefined, () => undefined);
  return next;
}

export async function appendLog(level, event, message) {
  const config = await getConfig();
  let safeMessage = String(message ?? "").slice(0, 500);
  for (const secret of [config.binance.apiKey, config.binance.apiSecret]) {
    if (secret) safeMessage = safeMessage.split(secret).join("[redacted]");
  }
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level: ["info", "warn", "error"].includes(level) ? level : "info",
    event: String(event || "system").slice(0, 80),
    message: safeMessage,
  };
  await updateData((data) => {
    data.logs.unshift(entry);
    data.logs = data.logs.slice(0, 1000);
  });
  return entry;
}

export function appDirectory() {
  return APP_DIR;
}

