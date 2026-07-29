// Completes Base -> Arc USDC bridges by submitting the Arc side and paying its gas.
//
//   ROUTER=0x... RELAYER_KEY_VAR=KEEPER_KEY node scripts/bridge-relayer.js
//   ROUTER=0x... node scripts/bridge-relayer.js --once
//   TX=0xabc...  node scripts/bridge-relayer.js --tx      # relay one transfer
//
// WHY THIS PROCESS EXISTS
// CCTP does not deliver. It burns on the source chain and mints only when
// somebody calls receiveMessage on the destination, which costs gas there. On
// Arc that gas is USDC, and a first-time bridger has none by definition: the
// whole reason they are bridging is to get some. Without a relayer their USDC is
// burned on Base and sitting behind a transaction they cannot afford to send.
//
// WHAT IT IS NOT
// Not custody, and not a trust assumption. It never touches user funds: the mint
// recipient is fixed inside the attested message, so this process cannot change
// where the money goes, only whether the transaction is submitted. And because
// BridgeFeeRouter sets destinationCaller to zero, ANYONE can submit it, so a
// user whose transfer we fail to relay can relay it themselves and lose nothing
// but the inconvenience. That is the property that makes this safe to run.
//
// THE KEY
// Gas-only, and never the deployer key, exactly like the arb keeper. Its sole
// power is to spend its own gas submitting messages Circle has already attested.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const ARC_RPC = process.env.ARC_RPC_URL || "https://5042.rpc.thirdweb.com";
const IRIS = process.env.IRIS_URL || "https://iris-api.circle.com";
const BASE_DOMAIN = 6;
const ARC_TRANSMITTER = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
const ROUTER = (process.env.ROUTER || "").trim();
const KEY_VAR = process.env.RELAYER_KEY_VAR || "KEEPER_KEY";
const POLL_MS = Number(process.env.POLL_MS || "30000");
const SPAN = Number(process.env.SPAN || "500");
const ONCE = process.argv.includes("--once");
const ONE_TX = process.argv.includes("--tx");

const BRIDGED = ethers.id("Bridged(address,bytes32,uint256,uint256,uint256)");
const TRANSMITTER_ABI = [
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
  "function usedNonces(bytes32) view returns (uint256)",
];

const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);
const die = (m) => { console.error("ERROR: " + m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stateFile = () => path.join(__dirname, "..", "data", "bridge-relayer.json");
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); }
  catch { return { router: ROUTER, lastScanned: 0, done: {} }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2) + "\n");
}

/// Ask Circle for the attestation covering a source transaction.
///
/// Defensive about the response shape on purpose. The success payload was not
/// observable while writing this, because it needs a real burn to exist, and the
/// error path is all that could be verified: an unknown hash returns
/// {"error":"Message not found for provided parameters"}, which at least
/// confirms the route and the query parameter. So anything unexpected is logged
/// verbatim rather than silently treated as "nothing to do", which would look
/// exactly like a quiet day while users waited.
async function fetchAttestations(txHash) {
  const url = `${IRIS}/v2/messages/${BASE_DOMAIN}?transactionHash=${txHash}`;
  const res = await fetch(url);
  const body = await res.text();
  let j;
  try { j = JSON.parse(body); }
  catch { throw new Error(`Circle returned non-JSON (${res.status}): ${body.slice(0, 200)}`); }
  if (j.error) return { pending: true, why: j.error };
  const msgs = Array.isArray(j.messages) ? j.messages : (j.message ? [j] : null);
  if (!msgs) throw new Error(`unrecognised Circle response: ${body.slice(0, 300)}`);
  return { pending: false, messages: msgs };
}

async function relayOne(arcSigner, transmitter, m, tag) {
  // Circle marks an attestation ready with status "complete"; anything else
  // means keep waiting rather than submit something unusable.
  const status = (m.status || "").toLowerCase();
  if (status && status !== "complete") return { relayed: false, why: `status ${m.status}` };
  if (!m.message || !m.attestation) return { relayed: false, why: "no message/attestation yet" };
  if (String(m.attestation).toLowerCase() === "pending") return { relayed: false, why: "attestation pending" };

  // Idempotent. A restart, a duplicate event, or a user who relayed it
  // themselves must not turn into a wasted reverting transaction.
  if (m.eventNonce) {
    try {
      const nonceKey = ethers.isHexString(m.eventNonce, 32)
        ? m.eventNonce
        : ethers.zeroPadValue(ethers.toBeHex(BigInt(m.eventNonce)), 32);
      if ((await transmitter.usedNonces(nonceKey)) > 0n) return { relayed: false, why: "already minted" };
    } catch { /* nonce shape varies; fall through to the simulation below */ }
  }

  // Simulated first so an already-minted or malformed message costs nothing.
  try {
    await transmitter.receiveMessage.staticCall(m.message, m.attestation);
  } catch (e) {
    return { relayed: false, why: `would revert: ${(e.shortMessage || e.message || "").slice(0, 90)}` };
  }

  const tx = await transmitter.receiveMessage(m.message, m.attestation, { gasLimit: 500_000 });
  const rec = await tx.wait();
  log(`${tag}  minted on Arc, gas ${rec.gasUsed}, tx ${rec.hash}`);
  return { relayed: true, hash: rec.hash };
}

async function main() {
  const baseRp = new ethers.JsonRpcProvider(BASE_RPC, undefined, { batchMaxCount: 1 });
  const arcRp = new ethers.JsonRpcProvider(ARC_RPC, undefined, { batchMaxCount: 1 });
  const key = (process.env[KEY_VAR] || "").trim();
  if (!key) die(`${KEY_VAR} is not set in .env`);
  const arcSigner = new ethers.Wallet(key, arcRp);
  const transmitter = new ethers.Contract(ARC_TRANSMITTER, TRANSMITTER_ABI, arcSigner);

  const gas = await arcRp.getBalance(arcSigner.address);
  log(`relayer  ${arcSigner.address}  [${KEY_VAR}]`);
  log(`arc gas  ${ethers.formatEther(gas)}  (USDC, 18-dec native)`);
  if (gas === 0n) log("WARNING: no Arc gas, every relay will fail until this is funded");

  if (ONE_TX) {
    const tx = (process.env.TX || "").trim();
    if (!ethers.isHexString(tx, 32)) die("set TX to the Base transaction hash to relay");
    const r = await fetchAttestations(tx);
    if (r.pending) return log(`not ready: ${r.why}`);
    for (const [i, m] of r.messages.entries()) {
      const out = await relayOne(arcSigner, transmitter, m, `${tx.slice(0, 10)}#${i}`);
      if (!out.relayed) log(`${tx.slice(0, 10)}#${i}  skipped: ${out.why}`);
    }
    return;
  }

  if (!ethers.isAddress(ROUTER)) die("set ROUTER to the deployed BridgeFeeRouter on Base");
  const state = loadState();
  if (state.router && state.router.toLowerCase() !== ROUTER.toLowerCase()) {
    log(`router changed, discarding state for ${state.router}`);
    state.router = ROUTER; state.lastScanned = 0; state.done = {};
  }
  state.router = ROUTER;
  if (!state.lastScanned) {
    state.lastScanned = Number(process.env.FROM_BLOCK || (await baseRp.getBlockNumber()) - 1);
  }
  log(`watching ${ROUTER} on Base from block ${state.lastScanned + 1}`);

  let fails = 0;
  async function tick() {
    try {
      const latest = await baseRp.getBlockNumber();
      // Chunked and sequential. Same discipline as the other indexers here: a
      // window that fails on the result cap must shrink rather than be skipped,
      // because a skipped window is a user whose bridge is never completed.
      for (let from = state.lastScanned + 1; from <= latest; ) {
        let width = Math.min(SPAN, latest - from + 1);
        let logs = null;
        while (logs === null) {
          try {
            logs = await baseRp.getLogs({ address: ROUTER, topics: [BRIDGED], fromBlock: from, toBlock: from + width - 1 });
          } catch (e) {
            if (width <= 1) throw e;
            width = Math.max(1, Math.floor(width / 2));
          }
        }
        for (const l of logs) {
          if (state.done[l.transactionHash]) continue;
          const r = await fetchAttestations(l.transactionHash);
          if (r.pending) { log(`${l.transactionHash.slice(0, 10)}  waiting: ${r.why}`); continue; }
          let all = true;
          for (const [i, m] of r.messages.entries()) {
            const out = await relayOne(arcSigner, transmitter, m, `${l.transactionHash.slice(0, 10)}#${i}`);
            if (!out.relayed) { all = false; log(`${l.transactionHash.slice(0, 10)}#${i}  ${out.why}`); }
          }
          // Only banked as done when every message in it landed, so a partial
          // relay is retried instead of being written off.
          if (all) state.done[l.transactionHash] = Date.now();
        }
        from += width;
        state.lastScanned = Math.min(from - 1, latest);
      }
      saveState(state);
      fails = 0;
    } catch (e) {
      fails++;
      log(`tick error (${fails}): ${(e.shortMessage || e.message || "").slice(0, 140)}`);
    }
    if (!ONCE) setTimeout(tick, fails ? Math.min(POLL_MS * 2 ** fails, 300_000) : POLL_MS);
  }
  await tick();
}

main().catch((e) => { console.error(e); process.exit(1); });
