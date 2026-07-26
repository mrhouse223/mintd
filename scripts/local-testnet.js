// One-command local sandbox: boots a local chain, deploys the FULL mintd.fun
// stack (mock USDT0, real Uniswap V3, InstantLaunchpad with $MINTD launched,
// MintSwap V2 fork, seeded USDT0/WgUSDT pool, funded MINTD farm), then serves
// the real frontend at http://localhost:8080 pre-wired to all of it.
//
//   node scripts/compile.js && node scripts/local-testnet.js
//
// MetaMask setup (printed again at boot):
//   Network: http://127.0.0.1:8545, chain id 31337, symbol USDT0
//   Import the printed test private key (play money only!)
const path = require("path");
const fs = require("fs");
const http = require("http");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const uni = (p) => require(p);
const E = (v) => ethers.parseEther(String(v));
const U = (v) => ethers.parseUnits(String(v), 6);

async function main() {
  // ---------------------------------------------------------- local chain
  const server = ganache.server({
    logging: { quiet: true },
    chain: { chainId: 31337 },
    wallet: { defaultBalance: 100000, deterministic: true },
    miner: { blockGasLimit: "0x1C9C380" },
  });
  await server.listen(8545);
  const provider = new ethers.BrowserProvider(server.provider);
  const accounts = await server.provider.request({ method: "eth_accounts", params: [] });
  const keys = server.provider.getInitialAccounts();
  const deployer = await provider.getSigner(0);
  const GS = { gasLimit: 9_000_000 };
  console.log("local chain on http://127.0.0.1:8545 (chain id 31337)");

  const dep = async (name, ...args) => {
    const a = build(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const depArt = async (art, ...args) => {
    const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };

  // ------------------------------------------------- USDT0 + Uniswap v3
  const usdt = await dep("MockUSDT0");
  const usdtAddr = await usdt.getAddress();
  const v3fac = await depArt(uni("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"));
  const npm = await depArt(
    uni("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"),
    await v3fac.getAddress(), usdtAddr, deployer.address
  );
  const router = await depArt(
    uni("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json"),
    ethers.ZeroAddress, await v3fac.getAddress(), await npm.getAddress(), usdtAddr
  );
  const quoter = await depArt(
    uni("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json"),
    await v3fac.getAddress(), usdtAddr
  );
  console.log("uniswap v3 stack deployed");

  // --------------------------------------------------------- launchpad
  const pad = await dep("InstantLaunchpad",
    await npm.getAddress(), await router.getAddress(), usdtAddr,
    deployer.address, E(1), 9000n, 3_000_000_000_000n
  );
  const padAddr = await pad.getAddress();
  const meta = JSON.stringify({ description: "Local test $MINTD. Every launch lands in a locked USDT0 pool.", website: "https://mintd.fun" });
  await (await pad.launch("mintd.fun", "MINTD", meta, 0, { value: E(101), ...GS })).wait(); // 1 fee + 100 dev buy
  const mintdAddr = await pad.allTokens(0);
  console.log(`launchpad: ${padAddr}`);
  console.log(`$MINTD:    ${mintdAddr}`);

  // ------------------------------------------- MintSwap fork + farm
  const wg = await dep("MemeToken20", "Wrapped gUSDT", "WgUSDT", "", E(1_000_000), deployer.address);
  const v2fac = await depArt(uni("@uniswap/v2-core/build/UniswapV2Factory.json"), deployer.address);
  const v2router = await depArt(uni("@uniswap/v2-periphery/build/UniswapV2Router02.json"), await v2fac.getAddress(), usdtAddr);
  const v2rAddr = await v2router.getAddress();
  await (await usdt.approve(v2rAddr, ethers.MaxUint256, GS)).wait();
  await (await wg.approve(v2rAddr, ethers.MaxUint256, GS)).wait();
  const dl = Math.floor(Date.now() / 1000) + 3600;
  await (await v2router.addLiquidity(usdtAddr, await wg.getAddress(), U(500), E(500), 0, 0, deployer.address, dl, GS)).wait();
  const lpAddr = await v2fac.getPair(usdtAddr, await wg.getAddress());
  const farm = await dep("StakingRewards", mintdAddr, lpAddr);
  const mintdC = new ethers.Contract(mintdAddr, build("MemeToken20").abi, deployer);
  await (await mintdC.transfer(await farm.getAddress(), E(10_000_000))).wait();
  await (await farm.notifyRewardAmount(E(10_000_000), GS)).wait();
  console.log(`mintswap:  router ${v2rAddr}`);
  console.log(`farm 1:    ${await farm.getAddress()} USDT0/WgUSDT (10M MINTD / 30 days)`);

  // second farm: USDT0/MINTD (seed at ~launch price, fund 5M MINTD)
  await (await mintdC.approve(v2rAddr, ethers.MaxUint256, GS)).wait();
  await (await v2router.addLiquidity(usdtAddr, mintdAddr, U(50), E(15_000_000), 0, 0, deployer.address, dl, GS)).wait();
  const lp2Addr = await v2fac.getPair(usdtAddr, mintdAddr);
  const farm2 = await dep("StakingRewards", mintdAddr, lp2Addr);
  await (await mintdC.transfer(await farm2.getAddress(), E(5_000_000))).wait();
  await (await farm2.notifyRewardAmount(E(5_000_000), GS)).wait();
  console.log(`farm 2:    ${await farm2.getAddress()} USDT0/MINTD (5M MINTD / 30 days)`);

  const zap = await dep("ZapIn", v2rAddr, usdtAddr);
  console.log(`zap:       ${await zap.getAddress()}`);

  // give the test wallet some WgUSDT to play with add-liquidity
  await (await wg.transfer(accounts[1], E(1000))).wait();

  // ------------------------------------------------------ frontend server
  const cfg = {
    chain: {
      chainId: "0x7a69", chainName: "mintd local sandbox",
      nativeCurrency: { name: "USDT0", symbol: "USDT0", decimals: 18 },
      rpcUrls: ["http://127.0.0.1:8545"], blockExplorerUrls: ["http://127.0.0.1:8545"],
    },
    addr: {
      router: await router.getAddress(), quoter: await quoter.getAddress(),
      npm: await npm.getAddress(), usdt0: usdtAddr,
    },
    pad: padAddr,
    mintswap: {
      router: v2rAddr, factory: await v2fac.getAddress(), wgusdt: await wg.getAddress(), zap: await zap.getAddress(),
      farms: [
        { name: "USDT0 / WgUSDT", farm: await farm.getAddress(), lp: lpAddr, tokenB: await wg.getAddress(), symB: "WgUSDT", decB: 18 },
        { name: "USDT0 / MINTD", farm: await farm2.getAddress(), lp: lp2Addr, tokenB: mintdAddr, symB: "MINTD", decB: 18 },
      ],
    },
  };
  const feDir = path.join(__dirname, "..", "frontend");
  http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/" || url === "/index.html") {
      let html = fs.readFileSync(path.join(feDir, "index.html"), "utf8");
      html = html.replace("<head>", `<head>\n<script>window.LOCAL_CONFIG = ${JSON.stringify(cfg)};</script>`);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else {
      const f = path.join(feDir, path.basename(url)); // flat dir only, no traversal
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200);
        res.end(fs.readFileSync(f));
      } else { res.writeHead(404); res.end("not found"); }
    }
  }).listen(8080);

  const acct1 = Object.values(keys)[1];
  const testKey = acct1.secretKey || acct1;
  console.log(`\n== SANDBOX READY ==`);
  console.log(`1. open  http://localhost:8080`);
  console.log(`2. MetaMask -> Add network manually:`);
  console.log(`     RPC http://127.0.0.1:8545   chain id 31337   symbol USDT0`);
  console.log(`3. MetaMask -> Import account with this TEST key (play money only):`);
  console.log(`     ${testKey}`);
  console.log(`   That wallet has 100,000 fake USDT0 and 1,000 WgUSDT.`);
  console.log(`\nEverything is fake and disappears when you Ctrl+C this script.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
