// Deploy the whole DEX layer to a chain that has none: MintSwap (Uniswap V2
// fork) plus a full Uniswap V3 stack.
//
//   node scripts/deploy-dex.js --chain arc-testnet            # dry run
//   node scripts/deploy-dex.js --chain arc-testnet --execute
//
// Written for Arc, where nothing is deployed: no V2, no V3, no WETH. The
// launchpad, the V3 locker and the zaps all depend on the V3 position manager,
// router and quoter, so "deploy the same contracts as mintd.fun" means
// standing up Uniswap first.
//
// Resumable. Every address is written to deployments/<chain>.json as it lands,
// and a re-run skips anything already recorded, so a run that dies halfway
// picks up where it stopped rather than deploying a second copy of everything.
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

const CHAINS = {
  "arc-testnet": {
    rpc: "https://rpc.testnet.arc.network",
    chainId: 5042002,
    // Native gas token, exposed as a 6-decimal ERC-20 at a system address.
    // CONFIRMED dual-decimal on 2026-07-28 against a funded address: native
    // eth_getBalance reports 18 decimals, balanceOf reports 6, and the ratio is
    // exactly 1e12. Identical to USDT0 on Stable, so CLAUDE.md gotcha 6 applies
    // here too. Comparing the two raw integers directly is a 1e12 error.
    gasToken: { address: "0x3600000000000000000000000000000000000000", symbol: "USDC", decimals: 6 },
    explorer: "https://testnet.arcscan.app",
    keyVar: "ARC_DEPLOYER_KEY",
  },
};

const EXECUTE = process.argv.includes("--execute");
const CHAIN = process.argv[process.argv.indexOf("--chain") + 1];
if (!CHAINS[CHAIN]) {
  console.error(`\n  usage: --chain <${Object.keys(CHAINS).join("|")}> [--execute]\n`);
  process.exit(1);
}
const CFG = CHAINS[CHAIN];
const OUT = path.join(ROOT, "deployments", `${CHAIN}.json`);

const uni = (p) => require(path.join(ROOT, "node_modules", "@uniswap", p));
const local = (n) => require(path.join(ROOT, "build", `${n}.json`));

function record() {
  try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { return { chain: CHAIN, chainId: CFG.chainId, contracts: {} }; }
}
function save(rec) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
}

function die(m) { console.error("\n  ABORT: " + m + "\n"); process.exit(1); }

(async () => {
  const rp = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId, { batchMaxCount: 1, staticNetwork: true });

  const rawKey = process.env[CFG.keyVar] || ENV[CFG.keyVar];
  if (!rawKey) die(`${CFG.keyVar} not set in .env. Use a FRESH key for this chain, never the Stable deployer.`);
  let k = rawKey.trim();
  if (/^[0-9a-fA-F]{64}$/.test(k)) k = "0x" + k;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) die(`${CFG.keyVar} is not a 32-byte private key`);
  const signer = new ethers.Wallet(k, rp);

  // A key that also controls Stable would defeat the point of a fresh one.
  const STABLE_DEPLOYER = "0x8Fc933374a2C1AA6d19c5F2BDa33Ad0B6bE9eBA4";
  if (signer.address.toLowerCase() === STABLE_DEPLOYER.toLowerCase())
    die("that is the compromised Stable deployer. Use a fresh key for this chain.");

  const bal = await rp.getBalance(signer.address);
  const head = await rp.getBlockNumber();
  console.log(`\nchain      ${CHAIN}  (id ${CFG.chainId})  block ${head}`);
  console.log(`deployer   ${signer.address}   (from .env ${CFG.keyVar})`);
  console.log(`balance    ${ethers.formatEther(bal)} ${CFG.gasToken.symbol}`);
  console.log(`mode       ${EXECUTE ? "EXECUTE" : "DRY RUN - nothing will be sent"}\n`);

  if (EXECUTE && bal === 0n)
    die(`deployer has no gas. Fund ${signer.address} at https://faucet.circle.com (select Arc Testnet, 20 USDC per 2 hours).`);

  const rec = record();
  const have = (n) => rec.contracts[n];

  const deploy = async (name, abi, bytecode, args = [], libs = null) => {
    if (have(name)) { console.log(`  ${name.padEnd(34)} already at ${rec.contracts[name]}`); return rec.contracts[name]; }
    if (!EXECUTE) { console.log(`  ${name.padEnd(34)} would deploy${args.length ? "  args: " + args.join(", ") : ""}`); return "0x" + "0".repeat(40); }
    let code = bytecode;
    if (libs) for (const [ph, addr] of Object.entries(libs)) code = code.split(ph).join(addr.slice(2).toLowerCase());
    if (code.includes("__$")) die(`${name} still has an unlinked library placeholder`);
    const f = new ethers.ContractFactory(abi, code, signer);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    const addr = await c.getAddress();
    rec.contracts[name] = addr;
    save(rec);
    console.log(`  ${name.padEnd(34)} ${addr}`);
    return addr;
  };

  console.log("MintSwap (Uniswap V2 fork) and the V3 stack\n");

  // WETH9. Both the V2 router and the whole V3 periphery require a wrapped
  // native token even on a chain whose gas is an ERC-20 already, because the
  // interfaces are hardcoded to one.
  const weth = await deploy("WETH9", local("WETH9").abi, local("WETH9").bytecode);

  // ---- MintSwap: V2 ------------------------------------------------------
  const facV2Art = uni("v2-core/build/UniswapV2Factory.json");
  const facV2 = await deploy("MintSwapFactory", facV2Art.abi, facV2Art.bytecode, [signer.address]);
  const rtV2Art = uni("v2-periphery/build/UniswapV2Router02.json");
  await deploy("MintSwapRouter", rtV2Art.abi, rtV2Art.bytecode, [facV2, weth]);

  // ---- Uniswap V3 --------------------------------------------------------
  const facV3Art = uni("v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
  const facV3 = await deploy("UniswapV3Factory", facV3Art.abi, facV3Art.bytecode);

  // NonfungibleTokenPositionDescriptor links NFTDescriptor at deploy time.
  const nftDescArt = uni("v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json");
  const nftDescLib = await deploy("NFTDescriptor", nftDescArt.abi, nftDescArt.bytecode);

  const descArt = uni("v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json");
  // The label is a bytes32 of the native symbol, right-padded. It only affects
  // the SVG a position NFT renders, but a wrong length reverts the deploy.
  const label = ethers.encodeBytes32String(CFG.gasToken.symbol);
  const desc = await deploy("PositionDescriptor", descArt.abi, descArt.bytecode, [weth, label],
    { "__$cea9be979eee3d87fb124d6cbb244bb0b5$__": nftDescLib });

  const npmArt = uni("v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
  const npm = await deploy("NonfungiblePositionManager", npmArt.abi, npmArt.bytecode, [facV3, weth, desc]);

  const routerArt = uni("swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");
  await deploy("SwapRouter02", routerArt.abi, routerArt.bytecode, [facV2, facV3, npm, weth]);

  const quoterArt = uni("v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json");
  await deploy("QuoterV2", quoterArt.abi, quoterArt.bytecode, [facV3, weth]);

  if (!EXECUTE) {
    console.log(`\ndry run only. re-run with --execute once ${signer.address} has gas.\n`);
    return;
  }

  rec.gasToken = CFG.gasToken;
  rec.deployer = signer.address;
  save(rec);

  // ---- prove the V3 stack actually works ---------------------------------
  console.log("\nsanity checks");
  const f3 = new ethers.Contract(rec.contracts.UniswapV3Factory,
    ["function feeAmountTickSpacing(uint24) view returns (int24)", "function owner() view returns (address)"], rp);
  for (const fee of [500, 3000, 10000]) {
    const ts = await f3.feeAmountTickSpacing(fee);
    console.log(`  fee tier ${String(fee).padStart(5)}  tickSpacing ${ts}${ts === 0n ? "  NOT ENABLED" : ""}`);
  }
  const nc = new ethers.Contract(rec.contracts.NonfungiblePositionManager,
    ["function factory() view returns (address)", "function WETH9() view returns (address)"], rp);
  console.log(`  NPM.factory matches:  ${(await nc.factory()).toLowerCase() === rec.contracts.UniswapV3Factory.toLowerCase()}`);
  console.log(`  NPM.WETH9 matches:    ${(await nc.WETH9()).toLowerCase() === weth.toLowerCase()}`);

  console.log(`\nrecorded in ${path.relative(ROOT, OUT)}`);
  console.log(`explorer: ${CFG.explorer}/address/${rec.contracts.UniswapV3Factory}\n`);
})().catch((e) => { console.error("\n" + (e.shortMessage || e.message) + "\n"); process.exit(1); });
