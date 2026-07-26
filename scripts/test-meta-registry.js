// Tests for TokenMetaRegistry against both launchpad struct shapes.
//   node scripts/compile.js && node scripts/test-meta-registry.js
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
let passed = 0, failed = 0;
function check(c, n) { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.log(`FAIL  ${n}`); } }

async function main() {
  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true } }));
  const [deployer, alice, bob] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const GS = { gasLimit: 2_000_000 };
  const dep = async (name, ...args) => {
    const a = build(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };

  // two mock pads with the two real struct shapes + one registry over both
  const padOld = await dep("MockPadOld");
  const padNew = await dep("MockPadNew");
  const reg = await dep("TokenMetaRegistry", [await padOld.getAddress(), await padNew.getAddress()]);

  const tokA = "0x1111111111111111111111111111111111111111"; // on old pad, creator alice
  const tokB = "0x2222222222222222222222222222222222222222"; // on new pad, creator bob
  const tokX = "0x3333333333333333333333333333333333333333"; // on no pad
  await (await padOld.set(tokA, alice.address, GS)).wait();
  await (await padNew.set(tokB, bob.address, GS)).wait();

  check((await reg.creatorOf(tokA)) === alice.address, "creator resolved from OLD 7-field pad");
  check((await reg.creatorOf(tokB)) === bob.address, "creator resolved from NEW 8-field pad");
  check((await reg.creatorOf(tokX)) === ethers.ZeroAddress, "unknown token resolves to zero");

  const json = '{"description":"new bio","x":"https://x.com/newlink"}';
  await (await reg.connect(alice).setMeta(tokA, json, GS)).wait();
  check((await reg.metaOf(tokA)) === json, "creator can set metadata override");

  let rev = false;
  try { await (await reg.connect(bob).setMeta(tokA, "{}", GS)).wait(); } catch { rev = true; }
  check(rev, "non-creator rejected");
  rev = false;
  try { await (await reg.connect(alice).setMeta(tokX, "{}", GS)).wait(); } catch { rev = true; }
  check(rev, "token on no known pad rejected");
  rev = false;
  try { await (await reg.connect(alice).setMeta(tokA, "x".repeat(9000), GS)).wait(); } catch { rev = true; }
  check(rev, "oversized json rejected");

  await (await reg.connect(alice).setMeta(tokA, "", GS)).wait();
  check((await reg.metaOf(tokA)) === "", "creator can clear their override");

  // update again after clearing
  await (await reg.connect(alice).setMeta(tokA, '{"telegram":"https://t.me/x"}', GS)).wait();
  check((await reg.metaOf(tokA)).includes("t.me"), "creator can re-set after clearing");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
