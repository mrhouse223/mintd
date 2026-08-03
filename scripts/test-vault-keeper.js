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
check(decide(BASE, 0n).action === "HOLD", "a missing previous price holds");
check(decide(BASE, null).action === "HOLD", "a null previous price holds");
check(decide(0n, BASE).action === "HOLD", "a zero current price holds");
check(decide(BASE, 0n).why.includes("no previous"), "and says why");

console.log("\n-- direction");
// r is scaled by 1e6, so the band of 1500 is 0.15%.
const down = sqrtAt(1 - 0.01);   // 1% down
const up = sqrtAt(1 + 0.01);     // 1% up
check(decide(down, BASE).action === "BUY", "a 1% fall buys");
check(decide(up, BASE).action === "SELL", "a 1% rise past 4x the band sells");
check(decide(BASE, BASE).action === "HOLD", "an unchanged price holds");

console.log("\n-- the band, and its asymmetry");
// Just inside and just outside, on both sides.
const justDown = sqrtAt(1 - 0.001);   // -0.1%, inside the 0.15% band
const pastDown = sqrtAt(1 - 0.002);   // -0.2%, outside
check(decide(justDown, BASE).action === "HOLD", "a fall inside the band holds");
check(decide(pastDown, BASE).action === "BUY", "a fall past the band buys");

// Selling needs FOUR times the band, so a rise that would have triggered a buy
// in the other direction must still hold.
const mirrorUp = sqrtAt(1 + 0.002);   // +0.2%: past the band, but not past 4x
check(decide(mirrorUp, BASE).action === "HOLD",
  "a rise the same size as a buying fall does NOT sell, the rule is buy-biased");
const bigUp = sqrtAt(1 + 0.007);      // +0.7%, past 4x the band
check(decide(bigUp, BASE).action === "SELL", "a rise past 4x the band sells");

console.log("\n-- r is signed and roughly the price move in parts per million");
const r1 = decide(sqrtAt(1.01), BASE).r;
check(r1 > 9_000 && r1 < 11_000, `a +1% move reads about +10,000 ppm (${r1})`);
const r2 = decide(sqrtAt(0.99), BASE).r;
check(r2 < -9_000 && r2 > -11_000, `a -1% move reads about -10,000 ppm (${r2})`);
check(decide(sqrtAt(1.01), BASE).r > 0 && decide(sqrtAt(0.99), BASE).r < 0, "sign follows direction");

console.log("\n-- custom bands");
check(decide(pastDown, BASE, 100).action === "BUY", "a tighter band buys the same fall");
check(decide(pastDown, BASE, 50_000).action === "HOLD", "a wide band ignores it");
check(decide(bigUp, BASE, 1500, 1).action === "SELL", "sellMult 1 makes the rule symmetric");
check(decide(mirrorUp, BASE, 1500, 1).action === "SELL", "and then a small rise does sell");

console.log("\n-- a tiny move cannot be truncated to nothing");
// The scaling happens before the division for exactly this reason.
const tiny = sqrtAt(1 - 0.0005);
check(decide(tiny, BASE).r !== 0, `a 0.05% move still registers (${decide(tiny, BASE).r})`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
