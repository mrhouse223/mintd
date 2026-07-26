// Creates a tiny MINTR/USDT0 pool on the CANONICAL Uniswap V2 on Stable
// (recognized Dexscreener venue + extra arbitrage surface for MINTR).
//   PRIVATE_KEY=0x... node scripts/add-mintr-uniswap.js
//
// Env:
//   MINTR       (default set to your deployed MINTR)
//   SEED_USDT0  USDT0 side, default "5"
//   SEED_MINTR  MINTR side, default "5"  (equal keeps the pool at price 1.0)
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const UNI_V2_ROUTER = "0xa571dc7c4f2369F1cA24D3a7E8a35c07Ff52bfC0"; // canonical Uniswap V2 Router02
const UNI_V2_FACTORY = "0x25D2d657F539F2bB16eC82773cBE5ee49ddD3c69"; // canonical V2 factory
const MINTR = process.env.MINTR || "0x8817D05f2560189F3697028f639Dbb4C68688400";

const ERC20 = ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  const wallet = new ethers.NonceManager(new ethers.Wallet(pk, provider));
  const addr = await wallet.getAddress();

  const seedUsdt = ethers.parseUnits(process.env.SEED_USDT0 || "5", 6);
  const seedMintr = ethers.parseEther(process.env.SEED_MINTR || "5");

  const usdt = new ethers.Contract(USDT0, ERC20, wallet);
  const mintr = new ethers.Contract(MINTR, ERC20, wallet);
  const [uBal, mBal] = await Promise.all([usdt.balanceOf(addr), mintr.balanceOf(addr)]);
  console.log(`deployer: ${addr}  USDT0: ${ethers.formatUnits(uBal, 6)}  MINTR: ${ethers.formatEther(mBal)}`);
  if (uBal < seedUsdt) throw new Error("Not enough USDT0");
  if (mBal < seedMintr) throw new Error("Not enough MINTR");

  await (await usdt.approve(UNI_V2_ROUTER, seedUsdt)).wait();
  await (await mintr.approve(UNI_V2_ROUTER, seedMintr)).wait();
  const router = new ethers.Contract(UNI_V2_ROUTER, [
    "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)",
  ], wallet);
  const dl = Math.floor(Date.now() / 1000) + 1200;
  console.log(`adding ${ethers.formatUnits(seedUsdt, 6)} USDT0 + ${ethers.formatEther(seedMintr)} MINTR to Uniswap V2…`);
  await (await router.addLiquidity(USDT0, MINTR, seedUsdt, seedMintr, 0, 0, addr, dl)).wait();

  const fac = new ethers.Contract(UNI_V2_FACTORY, ["function getPair(address,address) view returns (address)"], provider);
  const pair = await fac.getPair(USDT0, MINTR);
  console.log(`\nUniswap V2 MINTR/USDT0 pool: ${pair}`);
  console.log(`Dexscreener: https://dexscreener.com/stable/${pair}`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
