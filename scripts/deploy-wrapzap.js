// Deploys WrapZap (zero-slippage USDT0/WgUSDT LP entry via 1:1 wrapping).
//   PRIVATE_KEY=0x... ROUTER=0x... node scripts/deploy-wrapzap.js
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const WGUSDT = process.env.WGUSDT || "0x817997Ca8394E26CCE3dE3A076a4889b27DbF9dE";

async function main() {
  const pk = process.env.PRIVATE_KEY, routerAddr = process.env.ROUTER;
  if (!pk || !routerAddr) throw new Error("Set PRIVATE_KEY and ROUTER (MintSwap router) env vars");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  const wallet = new ethers.Wallet(pk, provider);
  const art = require(path.join(__dirname, "..", "build", "WrapZap.json"));
  const wz = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(routerAddr, USDT0, WGUSDT);
  await wz.waitForDeployment();
  console.log(`WrapZap deployed: ${await wz.getAddress()}`);
  console.log(`set MINTSWAP.wrapzap to this address in the frontend`);
}

main().catch((e) => { console.error(e); process.exit(1); });
