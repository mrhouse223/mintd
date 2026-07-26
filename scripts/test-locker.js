// Integration tests for TokenLocker in ganache with time travel.
//   node scripts/compile.js && node scripts/test-locker.js
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const E = (v) => ethers.parseEther(String(v));

let passed = 0, failed = 0;
function check(c, n) { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.log(`FAIL  ${n}`); } }

async function main() {
  const gp = ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 100000 } });
  const provider = new ethers.BrowserProvider(gp);
  const [deployer, feeRcpt, alice, bob] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const GS = { gasLimit: 3_000_000 };
  const warp = async (secs) => {
    await gp.request({ method: "evm_increaseTime", params: [secs] });
    await gp.request({ method: "evm_mine", params: [] });
  };
  const now = async () => (await provider.getBlock("latest")).timestamp;

  // token to lock + the locker itself (fee: 1 native)
  const tokArt = build("MemeToken20");
  const tok = await new ethers.ContractFactory(tokArt.abi, tokArt.bytecode, deployer).deploy("Lock Me", "LOCKME", "", E(1_000_000), alice.address);
  await tok.waitForDeployment();
  const tokAddr = await tok.getAddress();

  const FEE = E(1);
  const lkArt = build("TokenLocker");
  const locker = await new ethers.ContractFactory(lkArt.abi, lkArt.bytecode, deployer).deploy(feeRcpt.address, FEE);
  await locker.waitForDeployment();
  const lkAddr = await locker.getAddress();
  check((await locker.lockFee()) === FEE, "locker deployed with $1 fee");

  const tA = tok.connect(alice);
  await (await tA.approve(lkAddr, ethers.MaxUint256, GS)).wait();

  // ---- basic lock
  const t0 = await now();
  const unlock1 = t0 + 30 * 86400; // 30 days
  const rcL = await (await locker.connect(alice).lock(tokAddr, E(100_000), unlock1, { value: FEE, ...GS })).wait();
  check((await locker.lockCount()) === 1n, "lock stored");
  const L = await locker.locks(0);
  check(L.owner === alice.address && L.token === tokAddr, "owner + token recorded");
  check(L.amount === E(100_000), "full amount locked");
  check((await tok.balanceOf(lkAddr)) === E(100_000), "tokens held by locker");
  check((await locker.totalLocked(tokAddr)) === E(100_000), "totalLocked tracks");
  // balance at explicit blocks: BrowserProvider caches "latest" reads
  const feeDiff = (await provider.getBalance(feeRcpt.address, rcL.blockNumber)) -
                  (await provider.getBalance(feeRcpt.address, rcL.blockNumber - 1));
  check(feeDiff === FEE, "flat fee paid to platform");

  // ---- guards on creation
  let rev = false;
  try { await (await locker.connect(alice).lock(tokAddr, E(1), t0 - 100, { value: FEE, ...GS })).wait(); } catch { rev = true; }
  check(rev, "unlock time in the past rejected");
  rev = false;
  try { await (await locker.connect(alice).lock(tokAddr, E(1), unlock1, { value: 0, ...GS })).wait(); } catch { rev = true; }
  check(rev, "missing fee rejected");
  rev = false;
  try { await (await locker.connect(alice).lock(tokAddr, 0, unlock1, { value: FEE, ...GS })).wait(); } catch { rev = true; }
  check(rev, "zero amount rejected");
  rev = false;
  try { await (await locker.connect(alice).lock(tokAddr, E(1), t0 + 4000 * 86400, { value: FEE, ...GS })).wait(); } catch { rev = true; }
  check(rev, "duration over the 10y cap rejected");

  // ---- withdraw guards
  rev = false;
  try { await (await locker.connect(alice).withdraw(0, GS)).wait(); } catch { rev = true; }
  check(rev, "early withdraw rejected (still locked)");
  rev = false;
  try { await (await locker.connect(bob).withdraw(0, GS)).wait(); } catch { rev = true; }
  check(rev, "non-owner withdraw rejected");

  // ---- extend: only forward, only owner
  const unlock2 = unlock1 + 30 * 86400;
  await (await locker.connect(alice).extend(0, unlock2, GS)).wait();
  check((await locker.locks(0)).unlockTime === BigInt(unlock2), "extend pushes unlock out");
  rev = false;
  try { await (await locker.connect(alice).extend(0, unlock1, GS)).wait(); } catch { rev = true; }
  check(rev, "shortening a lock rejected");
  rev = false;
  try { await (await locker.connect(bob).extend(0, unlock2 + 86400, GS)).wait(); } catch { rev = true; }
  check(rev, "non-owner extend rejected");

  // ---- second lock by bob (bob needs tokens first)
  await (await tA.transfer(bob.address, E(5_000), GS)).wait();
  await (await tok.connect(bob).approve(lkAddr, ethers.MaxUint256, GS)).wait();
  const shortUnlock = (await now()) + 7 * 86400;
  await (await locker.connect(bob).lock(tokAddr, E(5_000), shortUnlock, { value: FEE, ...GS })).wait();
  check((await locker.lockCount()) === 2n, "second lock stored");
  const aliceIds = await locker.locksOf(alice.address);
  const bobIds = await locker.locksOf(bob.address);
  check(aliceIds.length === 1 && bobIds.length === 1, "locksOf per owner correct");
  check((await locker.locksForToken(tokAddr)).length === 2, "locksForToken correct");

  // ---- time travel: bob matures first
  await warp(8 * 86400);
  const bobBefore = await tok.balanceOf(bob.address);
  await (await locker.connect(bob).withdraw(1, GS)).wait();
  check((await tok.balanceOf(bob.address)) - bobBefore === E(5_000), "matured withdraw returns full amount");
  check((await locker.totalLocked(tokAddr)) === E(100_000), "totalLocked drops after withdraw");
  rev = false;
  try { await (await locker.connect(bob).withdraw(1, GS)).wait(); } catch { rev = true; }
  check(rev, "double withdraw rejected");

  // ---- alice's extended lock still locked at day 8, matures at day 60
  rev = false;
  try { await (await locker.connect(alice).withdraw(0, GS)).wait(); } catch { rev = true; }
  check(rev, "extended lock still locked before new unlock");
  await warp(60 * 86400);
  const aBefore = await tok.balanceOf(alice.address);
  await (await locker.connect(alice).withdraw(0, GS)).wait();
  check((await tok.balanceOf(alice.address)) - aBefore === E(100_000), "extended lock withdraws after new unlock");
  check((await locker.totalLocked(tokAddr)) === 0n, "totalLocked back to zero");

  // ---- admin surface: fee tune only, no token escape hatch
  rev = false;
  try { await (await locker.connect(alice).setFee(0, alice.address, GS)).wait(); } catch { rev = true; }
  check(rev, "setFee is onlyOwner");
  await (await locker.connect(deployer).setFee(0, feeRcpt.address, GS)).wait();
  check((await locker.lockFee()) === 0n, "owner can change fee");
  const fns = lkArt.abi.filter((x) => x.type === "function" && !["view", "pure"].includes(x.stateMutability)).map((x) => x.name);
  check(!fns.some((n) => /rescue|sweep|emergency|pause/i.test(n)), "no admin path to locked tokens");

  // free lock works after fee set to 0
  await (await tA.approve(lkAddr, ethers.MaxUint256, GS)).wait();
  await (await locker.connect(alice).lock(tokAddr, E(10), (await now()) + 86400, { value: 0, ...GS })).wait();
  check((await locker.lockCount()) === 3n, "zero-fee lock works");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
