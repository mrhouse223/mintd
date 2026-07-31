// Verifies every coin launched through a mintd.fun launchpad, on stablescan.
//
//   ETHERSCAN_API_KEY=… node scripts/verify-tokens.js            one pass
//   ETHERSCAN_API_KEY=… node scripts/verify-tokens.js --watch    keep checking for new launches
//
// WHY AN API KEY, AND WHY ETHERSCAN
// stablescan.xyz is an Etherscan V2 deployment. Its V1 endpoints are gone, and
// V2 is a single host keyed by chain id, so verification goes to
// api.etherscan.io/v2/api?chainid=988 rather than to stablescan itself. A free
// key works across every V2 chain.
//
// IN PRACTICE THIS RARELY HAS ANYTHING TO DO
// Etherscan auto-matches identical bytecode, so once ONE token from a pad is
// verified, every other coin from that pad verifies against it automatically,
// including future launches. This script exists for the first coin of a new
// pad, and as a safety net.
//
// WHY BOTH PADS ARE LISTED
// A token from the v2 pad does NOT auto-match one verified from the v1 pad, even
// though the source is identical: each launchpad compiles its own copy of
// MemeToken20, and solc hashes the containing file into the metadata, so the
// bytecode differs. That is exactly why a coin launched on the v2 pad showed
// unverified while all 122 on the v1 pad were fine.
const { ethers } = require("ethers");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const RPC = process.env.STABLE_RPC_URL || "https://rpc.stable.xyz";
const KEY = process.env.ETHERSCAN_API_KEY;
const API = "https://api.etherscan.io/v2/api";
const CHAIN_ID = 988;
const STATE = path.join(__dirname, "..", "data", "verified-tokens.json");

// `rev` reads the source from a git revision, for a pad whose source has been
// edited since it was deployed. The v2 pad predates four security fixes made to
// MintdLaunchpad.sol, so HEAD compiles to 17,039 bytes against 16,141 deployed
// and is rejected. null means HEAD is correct.
const PADS = [
  { name: "v2", addr: "0xCe7b02b3f0e5665f1C23E018039e9b6836c6221b", file: "MintdLaunchpad.sol",   rev: "ab31c4d4" },
  { name: "v1", addr: "0x75FAdB240006313294A5B502CA9268cB03Fa9AC0", file: "InstantLaunchpad.sol", rev: null },
];

// Must match scripts/compile.js. A different optimizer setting or evm version
// changes the real code, not just the metadata, and is rejected outright.
const SETTINGS = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris" };
const SOLC = "v0.8.26+commit.8a97fa7a";

const PAD_ABI = ["function tokenCount() view returns (uint256)", "function allTokens(uint256) view returns (address)"];
const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function metadataURI() view returns (string)",
  "function totalSupply() view returns (uint256)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One global gate on every API call. The free tier allows three a second and
// each token takes several; a throttled response carries no result field, which
// reads as missing data rather than as being rate limited.
let lastCall = 0;
async function gate() {
  const wait = Math.max(0, 400 - (Date.now() - lastCall));
  if (wait) await sleep(wait);
  lastCall = Date.now();
}
async function api(params) {
  await gate();
  const r = await fetch(`${API}?${new URLSearchParams({ chainid: String(CHAIN_ID), apikey: KEY, ...params })}`);
  const j = await r.json();
  if (typeof j.result === "string" && /rate limit/i.test(j.result)) throw new Error("rate limited: " + j.result);
  return j;
}

function loadDone() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE, "utf8")).verified || []); } catch { return new Set(); }
}
function saveDone(set) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({ verified: [...set] }, null, 1) + "\n");
  } catch (e) { console.error("could not persist state:", e.message); }
}

/// Standard JSON input, carrying the settings with it so there is nothing to
/// retype and get subtly wrong. Read from a git revision when the pad's source
/// has moved on since deployment.
function standardJson(pad) {
  const rel = "contracts/" + pad.file;
  const content = pad.rev
    ? execSync(`git show ${pad.rev}:${rel}`, { cwd: path.join(__dirname, "..") }).toString()
    : fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  return {
    rel,
    std: JSON.stringify({
      language: "Solidity",
      sources: { [rel]: { content } },
      settings: { ...SETTINGS, outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } } },
    }),
  };
}

async function isVerified(addr) {
  const j = await api({ module: "contract", action: "getsourcecode", address: addr });
  return !!((j.result || [])[0] || {}).SourceCode;
}

async function verifyOne(pad, addr, meta) {
  const { rel, std } = standardJson(pad);
  // `to` is always the launchpad: the pad constructs the token with
  // address(this) as the recipient. metadataURI has NO setter, so the value on
  // chain now is the value passed at construction; if one is ever added, this
  // breaks and every verification fails.
  const args = ethers.AbiCoder.defaultAbiCoder()
    .encode(["string", "string", "string", "uint256", "address"],
            [meta.name, meta.symbol, meta.uri, meta.supply, pad.addr]).slice(2);

  await gate();
  const body = new URLSearchParams({
    chainid: String(CHAIN_ID), apikey: KEY,
    module: "contract", action: "verifysourcecode",
    codeformat: "solidity-standard-json-input", sourceCode: std,
    contractaddress: addr, contractname: `${rel}:MemeToken20`,
    compilerversion: SOLC, constructorArguements: args,
  });
  const sub = await (await fetch(`${API}?chainid=${CHAIN_ID}&apikey=${KEY}`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body })).json();

  if (sub.status !== "1") {
    // "already verified" is success, not failure. Treat it as done rather than
    // retrying it on every pass forever.
    if (/already verified/i.test(sub.result || "")) return { ok: true, note: "already verified" };
    return { ok: false, note: sub.result || sub.message };
  }
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const st = await api({ module: "contract", action: "checkverifystatus", guid: sub.result });
    const res = String(st.result || "");
    if (/pass|already verified/i.test(res)) return { ok: true, note: res };
    if (/fail/i.test(res)) return { ok: false, note: res };
  }
  return { ok: false, note: "still pending after 60s" };
}

(async () => {
  if (!KEY) {
    console.error("Set ETHERSCAN_API_KEY. A free key from etherscan.io covers every");
    console.error("V2 chain including Stable (988). Put it in .env.");
    process.exit(1);
  }
  const watch = process.argv.includes("--watch");
  const rp = new ethers.JsonRpcProvider(RPC, 988, { staticNetwork: true, batchMaxCount: 1 });
  const done = loadDone();

  do {
    for (const pad of PADS) {
      const pc = new ethers.Contract(pad.addr, PAD_ABI, rp);
      let n;
      try { n = Number(await pc.tokenCount()); }
      catch (e) { console.error(`${pad.name} pad unreadable:`, e.shortMessage || e.message); continue; }
      let pending = 0;

      for (let i = 0; i < n; i++) {
        let addr;
        try { addr = await pc.allTokens(i); } catch { continue; }
        if (done.has(addr.toLowerCase())) continue;
        try {
          if (await isVerified(addr)) { done.add(addr.toLowerCase()); saveDone(done); continue; }
          pending++;
          const t = new ethers.Contract(addr, TOKEN_ABI, rp);
          const meta = { name: await t.name(), symbol: await t.symbol(), uri: await t.metadataURI(), supply: await t.totalSupply() };
          process.stdout.write(`${pad.name} #${i} ${meta.symbol.padEnd(10)} ${addr} … `);
          const r = await verifyOne(pad, addr, meta);
          console.log(r.ok ? `OK (${r.note})` : `FAILED: ${r.note}`);
          if (r.ok) { done.add(addr.toLowerCase()); saveDone(done); }
        } catch (e) {
          console.error(`${pad.name} #${i} ${addr} errored:`, e.shortMessage || e.message);
        }
      }
      console.log(`${pad.name} pad: ${n} tokens, ${pending} needed work`);
    }
    if (watch) { console.log("sleeping 10m"); await sleep(600000); }
  } while (watch);
})().catch((e) => { console.error(e.message); process.exit(1); });
