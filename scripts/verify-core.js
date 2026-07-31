// Verifies mintd.fun's core contracts on stablescan (Etherscan V2, chain 988).
//
//   ETHERSCAN_API_KEY=… node scripts/verify-core.js
//   ETHERSCAN_API_KEY=… node scripts/verify-core.js MINTR      just one
//
// The launched coins are NOT here: all 122 are already verified, because
// Etherscan auto-matches identical bytecode once one MemeToken20 is done. See
// scripts/verify-tokens.js.
//
// CONSTRUCTOR ARGS COME FROM THE CREATION TRANSACTION, NOT FROM GETTERS
// Reading current getters looks easier and is wrong. TokenLocker's feeRecipient
// reads as the Safe today, but it was constructed with the deployer and rotated
// afterwards, so a getter-derived argument would have failed verification while
// looking perfectly reasonable. Etherscan indexes creation transactions even
// though this chain's node prunes them, so the args are recovered from the tail
// of the creation input.
//
// The split point is the length of a locally compiled creationCode. That is
// exact even though the metadata HASH differs from the deployed one, because the
// metadata block is a fixed length: only its contents moved, not its size.
const { ethers } = require("ethers");
const solc = require("solc");
const fs = require("fs");
const path = require("path");

const KEY = process.env.ETHERSCAN_API_KEY;
const V2 = `https://api.etherscan.io/v2/api?chainid=988&apikey=${KEY}`;
const SOLC = "v0.8.26+commit.8a97fa7a";
const SETTINGS = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// address, file, contract name, constructor arg types.
// MintSwap's router is deliberately absent: it is a Uniswap V2 fork whose source
// is not in this repo, so there is nothing to submit for it.
const CORE = [
  ["MINTR",             "0x8817D05f2560189F3697028f639Dbb4C68688400", "MINTR.sol",             "MINTR",             ["address", "address"]],
  ["BuybackBurner",     "0x7F007fbc6061806888A39A79763808aF5B94F4f4", "BuybackBurner.sol",     "BuybackBurner",     ["address", "address", "address", "uint24"]],
  ["TokenMetaRegistry", "0x95B93c48522d0D53Bd2419bbC5Dc7e36E130E2BB", "TokenMetaRegistry.sol", "TokenMetaRegistry", ["address[]"]],
  ["MintSynth",         "0x09Eb7D9B18e56270F8898C4f3Ac3F2dc99F3b213", "MintSynth.sol",         "MintSynth",         ["string", "string", "address", "address", "address"]],
  ["MintrArbMulti",     "0xa96C23E75dd0e3b0B2548788ec72b3069d48a2C2", "MintrArbMulti.sol",     "MintrArbMulti",     ["address", "address", "address"]],
  ["ZapV3",             "0xdc6925bb23BBA955a8CcfE4C4d79C2647F9745Bb", "ZapV3.sol",             "ZapV3",             ["address", "address", "address"]],
  ["WrapZap",           "0x308b9b4aaD366263056b0705c52e2A3D43fb36Cc", "WrapZap.sol",           "WrapZap",           ["address", "address", "address"]],
  ["ZapIn",             "0x4e740F9edb5D69d68D73AC445DA1460c4B9eEd9d", "ZapIn.sol",             "ZapIn",             ["address", "address"]],
  ["Farm USDT0/WgUSDT", "0xd6160CDFB4F9C522a5BA77e05B4741B642B6Ff84", "StakingRewards.sol",    "StakingRewards",    ["address", "address"]],
  ["Farm MINTD/USDT0",  "0xF246F2B4710e37bE0FFeb22119654641b2cBc44E", "StakingRewards.sol",    "StakingRewards",    ["address", "address"]],
  ["Farm MGLD/USDT0",   "0x59Ab36B8daB00e13bD4c46D8D41b0FFa96707790", "StakingRewards.sol",    "StakingRewards",    ["address", "address"]],
  // Created INTERNALLY by MintSynth, so there is no top-level creation input to
  // slice. Its two constructor arguments are its name and symbol, neither of
  // which has a setter, so they are read off the token instead.
  ["MGLD",              "0x872a3C280B846759187c9E57F62d1Ed8407b135C", "MintSynth.sol",         "SynthToken",        ["string", "string"], "internal"],
];

const compiled = {};
function compile(file, name) {
  const k = file + ":" + name;
  if (compiled[k]) return compiled[k];
  const rel = "contracts/" + file;
  const input = {
    language: "Solidity",
    sources: { [rel]: { content: fs.readFileSync(path.join(__dirname, "..", rel), "utf8") } },
    settings: { ...SETTINGS, outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs[0].message.slice(0, 160));
  const c = out.contracts[rel] && out.contracts[rel][name];
  if (!c) throw new Error(`${name} not found in ${rel}`);
  return (compiled[k] = { std: JSON.stringify(input), creation: c.evm.bytecode.object, rel });
}

// One global gate on every API call, not a sleep between contracts.
//
// The free tier allows 3 calls a second and each contract makes four or five in
// quick succession, so spacing only the OUTER loop still bursts. Worse, a
// throttled response has no .result field, which read as "creation input
// unavailable" and looked exactly like Etherscan not having the transaction. It
// did have it; the request was simply rejected.
let lastCall = 0;
async function gate() {
  const wait = Math.max(0, 400 - (Date.now() - lastCall));
  if (wait) await sleep(wait);
  lastCall = Date.now();
}
async function get(params) {
  await gate();
  const r = await fetch(V2 + "&" + new URLSearchParams(params));
  const j = await r.json();
  // Say so loudly rather than letting a throttle masquerade as missing data.
  if (typeof j.result === "string" && /rate limit/i.test(j.result)) throw new Error("rate limited: " + j.result);
  return j;
}

async function recoverArgs(addr, creationHex, types) {
  const c = await get({ module: "contract", action: "getcontractcreation", contractaddresses: addr });
  const row = (c.result || [])[0];
  if (!row) return { err: "no creation record" };
  const tx = row.txHash || row.transactionHash;
  const t = await get({ module: "proxy", action: "eth_getTransactionByHash", txhash: tx });
  const input = t.result && t.result.input;
  if (!input) return { err: "creation input unavailable" };
  const body = input.slice(2);
  if (body.length < creationHex.length) return { err: "input shorter than local creationCode" };
  const args = body.slice(creationHex.length);
  // Decoding is the check. If these are not the real arguments the ABI decoder
  // rejects them here rather than Etherscan rejecting the whole submission with
  // a message that does not say why.
  try {
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(types, "0x" + args);
    return { args, decoded };
  } catch (e) {
    return { err: "args did not decode as " + types.join(",") + " (" + (e.shortMessage || e.message).slice(0, 60) + ")" };
  }
}

async function submit(addr, rel, name, std, args) {
  const body = new URLSearchParams({
    module: "contract", action: "verifysourcecode",
    codeformat: "solidity-standard-json-input", sourceCode: std,
    contractaddress: addr, contractname: `${rel}:${name}`,
    compilerversion: SOLC, constructorArguements: args,
  });
  await gate();
  const sub = await (await fetch(V2, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body })).json();
  if (sub.status !== "1") {
    if (/already verified/i.test(sub.result || "")) return "already verified";
    return "submit failed: " + (sub.result || sub.message);
  }
  for (let i = 0; i < 15; i++) {
    await sleep(5000);
    const st = await get({ module: "contract", action: "checkverifystatus", guid: sub.result });
    const res = String(st.result || "");
    if (/pass|already verified/i.test(res)) return res;
    if (/fail/i.test(res)) return res;
  }
  return "still pending after 75s";
}

(async () => {
  if (!KEY) { console.error("Set ETHERSCAN_API_KEY"); process.exit(1); }
  const only = process.argv[2];
  const rp = new ethers.JsonRpcProvider(process.env.STABLE_RPC_URL || "https://rpc.stable.xyz", 988,
    { staticNetwork: true, batchMaxCount: 1 });

  let ok = 0, skipped = 0, failed = 0;
  for (const [label, addr, file, name, types, mode] of CORE) {
    if (only && !label.toLowerCase().includes(only.toLowerCase())) continue;
    process.stdout.write(label.padEnd(20));
    try {
      const src = await get({ module: "contract", action: "getsourcecode", address: addr });
      if (((src.result || [])[0] || {}).SourceCode) { console.log("already verified"); ok++; skipped++; continue; }

      const { std, creation, rel } = compile(file, name);
      let args;
      if (mode === "internal") {
        // No creation input to slice; the arguments are the token's own strings.
        const t = new ethers.Contract(addr, ["function name() view returns (string)", "function symbol() view returns (string)"], rp);
        args = ethers.AbiCoder.defaultAbiCoder().encode(types, [await t.name(), await t.symbol()]).slice(2);
      } else {
        const r = await recoverArgs(addr, creation, types);
        if (r.err) { console.log("SKIP, " + r.err); failed++; continue; }
        args = r.args;
      }
      const res = await submit(addr, rel, name, std, args);
      console.log(res);
      if (/pass|already/i.test(res)) ok++; else failed++;
    } catch (e) {
      console.log("ERROR: " + (e.message || "").slice(0, 120));
      failed++;
    }
    await sleep(1500);
  }
  console.log(`\n${ok} verified (${skipped} already), ${failed} outstanding`);
})().catch((e) => { console.error(e.message); process.exit(1); });
