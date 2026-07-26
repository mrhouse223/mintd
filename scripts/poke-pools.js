// Generates a tiny bit of real swap volume on the MINTR/USDT0 pools so
// Dexscreener starts charting them. Does a small USDT0->MINTR buy then sells
// most of it back, on each router. Amounts are deliberately tiny.
//   PRIVATE_KEY=0x... node scripts/poke-pools.js
//
// Env:
//   AMOUNT_USDT   USDT0 per poke buy, default "1"
//   ROUND_TRIP    "1" to also sell back (default), "0" to only buy
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const MINTR = process.env.MINTR || "0x8817D05f2560189F3697028f639Dbb4C68688400";

const ROUTERS = [
  { label: "MintSwap", router: "0xb9274bEdaDcf31136F54A9501232e642a35C6Eb7" },
  { label: "Uniswap",  router: "0xa571dc7c4f2369F1cA24D3a7E8a35c07Ff52bfC0" },
];

const ERC20 = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])",
];

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  const wallet = new ethers.NonceManager(new ethers.Wallet(pk, provider));
  const addr = await wallet.getAddress();

  const amtIn = ethers.parseUnits(process.env.AMOUNT_USDT || "1", 6);
  const roundTrip = (process.env.ROUND_TRIP || "1") === "1";
  const usdt = new ethers.Contract(USDT0, ERC20, wallet);
  const mintr = new ethers.Contract(MINTR, ERC20, wallet);

  for (const { label, router } of ROUTERS) {
    const r = new ethers.Contract(router, ROUTER_ABI, wallet);
    const dl = () => Math.floor(Date.now() / 1000) + 600;
    console.log(`\n[${label}] buying ${ethers.formatUnits(amtIn, 6)} USDT0 -> MINTR…`);
    if ((await usdt.allowance(addr, router)) < amtIn) await (await usdt.approve(router, ethers.MaxUint256)).wait();
    const before = await mintr.balanceOf(addr);
    await (await r.swapExactTokensForTokens(amtIn, 0, [USDT0, MINTR], addr, dl())).wait();
    const got = (await mintr.balanceOf(addr)) - before;
    console.log(`  got ${ethers.formatEther(got)} MINTR`);

    if (roundTrip && got > 0n) {
      const sellAmt = (got * 90n) / 100n; // sell back ~90% to keep price near peg
      console.log(`[${label}] selling ${ethers.formatEther(sellAmt)} MINTR -> USDT0…`);
      if ((await mintr.allowance(addr, router)) < sellAmt) await (await mintr.approve(router, ethers.MaxUint256)).wait();
      await (await r.swapExactTokensForTokens(sellAmt, 0, [MINTR, USDT0], addr, dl())).wait();
      console.log(`  sold back`);
    }
  }
  console.log(`\ndone. Dexscreener usually starts charting within a few minutes of the first swap.`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
