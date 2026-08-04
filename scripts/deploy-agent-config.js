// Deploys AgentConfig to Stable (chain 988). No constructor args, no owner,
// holds nothing: it is a per-vault keeper-override registry gated on each
// vault's own owner(). Deployed from OWNER_KEY (never the compromised deployer).
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));

(async () => {
  const dry = process.argv.includes("--dry");
  let signer, provider;
  if (dry) {
    const ganache = require("ganache");
    provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 100 } }));
    signer = await provider.getSigner(0);
  } else {
    const env = {};
    for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    if (!env.OWNER_KEY) throw new Error("OWNER_KEY not set");
    provider = new ethers.JsonRpcProvider(process.env.STABLE_RPC_URL || "https://rpc.stable.xyz", 988, { staticNetwork: true, batchMaxCount: 1 });
    signer = new ethers.Wallet(env.OWNER_KEY, provider);
    const me = await signer.getAddress();
    if (me.toLowerCase() === "0x8fc933374a2c1aa6d19c5f2bda33ad0b6be9eba4") throw new Error("refusing the compromised deployer key");
    console.log(`using OWNER_KEY (${me}), balance ${ethers.formatEther(await provider.getBalance(me))}`);
  }
  const a = build("AgentConfig");
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy();
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(dry ? "dry: AgentConfig at " + addr : "DEPLOYED: " + addr);
  // sanity: constants read back
  console.log("MAX_BAND", (await c.MAX_BAND()).toString(), "MAX_LP_WIDTH", (await c.MAX_LP_WIDTH()).toString());
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
