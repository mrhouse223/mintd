// Deploys the TokenMetaRegistry to Stable Mainnet (988), wired to both
// launchpad versions so creators from either can edit their token pages.
//
//   PRIVATE_KEY=0x... node scripts/deploy-meta-registry.js
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const PADS = (process.env.PADS || "0x75FAdB240006313294A5B502CA9268cB03Fa9AC0,0x684A6449c946Cb3F3da395ea4dd12e4fd01933a9")
  .split(",").map((s) => s.trim()).filter(Boolean);

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY env var");
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) {
    throw new Error(`Expected Stable Mainnet (988), got ${net.chainId}`);
  }
  const wallet = new ethers.Wallet(pk, provider);
  console.log(`deployer: ${wallet.address}`);
  console.log(`pads: ${PADS.join(", ")}`);

  const art = require(path.join(__dirname, "..", "build", "TokenMetaRegistry.json"));
  const reg = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(PADS);
  console.log(`tx: ${reg.deploymentTransaction().hash}`);
  await reg.waitForDeployment();
  const addr = await reg.getAddress();
  console.log(`\nTokenMetaRegistry deployed: ${addr}`);
  console.log(`explorer: https://stablescan.xyz/address/${addr}`);
  console.log(`\nSet META_REGISTRY_ADDR to this address in frontend/index.html and redeploy the site.`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
