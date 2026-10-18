# Binance Futures Terminal

A self-hosted Node.js dashboard for live Binance USDⓈ-M Futures market analysis, local user accounts, trade monitoring, and optional automated execution.

## Start

Requires Node.js 22 or newer.

```sh
npm install
npm start
```

Open `http://localhost:3000`. Railway supplies `PORT` automatically; locally the server defaults to 3000. No build command or environment variables are required.

## First setup

1. Keep `binance.mode` set to `testnet`.
2. In `config.json`, set `admin.email` to the email address you will register with.
3. Add a Binance Futures **testnet** API key and secret to `binance.apiKey` and `binance.apiSecret`. Never paste them into the browser, chat, or source control.
4. Start the server, register using that exact admin email, sign in, and use **Test connection**.
5. Leave automated trading disabled until you have verified account access and risk settings. A mainnet switch and enabling automated trading are separate admin actions.

The default config has empty credentials, testnet selected, and auto trading disabled. The app reports disconnected when it cannot make a real signed Binance request. Public prices, candles, indicators, and signals come from Binance Futures endpoints; no sample balances or random prices are used.

## Local data and security

Users, scrypt password hashes, sessions, trades, signal history, and logs are stored in `data.json` beside the application files. Writes use a serialized atomic replacement. A malformed data file is preserved with a `.corrupt-<timestamp>` suffix before a fresh empty store is created. Passwords are never stored in plain text. Session cookies are HttpOnly and SameSite; HTTPS requests also receive Secure cookies.

`config.json` contains the Binance API secret and is intentionally excluded from source control. Restrict file permissions and back up the config/data files securely. Do not expose this server directly to the public internet without HTTPS and a trusted reverse proxy.

This application places real derivatives orders only when all configured gates pass. Futures are high risk: order fills, slippage, exchange outages, liquidation, funding, and API behavior can cause losses beyond an intended plan. Protective orders are considered active only after Binance confirms them. The software cannot guarantee profit or uninterrupted protection.

## Railway

Deploy this folder as a Node.js service with `npm install` and `npm start`; `railway.json` contains the start command and health check. The app needs no Telegram variables or Binance environment variables. Add the Binance keys to the server-side `config.json` after deployment and do not commit that file.

The JSON store is a single-process local-file database, not a distributed database. Railway container files may not survive replacement unless persistent storage is configured. Use one running replica and arrange durable storage and secure backups for `config.json` and `data.json` before treating the deployment as a persistent production trading service. Do not run multiple replicas against the same local JSON files.
