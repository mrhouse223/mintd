// Deploys BridgeFeeRouter to Base, for USDC bridging into Arc via CCTP.
//
//   FEE_RECIPIENT=0x... node scripts/deploy-bridge-fee-router.js --dry
//   FEE_RECIPIENT=0x... node scripts/deploy-bridge-fee-router.js
//
//   FEE_BPS         defaults to 100 (1.00%), and the contract caps it there
//   ALLOW_EOA_FEE=1 permit a fee recipient with no code (see below)
//
// EVERY CHECK HERE EXISTS BECAUSE THE CONTRACT IS IMMUTABLE
// `feeRecipient`, `feeBps` and `destinationDomain` cannot be changed after this
// script runs. There is no admin, no setter and no upgrade path, by design. So
// each of these is verified against live chain state before anything is sent,
// and read back off the deployed contract afterwards.
//
// The fee-recipient code check is the one that matters most. A Safe that exists
// on one chain does NOT exist at that address on another: the mintd Safe
// 0xE5F4…0e28 is live on Stable and has no code on Base. USDC transfers to a
// codeless address succeed, so fees would accumulate at an address nobody can
// spend from until an identical Safe is deployed there. That is recoverable only
// if the original deployment is reproducible, and silent until someone tries to
// withdraw.
require("dotenv").config();
const path = require("path");
const { ethers } = require("ethers");

const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const KEY_VAR = process.env.KEY_VAR || "OWNER_KEY";
const DRY = process.argv.includes("--dry");

// Base mainnet, verified on chain rather than copied from a doc.
const BASE_CHAIN_ID = 8453n;
const BASE_DOMAIN = 6;
const ARC_DOMAIN = 26;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";

const FEE_BPS = Number(process.env.FEE_BPS || "100");
const FEE_RECIPIENT = (process.env.FEE_RECIPIENT || "").trim();

const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);
const die = (m) => { console.error("ERROR: " + m); process.exit(1); };

async function main() {
  if (!ethers.isAddress(FEE_RECIPIENT)) die("set FEE_RECIPIENT to the address that should receive fees");

  const rp = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
  const net = await rp.getNetwork();
  if (net.chainId !== BASE_CHAIN_ID) die(`connected to chain ${net.chainId}, expected Base ${BASE_CHAIN_ID}`);
  log(`chain    Base (${net.chainId})`);

  const key = (process.env[KEY_VAR] || "").trim();
  if (!key) die(`${KEY_VAR} is not set in .env`);
  const w = new ethers.Wallet(key, rp);
  const bal = await rp.getBalance(w.address);
  log(`deployer ${w.address}  [${KEY_VAR}]  ${ethers.formatEther(bal)} ETH`);
  if (bal === 0n) die("deployer has no ETH for gas on Base");

  // ---- USDC is the real one, and 6-dec
  const usdc = new ethers.Contract(USDC_BASE,
    ["function symbol() view returns (string)", "function decimals() view returns (uint8)"], rp);
  const sym = await usdc.symbol();
  const dec = Number(await usdc.decimals());
  if (sym !== "USDC" || dec !== 6) die(`USDC at ${USDC_BASE} reports ${sym}/${dec}, expected USDC/6`);
  log(`usdc     ${USDC_BASE}  ${sym} ${dec}dec`);

  // ---- the messenger really is CCTP on Base, and Arc is not Base
  const tm = new ethers.Contract(TOKEN_MESSENGER,
    ["function localMessageTransmitter() view returns (address)"], rp);
  const transmitter = await tm.localMessageTransmitter();
  const mt = new ethers.Contract(transmitter, ["function localDomain() view returns (uint32)"], rp);
  const localDomain = Number(await mt.localDomain());
  if (localDomain !== BASE_DOMAIN) die(`messenger reports local domain ${localDomain}, expected Base ${BASE_DOMAIN}`);
  if (ARC_DOMAIN === localDomain) die("destination domain equals the local domain");
  log(`messenger ${TOKEN_MESSENGER}  localDomain ${localDomain} -> destination ${ARC_DOMAIN}`);

  // ---- the fee recipient can actually spend what it receives
  const feeCode = await rp.getCode(FEE_RECIPIENT);
  if (feeCode === "0x") {
    const msg = [
      `FEE_RECIPIENT ${FEE_RECIPIENT} has NO CODE on Base.`,
      "",
      "If this is meant to be a Safe, it does not exist on this chain. A Safe",
      "deployed on Stable or Arc is not deployable-by-default at the same address",
      "on Base; it has to be created there. Fees sent here would be unspendable",
      "until an identical Safe is deployed at this exact address, and feeRecipient",
      "is immutable so this cannot be corrected afterwards.",
      "",
      "Deploy the Safe on Base first and re-run, or set ALLOW_EOA_FEE=1 if you",
      "genuinely intend a plain EOA you control.",
    ].join("\n");
    if (process.env.ALLOW_EOA_FEE !== "1") die(msg);
    log("WARNING: fee recipient has no code, proceeding because ALLOW_EOA_FEE=1");
  } else {
    // If it looks like a Safe, say who can actually move the money.
    try {
      const safe = new ethers.Contract(FEE_RECIPIENT,
        ["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"], rp);
      const owners = await safe.getOwners();
      const thr = await safe.getThreshold();
      log(`feeTo    ${FEE_RECIPIENT}  Safe, ${thr}-of-${owners.length}`);
      log(`         owners ${owners.join(", ")}`);
    } catch {
      log(`feeTo    ${FEE_RECIPIENT}  contract (${(feeCode.length - 2) / 2} bytes), not a Safe`);
    }
  }

  if (FEE_BPS > 100) die(`FEE_BPS ${FEE_BPS} exceeds the contract's own 100 cap; it would revert`);
  log(`fee      ${FEE_BPS} bps (${(FEE_BPS / 100).toFixed(2)}%)`);

  const art = require(path.join(__dirname, "..", "build", "BridgeFeeRouter.json"));
  const CF = new ethers.ContractFactory(art.abi, art.bytecode, w);
  const args = [USDC_BASE, TOKEN_MESSENGER, FEE_RECIPIENT, FEE_BPS, ARC_DOMAIN];
  const gas = await rp.estimateGas({ ...(await CF.getDeployTransaction(...args)), from: w.address });
  const fee = await rp.getFeeData();
  log(`gas      ~${gas}, cost ~${ethers.formatEther(gas * (fee.gasPrice || 0n))} ETH`);

  if (DRY) { log("--dry: every precondition passed, nothing sent"); return; }

  log("");
  log("deploying...");
  const c = await CF.deploy(...args, { gasLimit: (gas * 130n) / 100n });
  await c.waitForDeployment();
  const addr = await c.getAddress();
  log(`deployed ${addr}`);

  // ---- read every immutable back and diff it. The only verification that counts.
  const onUsdc = await c.usdc();
  const onMsgr = await c.messenger();
  const onFeeTo = await c.feeRecipient();
  const onBps = Number(await c.feeBps());
  const onDom = Number(await c.destinationDomain());
  const bad = [];
  if (onUsdc.toLowerCase() !== USDC_BASE.toLowerCase()) bad.push(`usdc ${onUsdc}`);
  if (onMsgr.toLowerCase() !== TOKEN_MESSENGER.toLowerCase()) bad.push(`messenger ${onMsgr}`);
  if (onFeeTo.toLowerCase() !== FEE_RECIPIENT.toLowerCase()) bad.push(`feeRecipient ${onFeeTo}`);
  if (onBps !== FEE_BPS) bad.push(`feeBps ${onBps}`);
  if (onDom !== ARC_DOMAIN) bad.push(`destinationDomain ${onDom}`);
  if (bad.length) die(`READBACK MISMATCH, DO NOT USE THIS ADDRESS: ${bad.join("; ")}`);
  log("readback matches every argument");

  const q = await c.quote(ethers.parseUnits("100", 6));
  log(`quote(100 USDC) -> fee ${ethers.formatUnits(q.fee, 6)}, bridged ${ethers.formatUnits(q.bridged, 6)}`);
  log("");
  log(`explorer https://basescan.org/address/${addr}`);
  log("NEXT: a relayer must call receiveMessage on Arc, since CCTP does not");
  log("      deliver on its own and a first-time bridger has no Arc gas.");
}

main().catch((e) => { console.error(e); process.exit(1); });
