// Deploys the MintSwap ZapIn helper (USDT0-only LP entry).
//   PRIVATE_KEY=0x... ROUTER=0x... node scripts/deploy-zap.js
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";

async function main() {
  const pk = process.env.PRIVATE_KEY, routerAddr = process.env.ROUTER;
  if (!pk || !routerAddr) throw new Error("Set PRIVATE_KEY and ROUTER env vars");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  const wallet = new ethers.Wallet(pk, provider);
  const art = require(path.join(__dirname, "..", "build", "ZapIn.json"));
  const zap = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(routerAddr, USDT0);
  await zap.waitForDeployment();
  console.log(`ZapIn deployed: ${await zap.getAddress()}`);
  console.log(`set MINTSWAP.zap to this address in the frontend`);
}

main().catch((e) => { console.error(e); process.exit(1); });
