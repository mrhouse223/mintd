// Deepens (or creates) the MintSwap V2 MINTR/USDT0 pool so it charts on
// Dexscreener and gives the buybot real volume to report.
//   PRIVATE_KEY=0x... node scripts/add-mintr-mintswap.js
//
// A MintSwap MINTR/USDT0 pool already exists (seeded 20/20 at price 1.0 by
// deploy-mintr.js). addLiquidity here just adds to it. Equal USDT0/MINTR keeps
// the pool at the ~1.0 contract price. Env:
//   SEED_USDT0  default "20"   SEED_MINTR default "20"
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const MINTR = process.env.MINTR || "0x8817D05f2560189F3697028f639Dbb4C68688400";
const ROUTER = process.env.ROUTER || "0xb9274bEdaDcf31136F54A9501232e642a35C6Eb7";  // MintSwap V2 router
const FACTORY = process.env.FACTORY || "0x65E12569E20E8706A4a60fCAB13e9069B78F9f8E"; // MintSwap V2 factory

const ERC20 = ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  const wallet = new ethers.NonceManager(new ethers.Wallet(pk, provider));
  const addr = await wallet.getAddress();

  const seedUsdt = ethers.parseUnits(process.env.SEED_USDT0 || "20", 6);
  const seedMintr = ethers.parseEther(process.env.SEED_MINTR || "20");

  const usdt = new ethers.Contract(USDT0, ERC20, wallet);
  const mintr = new ethers.Contract(MINTR, ERC20, wallet);
  const [uBal, mBal] = await Promise.all([usdt.balanceOf(addr), mintr.balanceOf(addr)]);
  console.log(`deployer: ${addr}\n  USDT0: ${ethers.formatUnits(uBal, 6)}   MINTR: ${ethers.formatEther(mBal)}`);
  if (uBal < seedUsdt) throw new Error("Not enough USDT0");
  if (mBal < seedMintr) throw new Error("Not enough MINTR");

  await (await usdt.approve(ROUTER, seedUsdt)).wait();
  await (await mintr.approve(ROUTER, seedMintr)).wait();
  const router = new ethers.Contract(ROUTER, [
    "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)",
  ], wallet);
  const dl = Math.floor(Date.now() / 1000) + 1200;
  console.log(`adding ${ethers.formatUnits(seedUsdt, 6)} USDT0 + ${ethers.formatEther(seedMintr)} MINTR to MintSwap…`);
  // mins at 0: pool is ~1:1 so the router pulls both sides evenly
  await (await router.addLiquidity(USDT0, MINTR, seedUsdt, seedMintr, 0, 0, addr, dl)).wait();

  const fac = new ethers.Contract(FACTORY, ["function getPair(address,address) view returns (address)"], provider);
  const pair = await fac.getPair(USDT0, MINTR);
  console.log(`\nMintSwap MINTR/USDT0 pair: ${pair}`);
  console.log(`Dexscreener: https://dexscreener.com/stable/${pair}`);
  console.log(`(pass this pair to the buybot as PAIR=...)`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
