// Deploys BondMarket to Stable (chain 988).
//
//   node scripts/deploy-bonds.js --dry     full sequence against ganache
//   node scripts/deploy-bonds.js           the real thing
//
// WHICH KEY, AND WHY IT MATTERS
// Whoever sends the deployment becomes `owner`. The original deployer key is
// compromised (see CLAUDE.md) and must never hold a role again, and the keeper
// is gas-only by policy, so this uses OWNER_KEY and then hands ownership to the
// Safe. The key is matched by ADDRESS and only its variable name is ever
// printed; nothing here reads or logs a key.
//
// The allowlist is set BEFORE ownership moves. Launchpad coins need no listing
// (both pads are passed to the constructor and isAllowed asks them directly),
// but FEFER does, and once the Safe owns this it takes a Safe transaction.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));

const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const SAFE  = "0xE5F40204C8E921834C70B0E2631bE79F076B0e28";
const PAD_V2 = "0xCe7b02b3f0e5665f1C23E018039e9b6836c6221b";
const PAD_V1 = "0x75FAdB240006313294A5B502CA9268cB03Fa9AC0";
const FEFER  = "0xeaf7aC0FdF150CDD89340fB762D83848De6A7b83";

const FEE_BPS = 100;                          // 1%, to the Safe
const CREATE_FEE = ethers.parseEther("1");    // $1. NATIVE USDT0 is 18-dec (gotcha 6)

// STABLE (0x…1003) is deliberately absent. It is a client precompile with no
// readable source whose transferFrom reverted on a zero-value probe, and escrow
// is built on transferFrom. It goes on the list only after a fork test.

function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

async function run(signer, provider, label) {
  const art = build("BondMarket");
  const me = await signer.getAddress();
  console.log(`\n[${label}] deploying from ${me}`);

  const f = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const c = await f.deploy(USDT0, SAFE, FEE_BPS, CREATE_FEE, [PAD_V2, PAD_V1]);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`[${label}] BondMarket at ${addr}`);

  // FEFER before the handover, or it needs a Safe transaction afterwards.
  await (await c.setAllowed(FEFER, true)).wait();
  console.log(`[${label}] FEFER allowlisted`);

  // Read back BEFORE handing over, so a wrong constructor argument is caught
  // while this key can still redeploy cheaply.
  const checks = {
    usdt0: await c.usdt0(),
    feeRecipient: await c.feeRecipient(),
    feeBps: (await c.feeBps()).toString(),
    createFee: ethers.formatEther(await c.createFee()),
    owner: await c.owner(),
    paused: await c.paused(),
    padCount: (await c.padCount()).toString(),
    feferAllowed: await c.isAllowed(FEFER),
    zeroAllowed: await c.isAllowed(ethers.ZeroAddress),
  };
  console.log(`[${label}] state:`, checks);

  const bad = [];
  if (checks.usdt0.toLowerCase() !== USDT0.toLowerCase()) bad.push("usdt0");
  if (checks.feeRecipient.toLowerCase() !== SAFE.toLowerCase()) bad.push("feeRecipient is not the Safe");
  if (checks.feeBps !== "100") bad.push("feeBps");
  if (checks.createFee !== "1.0") bad.push("createFee");
  if (checks.padCount !== "2") bad.push("padCount");
  if (!checks.feferAllowed) bad.push("FEFER not allowed");
  if (checks.zeroAllowed) bad.push("zero address allowed");
  if (checks.paused) bad.push("deployed paused");
  if (bad.length) throw new Error("post-deploy checks failed: " + bad.join(", "));

  // A launchpad coin must pass WITHOUT being listed, which is the whole point of
  // handing the pads to the constructor. Skipped on the dry run, where those
  // addresses hold no code: staticcall to an empty address returns no data, so
  // the check would fail for a reason that says nothing about the deployment.
  // scripts/test-bonds.js covers this path against both pad struct shapes.
  if (label === "live") {
    const mintd = "0xE62C47074abb52A2bc87B62E47e3411A0020f020";
    const padOk = await c.isAllowed(mintd);
    console.log(`[${label}] launchpad coin allowed without listing:`, padOk);
    if (!padOk) throw new Error("pad-derived allowlist is not working");
  }

  await (await c.transferOwnership(SAFE)).wait();
  const finalOwner = await c.owner();
  console.log(`[${label}] owner -> ${finalOwner}`);
  if (finalOwner.toLowerCase() !== SAFE.toLowerCase()) throw new Error("ownership did not move to the Safe");

  return addr;
}

(async () => {
  const dry = process.argv.includes("--dry");
  if (dry) {
    const ganache = require("ganache");
    const gp = ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 1000 }, miner: { blockGasLimit: "0x1C9C380" } });
    const provider = new ethers.BrowserProvider(gp);
    await run(await provider.getSigner(0), provider, "dry");
    console.log("\nDRY RUN OK. Re-run without --dry to deploy for real.");
    process.exit(0);
  }

  const env = readEnv();
  const keyVar = "OWNER_KEY";
  const key = env[keyVar];
  if (!key) throw new Error(`${keyVar} is not set in .env`);
  const provider = new ethers.JsonRpcProvider(process.env.STABLE_RPC_URL || "https://rpc.stable.xyz", 988,
    { staticNetwork: true, batchMaxCount: 1 });
  const signer = new ethers.Wallet(key, provider);
  const me = await signer.getAddress();

  const BURNED = "0x8fc933374a2c1aa6d19c5f2bda33ad0b6be9eba4";
  if (me.toLowerCase() === BURNED) throw new Error("refusing to deploy from the compromised deployer key");
  const bal = await provider.getBalance(me);
  console.log(`using ${keyVar} (${me}), balance ${ethers.formatEther(bal)}`);
  if (bal < ethers.parseEther("1")) throw new Error("not enough native USDT0 for gas");

  const addr = await run(signer, provider, "live");
  console.log(`\nDEPLOYED: ${addr}`);
  console.log("Next: set bondMarket in frontend/index.html and flip features.bonds, then verify on stablescan.");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
