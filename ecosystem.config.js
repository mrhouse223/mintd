// pm2 process definitions for every mintd background service.
//
//   pm2 start ecosystem.config.js      start or reload everything
//   pm2 logs mintr-buybot              tail one service
//   pm2 save                           remember this set across reboots
//
// Secrets live in a .env file NEXT TO THIS FILE, never inline, so this file is
// safe to commit and .env is not. Copy .env.example to .env and chmod 600 it.
//
// NOTE: anything set in an `env` block here OVERRIDES the script's own default.
// That is why LOGO_URL and BUY_TOKEN are deliberately absent below: the scripts
// already carry the correct branding and should win.
const fs = require("fs");
const path = require("path");

// minimal .env reader, no dependency required
const env = {};
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  console.warn("no .env next to ecosystem.config.js, services may not start");
}

const common = {
  cwd: __dirname,
  autorestart: true,
  max_restarts: 50,
  restart_delay: 5000,
  min_uptime: "30s",
  max_memory_restart: "300M",
  time: true, // timestamp every log line
};

module.exports = {
  apps: [
    {
      ...common,
      name: "mintr-buybot",
      script: "scripts/mintr-buybot.js",
      env: {
        TG_BOT_TOKEN: env.TG_BOT_TOKEN,
        TG_CHAT_ID: env.TG_CHAT_ID,
        MIN_USD: env.MIN_USD || "1",
      },
    },
    {
      ...common,
      name: "mgld-buybot",
      script: "scripts/mgld-buybot.js",
      env: {
        TG_BOT_TOKEN: env.TG_BOT_TOKEN,
        TG_CHAT_ID: env.MGLD_CHAT_ID || env.TG_CHAT_ID,
        MIN_USD: env.MIN_USD || "1",
      },
    },
    {
      ...common,
      name: "stats-indexer",
      script: "scripts/stats-indexer.js",
      args: "--watch",
      env: {
        STATS_POLL_MS: env.STATS_POLL_MS || "180000",
      },
    },
    {
      ...common,
      name: "arb-keeper",
      script: "scripts/arb-keeper-multi.js",
      env: {
        ARB: env.ARB,
        PRIVATE_KEY: env.KEEPER_KEY, // dedicated gas-only wallet, not the deployer
        MAX_SIZE: env.ARB_MAX_SIZE || "250",
        POLL_MS: env.ARB_POLL_MS || "20000",
        TG_BOT_TOKEN: env.TG_BOT_TOKEN,
        TG_CHAT_ID: env.TG_CHAT_ID,
      },
    },
  ],
};
