// Deploys a MintSynth CDP engine to Stable Mainnet (988).
//
//   PRIVATE_KEY=0x... node scripts/deploy-synth.js              # sGOLD (default)
//   SYNTH=btc PRIVATE_KEY=0x... node scripts/deploy-synth.js    # sBTC
//   SYNTH=eth PRIVATE_KEY=0x... node scripts/deploy-synth.js    # sETH
//
// Oracle addresses are RedStone push feeds live on Stable mainnet, published at
// https://docs.stable.xyz/en/reference/oracles
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
// Mint fees default to the BuybackBurner: every MGLD minted turns into USDT0
// that anyone can trigger into a MINTD market-buy and burn. Pass FEE_RECIPIENT
// to override (e.g. your own wallet).
const BUYBACK = "0x7F007fbc6061806888A39A79763808aF5B94F4f4";

// RedStone push feeds on Stable mainnet (Chainlink-compatible AggregatorV3)
const FEEDS = {
  gold: { name: "Mintd Gold", symbol: "MGLD", feed: "0xd5E244accc514b56DCAD89897DD44499E7C35a05", pair: "XAUt/USD" },
  btc:  { name: "Mintd BTC",  symbol: "MBTC", feed: "0x687103bA8CC2f66C94696182Ef410400Da45fb24", pair: "BTC/USD" },
  eth:  { name: "Mintd ETH",  symbol: "METH", feed: "0x457BE3C697c644bF329C2C3ea79EbF1D254d603a", pair: "ETH/USD" },
};

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY env var");
  const which = (process.env.SYNTH || "gold").toLowerCase();
  const cfg = FEEDS[which];
  if (!cfg) throw new Error(`Unknown SYNTH "${which}". Use one of: ${Object.keys(FEEDS).join(", ")}`);

  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) {
    throw new Error(`Expected Stable Mainnet (988), got ${net.chainId}`);
  }
  const wallet = new ethers.Wallet(pk, provider);
  console.log(`deployer: ${wallet.address}`);
  console.log(`synth:    ${cfg.name} (${cfg.symbol})  tracking ${cfg.pair}`);

  // sanity: the feed must be live and returning a sane, fresh price
  const feed = new ethers.Contract(cfg.feed, [
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
    "function decimals() view returns (uint8)",
  ], provider);
  const [, answer, , updatedAt] = await feed.latestRoundData();
  const dec = Number(await feed.decimals());
  if (answer <= 0n) throw new Error("Oracle returned a non-positive price, aborting");
  const ageMin = Math.round((Date.now() / 1000 - Number(updatedAt)) / 60);
  console.log(`oracle:   ${cfg.feed}`);
  console.log(`price:    $${ethers.formatUnits(answer, dec)}  (updated ${ageMin} min ago)`);
  if (ageMin > 12 * 60) throw new Error("Oracle price is over 12h old, aborting");

  const art = require(path.join(__dirname, "..", "build", "MintSynth.json"));
  const feeRecipient = process.env.FEE_RECIPIENT || BUYBACK;
  console.log(`fees to:  ${feeRecipient}${feeRecipient === BUYBACK ? "  (BuybackBurner: mint fees burn $MINTD)" : ""}`);
  const args = [cfg.name, cfg.symbol, USDT0, cfg.feed, feeRecipient];
  const eng = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(...args);
  console.log(`tx: ${eng.deploymentTransaction().hash}`);
  await eng.waitForDeployment();
  const addr = await eng.getAddress();
  const synthAddr = await eng.synth();

  console.log(`\nMintSynth engine: ${addr}`);
  console.log(`${cfg.symbol} token:    ${synthAddr}`);
  console.log(`explorer: https://stablescan.xyz/address/${addr}`);
  console.log(`\nRisk parameters (tune with setParams):`);
  console.log(`  min collateral ratio: ${Number(await eng.minCollateralRatio()) / 100}%`);
  console.log(`  liquidation ratio:    ${Number(await eng.liquidationRatio()) / 100}%`);
  console.log(`  liquidation bonus:    ${Number(await eng.liquidationBonus()) / 100}%`);
  console.log(`  mint fee:             ${Number(await eng.mintFeeBps()) / 100}%`);
  console.log(`\nAdd this to SYNTHS in frontend/index.html, then seed a small`);
  console.log(`${cfg.symbol}/USDT0 pool on MintSwap so arbitrage can track the oracle.`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
