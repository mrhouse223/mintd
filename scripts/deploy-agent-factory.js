// Deploys AgentVaultFactory to Stable (chain 988).
//
//   node scripts/deploy-agent-factory.js --dry
//   node scripts/deploy-agent-factory.js
//
// The factory has no owner, holds nothing, and takes no fee. It is the trust
// anchor: isVault(x) is what lets the site say address x runs the reviewed
// bytecode against the canonical NPM and router rather than a lookalike with a
// hostile router in it.
//
// Deployed from OWNER_KEY. The original deployer is compromised and the script
// refuses it by address.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));

const NPM = "0x3BdC3437405f7D801b6036532713fc1F179136a6";     // NonfungiblePositionManager
const ROUTER = "0x32eaf9B5d5F2CD7361c5012890C943D7de84C22a";  // SwapRouter02
const V3FACTORY = "0x88F0a512eF09175D456bc9547f914f48C013E4aA";
const MINTD_POOL = "0xBEf7e37d8F6d9dC70Af16ED1b3f7a7db8e13AFf6";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";

function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

(async () => {
  const dry = process.argv.includes("--dry");
  let signer, provider, me;

  if (dry) {
    const ganache = require("ganache");
    const gp = ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 1000 }, miner: { blockGasLimit: "0x1C9C380" } });
    provider = new ethers.BrowserProvider(gp);
    signer = await provider.getSigner(0);
    me = await signer.getAddress();
  } else {
    const env = readEnv();
    if (!env.OWNER_KEY) throw new Error("OWNER_KEY is not set in .env");
    provider = new ethers.JsonRpcProvider(process.env.STABLE_RPC_URL || "https://rpc.stable.xyz", 988,
      { staticNetwork: true, batchMaxCount: 1 });
    signer = new ethers.Wallet(env.OWNER_KEY, provider);
    me = await signer.getAddress();
    if (me.toLowerCase() === "0x8fc933374a2c1aa6d19c5f2bda33ad0b6be9eba4") {
      throw new Error("refusing to deploy from the compromised deployer key");
    }
    const bal = await provider.getBalance(me);
    console.log(`using OWNER_KEY (${me}), balance ${ethers.formatEther(bal)}`);
    if (bal < ethers.parseEther("1")) throw new Error("not enough native USDT0 for gas");
  }

  // The dry run cannot exercise the constructor at all: it requires NPM and the
  // router to be live contracts and NPM.factory() to answer, none of which exist
  // on a bare ganache. So the dry path only proves the artifact deploys, and the
  // real checks below run against the live chain.
  if (dry) {
    const art = build("AgentVaultFactory");
    console.log(`artifact ok, ${art.bytecode.length / 2 - 1} bytes of creation code`);
    console.log("constructor needs a live NPM and router, so the real check is on chain");
    console.log("\nDRY RUN OK.");
    process.exit(0);
  }

  const art = build("AgentVaultFactory");
  const f = await new ethers.ContractFactory(art.abi, art.bytecode, signer).deploy(NPM, ROUTER);
  await f.waitForDeployment();
  const addr = await f.getAddress();
  console.log(`\nAgentVaultFactory at ${addr}`);

  const checks = { npm: await f.npm(), router: await f.router(), vaultCount: (await f.vaultCount()).toString() };
  console.log("state:", checks);
  const bad = [];
  if (checks.npm.toLowerCase() !== NPM.toLowerCase()) bad.push("npm");
  if (checks.router.toLowerCase() !== ROUTER.toLowerCase()) bad.push("router");
  if (checks.vaultCount !== "0") bad.push("vaultCount");
  if (bad.length) throw new Error("post-deploy checks failed: " + bad.join(", "));

  // Simulated, never sent: proves a real pool builds a vault, and that the
  // canonical-pool check rejects an address that is merely a contract.
  const v = await f.createVault.staticCall(MINTD_POOL, ethers.ZeroAddress, USDT0);
  console.log(`createVault(MINTD/USDT0) simulates fine -> ${v}`);
  let rejected = false;
  try { await f.createVault.staticCall(ROUTER, ethers.ZeroAddress, USDT0); } catch { rejected = true; }
  console.log("a non-pool address is rejected:", rejected);
  if (!rejected) throw new Error("the canonical-pool check is not working");

  console.log(`\nDEPLOYED: ${addr}`);
  console.log("Next: set agentFactory in frontend/index.html, and point the keeper at it.");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
