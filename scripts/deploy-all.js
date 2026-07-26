// One-command deploy of the entire platform, driven by brand.json.
//
//   PRIVATE_KEY=0x... node scripts/deploy-all.js            # deploy everything
//   PRIVATE_KEY=0x... node scripts/deploy-all.js --dry       # plan only
//   PRIVATE_KEY=0x... node scripts/deploy-all.js --only=locker,registry
//
// RESUMABLE: every address is written to deployments/<chainId>.json as soon as
// it exists. Re-running skips anything already deployed, so a failure halfway
// through costs you nothing. Delete an entry from that file to redeploy it.
//
// Deliberately NOT included: seeding pools, funding farms and launching the
// platform token's market. Those spend real money in amounts you should choose
// per launch, and they are separate scripts.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const brand = require(path.join(ROOT, "brand.json"));
const art = (n) => require(path.join(ROOT, "build", `${n}.json`));

const DRY = process.argv.includes("--dry");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").replace("--only=", "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const want = (step) => !ONLY.length || ONLY.includes(step);

function loadState(chainId) {
  const p = path.join(ROOT, "deployments", `${chainId}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try { return { p, s: JSON.parse(fs.readFileSync(p, "utf8")) }; } catch { return { p, s: {} }; }
}
function save(p, s) { fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n"); }

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY env var");
  const c = brand.chain;
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || c.rpc, undefined, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== c.chainId && !process.env.ALLOW_ANY_CHAIN) {
    throw new Error(`brand.json expects chain ${c.chainId}, RPC is ${net.chainId}`);
  }
  const wallet = new ethers.Wallet(pk, provider);
  const bal = await provider.getBalance(wallet.address);

  console.log(`\n  ${brand.name}  ->  ${c.name} (${c.chainId})`);
  console.log(`  deployer ${wallet.address}  ${ethers.formatEther(bal)} ${c.quoteSymbol}\n`);

  const { p: statePath, s: state } = loadState(c.chainId);
  const E = (v) => ethers.parseEther(String(v));

  const deploy = async (key, contract, args, label) => {
    if (!want(key)) return state[key];
    if (state[key]) { console.log(`  = ${label.padEnd(22)} ${state[key]}  (already deployed)`); return state[key]; }
    if (DRY) { console.log(`  + ${label.padEnd(22)} would deploy`); return null; }
    const a = art(contract);
    const inst = await new ethers.ContractFactory(a.abi, a.bytecode, wallet).deploy(...args);
    await inst.waitForDeployment();
    state[key] = await inst.getAddress();
    save(statePath, state);
    console.log(`  + ${label.padEnd(22)} ${state[key]}`);
    return state[key];
  };

  // 1. launchpad ------------------------------------------------------------
  const pad = await deploy("launchpad", "InstantLaunchpad", [
    c.positionManager, c.swapRouter, c.quoteToken,
    process.env.FEE_RECIPIENT || wallet.address,
    E(brand.economics.creationFeeUsdt),
    BigInt(brand.economics.creatorShareBps),
    E(brand.economics.startPriceUsdt),
    ethers.ZeroAddress, 0n,
  ], "Launchpad");

  // 2. platform token, launched through the pad ------------------------------
  if (want("platformToken") && !state.platformToken && !DRY && pad) {
    const padC = new ethers.Contract(pad, art("InstantLaunchpad").abi, wallet);
    const fee = await padC.creationFee();
    const meta = JSON.stringify({
      image: `${brand.domain}/logo.png`,
      description: brand.description,
      x: brand.socials.x, telegram: brand.socials.telegram, website: brand.domain,
    });
    const tx = await padC.launch(brand.platformToken.name, brand.platformToken.symbol, meta, 0, { value: fee });
    await tx.wait();
    state.platformToken = await padC.allTokens(0);
    save(statePath, state);
    console.log(`  + ${("$" + brand.platformToken.symbol).padEnd(22)} ${state.platformToken}`);
  } else if (state.platformToken) {
    console.log(`  = ${("$" + brand.platformToken.symbol).padEnd(22)} ${state.platformToken}  (already launched)`);
  }

  // 3. buyback burner, needs the platform token ------------------------------
  const burner = await deploy("buyback", "BuybackBurner",
    [c.quoteToken, c.swapRouter, state.platformToken || ethers.ZeroAddress, 10000], "BuybackBurner");

  // 4. reserve token, fees route to the burner -------------------------------
  const mintr = await deploy("reserveToken", "MINTR",
    [c.quoteToken, burner || wallet.address], `$${brand.reserveToken.symbol}`);

  // 5. utilities -------------------------------------------------------------
  await deploy("locker", "TokenLocker",
    [process.env.FEE_RECIPIENT || wallet.address, E(brand.economics.creationFeeUsdt)], "TokenLocker");

  await deploy("v3Locker", "V3PositionLocker", [c.positionManager], "V3PositionLocker");

  await deploy("metaRegistry", "TokenMetaRegistry", [[pad].filter(Boolean)], "MetaRegistry");

  // 6. gold synth, fees also burn the platform token -------------------------
  await deploy("goldSynth", "MintSynth", [
    brand.goldToken.name, brand.goldToken.symbol,
    c.quoteToken, c.goldOracle, burner || wallet.address,
  ], `$${brand.goldToken.symbol} engine`);

  console.log(`\n  state written to deployments/${c.chainId}.json`);
  if (DRY) { console.log("  (dry run, nothing was sent)\n"); return; }

  console.log(`
  Next, in order:
    1. seed the reserve token:   node scripts/deploy-mintr.js   (or seed() directly)
    2. deploy MintSwap:          node scripts/deploy-mintswap.js
    3. farms + pools:            deploy-farm.js, deploy-mgld-farm.js, seed-mgld-pool.js
    4. arb keeper:               node scripts/deploy-arb.js
    5. paste the addresses below into frontend/index.html and deploy the site
`);
  console.log("  frontend constants:");
  const map = {
    DEFAULT_PAD: state.launchpad, MINTD_ADDR: state.platformToken,
    MINTR_ADDR: state.reserveToken, BUYBACK_ADDR: state.buyback,
    LOCKER_ADDR: state.locker, V3_LOCKER_ADDR: state.v3Locker,
    META_REGISTRY_ADDR: state.metaRegistry, SYNTH_ADDR: state.goldSynth,
  };
  for (const [k, v] of Object.entries(map)) if (v) console.log(`    const ${k} = "${v}";`);
  console.log("");
}

main().catch((e) => { console.error("\n  " + (e.shortMessage || e.message || e) + "\n"); process.exit(1); });
