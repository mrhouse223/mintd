// Deploys MintrArbMulti, registers every MINTR/USDT0 pool, and funds the float.
//
//   node scripts/deploy-arb-multi.js --dry
//   node scripts/deploy-arb-multi.js
//   FUND=200 node scripts/deploy-arb-multi.js
//
// Reads PROFIT_TO and the deployer key from .env. Pools default to the MintSwap
// pair (resolved from the factory) plus the canonical Uniswap V2 pair; override
// with POOLS=0xaddr,0xaddr.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function loadEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* fall back to process env */ }
  return out;
}
const ENV = loadEnv();

const RPC_URL = process.env.RPC_URL || ENV.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const MINTR = process.env.MINTR || "0x8817D05f2560189F3697028f639Dbb4C68688400";
const FACTORY = process.env.FACTORY || "0x65E12569E20E8706A4a60fCAB13e9069B78F9f8E";
const UNI_PAIR = "0x5e89ECD99A02BD709C71cDF62518490E07Fb567b"; // canonical Uniswap V2 MINTR/USDT0
const DRY = process.argv.includes("--dry");

async function main() {
  const profitTo = process.env.PROFIT_TO || ENV.PROFIT_TO;
  if (!profitTo || !ethers.isAddress(profitTo)) {
    throw new Error("Set PROFIT_TO in .env to the address that should receive arb profit");
  }
  const pk = process.env.PRIVATE_KEY || ENV.OWNER_KEY || ENV.PRIVATE_KEY || ENV.DEPLOYER_KEY;
  if (!pk) throw new Error("No deployer key in .env (OWNER_KEY or PRIVATE_KEY)");

  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) {
    throw new Error(`Expected Stable Mainnet (988), got ${net.chainId}`);
  }
  const wallet = new ethers.Wallet(pk, provider);
  console.log(`\n  deployer   ${wallet.address}`);
  console.log(`  profit to  ${profitTo}`);

  // which pools to register
  let pools = (process.env.POOLS || ENV.POOLS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!pools.length) {
    const fac = new ethers.Contract(FACTORY, ["function getPair(address,address) view returns (address)"], provider);
    const mintSwap = await fac.getPair(USDT0, MINTR);
    pools = [mintSwap, UNI_PAIR].filter((a) => a && a !== ethers.ZeroAddress);
  }
  // drop anything that is not actually a live USDT0/MINTR pair with reserves
  const checked = [];
  for (const p of pools) {
    try {
      const c = new ethers.Contract(p, [
        "function token0() view returns (address)",
        "function token1() view returns (address)",
        "function getReserves() view returns (uint112,uint112,uint32)",
      ], provider);
      const [t0, t1] = [await c.token0(), await c.token1()];
      const pairOk = [t0.toLowerCase(), t1.toLowerCase()].sort().join() ===
        [USDT0.toLowerCase(), MINTR.toLowerCase()].sort().join();
      if (!pairOk) { console.log(`  skip ${p}: not a USDT0/MINTR pair`); continue; }
      const [r0, r1] = await c.getReserves();
      if (r0 === 0n || r1 === 0n) { console.log(`  skip ${p}: empty pool`); continue; }
      checked.push(p);
      console.log(`  pool       ${p}`);
    } catch (e) {
      console.log(`  skip ${p}: ${e.shortMessage || e.message}`);
    }
  }
  if (!checked.length) throw new Error("no usable pools found");

  if (DRY) { console.log(`\n  (dry run, nothing was sent)\n`); return; }

  const art = require(path.join(__dirname, "..", "build", "MintrArbMulti.json"));
  const arb = await new ethers.ContractFactory(art.abi, art.bytecode, wallet)
    .deploy(USDT0, MINTR, profitTo);
  await arb.waitForDeployment();
  const addr = await arb.getAddress();
  console.log(`\n  MintrArbMulti  ${addr}`);
  console.log(`  explorer       https://stablescan.xyz/address/${addr}`);

  for (const p of checked) {
    await (await arb.addPool(p, 30)).wait(); // 30 bps = the standard V2 fee
    console.log(`  registered     ${p}`);
  }

  // report the spread on each pool so a bad wiring is obvious immediately
  console.log("");
  for (let i = 0; i < checked.length; i++) {
    const [m, c] = await arb.prices(i);
    const dev = (Number(ethers.formatEther(m)) / Number(ethers.formatEther(c)) - 1) * 100;
    console.log(`  pool ${i}  market $${Number(ethers.formatEther(m)).toFixed(6)}  vs backing $${Number(ethers.formatEther(c)).toFixed(6)}  (${dev >= 0 ? "+" : ""}${dev.toFixed(2)}%)`);
  }

  const fund = process.env.FUND || ENV.ARB_FUND;
  if (fund) {
    const amt = ethers.parseUnits(fund, 6);
    const usdt = new ethers.Contract(USDT0, [
      "function approve(address,uint256) returns (bool)",
      "function allowance(address,address) view returns (uint256)",
    ], wallet);
    if ((await usdt.allowance(wallet.address, addr)) < amt) {
      await (await usdt.approve(addr, ethers.MaxUint256)).wait();
    }
    await (await arb.fund(amt)).wait();
    console.log(`\n  float          ${ethers.formatUnits(await arb.available(), 6)} USDT0`);
  }

  console.log(`\n  Update .env:   ARB=${addr}`);
  console.log(`  Then:          pm2 delete all && pm2 start ecosystem.config.js && pm2 save\n`);
}

main().catch((e) => { console.error("\n  " + (e.shortMessage || e.message || e) + "\n"); process.exit(1); });
