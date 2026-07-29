// Deploys AgentVaultFactory.
//
//   node scripts/deploy-agent-vault-factory.js            # arc-testnet
//   node scripts/deploy-agent-vault-factory.js stable
//   node scripts/deploy-agent-vault-factory.js arc-testnet --dry
//
// The factory has no owner and no setters, so the deploying key gains nothing
// and cannot repoint anything afterwards. What the key DOES decide, permanently,
// is which position manager and router every vault this factory ever creates
// will approve tokens to. Those two addresses are the whole security argument,
// so they are read back from the deployed contract and diffed against the
// source of truth before this script will call the deploy a success.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const root = path.join(__dirname, "..");
const ARC_FILE = path.join(root, "deployments", "arc-testnet.json");

const CHAINS = {
  "arc-testnet": {
    rpc: "https://rpc.testnet.arc.network",
    chainId: 5042002,
    key: "ARC_DEPLOYER_KEY",
    explorer: "https://testnet.arcscan.app/address/",
    // Read from the deployments file rather than pasted here: that file is the
    // source of truth for Arc, and a second copy is a second thing to get wrong.
    from: () => {
      const j = JSON.parse(fs.readFileSync(ARC_FILE, "utf8"));
      return { npm: j.contracts.NonfungiblePositionManager, router: j.contracts.SwapRouter02 };
    },
    record: (addr) => {
      const j = JSON.parse(fs.readFileSync(ARC_FILE, "utf8"));
      j.contracts.AgentVaultFactory = addr;
      fs.writeFileSync(ARC_FILE, JSON.stringify(j, null, 2) + "\n");
      return "deployments/arc-testnet.json";
    },
  },
  stable: {
    rpc: process.env.RPC_URL || "https://rpc.stable.xyz",
    chainId: 988,
    // Never the burned deployer. See CLAUDE.md security state.
    key: "OWNER_KEY",
    explorer: "https://stablescan.xyz/address/",
    from: () => ({
      npm: "0x3BdC3437405f7D801b6036532713fc1F179136a6",
      router: "0x32eaf9B5d5F2CD7361c5012890C943D7de84C22a",
    }),
    record: () => null,
  },
};

const die = (m) => { console.error("ERROR: " + m); process.exit(1); };

async function main() {
  const which = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "arc-testnet";
  const dry = process.argv.includes("--dry");
  const cfg = CHAINS[which] || die(`unknown chain "${which}", expected one of: ${Object.keys(CHAINS).join(", ")}`);

  const art = require(path.join(root, "build", "AgentVaultFactory.json"));
  const { npm, router } = cfg.from();
  if (!npm || !router) die("position manager or router missing from the source of truth");

  // batchMaxCount 1: Stable's RPC rejects batched JSON-RPC outright, and Arc is
  // treated the same way rather than discovering the difference in production.
  const rp = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId, { batchMaxCount: 1 });
  const raw = (process.env[cfg.key] || "").trim();
  if (!raw) die(`${cfg.key} is not set in .env`);
  const wallet = new ethers.Wallet(raw, rp);

  const bal = await rp.getBalance(wallet.address);
  const fee = await rp.getFeeData();
  const gasPrice = fee.gasPrice || 0n;

  console.log(`chain      ${which} (${cfg.chainId})`);
  console.log(`deployer   ${wallet.address}   [${cfg.key}]`);
  // 18-dec native even where the ERC-20 of the same token is 6-dec. Formatting
  // this as 6 reads a million times high, which is CLAUDE.md gotcha 6.
  console.log(`balance    ${ethers.formatEther(bal)} (native, 18-dec)`);
  console.log(`npm        ${npm}`);
  console.log(`router     ${router}`);

  for (const [label, addr] of [["position manager", npm], ["router", router]]) {
    const code = await rp.getCode(addr);
    if (code === "0x") die(`${label} ${addr} has no code on ${which}`);
  }
  console.log("both target contracts have code on chain");

  const CF = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
  const deployTx = await CF.getDeployTransaction(npm, router);
  const gas = await rp.estimateGas({ ...deployTx, from: wallet.address });
  // The constructor writes no storage, so nothing here is refund-distorted the
  // way the vault's own entry points are, but a margin costs nothing.
  const gasLimit = (gas * 130n) / 100n;
  console.log(`gas        ~${gas} (limit ${gasLimit}), cost ~${ethers.formatEther(gas * gasPrice)}`);
  if (bal < gas * gasPrice) die("deployer cannot cover the deploy");

  if (dry) { console.log("\n--dry: stopping before sending anything"); return; }

  console.log("\ndeploying...");
  const c = await CF.deploy(npm, router, { gasLimit });
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`deployed   ${addr}`);

  // The only verification that matters. A factory wired to the wrong router
  // produces vaults that are drained on their first rebalance, and nothing
  // about the deployment itself would look wrong.
  const onNpm = await c.npm();
  const onRouter = await c.router();
  const ok = onNpm.toLowerCase() === npm.toLowerCase() && onRouter.toLowerCase() === router.toLowerCase();
  console.log(`readback   npm=${onNpm} router=${onRouter}`);
  if (!ok) die("READBACK MISMATCH: do not use this factory, redeploy it");
  const count = await c.vaultCount();
  if (count !== 0n) die(`unexpected vaultCount ${count} on a fresh factory`);
  console.log("readback matches the source of truth, vaultCount 0");

  const file = cfg.record(addr);
  if (file) console.log(`recorded   ${file}`);
  console.log(`explorer   ${cfg.explorer}${addr}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
