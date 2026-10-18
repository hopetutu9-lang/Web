import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  appendLog,
  ensureFiles,
  getConfig,
  getData,
  updateConfig,
  updateData,
} from "./store.js";
import {
  closeTrade,
  currentPrice,
  getAccountSnapshot,
  getMarketDetail,
  realizedPnl,
  restartMarketSocket,
  scanMarkets,
  setAdminSettings,
  startBackgroundServices,
  startWorker,
  stopWorker,
  testConnection,
  manageTrade,
} from "./market-engine.js";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "futures_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const authBuckets = new Map();
let servicesStarted = false;

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function safeUser(user) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  };
}

function response(status, body, headers = {}) {
  return { status, body, headers };
}

function message(status, text, data) {
  return response(status, { ok: status < 400, message: text, ...(data === undefined ? {} : { data }) });
}

function getCookie(cookieHeader, key) {
  for (const part of String(cookieHeader || "").split(";")) {
    const split = part.trim().indexOf("=");
    if (split < 0) continue;
    if (part.slice(0, split).trim() === key) {
      try {
        return decodeURIComponent(part.slice(split + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function cookieHeader(token, headers) {
  const secure =
    String(headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" ||
    process.env.NODE_ENV === "production";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure ? "; Secure" : ""}`;
}

async function userForCookie(cookieHeaderValue) {
  const token = getCookie(cookieHeaderValue, SESSION_COOKIE);
  if (!token || token.length > 256) return null;
  const tokenHash = hashToken(token);
  const data = await getData();
  const session = data.sessions.find((item) => item.tokenHash === tokenHash && Date.parse(item.expiresAt) > Date.now());
  if (!session) return null;
  const user = data.users.find((item) => item.id === session.userId);
  return user || null;
}

function isRateLimited(headers, route) {
  const ip = String(headers["x-forwarded-for"] || headers["x-real-ip"] || "local").split(",")[0].trim();
  const key = `${route}:${ip}`;
  const current = authBuckets.get(key) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  if (current.resetAt < Date.now()) {
    current.count = 0;
    current.resetAt = Date.now() + 15 * 60 * 1000;
  }
  current.count += 1;
  authBuckets.set(key, current);
  if (authBuckets.size > 2000) {
    for (const [storedKey, value] of authBuckets) {
      if (value.resetAt < Date.now()) authBuckets.delete(storedKey);
    }
  }
  return current.count > (route === "login" ? 10 : 5);
}

async function makeSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const session = {
    id: randomBytes(16).toString("hex"),
    userId,
    tokenHash,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_MS).toISOString(),
  };
  await updateData((data) => {
    data.sessions = data.sessions.filter((item) => Date.parse(item.expiresAt) > Date.now());
    data.sessions.push(session);
  });
  return token;
}

function validateSameOrigin(request) {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) return true;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const forwardedHost = String(request.headers["x-forwarded-host"] || "").split(",")[0].trim();
    const requestHost = String(forwardedHost || request.headers.host || "").split(",")[0].trim().toLowerCase();
    return Boolean(requestHost && originHost === requestHost);
  } catch {
    return false;
  }
}

function publicSettings(config) {
  return {
    mode: config.binance.mode,
    autoTradingEnabled: config.trading.enabled,
    riskPercent: config.risk.riskPercent,
    maxOpenTrades: config.risk.maxOpenTrades,
    leverage: config.risk.leverage,
    riskReward: config.risk.riskReward,
    maxDailyLoss: config.risk.maxDailyLoss,
    maxDailyTrades: config.risk.maxDailyTrades,
    scanIntervalSeconds: config.trading.scanIntervalSeconds,
    minSignalScore: config.trading.minSignalScore,
    moveStopToBreakEvenAfterTp1: config.trading.moveStopToBreakEvenAfterTp1,
    pairs: config.trading.pairs,
  };
}

function isAdmin(user) {
  return user?.role === "admin";
}

function adminRequired(user) {
  return !isAdmin(user) ? response(403, { error: "Admin access required" }) : null;
}

function validateBody(schema, body) {
  const fail = (text) => {
    const error = new Error(text);
    error.status = 400;
    throw error;
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid request body");
  if (schema === "register") {
    if (typeof body.fullName !== "string" || !body.fullName.trim() || body.fullName.length > 120) fail("Enter your full name");
    if (typeof body.email !== "string" || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) fail("Enter a valid email address");
    if (typeof body.password !== "string" || body.password.length < 6 || body.password.length > 128) fail("Password must be 6 to 128 characters");
    if (typeof body.confirmPassword !== "string" || body.confirmPassword.length < 6 || body.confirmPassword.length > 128) fail("Confirm your password");
    return body;
  }
  if (schema === "login") {
    if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) fail("Enter a valid email address");
    if (typeof body.password !== "string" || !body.password.length || body.password.length > 128) fail("Enter your password");
    return body;
  }
  if (schema === "manage") {
    if (!["stopLoss", "tp1", "tp2", "tp3"].every((key) => Number.isFinite(Number(body[key])) && Number(body[key]) > 0)) {
      fail("All protective levels must be positive prices");
    }
    return {
      stopLoss: Number(body.stopLoss),
      tp1: Number(body.tp1),
      tp2: Number(body.tp2),
      tp3: Number(body.tp3),
    };
  }
  if (schema === "profile") {
    if (typeof body.fullName !== "string" || !body.fullName.trim() || body.fullName.length > 120) fail("Enter a valid name");
    return { fullName: body.fullName.trim() };
  }
  if (schema === "settings") {
    const numberRules = {
      riskPercent: [0.1, 5],
      maxOpenTrades: [1, 20],
      leverage: [1, 20],
      riskReward: [1, 10],
      maxDailyLoss: [0.1, 20],
      maxDailyTrades: [1, 100],
      scanIntervalSeconds: [15, 3600],
      minSignalScore: [60, 100],
    };
    for (const [key, [min, max]] of Object.entries(numberRules)) {
      if (body[key] !== undefined && (!Number.isFinite(Number(body[key])) || Number(body[key]) < min || Number(body[key]) > max)) {
        fail(`${key} must be between ${min} and ${max}`);
      }
    }
    if (body.mode !== undefined && !["testnet", "mainnet"].includes(body.mode)) fail("Mode must be testnet or mainnet");
    if (body.autoTradingEnabled !== undefined && typeof body.autoTradingEnabled !== "boolean") fail("autoTradingEnabled must be a boolean");
    if (body.pairs !== undefined && (!Array.isArray(body.pairs) || body.pairs.length > 50 || body.pairs.some((pair) => typeof pair !== "string" || !/^[A-Z0-9]{4,20}$/.test(pair)))) {
      fail("Pairs must be a list of valid USDT market symbols");
    }
    return body;
  }
  fail("Invalid request");
}

async function register(body, headers) {
  if (isRateLimited(headers, "register")) return response(429, { error: "Too many registration attempts. Try again later." });
  const input = validateBody("register", body);
  const fullName = String(input.fullName).trim();
  const email = String(input.email).trim().toLowerCase();
  if (!fullName || fullName.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response(400, { error: "Enter a valid name and email address" });
  }
  if (input.password !== input.confirmPassword) {
    return response(400, { error: "Passwords do not match" });
  }
  const data = await getData();
  if (data.users.some((user) => user.email === email)) {
    return response(409, { error: "An account with this email already exists" });
  }
  const salt = randomBytes(16).toString("hex");
  const passwordHash = (await scrypt(input.password, salt, 64)).toString("hex");
  const config = await getConfig();
  const user = {
    id: randomBytes(16).toString("hex"),
    fullName,
    email,
    role: config.admin.email && email === config.admin.email ? "admin" : "user",
    passwordSalt: salt,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  await updateData((state) => {
    if (state.users.some((item) => item.email === email)) {
      const error = new Error("An account with this email already exists");
      error.status = 409;
      throw error;
    }
    state.users.push(user);
  });
  const token = await makeSession(user.id);
  await appendLog("info", "Account registered", "A new local user account was created");
  return response(201, { authenticated: true, user: safeUser(user) }, { "set-cookie": cookieHeader(token, headers) });
}

async function login(body, headers) {
  if (isRateLimited(headers, "login")) return response(429, { error: "Too many login attempts. Try again later." });
  const input = validateBody("login", body);
  const email = String(input.email).trim().toLowerCase();
  const data = await getData();
  const user = data.users.find((item) => item.email === email);
  if (!user) {
    await scrypt(input.password, "00000000000000000000000000000000", 64);
    return response(401, { error: "Invalid email or password" });
  }
  const actual = Buffer.from(await scrypt(input.password, user.passwordSalt, 64));
  const expected = Buffer.from(user.passwordHash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return response(401, { error: "Invalid email or password" });
  }
  const token = await makeSession(user.id);
  return response(200, { authenticated: true, user: safeUser(user) }, { "set-cookie": cookieHeader(token, headers) });
}

async function dailyPnl() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return realizedPnl(start.getTime());
}

async function dashboardFor(user) {
  const [data, config] = await Promise.all([getData(), getConfig()]);
  let account = {
    connected: false,
    mode: config.binance.mode,
    walletBalance: null,
    availableBalance: null,
    unrealizedPnl: null,
    positions: [],
    checkedAt: null,
    message: config.binance.apiKey && config.binance.apiSecret ? "Connection has not been checked" : "Binance API credentials are not configured",
  };
  if (config.binance.apiKey && config.binance.apiSecret) {
    try {
      account = { ...(await getAccountSnapshot()), message: "Live Futures account data" };
      const pnl = await dailyPnl();
      account.todayPnl = pnl;
    } catch (error) {
      account.message = error instanceof Error ? error.message.slice(0, 240) : "Binance account request failed";
    }
  }
  const ownTrades = data.trades.filter((trade) => isAdmin(user) || trade.ownerId === user.id);
  const closed = ownTrades.filter((trade) => trade.status !== "OPEN" && trade.realizedPnl !== null);
  const winners = closed.filter((trade) => Number(trade.realizedPnl) > 0).length;
  const summary = {
    walletBalance: account.walletBalance,
    availableBalance: account.availableBalance,
    openTrades: account.connected ? account.positions.length : null,
    unrealizedPnl: account.unrealizedPnl,
    todayPnl: account.todayPnl ?? null,
    winRate: closed.length ? (winners / closed.length) * 100 : null,
    totalTrades: ownTrades.length,
  };
  return {
    connection: {
      connected: account.connected,
      mode: config.binance.mode,
      message: account.message,
      walletBalance: account.walletBalance,
      availableBalance: account.availableBalance,
      checkedAt: account.checkedAt,
    },
    metrics: summary,
    bot: {
      running: data.bot.running === true,
      workerStatus: data.bot.workerStatus,
      autoTradingEnabled: config.trading.enabled,
      websocketStatus: data.bot.websocketStatus,
      lastError: data.bot.lastError,
    },
    timestamps: {
      lastMarketScan: data.bot.lastMarketScan,
      lastSignal: data.bot.lastSignal?.createdAt || null,
      lastBalanceFetch: data.bot.lastBalanceFetch,
      lastExecution: data.bot.lastExecution,
    },
    pairs: config.trading.pairs,
    recentSignals: data.signals.slice(0, 5),
    recentTrades: ownTrades.slice(0, 5),
  };
}

async function listTrades(user) {
  const data = await getData();
  const config = await getConfig();
  const trades = data.trades.filter((trade) => isAdmin(user) || trade.ownerId === user.id);
  const positions = new Map();
  if (config.binance.apiKey && config.binance.apiSecret) {
    try {
      const account = await getAccountSnapshot();
      for (const position of account.positions) positions.set(position.symbol, position);
    } catch {}
  }
  const current = Date.now();
  return trades.map((trade) => {
    const position = positions.get(trade.symbol);
    const markPrice = currentPrice(trade.symbol) || position?.markPrice || trade.markPrice;
    const quantity = position?.positionAmt ? Math.abs(position.positionAmt) : trade.remainingQuantity;
    return {
      ...trade,
      quantity: quantity ?? null,
      upnl: position ? position.unRealizedProfit : trade.upnl ?? null,
      markPrice: markPrice ?? null,
      remainingQuantity: quantity ?? null,
      duration: Math.max(0, current - Date.parse(trade.openedAt)),
      pnlPercent: position?.positionInitialMargin
        ? (position.unRealizedProfit / position.positionInitialMargin) * 100
        : trade.pnlPercent ?? null,
    };
  });
}

async function updateProfile(user, body) {
  const input = validateBody("profile", body);
  const fullName = String(input.fullName).trim();
  if (!fullName || fullName.length > 120) return response(400, { error: "Enter a valid name" });
  const updated = await updateData((data) => {
    const local = data.users.find((item) => item.id === user.id);
    if (!local) return null;
    local.fullName = fullName;
    return safeUser(local);
  });
  return response(200, { user: updated });
}

async function handleApi(request) {
  const method = String(request.method || "GET").toUpperCase();
  let url;
  try {
    url = new URL(request.url || "/", "http://local");
  } catch {
    return response(400, { error: "Invalid URL" });
  }
  let pathname = url.pathname;
  if (pathname.startsWith("/api/")) pathname = pathname.slice(4);
  if (pathname === "/api") pathname = "/";
  if (!validateSameOrigin({ ...request, method })) return response(403, { error: "Cross-origin request rejected" });

  const publicRoute =
    pathname === "/healthz" ||
    pathname === "/auth/register" ||
    pathname === "/auth/login" ||
    pathname === "/auth/session" ||
    pathname === "/auth/logout" ||
    pathname === "/market" ||
    pathname.startsWith("/market/");
  const user = await userForCookie(request.headers?.cookie);
  if (!publicRoute && !user) return response(401, { error: "Sign in to continue" });

  if (method === "GET" && pathname === "/healthz") {
    return response(200, { status: "ok", service: "binance-futures-terminal" });
  }
  if (method === "POST" && pathname === "/auth/register") return register(request.body || {}, request.headers || {});
  if (method === "POST" && pathname === "/auth/login") return login(request.body || {}, request.headers || {});
  if (method === "GET" && pathname === "/auth/session") {
    return response(200, { authenticated: Boolean(user), user: user ? safeUser(user) : null });
  }
  if (method === "POST" && pathname === "/auth/logout") {
    const token = getCookie(request.headers?.cookie, SESSION_COOKIE);
    if (token) {
      await updateData((data) => {
        data.sessions = data.sessions.filter((session) => session.tokenHash !== hashToken(token));
      });
    }
    return response(200, { ok: true, message: "Signed out" }, {
      "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${String(request.headers?.["x-forwarded-proto"] || "").includes("https") ? "; Secure" : ""}`,
    });
  }
  if (method === "GET" && pathname === "/market") {
    try {
      const markets = await scanMarkets();
      const search = (url.searchParams.get("search") || "").trim().toUpperCase();
      return response(200, {
        markets: search ? markets.filter((item) => item.symbol.includes(search)) : markets,
        updatedAt: scanMarkets.updatedAt ? new Date(scanMarkets.updatedAt).toISOString() : null,
        error: null,
      });
    } catch (error) {
      return response(502, { markets: [], updatedAt: null, error: error instanceof Error ? error.message : "Live market data unavailable" });
    }
  }
  if (method === "GET" && pathname.startsWith("/market/")) {
    try {
      return response(200, await getMarketDetail(decodeURIComponent(pathname.slice("/market/".length))));
    } catch (error) {
      return response(404, { error: error instanceof Error ? error.message : "Symbol unavailable" });
    }
  }
  if (method === "GET" && pathname === "/dashboard") return response(200, await dashboardFor(user));
  if (method === "GET" && pathname === "/signals") {
    const data = await getData();
    return response(200, { signals: data.signals });
  }
  if (method === "GET" && pathname === "/trades") return response(200, { trades: await listTrades(user) });
  if (method === "POST" && pathname === "/binance/test") {
    const result = await testConnection();
    return response(result.connected ? 200 : 401, result);
  }
  if (method === "POST" && pathname === "/bot/start") {
    const denied = adminRequired(user);
    if (denied) return denied;
    try {
      await setAdminSettings({ autoTradingEnabled: true });
      await startWorker(user.id);
      return message(200, "Auto trading worker started");
    } catch (error) {
      await updateConfig((config) => {
        config.trading.enabled = false;
      });
      return response(409, { error: error instanceof Error ? error.message : "Could not start the trading worker" });
    }
  }
  if (method === "POST" && pathname === "/bot/stop") {
    const denied = adminRequired(user);
    if (denied) return denied;
    await stopWorker();
    return message(200, "Auto trading worker stopped. Exchange protection orders remain active.");
  }
  if (method === "GET" && pathname === "/settings") {
    const config = await getConfig();
    return response(200, {
      settings: publicSettings(config),
      mode: config.binance.mode,
      adminEmailConfigured: Boolean(config.admin.email),
      credentialsConfigured: Boolean(config.binance.apiKey && config.binance.apiSecret),
    });
  }
  if (method === "PATCH" && pathname === "/settings") {
    const denied = adminRequired(user);
    if (denied) return denied;
    const input = validateBody("settings", request.body || {});
    const data = await getData();
    if (input.mode && input.mode !== (await getConfig()).binance.mode && data.bot.running) {
      return response(409, { error: "Stop the trading worker before switching Binance environments" });
    }
    try {
      const config = await setAdminSettings(input);
      if (input.mode) await restartMarketSocket();
      await appendLog("info", "Settings updated", `Trading limits or mode changed by admin ${user.email}`);
      return response(200, {
        settings: publicSettings(config),
        mode: config.binance.mode,
        adminEmailConfigured: Boolean(config.admin.email),
        credentialsConfigured: Boolean(config.binance.apiKey && config.binance.apiSecret),
      });
    } catch (error) {
      return response(400, { error: error instanceof Error ? error.message : "Settings could not be saved" });
    }
  }
  if (method === "GET" && pathname === "/profile") return response(200, { user: safeUser(user) });
  if (method === "PATCH" && pathname === "/profile") return updateProfile(user, request.body || {});
  if (method === "GET" && pathname === "/logs") {
    const denied = adminRequired(user);
    if (denied) return denied;
    const data = await getData();
    return response(200, { logs: data.logs.slice(0, 500) });
  }
  if (method === "GET" && pathname === "/admin/overview") {
    const denied = adminRequired(user);
    if (denied) return denied;
    const [data, config] = await Promise.all([getData(), getConfig()]);
    let connection = {
      connected: false,
      mode: config.binance.mode,
      walletBalance: null,
      availableBalance: null,
      unrealizedPnl: null,
      positions: [],
    };
    if (config.binance.apiKey && config.binance.apiSecret) {
      try {
        connection = await getAccountSnapshot();
      } catch {}
    }
    const realized = data.trades.reduce(
      (sum, trade) => sum + (Number.isFinite(Number(trade.realizedPnl)) ? Number(trade.realizedPnl) : 0),
      0,
    );
    return response(200, {
      usersCount: data.users.length,
      tradesCount: data.trades.length,
      openTrades: connection.positions.length,
      pnl: realized,
      bot: {
        ...data.bot,
        autoTradingEnabled: config.trading.enabled,
      },
      connection: {
        connected: connection.connected,
        mode: connection.mode,
        walletBalance: connection.walletBalance,
        availableBalance: connection.availableBalance,
      },
    });
  }
  if (method === "GET" && pathname === "/admin/users") {
    const denied = adminRequired(user);
    if (denied) return denied;
    const data = await getData();
    return response(200, { users: data.users.map(safeUser) });
  }
  const closeMatch = pathname.match(/^\/trades\/([A-Za-z0-9_-]+)\/close$/);
  if (method === "POST" && closeMatch) {
    const data = await getData();
    const trade = data.trades.find((item) => item.id === closeMatch[1]);
    if (!trade || (!isAdmin(user) && trade.ownerId !== user.id)) return response(404, { error: "Trade not found" });
    try {
      return message(200, "Binance position closed", { trade: await closeTrade(trade.id) });
    } catch (error) {
      return response(409, { error: error instanceof Error ? error.message : "Binance position could not be closed" });
    }
  }
  const manageMatch = pathname.match(/^\/trades\/([A-Za-z0-9_-]+)\/manage$/);
  if (method === "POST" && manageMatch) {
    const data = await getData();
    const trade = data.trades.find((item) => item.id === manageMatch[1]);
    if (!trade || (!isAdmin(user) && trade.ownerId !== user.id)) return response(404, { error: "Trade not found" });
    const input = validateBody("manage", request.body || {});
    try {
      return message(200, "Binance protective orders verified", { trade: await manageTrade(trade.id, input) });
    } catch (error) {
      return response(400, { error: error instanceof Error ? error.message : "Could not update trade protection" });
    }
  }
  return response(404, { error: "Not found" });
}

export async function startServices() {
  if (servicesStarted) return;
  servicesStarted = true;
  await ensureFiles();
  await startBackgroundServices();
}

async function handleApiSafely(request) {
  try {
    return await handleApi(request);
  } catch (error) {
    const status = Number(error?.status);
    const safeStatus = Number.isInteger(status) && status >= 400 && status < 500 ? status : 500;
    return response(safeStatus, {
      error:
        safeStatus === 500
          ? "The request could not be completed"
          : String(error?.message || "Invalid request").slice(0, 240),
    });
  }
}

export default { handleApi: handleApiSafely, startServices };

