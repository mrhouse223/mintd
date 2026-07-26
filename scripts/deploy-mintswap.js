// Deploys the MintSwap V2 fork (Uniswap V2 factory + router) to Stable (988).
//
//   PRIVATE_KEY=0x... node scripts/deploy-mintswap.js
//
// Requires the V2 artifacts:
//   npm install @uniswap/v2-core@1.0.1 @uniswap/v2-periphery@1.1.0-beta.0
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY env var");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  const wallet = new ethers.Wallet(pk, provider);
  console.log(`deployer: ${wallet.address} (${ethers.formatEther(await provider.getBalance(wallet.address))} USDT0)`);

  const facArt = require("@uniswap/v2-core/build/UniswapV2Factory.json");
  const factory = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, wallet).deploy(wallet.address);
  await factory.waitForDeployment();
  const facAddr = await factory.getAddress();
  console.log(`MintSwap factory: ${facAddr}`);

  const rArt = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");
  // WETH slot is unused on Stable (token-token routing only); points at USDT0.
  const router = await new ethers.ContractFactory(rArt.abi, rArt.bytecode, wallet).deploy(facAddr, USDT0);
  await router.waitForDeployment();
  console.log(`MintSwap router:  ${await router.getAddress()}`);
  console.log(`\nNext: PRIVATE_KEY=... ROUTER=${await router.getAddress()} FACTORY=${facAddr} node scripts/deploy-farm.js`);
}

main().catch((e) => { console.error(e); process.exit(1); });
