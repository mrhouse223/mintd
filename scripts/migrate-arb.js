// Redeploy MintrArb pointing its profit at a different destination, and move
// the float over from the old one.
//
// `burner` is immutable in MintrArb: there is no setter, and callerBps caps at
// 50%, so changing where profit lands means a new contract.
//
//   node scripts/migrate-arb.js --dry     # plan only, nothing sent
//   node scripts/migrate-arb.js           # do it
//
// Reads ARB, PROFIT_TO and the owner's key from .env. No secrets on the command
// line. Add PROFIT_TO=0x... to .env before running.
//
// PROFIT_TO can be any address. Point it at the BuybackBurner to keep profits
// buying and burning MINTD, or at a wallet to take them as USDT0.
//
// Steps: sweep the old float -> deploy the new arb -> fund it with the same
// amount -> print the .env line. The old contract is left in place, harmless
// and empty; pause it if you prefer.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// Read .env ourselves so keys never have to be typed on a command line, where
// they end up in shell history and in any screenshot of the terminal.
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

// Find whichever key in .env actually controls `owner`, rather than making the
// operator work out which one that is. Never prints a key, only an address.
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

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const MINTR = process.env.MINTR || "0x8817D05f2560189F3697028f639Dbb4C68688400";
const ROUTER = process.env.ROUTER || "0xb9274bEdaDcf31136F54A9501232e642a35C6Eb7";
const FACTORY = process.env.FACTORY || "0x65E12569E20E8706A4a60fCAB13e9069B78F9f8E";
const DRY = process.argv.includes("--dry");

const OLD_ABI = [
  "function owner() view returns (address)",
  "function burner() view returns (address)",
  "function available() view returns (uint256)",
  "function totalProfit() view returns (uint256)",
  "function sweep(address,uint256)",
  "function setParams(uint256,uint256,bool)",
];

async function main() {
  const env = loadEnv();
  const OLD_ARB = process.env.OLD_ARB || env.ARB;
  const PROFIT_TO = process.env.PROFIT_TO || env.PROFIT_TO;
  if (!PROFIT_TO || !ethers.isAddress(PROFIT_TO)) {
    throw new Error("Set PROFIT_TO to the address that should receive arb profit\n" +
      "         (add PROFIT_TO=0x... to .env, or pass it inline)");
  }
  if (!OLD_ARB) throw new Error("No ARB address found in .env, and OLD_ARB not set");

  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) {
    throw new Error(`Expected Stable Mainnet (988), got ${net.chainId}`);
  }

  // work out who owns the old arb, then pick the matching key out of .env
  const ownerAddr = await new ethers.Contract(OLD_ARB, OLD_ABI, provider).owner();
  const pk = process.env.PRIVATE_KEY || keyFor(ownerAddr, env);
  if (!pk) {
    throw new Error(`No key in .env controls ${ownerAddr}.\n` +
      `         Add the owner's key to .env as OWNER_KEY=0x... and re-run.\n` +
      `         (export it from MetaMask: Account details -> Show private key)`);
  }
  const wallet = new ethers.Wallet(pk, provider);
  const usdt = new ethers.Contract(USDT0, [
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ], wallet);

  console.log(`\n  deployer   ${wallet.address}`);
  console.log(`  profit to  ${PROFIT_TO}`);

  // 1. drain the old float ---------------------------------------------------
  let float = 0n;
  if (OLD_ARB) {
    const old = new ethers.Contract(OLD_ARB, OLD_ABI, wallet);
    const owner = await old.owner();
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(`old arb owner is ${owner}, not ${wallet.address}`);
    }
    float = await old.available();
    console.log(`\n  old arb    ${OLD_ARB}`);
    console.log(`    float          ${ethers.formatUnits(float, 6)} USDT0`);
    console.log(`    old profit to  ${await old.burner()}`);
    console.log(`    lifetime       ${ethers.formatUnits(await old.totalProfit(), 6)} USDT0`);
    if (!DRY && float > 0n) {
      console.log(`    pausing and sweeping ...`);
      await (await old.setParams(0, ethers.MaxUint256, true)).wait(); // stop it arbing mid-migration
      await (await old.sweep(USDT0, float)).wait();
      console.log(`    swept ${ethers.formatUnits(float, 6)} USDT0 back to you`);
    }
  }

  // 2. resolve the pair ------------------------------------------------------
  let pair = process.env.PAIR;
  if (!pair) {
    const fac = new ethers.Contract(FACTORY, ["function getPair(address,address) view returns (address)"], provider);
    pair = await fac.getPair(USDT0, MINTR);
  }
  if (!pair || pair === ethers.ZeroAddress) throw new Error("MINTR/USDT0 pair not found");
  console.log(`\n  pair       ${pair}`);

  if (DRY) { console.log(`\n  (dry run, nothing was sent)\n`); return; }

  // 3. deploy ----------------------------------------------------------------
  const art = require(path.join(__dirname, "..", "build", "MintrArb.json"));
  const arb = await new ethers.ContractFactory(art.abi, art.bytecode, wallet)
    .deploy(USDT0, MINTR, ROUTER, pair, PROFIT_TO);
  await arb.waitForDeployment();
  const addr = await arb.getAddress();
  console.log(`\n  new arb    ${addr}`);
  console.log(`  explorer   https://stablescan.xyz/address/${addr}`);

  // 4. refund the float ------------------------------------------------------
  const fundAmt = process.env.FUND ? ethers.parseUnits(process.env.FUND, 6) : float;
  if (fundAmt > 0n) {
    const bal = await usdt.balanceOf(wallet.address);
    if (bal < fundAmt) throw new Error(`need ${ethers.formatUnits(fundAmt, 6)} USDT0, have ${ethers.formatUnits(bal, 6)}`);
    if ((await usdt.allowance(wallet.address, addr)) < fundAmt) {
      await (await usdt.approve(addr, ethers.MaxUint256)).wait();
    }
    await (await arb.fund(fundAmt)).wait();
    console.log(`  float      ${ethers.formatUnits(await arb.available(), 6)} USDT0`);
  }

  console.log(`\n  Update .env:   ARB=${addr}`);
  console.log(`  Then:          pm2 delete all && pm2 start ecosystem.config.js && pm2 save`);
  console.log(`  (pm2 restart alone will not pick up a changed .env)\n`);
}

main().catch((e) => { console.error("\n  " + (e.shortMessage || e.message || e) + "\n"); process.exit(1); });
