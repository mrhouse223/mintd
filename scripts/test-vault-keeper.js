// Unit tests for the vault keeper's decision rule.
//   node scripts/test-vault-keeper.js
//
// No chain and no ganache: `decide` is pure, which is the point of having split
// it out. The rule decides whether real money moves, so the boundaries get
// asserted exactly rather than approximately.
const { decide } = require("./vault-keeper.js");

let passed = 0, failed = 0;
const check = (c, n) => { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.log(`FAIL  ${n}`); } };

// sqrtPriceX96 for a given price ratio. Squaring is what the rule compares, so
// the inputs are built the same way the chain would produce them.
const Q96 = 2n ** 96n;
const sqrtAt = (ratio) => BigInt(Math.floor(Math.sqrt(ratio) * 2 ** 48)) * (Q96 / 2n ** 48n);

const BASE = sqrtAt(1);
const D = 1500; // default band

console.log("-- no history means HOLD, never a guess");
check(decide(BASE, 0n, false).action === "HOLD", "a missing previous price holds");
check(decide(BASE, null, false).action === "HOLD", "a null previous price holds");
check(decide(0n, BASE, false).action === "HOLD", "a zero current price holds");
check(decide(BASE, 0n, false).why.includes("no previous"), "and says why");

console.log("\n-- direction");
// r is scaled by 1e6, so the band of 1500 is 0.15%.
const down = sqrtAt(1 - 0.01);   // 1% down
const up = sqrtAt(1 + 0.01);     // 1% up
check(decide(down, BASE, false).action === "BUY", "a 1% fall buys");
check(decide(up, BASE, false).action === "SELL", "a 1% rise past 4x the band sells");
check(decide(BASE, BASE, false).action === "HOLD", "an unchanged price holds");

console.log("\n-- the band, and its asymmetry");
// Just inside and just outside, on both sides.
const justDown = sqrtAt(1 - 0.001);   // -0.1%, inside the 0.15% band
const pastDown = sqrtAt(1 - 0.002);   // -0.2%, outside
check(decide(justDown, BASE, false).action === "HOLD", "a fall inside the band holds");
check(decide(pastDown, BASE, false).action === "BUY", "a fall past the band buys");

// Selling needs FOUR times the band, so a rise that would have triggered a buy
// in the other direction must still hold.
const mirrorUp = sqrtAt(1 + 0.002);   // +0.2%: past the band, but not past 4x
check(decide(mirrorUp, BASE, false).action === "HOLD",
  "a rise the same size as a buying fall does NOT sell, the rule is buy-biased");
const bigUp = sqrtAt(1 + 0.007);      // +0.7%, past 4x the band
check(decide(bigUp, BASE, false).action === "SELL", "a rise past 4x the band sells");

console.log("\n-- r is signed and roughly the price move in parts per million");
const r1 = decide(sqrtAt(1.01), BASE, false).r;
check(r1 > 9_000 && r1 < 11_000, `a +1% move reads about +10,000 ppm (${r1})`);
const r2 = decide(sqrtAt(0.99), BASE, false).r;
check(r2 < -9_000 && r2 > -11_000, `a -1% move reads about -10,000 ppm (${r2})`);
check(decide(sqrtAt(1.01), BASE, false).r > 0 && decide(sqrtAt(0.99), BASE, false).r < 0, "sign follows direction");

console.log("\n-- custom bands");
check(decide(pastDown, BASE, false, 100).action === "BUY", "a tighter band buys the same fall");
check(decide(pastDown, BASE, false, 50_000).action === "HOLD", "a wide band ignores it");
check(decide(bigUp, BASE, false, 1500, 1).action === "SELL", "sellMult 1 makes the rule symmetric");
check(decide(mirrorUp, BASE, false, 1500, 1).action === "SELL", "and then a small rise does sell");

console.log("\n-- a tiny move cannot be truncated to nothing");
// The scaling happens before the division for exactly this reason.
const tiny = sqrtAt(1 - 0.0005);
check(decide(tiny, BASE, false).r !== 0, `a 0.05% move still registers (${decide(tiny, BASE, false).r})`);


console.log("\n-- ORIENTATION: which way is a drawdown depends on address ordering");
// sqrtPriceX96 is token1 per token0. When the QUOTE is token0, as USDT0 is
// against MINTD, the number is coin-per-quote and it goes UP as the coin gets
// CHEAPER. Reading the raw move as the coin's move inverts the entire strategy
// while every log line still looks right, which is what a live keeper was doing.
const cheaper = sqrtAt(1 + 0.01);   // more coin per quote = coin fell 1%
const dearer  = sqrtAt(1 - 0.01);   // fewer coin per quote = coin rose 1%

check(decide(cheaper, BASE, true).action === "BUY",
  "quote is token0: sqrtPrice UP means the coin fell, so it BUYS");
check(decide(dearer, BASE, true).action === "SELL",
  "quote is token0: sqrtPrice DOWN means the coin rose, so it SELLS");
check(decide(cheaper, BASE, true).r < 0, "and r is reported as the COIN's move, negative for a fall");

// The other ordering must give the opposite reading of the same numbers.
check(decide(cheaper, BASE, false).action === "SELL",
  "quote is token1: the same sqrtPrice rise means the coin ROSE");
check(decide(cheaper, BASE, true).action !== decide(cheaper, BASE, false).action,
  "the two orderings genuinely disagree, which is why it cannot be assumed");
check(decide(cheaper, BASE, true).r === -decide(cheaper, BASE, false).r,
  "r is the same magnitude with the sign flipped");

let threw = false;
try { decide(cheaper, BASE); } catch { threw = true; }
check(threw, "omitting the orientation throws rather than silently picking one");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
