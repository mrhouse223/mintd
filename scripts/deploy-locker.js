// Deploys the TokenLocker to Stable Mainnet (988).
//
//   PRIVATE_KEY=0x... node scripts/deploy-locker.js
//
// Optional env:
//   RPC_URL        default https://rpc.stable.xyz
//   FEE_RECIPIENT  fee destination (default deployer address)
//   LOCK_FEE       flat fee per lock in USDT0, default "1"
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY env var");
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) {
    throw new Error(`Expected Stable Mainnet (988), got ${net.chainId}`);
  }
  const wallet = new ethers.Wallet(pk, provider);
  console.log(`deployer: ${wallet.address} (${ethers.formatEther(await provider.getBalance(wallet.address))} USDT0)`);

  const art = require(path.join(__dirname, "..", "build", "TokenLocker.json"));
  const args = [
    process.env.FEE_RECIPIENT || wallet.address,
    ethers.parseEther(process.env.LOCK_FEE || "1"),
  ];
  console.log(`feeRecipient: ${args[0]}   lockFee: ${ethers.formatEther(args[1])} USDT0`);
  const locker = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(...args);
  console.log(`tx: ${locker.deploymentTransaction().hash}`);
  await locker.waitForDeployment();
  const addr = await locker.getAddress();
  console.log(`\nTokenLocker deployed: ${addr}`);
  console.log(`explorer: https://stablescan.xyz/address/${addr}`);
  console.log(`\nSet LOCKER_ADDR to this address in frontend/index.html and redeploy the site.`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
