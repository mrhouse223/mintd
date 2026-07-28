// Deploy MintdLaunchpad to Stable, replacing the front-runnable launchpad.
//
//   node scripts/deploy-stable-v2.js            dry run
//   node scripts/deploy-stable-v2.js --execute  for real
//
// WHY
// InstantLaunchpad at 0x75FAdB24 is immutable and lets a stranger set any
// creator's launch price, taking the whole supply for about $50. Reproduced in
// scripts/test-launch-frontrun.js. It cannot be patched, only replaced.
//
// WHAT DOES NOT CHANGE
// 90/10 creator split, the 1 USDT0 creation fee, the $3,000 starting market
// cap, and the dev buy stays UNCAPPED, exactly as today. This deployment is a
// security fix and nothing else: a creator launching on the new pad gets the
// same deal they got on the old one. Every existing token stays where it is,
// on the old pad, with its liquidity locked, forever.
//
// OWNERSHIP
// The Safe cannot deploy, since its key is not on this machine, so the deploy
// is signed by a funded key. Owner AND both fee recipients are set to the Safe
// in the constructor, so the deploying key never holds admin or receives a
// unit of revenue at any point. There is no post-deploy window to exploit.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
function loadEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
}
const ENV = loadEnv();

const RPC = process.env.RPC_URL || "https://rpc.stable.xyz";
const CHAIN_ID = 988;
const SAFE = "0xE5F40204C8E921834C70B0E2631bE79F076B0e28";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const MINTR = "0x8817D05f2560189F3697028f639Dbb4C68688400";
const NPM = "0x3BdC3437405f7D801b6036532713fc1F179136a6";
const ROUTER = "0x32eaf9B5d5F2CD7361c5012890C943D7de84C22a";
const OLD_PAD = "0x75FAdB240006313294A5B502CA9268cB03Fa9AC0";
const OUT = path.join(ROOT, "deployments", "stable.json");

// Read live off the old pad rather than retyped, so the new pad cannot quietly
// launch on different terms than the one it replaces.
const PARAMS = {
  creationFee: ethers.parseEther("1"),
  creatorShareBps: 9000n,   // unchanged: creators keep 90%
  buybackShareBps: 0n,      // no buyback split on Stable; the whole 10% is one payee
  devBuyCapBps: 10000n,     // cap DISABLED, matching today's behaviour
  startPriceUsdt1e18: 3000000000000n,
  startPriceMintr1e18: 3000000000000n,
};

const EXECUTE = process.argv.includes("--execute");
const local = (n) => require(path.join(ROOT, "build", `${n}.json`));
function die(m) { console.error("\n  ABORT: " + m + "\n"); process.exit(1); }

(async () => {
  const rp = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { batchMaxCount: 1, staticNetwork: true });

  // Any funded key. Ownership goes to the Safe within the same run, and the
  // fee recipients never point here at all.
  let signer = null, used = null;
  for (const v of ["DEPLOYER_KEY", "OWNER_KEY", "KEEPER_KEY"]) {
    let k = (process.env[v] || ENV[v] || "").trim();
    if (!k) continue;
    if (/^[0-9a-fA-F]{64}$/.test(k)) k = "0x" + k;
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) continue;
    const w = new ethers.Wallet(k, rp);
    if ((await rp.getBalance(w.address)) > ethers.parseEther("2")) { signer = w; used = v; break; }
  }
  if (!signer) die("no funded key found among DEPLOYER_KEY, OWNER_KEY, KEEPER_KEY");

  console.log(`\nchain      stable (988)   block ${await rp.getBlockNumber()}`);
  console.log(`deployer   ${signer.address}   (from ${used})`);
  console.log(`balance    ${ethers.formatEther(await rp.getBalance(signer.address))} USDT0`);
  console.log(`owner will be the Safe ${SAFE}`);
  console.log(`mode       ${EXECUTE ? "EXECUTE" : "DRY RUN"}\n`);

  // Confirm the terms we are about to deploy actually match the live pad, so a
  // "security fix only" deployment cannot silently change the deal.
  const old = new ethers.Contract(OLD_PAD, [
    "function creationFee() view returns (uint256)",
    "function creatorShareBps() view returns (uint256)",
    "function startPriceUsdt1e18() view returns (uint256)",
    "function feeRecipient() view returns (address)",
    "function tokenCount() view returns (uint256)",
  ], rp);
  const liveFee = await old.creationFee();
  const liveShare = await old.creatorShareBps();
  const livePrice = await old.startPriceUsdt1e18();
  const liveRecipient = await old.feeRecipient();
  const liveCount = await old.tokenCount();

  console.log("terms on the live pad, which the new one must match");
  const cmp = (label, live, want) => {
    const ok = String(live) === String(want);
    console.log(`  ${label.padEnd(20)} live ${String(live).padEnd(24)} new ${String(want)}   ${ok ? "same" : "DIFFERENT"}`);
    return ok;
  };
  let same = true;
  same = cmp("creationFee", liveFee, PARAMS.creationFee) && same;
  same = cmp("creatorShareBps", liveShare, PARAMS.creatorShareBps) && same;
  same = cmp("startPrice", livePrice, PARAMS.startPriceUsdt1e18) && same;
  console.log(`  ${"feeRecipient".padEnd(20)} live ${liveRecipient}   new ${SAFE}   ${liveRecipient.toLowerCase() === SAFE.toLowerCase() ? "same" : "DIFFERENT"}`);
  console.log(`  ${"existing tokens".padEnd(20)} ${liveCount} on the old pad, none of which move\n`);
  if (!same) die("the new terms differ from the live pad. This deployment is meant to change nothing but the bug.");

  let rec = { chain: "stable", chainId: CHAIN_ID, contracts: {} };
  try { rec = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}
  rec.contracts = rec.contracts || {};
  rec.contracts.InstantLaunchpad = OLD_PAD;

  if (!EXECUTE) {
    console.log("would deploy MintdLaunchpad with:");
    console.log(`  npm ${NPM}\n  router ${ROUTER}\n  quote ${USDT0}`);
    console.log(`  buyback ${SAFE}\n  ops ${SAFE}`);
    console.log(`  creationFee ${ethers.formatEther(PARAMS.creationFee)}  creatorShareBps ${PARAMS.creatorShareBps}`);
    console.log(`  buybackShareBps ${PARAMS.buybackShareBps}  devBuyCapBps ${PARAMS.devBuyCapBps} (disabled)`);
    console.log(`  mintr ${MINTR}`);
    console.log("would then deploy TokenMetaRegistry([oldPad, newPad]); owner is the Safe from birth");
    console.log("\ndry run only. re-run with --execute\n");
    return;
  }

  // ------------------------------------------------------------------ deploy
  // Owner is the Safe from the constructor, so there is no post-deploy
  // transfer window and the deploying key never holds admin. The old flow, a
  // second transferOwnership transaction, left tens of blocks in which anyone
  // else holding the deploying key could capture this immutable contract's
  // admin permanently.
  const a = local("MintdLaunchpad");
  const pad = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(
    SAFE, NPM, ROUTER, USDT0, SAFE, SAFE,
    PARAMS.creationFee, PARAMS.creatorShareBps, PARAMS.buybackShareBps, PARAMS.devBuyCapBps,
    PARAMS.startPriceUsdt1e18, MINTR, PARAMS.startPriceMintr1e18
  );
  await pad.waitForDeployment();
  const padAddr = await pad.getAddress();
  rec.contracts.MintdLaunchpad = padAddr;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
  console.log(`  MintdLaunchpad     ${padAddr}`);

  // The existing registry's `pads` is constructor-set with no setter, so it can
  // never learn about this pad and creators on it could not edit their pages.
  const r = local("TokenMetaRegistry");
  const reg = await new ethers.ContractFactory(r.abi, r.bytecode, signer).deploy([OLD_PAD, padAddr]);
  await reg.waitForDeployment();
  const regAddr = await reg.getAddress();
  rec.contracts.TokenMetaRegistry = regAddr;
  fs.writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
  console.log(`  TokenMetaRegistry  ${regAddr}`);

  // ------------------------------------------------------------ sanity check
  console.log("\nread back from chain");
  const p = new ethers.Contract(padAddr, [
    "function creationFee() view returns (uint256)",
    "function creatorShareBps() view returns (uint256)",
    "function buybackShareBps() view returns (uint256)",
    "function devBuyCapBps() view returns (uint256)",
    "function maxDevBuyTokens() view returns (uint256)",
    "function quoteToken() view returns (address)",
    "function usdt0() view returns (address)",
    "function mintr() view returns (address)",
    "function buybackRecipient() view returns (address)",
    "function opsRecipient() view returns (address)",
    "function owner() view returns (address)",
    "function tokenCount() view returns (uint256)",
    "function nativeToErc20() view returns (uint256)",
    "function transferOwnership(address)",
  ], signer);

  let bad = 0;
  const want = (label, got, expected) => {
    const ok = String(got).toLowerCase() === String(expected).toLowerCase();
    if (!ok) bad++;
    console.log(`  ${label.padEnd(20)} ${got}${ok ? "" : `   EXPECTED ${expected}`}`);
  };
  want("creationFee", await p.creationFee(), PARAMS.creationFee);
  want("creatorShareBps", await p.creatorShareBps(), 9000n);
  want("buybackShareBps", await p.buybackShareBps(), 0n);
  want("devBuyCapBps", await p.devBuyCapBps(), 10000n);
  want("maxDevBuyTokens", await p.maxDevBuyTokens(), ethers.parseEther("1000000000"));
  want("quoteToken", await p.quoteToken(), USDT0);
  want("usdt0 alias", await p.usdt0(), USDT0);
  want("mintr", await p.mintr(), MINTR);
  want("buybackRecipient", await p.buybackRecipient(), SAFE);
  want("opsRecipient", await p.opsRecipient(), SAFE);
  want("nativeToErc20", await p.nativeToErc20(), 10n ** 12n);
  console.log(`  ${"tokenCount".padEnd(20)}${await p.tokenCount()}`);

  const regC = new ethers.Contract(regAddr, ["function pads(uint256) view returns (address)"], rp);
  want("registry pads[0]", await regC.pads(0), OLD_PAD);
  want("registry pads[1]", await regC.pads(1), padAddr);

  // Owner was set to the Safe in the constructor, so there is nothing to hand
  // over. Confirm it rather than assume it.
  const finalOwner = await p.owner();
  console.log(`  ${"owner".padEnd(20)}${finalOwner}   ${finalOwner.toLowerCase() === SAFE.toLowerCase() ? "the Safe, correct" : "WRONG"}`);
  if (finalOwner.toLowerCase() !== SAFE.toLowerCase()) { bad++; }

  if (bad) die(`${bad} sanity check(s) mismatched. Do NOT point the frontend at this.`);

  console.log(`\nrecorded in ${path.relative(ROOT, OUT)}`);
  console.log(`old pad stays live at ${OLD_PAD}; its ${liveCount} tokens are untouched`);
  console.log(`explorer: https://stablescan.xyz/address/${padAddr}\n`);
})().catch((e) => { console.error("\n" + (e.shortMessage || e.message) + "\n"); process.exit(1); });
