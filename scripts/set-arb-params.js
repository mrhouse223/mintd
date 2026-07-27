// Adjust MintrArb parameters. Owner only.
//
//   node scripts/set-arb-params.js --caller-bps=0
//   node scripts/set-arb-params.js --caller-bps=0 --min-profit=0.01
//   node scripts/set-arb-params.js --pause
//   node scripts/set-arb-params.js --show                  (read only)
//   node scripts/set-arb-params.js --sweep                 (retire: pause + drain)
//   node scripts/set-arb-params.js --move-to=0xNewArb      (drain into another arb)
//
// ARB= in .env selects which contract you are acting on.
//
// callerBps is the share of each arb's profit paid to whoever triggered it.
// Setting it to 0 sends 100% to the BuybackBurner, i.e. treats arb profit
// exactly like every other platform fee.
//
// Note: at 0 there is no incentive for an outside keeper to run this. That is
// fine while you run the only keeper, but if yours is down nobody arbs and the
// pool price is free to drift from the contract price.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// Read .env directly so no address or key has to be exported into the shell.
function loadEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env, fall back to process env */ }
  return out;
}

// Pick whichever key in .env controls `owner`. Prints the variable name, never
// the key itself.
function keyFor(owner, env) {
  const want = owner.toLowerCase();
  for (const name of ["PRIVATE_KEY", "DEPLOYER_KEY", "OWNER_KEY", "KEEPER_KEY"]) {
    const v = env[name] || process.env[name];
    if (!v) continue;
    try {
      if (new ethers.Wallet(v).address.toLowerCase() === want) {
        console.log(`  using ${name} from .env (matches owner)`);
        return v;
      }
    } catch { /* not a valid key, skip */ }
  }
  return null;
}

const ENV = loadEnv();
const RPC_URL = process.env.RPC_URL || ENV.RPC_URL || "https://rpc.stable.xyz";
const ARB = process.env.ARB || ENV.ARB || "";

const ABI = [
  "function callerBps() view returns (uint256)",
  "function minProfit() view returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function totalProfit() view returns (uint256)",
  "function available() view returns (uint256)",
  "function setParams(uint256,uint256,bool)",
  "function sweep(address,uint256)",
  "function fund(uint256)",
];
// only one of these exists depending on which version the address is
const DEST_ABI = [
  "function burner() view returns (address)",
  "function profitTo() view returns (address)",
];
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : null;
};

async function main() {
  if (!ARB) throw new Error("Set ARB to the MintrArb address (or put it in .env)");
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const read = new ethers.Contract(ARB, ABI, provider);

  const [bps, minP, paused, owner, total] = [
    await read.callerBps(), await read.minProfit(), await read.paused(),
    await read.owner(), await read.totalProfit(),
  ];
  // v1 calls it burner, v2 calls it profitTo
  const d = new ethers.Contract(ARB, DEST_ABI, provider);
  let dest = "unknown";
  try { dest = await d.profitTo(); } catch { try { dest = await d.burner(); } catch {} }

  console.log(`\n  MintrArb ${ARB}`);
  console.log(`    owner          ${owner}`);
  console.log(`    profit to      ${dest}`);
  console.log(`    float          ${ethers.formatUnits(await read.available(), 6)} USDT0`);
  console.log(`    callerBps      ${bps}  (${Number(bps) / 100}% of profit to the caller)`);
  console.log(`    to platform    ${10000n - bps}  (${(10000 - Number(bps)) / 100}%)`);
  console.log(`    minProfit      ${ethers.formatUnits(minP, 6)} USDT0`);
  console.log(`    paused         ${paused}`);
  console.log(`    lifetime profit ${ethers.formatUnits(total, 6)} USDT0\n`);

  if (process.argv.includes("--show")) return;

  // --sweep pulls the float back to the owner and pauses, so a retired contract
  // cannot keep trading. --move-to sends it straight into another arb's float.
  const moveTo = arg("move-to");
  if (process.argv.includes("--sweep") || moveTo) {
    const pk0 = process.env.PRIVATE_KEY || keyFor(owner, ENV);
    if (!pk0) throw new Error(`No key in .env controls ${owner}. Add it as OWNER_KEY=0x...`);
    const w = new ethers.Wallet(pk0, provider);
    const c = new ethers.Contract(ARB, ABI, w);
    const bal = await read.available();
    if (bal === 0n) { console.log("  float already empty\n"); return; }

    console.log(`  pausing ${ARB} ...`);
    await (await c.setParams(0, ethers.MaxUint256, true)).wait();
    console.log(`  sweeping ${ethers.formatUnits(bal, 6)} USDT0 to ${w.address} ...`);
    await (await c.sweep(USDT0, bal)).wait();

    if (moveTo) {
      if (!ethers.isAddress(moveTo)) throw new Error("--move-to needs a valid address");
      const usdt = new ethers.Contract(USDT0, [
        "function approve(address,uint256) returns (bool)",
        "function allowance(address,address) view returns (uint256)",
      ], w);
      if ((await usdt.allowance(w.address, moveTo)) < bal) {
        await (await usdt.approve(moveTo, ethers.MaxUint256)).wait();
      }
      await (await new ethers.Contract(moveTo, ABI, w).fund(bal)).wait();
      const nowFloat = await new ethers.Contract(moveTo, ABI, provider).available();
      console.log(`  moved into ${moveTo}, float now ${ethers.formatUnits(nowFloat, 6)} USDT0\n`);
    } else {
      console.log(`  done\n`);
    }
    return;
  }

  const newBps = arg("caller-bps") != null ? BigInt(arg("caller-bps")) : bps;
  const newMin = arg("min-profit") != null ? ethers.parseUnits(arg("min-profit"), 6) : minP;
  const newPaused = process.argv.includes("--pause") ? true
    : process.argv.includes("--unpause") ? false : paused;

  if (newBps === bps && newMin === minP && newPaused === paused) {
    console.log("  nothing to change (pass --caller-bps, --min-profit, --pause or --unpause)\n");
    return;
  }
  if (newBps > 5000n) throw new Error("callerBps cannot exceed 5000 (50%)");

  const pk = process.env.PRIVATE_KEY || keyFor(owner, ENV);
  if (!pk) throw new Error(`No key in .env controls ${owner}. Add it as OWNER_KEY=0x...`);
  const wallet = new ethers.Wallet(pk, provider);
  if (wallet.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`key is ${wallet.address}, but the owner is ${owner}`);
  }

  console.log(`  setParams(${newBps}, ${ethers.formatUnits(newMin, 6)}, ${newPaused}) ...`);
  const tx = await new ethers.Contract(ARB, ABI, wallet).setParams(newBps, newMin, newPaused);
  await tx.wait();
  console.log(`  done: ${tx.hash}`);
  console.log(`  caller now takes ${Number(newBps) / 100}%, platform takes ${(10000 - Number(newBps)) / 100}%\n`);
}

main().catch((e) => { console.error("\n  " + (e.shortMessage || e.message || e) + "\n"); process.exit(1); });
