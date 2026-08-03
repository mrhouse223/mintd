// Deploys BuybackVaultFactory to Stable (chain 988).
//
//   node scripts/deploy-vault-factory.js --dry
//   node scripts/deploy-vault-factory.js
//
// The factory has NO owner and holds no funds, so unlike BondMarket there is
// nothing to hand over afterwards. It exists to be the trust anchor: isVault(x)
// is what proves an address runs the reviewed bytecode against the canonical
// router, rather than being a lookalike with a hostile router in it.
//
// Deployed from OWNER_KEY. The original deployer is compromised and the script
// refuses it by address.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));

const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const ROUTER = "0x32eaf9B5d5F2CD7361c5012890C943D7de84C22a";  // SwapRouter02
const V3FACTORY = "0x88F0a512eF09175D456bc9547f914f48C013E4aA"; // read from NPM.factory()
const MINTD = "0xE62C47074abb52A2bc87B62E47e3411A0020f020";
const MINTD_POOL = "0xBEf7e37d8F6d9dC70Af16ED1b3f7a7db8e13AFf6";

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
  let signer, provider;

  if (dry) {
    const ganache = require("ganache");
    const gp = ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 1000 }, miner: { blockGasLimit: "0x1C9C380" } });
    provider = new ethers.BrowserProvider(gp);
    signer = await provider.getSigner(0);
  } else {
    const env = readEnv();
    const keyVar = "OWNER_KEY";
    if (!env[keyVar]) throw new Error(`${keyVar} is not set in .env`);
    provider = new ethers.JsonRpcProvider(process.env.STABLE_RPC_URL || "https://rpc.stable.xyz", 988,
      { staticNetwork: true, batchMaxCount: 1 });
    signer = new ethers.Wallet(env[keyVar], provider);
    const me = await signer.getAddress();
    if (me.toLowerCase() === "0x8fc933374a2c1aa6d19c5f2bda33ad0b6be9eba4") {
      throw new Error("refusing to deploy from the compromised deployer key");
    }
    const bal = await provider.getBalance(me);
    console.log(`using ${keyVar} (${me}), balance ${ethers.formatEther(bal)}`);
    if (bal < ethers.parseEther("1")) throw new Error("not enough native USDT0 for gas");
  }

  const art = build("BuybackVaultFactory");
  const f = await new ethers.ContractFactory(art.abi, art.bytecode, signer).deploy(USDT0, ROUTER, V3FACTORY);
  await f.waitForDeployment();
  const addr = await f.getAddress();
  console.log(`\nBuybackVaultFactory at ${addr}`);

  const checks = {
    quote: await f.quote(),
    router: await f.router(),
    v3factory: await f.v3factory(),
    vaultCount: (await f.vaultCount()).toString(),
  };
  console.log("state:", checks);
  const bad = [];
  if (checks.quote.toLowerCase() !== USDT0.toLowerCase()) bad.push("quote");
  if (checks.router.toLowerCase() !== ROUTER.toLowerCase()) bad.push("router");
  if (checks.v3factory.toLowerCase() !== V3FACTORY.toLowerCase()) bad.push("v3factory");
  if (checks.vaultCount !== "0") bad.push("vaultCount");
  if (bad.length) throw new Error("post-deploy checks failed: " + bad.join(", "));

  // The factory is only useful if it can actually build a vault against a real
  // pool, and the canonical-pool check inside the vault is what would reject a
  // wrong V3FACTORY. Simulated on the live chain, never sent.
  if (!dry) {
    const vaultAddr = await f.create.staticCall(MINTD, MINTD_POOL);
    console.log(`create(MINTD) simulates fine -> ${vaultAddr}`);
    let rejected = false;
    try { await f.create.staticCall(MINTD, ROUTER); } catch { rejected = true; }
    console.log("a non-pool address is rejected:", rejected);
    if (!rejected) throw new Error("the canonical-pool check is not working");
  }

  console.log(dry ? "\nDRY RUN OK." : `\nDEPLOYED: ${addr}`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
