// Deploys MINTR, seeds its reserve, and optionally seeds a MintSwap MINTR/USDT0
// pool (the arbitrage venue) at the contract price.
//
//   PRIVATE_KEY=0x... node scripts/deploy-mintr.js
//
// Env:
//   FEE_RECIPIENT   platform fee wallet (default deployer)
//   SEED_USDT0      reserve seed, default "100"
//   SEED_MINTR      initial MINTR supply, default "100" (price = USDT0/MINTR)
//   DEX_MINTR       MINTR to seed the MintSwap pool, default "20" (0 to skip)
//   DEX_USDT0       USDT0 to seed the MintSwap pool, default matches price
//   ROUTER          MintSwap V2 router (default set)
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const ROUTER = process.env.ROUTER || "0xb9274bEdaDcf31136F54A9501232e642a35C6Eb7";

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  const wallet = new ethers.NonceManager(new ethers.Wallet(pk, provider));
  const addr = await wallet.getAddress();
  const feeRecipient = process.env.FEE_RECIPIENT || addr;

  const seedUsdt = ethers.parseUnits(process.env.SEED_USDT0 || "100", 6);
  const seedMintr = ethers.parseEther(process.env.SEED_MINTR || "100");
  const dexMintr = ethers.parseEther(process.env.DEX_MINTR || "20");
  // default DEX USDT0 keeps the pool at the seed price (usdt/mintr)
  const dexUsdt = process.env.DEX_USDT0
    ? ethers.parseUnits(process.env.DEX_USDT0, 6)
    : (dexMintr * seedUsdt) / seedMintr;

  const usdt = new ethers.Contract(USDT0, [
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ], wallet);
  console.log(`deployer: ${addr}  USDT0: ${ethers.formatUnits(await usdt.balanceOf(addr), 6)}`);

  // deploy MINTR
  const art = require(path.join(__dirname, "..", "build", "MINTR.json"));
  const mintr = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(USDT0, feeRecipient);
  await mintr.waitForDeployment();
  const mAddr = await mintr.getAddress();
  console.log(`MINTR deployed: ${mAddr}`);

  // seed reserve + initial supply
  await (await usdt.approve(mAddr, seedUsdt)).wait();
  await (await mintr.seed(seedUsdt, seedMintr)).wait();
  console.log(`seeded: ${ethers.formatUnits(seedUsdt, 6)} USDT0 reserve / ${ethers.formatEther(seedMintr)} MINTR (price ${ethers.formatEther(await mintr.price1e18())})`);

  // optional MintSwap MINTR/USDT0 pool for arbitrage
  if (dexMintr > 0n && dexUsdt > 0n) {
    const v2 = new ethers.Contract(ROUTER, [
      "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)",
    ], wallet);
    await (await new ethers.Contract(mAddr, ["function approve(address,uint256) returns (bool)"], wallet).approve(ROUTER, dexMintr)).wait();
    await (await usdt.approve(ROUTER, dexUsdt)).wait();
    const dl = Math.floor(Date.now() / 1000) + 1200;
    await (await v2.addLiquidity(USDT0, mAddr, dexUsdt, dexMintr, 0, 0, addr, dl)).wait();
    console.log(`MintSwap MINTR/USDT0 pool seeded: ${ethers.formatUnits(dexUsdt, 6)} USDT0 + ${ethers.formatEther(dexMintr)} MINTR`);
  }

  console.log(`\nset MINTR_ADDR to ${mAddr} in the frontend`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
