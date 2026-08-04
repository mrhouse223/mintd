// Unit tests for AgentConfig. It holds no funds, so the whole surface is the
// owner gate and the bounds.
//   node scripts/compile.js && node scripts/test-agent-config.js
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
let passed = 0, failed = 0;
const check = (c, n) => { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.log(`FAIL  ${n}`); } };
async function reverts(fn, label, want) {
  try { await fn(); failed++; console.log(`FAIL  ${label} (did not revert)`); }
  catch (e) { const m = e.shortMessage || e.message || "";
    if (want && !m.includes(want)) { failed++; console.log(`FAIL  ${label} (wrong reason: ${m.slice(0,70)})`); }
    else { passed++; console.log(`  ok  ${label}`); } }
}

async function main() {
  const gp = ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 1000 } });
  const provider = new ethers.BrowserProvider(gp);
  const [deployer, alice, bob] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const GS = { gasLimit: 3_000_000 };
  const dep = async (n, s, ...a) => { const b = build(n); const c = await new ethers.ContractFactory(b.abi, b.bytecode, s).deploy(...a); await c.waitForDeployment(); return c; };

  const cfg = await dep("AgentConfig", deployer);
  const cfgAddr = await cfg.getAddress();

  // A stand-in vault: anything exposing owner(). MockOwned isn't in the tree, so
  // reuse AgentConfig-shaped owner via a tiny inline deploy through a known
  // contract that has owner(). BuybackVault has owner(); deploy a bare one is
  // heavy, so use a minimal owner stub.
  const ownedAbi = ["function owner() view returns (address)"];
  // MockPadNew has no owner(); use a TestToken? It has no owner either. Deploy a
  // one-liner owner contract via inline bytecode: returns a fixed owner.
  // Simplest: point the vault arg at an EOA-like contract we control. Instead we
  // deploy StakingRewards? Overkill. Use the fact that a plain address with no
  // code makes owner() revert, which is itself a test.
  await reverts(() => cfg.connect(alice).setConfig.staticCall(bob.address, 300, 3, 8, 75),
    "a vault whose owner() cannot be read is rejected", "");

  // Deploy something that genuinely has owner() == alice: BuybackVaultFactory
  // has no owner, but a BuybackVault does. Cheapest real owner() is a MINTR-less
  // path; instead deploy a trivial Owned via AgentConfig itself is not owned.
  // Use TokenLocker: its owner() is the deployer.
  const locker = await dep("TokenLocker", alice, deployer.address, 0);
  const lockerAddr = await locker.getAddress(); // owner() == alice (constructor sets owner=msg.sender)
  check((await locker.owner()) === alice.address, "stand-in vault owner is alice");

  console.log("\n-- owner gate");
  await reverts(() => cfg.connect(bob).setConfig.staticCall(lockerAddr, 300, 3, 8, 75),
    "a non-owner cannot set a vault's config", "not vault owner");
  await (await cfg.connect(alice).setConfig(lockerAddr, 300, 3, 8, 75, GS)).wait();
  const c = await cfg.get(lockerAddr);
  check(c.set && Number(c.band) === 300 && Number(c.sellMult) === 3 && Number(c.lpWidth) === 8 && Number(c.lpEdgePct) === 75,
    "owner's config is stored and reads back exactly");

  console.log("\n-- bounds");
  await reverts(() => cfg.connect(alice).setConfig.staticCall(lockerAddr, 0, 3, 8, 75), "band floor", "band");
  await reverts(() => cfg.connect(alice).setConfig.staticCall(lockerAddr, 50001, 3, 8, 75), "band cap", "band");
  await reverts(() => cfg.connect(alice).setConfig.staticCall(lockerAddr, 300, 0, 8, 75), "sellMult floor", "sellMult");
  await reverts(() => cfg.connect(alice).setConfig.staticCall(lockerAddr, 300, 21, 8, 75), "sellMult cap", "sellMult");
  await reverts(() => cfg.connect(alice).setConfig.staticCall(lockerAddr, 300, 3, 0, 75), "lpWidth floor", "lpWidth");
  await reverts(() => cfg.connect(alice).setConfig.staticCall(lockerAddr, 300, 3, 101, 75), "lpWidth cap", "lpWidth");
  await reverts(() => cfg.connect(alice).setConfig.staticCall(lockerAddr, 300, 3, 8, 0), "lpEdge floor", "lpEdge");
  await reverts(() => cfg.connect(alice).setConfig.staticCall(lockerAddr, 300, 3, 8, 100), "lpEdge cap", "lpEdge");

  console.log("\n-- clear falls back to keeper defaults");
  await reverts(() => cfg.connect(bob).clearConfig.staticCall(lockerAddr), "non-owner cannot clear", "not vault owner");
  await (await cfg.connect(alice).clearConfig(lockerAddr, GS)).wait();
  check(!(await cfg.get(lockerAddr)).set, "cleared config reports set=false, so the keeper uses its own defaults");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
