// Deploys MintrArb and (optionally) funds its float.
//
//   PRIVATE_KEY=0x... node scripts/deploy-arb.js
//   FUND=200 PRIVATE_KEY=0x... node scripts/deploy-arb.js    # also seed 200 USDT0
//
// Optional env: PAIR (defaults to the MintSwap MINTR/USDT0 pair), ROUTER,
// BURNER, MINTR, USDT0.
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const MINTR = process.env.MINTR || "0x8817D05f2560189F3697028f639Dbb4C68688400";
const ROUTER = process.env.ROUTER || "0xb9274bEdaDcf31136F54A9501232e642a35C6Eb7"; // MintSwap V2
const FACTORY = process.env.FACTORY || "0x65E12569E20E8706A4a60fCAB13e9069B78F9f8E";
const BURNER = process.env.BURNER || "0x7F007fbc6061806888A39A79763808aF5B94F4f4";

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

  let pair = process.env.PAIR;
  if (!pair) {
    const fac = new ethers.Contract(FACTORY, ["function getPair(address,address) view returns (address)"], provider);
    pair = await fac.getPair(USDT0, MINTR);
  }
  if (!pair || pair === ethers.ZeroAddress) throw new Error("MINTR/USDT0 pair not found");
  console.log(`pair:     ${pair}`);
  console.log(`burner:   ${BURNER}`);

  const art = require(path.join(__dirname, "..", "build", "MintrArb.json"));
  const arb = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(USDT0, MINTR, ROUTER, pair, BURNER);
  console.log(`tx: ${arb.deploymentTransaction().hash}`);
  await arb.waitForDeployment();
  const addr = await arb.getAddress();
  console.log(`\nMintrArb deployed: ${addr}`);
  console.log(`explorer: https://stablescan.xyz/address/${addr}`);

  const [m, c] = await arb.prices();
  console.log(`\nmarket price:   $${ethers.formatEther(m)}`);
  console.log(`contract price: $${ethers.formatEther(c)}`);
  const dev = (Number(ethers.formatEther(m)) / Number(ethers.formatEther(c)) - 1) * 100;
  console.log(`deviation:      ${dev >= 0 ? "+" : ""}${dev.toFixed(2)}%`);

  if (process.env.FUND) {
    const amt = ethers.parseUnits(process.env.FUND, 6);
    const usdt = new ethers.Contract(USDT0, [
      "function approve(address,uint256) returns (bool)",
      "function allowance(address,address) view returns (uint256)",
    ], wallet);
    if ((await usdt.allowance(wallet.address, addr)) < amt) {
      console.log("\napproving USDT0…");
      await (await usdt.approve(addr, ethers.MaxUint256)).wait();
    }
    console.log(`funding float with ${process.env.FUND} USDT0…`);
    await (await arb.fund(amt)).wait();
    console.log(`float: ${ethers.formatUnits(await arb.available(), 6)} USDT0`);
  }

  console.log(`\nRun the keeper:  ARB=${addr} PRIVATE_KEY=0x... node scripts/arb-keeper.js`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
