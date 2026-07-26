# Launch playbook

How to stand up the whole platform again, under any name, on any EVM chain.
Roughly two hours end to end, most of it waiting on the compiler.

---

## 0. Put this in git first

Nothing else here matters if the code only exists as file copies.

```bash
cd ~/mintd
git init
git add -A
git commit -m "mintd.fun: launchpad, MINTR, MGLD, locker, farms, bots"
# then push to a private GitHub repo
git remote add origin git@github.com:you/mintd.git
git push -u origin main
```

`.gitignore` already excludes `.env`, `build/` and `node_modules/`.
`deployments/` **is** committed on purpose: it is how you find your contracts again.

---

## 1. Fork it for a new brand

```bash
git clone <your repo> newbrand && cd newbrand
```

Edit **`brand.json`** and nothing else:

| Field | What it does |
|---|---|
| `name`, `tagline`, `domain` | site identity |
| `platformToken`, `reserveToken`, `goldToken` | the three token names and tickers |
| `socials` | X and Telegram links |
| `theme` | accent colours |
| `economics` | creation fee, creator share, opening price, graduation target |
| `chain` | RPC, quote token, DEX addresses, oracle |

Replace the artwork in `frontend/`: `logo.png`, `logo.svg`, `icon-192.png`,
`icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, plus
`mintr.png` and `mgld.png` if you keep those products.

---

## 2. Deploy the contracts

```bash
npm install
node scripts/compile.js                 # 30 to 60 seconds

# see the plan without spending anything
PRIVATE_KEY=0x... node scripts/deploy-all.js --dry

# do it
PRIVATE_KEY=0x... node scripts/deploy-all.js
```

`deploy-all.js` is **resumable**. Every address lands in
`deployments/<chainId>.json` the moment it exists, and re-running skips whatever
is already there. If it dies halfway, run it again.

It deploys, in dependency order: launchpad → platform token → buyback burner →
reserve token → token locker → V3 position locker → meta registry → gold synth.
At the end it prints the exact frontend constants to paste in.

Redeploy one thing: delete its key from the JSON, or `--only=locker`.

---

## 3. Money steps, separately

These spend real funds in amounts you choose, so they are deliberately not in
`deploy-all`:

```bash
node scripts/deploy-mintr.js        # seed the reserve token
node scripts/deploy-mintswap.js     # your own V2 AMM
node scripts/deploy-farm.js         # LP farm + rewards
node scripts/seed-mgld-pool.js      # gold pool at the oracle price
node scripts/deploy-arb.js          # arb contract, FUND=200 to seed the float
```

---

## 4. Frontend

Paste the printed constants into `frontend/index.html`, then deploy the folder to
Netlify. It is a single static file plus images, so any host works.

The PWA files (`manifest.webmanifest`, `sw.js`, icons) need no changes beyond the
name and colours inside the manifest.

---

## 5. Bots

```bash
cp .env.example .env && chmod 600 .env    # fill in, never commit
pm2 start ecosystem.config.js && pm2 save
pm2 startup                                # run the line it prints
```

Runs the two buybots and the arb keeper. Use a **dedicated gas-only wallet** for
`KEEPER_KEY`.

---

## 6. Before telling anyone

- [ ] `node scripts/test-instant.js` and the other suites pass
- [ ] verify contracts on the explorer (`verify-prep.js`, `verify-token.js`)
- [ ] launch the platform token and seed a real market
- [ ] trigger one buyback so the burn counter is not zero
- [ ] test a buy, a sell, a launch and a claim from a fresh wallet
- [ ] check the site on a phone, install the PWA
- [ ] move ownership off the deploying key

---

## What is reusable vs what is not

**Reusable as-is:** every contract, every deploy and test script, the whole
frontend, the bots, the PWA. Change `brand.json` and the images.

**Needs thought per launch:** how much liquidity to seed, farm emission size,
which oracle feeds exist on the target chain, and whether that chain has a
canonical Uniswap V3 (the launchpad requires one; see `ROADMAP-arc-and-agents.md`
for the Arc analysis of exactly this problem).

**Do not reuse:** private keys, and the `deployments/` file from another brand.
