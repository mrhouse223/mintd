// Deploys ZapV3 (USDT0-only LP entry routing the swap through canonical
// Uniswap V3). Used for MintSwap pools whose other token trades on Uniswap.
//   PRIVATE_KEY=0x... ROUTER=0x... node scripts/deploy-zapv3.js
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const V3_ROUTER = process.env.V3_ROUTER || "0x32eaf9B5d5F2CD7361c5012890C943D7de84C22a"; // canonical SwapRouter02

async function main() {
  const pk = process.env.PRIVATE_KEY, mintswapRouter = process.env.ROUTER;
  if (!pk || !mintswapRouter) throw new Error("Set PRIVATE_KEY and ROUTER (MintSwap V2 router)");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  const wallet = new ethers.Wallet(pk, provider);
  const art = require(path.join(__dirname, "..", "build", "ZapV3.json"));
  const zap = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(mintswapRouter, V3_ROUTER, USDT0);
  await zap.waitForDeployment();
  console.log(`ZapV3 deployed: ${await zap.getAddress()}`);
  console.log(`set MINTSWAP.zapv3 to this address in the frontend`);
}

main().catch((e) => { console.error(e); process.exit(1); });
