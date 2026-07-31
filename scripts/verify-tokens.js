// Verifies every coin launched through the mintd.fun launchpad on stablescan.
//
//   ETHERSCAN_API_KEY=… node scripts/verify-tokens.js            one pass
//   ETHERSCAN_API_KEY=… node scripts/verify-tokens.js --watch    keep verifying new launches
//   ETHERSCAN_API_KEY=… node scripts/verify-tokens.js --only 0x… a single token
//
// WHY AN API KEY, AND WHY ETHERSCAN
// stablescan.xyz is an Etherscan V2 deployment. Its V1 endpoints are gone, and
// V2 is a single host keyed by chain id, so verification goes to
// api.etherscan.io/v2/api?chainid=988 rather than to stablescan itself. A free
// key works across every V2 chain.
//
// WHY THE CONSTRUCTOR ARGS CAN BE REBUILT
// Verifying a contract with a constructor needs the exact arguments it was
// deployed with, and this chain prunes history, so the creation transaction is
// not reliably fetchable for a token launched months ago. It does not need to
// be. MemeToken20 takes (name, symbol, metadataURI, supply, to); the first four
// are readable off the token today, and `to` is always the launchpad, because
// the pad constructs the token with address(this) as the recipient. Crucially
// metadataURI has NO setter, so the value on chain now is the value passed at
// construction. If a setter were ever added, this script breaks and every
// verification silently fails, so that is worth knowing before changing the
// token.
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.STABLE_RPC_URL || "https://rpc.stable.xyz";
const KEY = process.env.ETHERSCAN_API_KEY;
const API = "https://api.etherscan.io/v2/api";
const CHAIN_ID = 988;
const PAD = "0x75FAdB240006313294A5B502CA9268cB03Fa9AC0";
const SRC = path.join(__dirname, "..", "contracts", "InstantLaunchpad.sol");
const STATE = path.join(__dirname, "..", "data", "verified-tokens.json");

// Must match scripts/compile.js exactly. A different optimizer setting or evm
// version produces different bytecode and the verification is rejected.
const SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  viaIR: true,
  evmVersion: "paris",
};
const SOLC = "v0.8.26+commit.8a97fa7a";

const PAD_ABI = [
  "function tokenCount() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
];
const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function metadataURI() view returns (string)",
  "function totalSupply() view returns (uint256)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadDone() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE, "utf8")).verified || []); } catch { return new Set(); }
}
function saveDone(set) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({ verified: [...set] }, null, 1) + "\n");
  } catch (e) { console.error("could not persist state:", e.message); }
}

async function api(params) {
  const q = new URLSearchParams({ chainid: String(CHAIN_ID), apikey: KEY, ...params });
  const r = await fetch(`${API}?${q}`);
  return r.json();
}
async function apiPost(params) {
  const body = new URLSearchParams({ chainid: String(CHAIN_ID), apikey: KEY, ...params });
  const r = await fetch(`${API}?chainid=${CHAIN_ID}&apikey=${KEY}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return r.json();
}

async function isVerified(addr) {
  const j = await api({ module: "contract", action: "getsourcecode", address: addr });
  const r = (j.result || [])[0] || {};
  return !!(r.SourceCode && r.SourceCode.length);
}

/// Standard JSON input. Preferred over flattened single-file because it carries
/// the settings with it, so there is nothing to retype and get subtly wrong.
function standardJson() {
  return JSON.stringify({
    language: "Solidity",
    sources: { "contracts/InstantLaunchpad.sol": { content: fs.readFileSync(SRC, "utf8") } },
    settings: { ...SETTINGS, outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } } },
  });
}

async function verifyOne(addr, meta) {
  const args = ethers.AbiCoder.defaultAbiCoder()
    .encode(["string", "string", "string", "uint256", "address"],
            [meta.name, meta.symbol, meta.uri, meta.supply, PAD])
    .slice(2);   // Etherscan wants it without the 0x

  const sub = await apiPost({
    module: "contract",
    action: "verifysourcecode",
    codeformat: "solidity-standard-json-input",
    sourceCode: standardJson(),
    contractaddress: addr,
    contractname: "contracts/InstantLaunchpad.sol:MemeToken20",
    compilerversion: SOLC,
    constructorArguements: args,
  });

  if (sub.status !== "1") {
    // "already verified" is success, not failure. Treat it as done rather than
    // retrying it on every pass forever.
    if (/already verified/i.test(sub.result || "")) return { ok: true, note: "already verified" };
    return { ok: false, note: sub.result || sub.message };
  }

  const guid = sub.result;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const st = await api({ module: "contract", action: "checkverifystatus", guid });
    const res = String(st.result || "");
    if (/pass|already verified/i.test(res)) return { ok: true, note: res };
    if (/fail/i.test(res)) return { ok: false, note: res };
  }
  return { ok: false, note: "still pending after 60s" };
}

(async () => {
  if (!KEY) {
    console.error("Set ETHERSCAN_API_KEY. A free key from etherscan.io works for");
    console.error("every V2 chain including Stable (988). Put it in .env.");
    process.exit(1);
  }
  const watch = process.argv.includes("--watch");
  const onlyIx = process.argv.indexOf("--only");
  const only = onlyIx > -1 ? process.argv[onlyIx + 1] : null;

  const rp = new ethers.JsonRpcProvider(RPC, 988, { staticNetwork: true, batchMaxCount: 1 });
  const pad = new ethers.Contract(PAD, PAD_ABI, rp);
  const done = loadDone();

  do {
    const n = Number(await pad.tokenCount());
    console.log(`launchpad has ${n} tokens, ${done.size} already recorded verified`);

    for (let i = 0; i < n; i++) {
      let addr;
      try { addr = await pad.allTokens(i); } catch (e) { console.error(`#${i} unreadable:`, e.shortMessage || e.message); continue; }
      if (only && addr.toLowerCase() !== only.toLowerCase()) continue;
      if (done.has(addr.toLowerCase())) continue;

      try {
        if (await isVerified(addr)) {
          console.log(`#${i} ${addr} already verified`);
          done.add(addr.toLowerCase()); saveDone(done);
          continue;
        }
        const t = new ethers.Contract(addr, TOKEN_ABI, rp);
        const meta = {
          name: await t.name(), symbol: await t.symbol(),
          uri: await t.metadataURI(), supply: await t.totalSupply(),
        };
        process.stdout.write(`#${i} ${meta.symbol.padEnd(10)} ${addr} … `);
        const r = await verifyOne(addr, meta);
        console.log(r.ok ? `OK (${r.note})` : `FAILED: ${r.note}`);
        if (r.ok) { done.add(addr.toLowerCase()); saveDone(done); }
      } catch (e) {
        console.error(`#${i} ${addr} errored:`, e.shortMessage || e.message);
      }
      // Free tier is 5 calls/sec. Each token costs several, so pace it rather
      // than getting throttled halfway through and having to work out where.
      await sleep(1200);
    }

    if (watch) { console.log("sleeping 10m, will pick up new launches"); await sleep(600000); }
  } while (watch);
})().catch((e) => { console.error(e.message); process.exit(1); });
