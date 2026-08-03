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
      // Records how long each address holds MINTD, for an Arc allocation.
      // This one is genuinely irreplaceable: the RPC keeps four to five days
      // of logs and has no archive, so any stretch this process is not running
      // for is holding history that can never be reconstructed. If it is down,
      // fix it the same day.
      name: "holder-ledger",
      script: "scripts/holder-ledger.js",
      args: "--watch",
    },
    {
      ...common,
      // Completes Base -> Arc USDC bridges. CCTP burns on Base and mints only
      // when someone submits receiveMessage on Arc, which costs Arc gas a
      // first-time bridger has none of, so this pays it for them. It never
      // touches user funds: the recipient is fixed inside Circle's attested
      // message, so this process only decides whether to submit, never where
      // anything goes. If it stops, transfers are not lost, because
      // destinationCaller is zero and anyone can submit them instead.
      name: "bridge-relayer",
      script: "scripts/bridge-relayer.js",
      env: {
        ROUTER: "0xEAD1eB5e6464e8EABEC893A02c83073A84c3e217", // BridgeFeeRouter on Base
        RELAYER_KEY_VAR: "KEEPER_KEY", // gas-only, never the deployer
        KEEPER_KEY: env.KEEPER_KEY,
        POLL_MS: "30000",
      },
    },
    {
      ...common,
      // Publishes frontend/stats.json hourly.
      //
      // The indexer writes that file every few minutes but nothing committed it,
      // so the live site served numbers 42 hours old while the local file was
      // current: TVL read 18,797 against an actual 33,059. A stats indexer that
      // runs perfectly and never publishes looks exactly like a broken indexer
      // from outside.
      //
      // A one-shot like the snapshot job, so "waiting restart" between runs is
      // correct. publish-stats.sh re-runs the indexer, stages ONLY stats.json,
      // and exits without committing when the numbers have not moved.
      name: "stats-publish",
      script: "scripts/publish-stats.sh",
      interpreter: "bash",
      autorestart: false,
      cron_restart: "23 * * * *",
    },
    {
      ...common,
      // Records StableEarn's share price once a day so the Earn tab can state a
      // MEASURED yield rather than repeat someone else's headline. Irreplaceable
      // for the same reason as holder-ledger: Stable has no archive state, so a
      // share price not captured while the chain was live cannot be read back,
      // and a gap is a hole in the series forever.
      //
      // A one-shot, not a service. autorestart is off and cron_restart is what
      // runs it, so pm2 shows it "stopped" between daily runs; that is correct
      // and not a crash. It commits and pushes only frontend/stable-earn.json.
      name: "stable-earn-snapshot",
      script: "scripts/publish-stable-earn.sh",
      interpreter: "bash",
      autorestart: false,
      cron_restart: "17 3 * * *",
    },
    {
      ...common,
      // Pings Telegram the moment StableEarn starts accepting deposits again.
      // There is no event to subscribe to: Morpho Vault V2 derives maxDeposit
      // from the underlying markets' caps rather than storing it, so nothing is
      // emitted when it changes and polling is the only option.
      //
      // Read-only. It holds no key and can move nothing.
      name: "stable-earn-cap-watch",
      script: "scripts/stable-earn-cap-watch.js",
      env: {
        TG_BOT_TOKEN: env.TG_BOT_TOKEN,
        TG_CHAT_ID: env.TG_CHAT_ID,
        POLL_MS: env.SE_CAP_POLL_MS || "120000",
      },
    },
    {
      ...common,
      // Drives BuybackVault agents. Acts ONLY on vaults that have named this
      // wallet, so it is opt-in per vault and does nothing until someone
      // switches theirs on.
      //
      // It holds no funds and has no privileges beyond being named. execute()
      // and executeSell() take no arguments, so this key cannot choose a price,
      // a size or a recipient; a thief gets wasted gas and badly timed trades
      // inside each vault's own bounds, and any owner can revoke it in one
      // transaction. Gas-only key, never the deployer.
      //
      // The interval jitters inside the script rather than being a cron: a
      // buyer whose timing is public, in a thin pool, on a chain whose
      // front-running hole is unfixed, is somebody else's free lunch.
      name: "vault-keeper",
      script: "scripts/vault-keeper.js",
      env: {
        KEEPER_KEY: env.KEEPER_KEY,
        VAULT_FACTORY: env.VAULT_FACTORY || "0x3db601869c2C47Bfa9b08c62E077Df4806C1283A",
        MIN_MS: env.VAULT_MIN_MS || "600000",
        MAX_MS: env.VAULT_MAX_MS || "900000",
        DEAD_ZONE: env.VAULT_DEAD_ZONE || "1500",
        SELL_MULT: env.VAULT_SELL_MULT || "3",
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
