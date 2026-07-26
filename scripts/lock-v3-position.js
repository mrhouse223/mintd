// Deploys the V3PositionLocker (once) and permanently locks a Uniswap V3
// position in it, keeping trading fees claimable by a beneficiary forever.
//
//   Step 1, deploy the locker:
//     PRIVATE_KEY=0x... node scripts/lock-v3-position.js deploy
//
//   Step 2, find your position id for a pool:
//     POOL=0x... PRIVATE_KEY=0x... node scripts/lock-v3-position.js find
//
//   Step 3, lock it (IRREVERSIBLE):
//     LOCKER=0x... TOKEN_ID=123 CONFIRM=LOCK_FOREVER PRIVATE_KEY=0x... \
//       node scripts/lock-v3-position.js lock
//
// Optional: BENEFICIARY=0x... to send fees somewhere other than your wallet.
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const NPM_ADDR = process.env.POSITION_MANAGER || "0x3BdC3437405f7D801b6036532713fc1F179136a6";

const NPM_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128 liquidity,uint256,uint256,uint128 owed0,uint128 owed1)",
  "function safeTransferFrom(address,address,uint256,bytes)",
];
const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

async function main() {
  // tolerate stray whitespace/quotes, and infer the mode from env when omitted
  let mode = (process.argv[2] || process.env.MODE || "").trim().replace(/['"]/g, "").toLowerCase();
  if (!mode) {
    if (process.env.TOKEN_ID && process.env.LOCKER) mode = "lock";
    else if (process.env.POOL) mode = "find";
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY env var");
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) {
    throw new Error(`Expected Stable Mainnet (988), got ${net.chainId}`);
  }
  const wallet = new ethers.Wallet(pk, provider);
  const npm = new ethers.Contract(NPM_ADDR, NPM_ABI, wallet);
  console.log(`wallet: ${wallet.address}\n`);

  if (mode === "deploy") {
    const art = require(path.join(__dirname, "..", "build", "V3PositionLocker.json"));
    const locker = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(NPM_ADDR);
    console.log(`tx: ${locker.deploymentTransaction().hash}`);
    await locker.waitForDeployment();
    const addr = await locker.getAddress();
    console.log(`\nV3PositionLocker deployed: ${addr}`);
    console.log(`explorer: https://stablescan.xyz/address/${addr}`);
    console.log(`\nNext: LOCKER=${addr} POOL=0x... node scripts/lock-v3-position.js find`);
    return;
  }

  if (mode === "find") {
    const pool = process.env.POOL;
    if (!pool) throw new Error("Set POOL=0x... (the Uniswap V3 pool address)");
    const p = new ethers.Contract(pool, POOL_ABI, provider);
    const [t0, t1, fee] = await Promise.all([p.token0(), p.token1(), p.fee()]);
    console.log(`pool ${pool}`);
    console.log(`  token0 ${t0}\n  token1 ${t1}\n  fee    ${Number(fee) / 10000}%\n`);
    const n = Number(await npm.balanceOf(wallet.address));
    console.log(`you hold ${n} position NFT(s); matching ones:`);
    let found = 0;
    for (let i = 0; i < n; i++) {
      const id = await npm.tokenOfOwnerByIndex(wallet.address, i);
      const pos = await npm.positions(id);
      if (pos[2].toLowerCase() === t0.toLowerCase() && pos[3].toLowerCase() === t1.toLowerCase() && Number(pos[4]) === Number(fee)) {
        found++;
        console.log(`  TOKEN_ID=${id}  liquidity=${pos.liquidity}  unclaimed fees: ${pos.owed0} / ${pos.owed1}`);
      }
    }
    if (!found) console.log("  none found in this wallet");
    return;
  }

  if (mode === "lock") {
    const locker = process.env.LOCKER;
    const tokenId = process.env.TOKEN_ID;
    if (!locker || !tokenId) throw new Error("Set LOCKER=0x... and TOKEN_ID=...");
    if (process.env.CONFIRM !== "LOCK_FOREVER") {
      throw new Error("This is IRREVERSIBLE. Re-run with CONFIRM=LOCK_FOREVER to proceed.");
    }
    const owner = await npm.ownerOf(tokenId);
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(`You do not own position ${tokenId} (owner is ${owner})`);
    }
    const beneficiary = process.env.BENEFICIARY || wallet.address;
    const pos = await npm.positions(tokenId);
    console.log(`locking position ${tokenId}`);
    console.log(`  liquidity:   ${pos.liquidity}`);
    console.log(`  beneficiary: ${beneficiary}`);
    console.log(`  locker:      ${locker}`);
    console.log(`\nThe liquidity becomes PERMANENTLY unwithdrawable. Fees stay claimable.\n`);

    const data = process.env.BENEFICIARY
      ? ethers.AbiCoder.defaultAbiCoder().encode(["address"], [beneficiary])
      : "0x";
    const tx = await npm["safeTransferFrom(address,address,uint256,bytes)"](wallet.address, locker, tokenId, data);
    console.log(`tx: ${tx.hash}`);
    await tx.wait();
    const newOwner = await npm.ownerOf(tokenId);
    console.log(`\nlocked. position now owned by ${newOwner}`);
    console.log(`explorer: https://stablescan.xyz/token/${NPM_ADDR}?a=${tokenId}`);
    return;
  }

  console.log("Usage: node scripts/lock-v3-position.js [deploy|find|lock]");
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
