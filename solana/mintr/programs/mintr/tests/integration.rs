// End-to-end tests for the mintr program on a real in-process SVM (litesvm),
// with the real SPL Token and Associated-Token programs. These exercise the
// parts the pure-math unit tests cannot: the CPIs actually move USDC and mint
// MINTR, the owner gate actually rejects, and there is no path that drains the
// reserve. Run with `anchor build && cargo test` (the .so is read at runtime).
use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        instruction::Instruction, program_pack::Pack, system_instruction, system_program,
    },
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::{
    associated_token::{get_associated_token_address, ID as ATA_PROGRAM_ID},
    token::{spl_token, ID as TOKEN_PROGRAM_ID},
};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

const USDC_DECIMALS: u8 = 6;
// Starting pool used across tests: 1,000 USDC backing 100,000 MINTR -> $0.01.
const SEED_USDC: u64 = 1_000_000_000; // 1,000 USDC (6-dec)
const SEED_MINTR: u64 = 100_000_000_000; // 100,000 MINTR (6-dec)

struct Env {
    svm: LiteSVM,
    pid: Pubkey,
    config: Pubkey,
    mintr_mint: Pubkey,
    reserve_vault: Pubkey,
    usdc: Pubkey,
    owner: Keypair, // program owner AND the test-USDC mint authority
}

fn send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    signers: &[&Keypair],
) -> Result<(), String> {
    // litesvm does not advance the blockhash on its own, so two byte-identical
    // transactions would collide as AlreadyProcessed. Advance it every send.
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    // Dedupe by pubkey: the fee payer is often also a mint/transfer authority,
    // and passing the same keypair twice trips try_new's TooManySigners check.
    let mut uniq: Vec<&Keypair> = Vec::new();
    for s in signers {
        if !uniq.iter().any(|u| u.pubkey() == s.pubkey()) {
            uniq.push(s);
        }
    }
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &uniq)
        .map_err(|e| format!("sign: {e:?}"))?;
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?}", e.err))
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair, authority: &Pubkey, decimals: u8) -> Pubkey {
    let mint = Keypair::new();
    let rent = svm.minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN);
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        rent,
        spl_token::state::Mint::LEN as u64,
        &TOKEN_PROGRAM_ID,
    );
    let init =
        spl_token::instruction::initialize_mint2(&TOKEN_PROGRAM_ID, &mint.pubkey(), authority, None, decimals)
            .unwrap();
    send(svm, &[create, init], payer, &[payer, &mint]).unwrap();
    mint.pubkey()
}

fn create_ata(svm: &mut LiteSVM, payer: &Keypair, wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    let ix = anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account(
        &payer.pubkey(),
        wallet,
        mint,
        &TOKEN_PROGRAM_ID,
    );
    send(svm, &[ix], payer, &[payer]).unwrap();
    get_associated_token_address(wallet, mint)
}

fn give_usdc(svm: &mut LiteSVM, payer: &Keypair, mint: &Pubkey, auth: &Keypair, dest: &Pubkey, amount: u64) {
    let ix = spl_token::instruction::mint_to(&TOKEN_PROGRAM_ID, mint, dest, &auth.pubkey(), &[], amount).unwrap();
    send(svm, &[ix], payer, &[payer, auth]).unwrap();
}

fn token_balance(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    let acc = svm.get_account(ata).unwrap();
    spl_token::state::Account::unpack(&acc.data).unwrap().amount
}

fn supply(svm: &LiteSVM, mint: &Pubkey) -> u64 {
    let acc = svm.get_account(mint).unwrap();
    spl_token::state::Mint::unpack(&acc.data).unwrap().supply
}

fn read_config(svm: &LiteSVM, config: &Pubkey) -> mintr::Config {
    let acc = svm.get_account(config).unwrap();
    mintr::Config::try_deserialize(&mut &acc.data[..]).unwrap()
}

fn funded_user(svm: &mut LiteSVM) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), 100_000_000_000).unwrap(); // 100 SOL for rent + fees
    kp
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let pid = mintr::ID;
    let so = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/mintr.so"
    ))
    .expect("run `anchor build` first to produce target/deploy/mintr.so");
    svm.add_program(pid, &so).unwrap();

    let owner = Keypair::new();
    svm.airdrop(&owner.pubkey(), 100_000_000_000).unwrap();

    // A test USDC whose mint authority is the owner, so we can hand it out.
    let usdc = create_mint(&mut svm, &owner, &owner.pubkey(), USDC_DECIMALS);

    let config = Pubkey::find_program_address(&[b"config"], &pid).0;
    let mintr_mint = Pubkey::find_program_address(&[b"mintr_mint"], &pid).0;
    let reserve_vault = Pubkey::find_program_address(&[b"reserve_vault"], &pid).0;

    let ix = Instruction::new_with_bytes(
        pid,
        &mintr::instruction::Initialize {}.data(),
        mintr::accounts::Initialize {
            owner: owner.pubkey(),
            config,
            mintr_mint,
            usdc_mint: usdc,
            reserve_vault,
            token_program: TOKEN_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[ix], &owner, &[&owner]).unwrap();

    Env { svm, pid, config, mintr_mint, reserve_vault, usdc, owner }
}

fn seed(env: &mut Env, usdc_amount: u64, mintr_amount: u64) -> Pubkey {
    let owner_usdc = create_ata(&mut env.svm, &env.owner, &env.owner.pubkey(), &env.usdc);
    give_usdc(&mut env.svm, &env.owner, &env.usdc, &env.owner, &owner_usdc, usdc_amount);
    let owner_mintr = create_ata(&mut env.svm, &env.owner, &env.owner.pubkey(), &env.mintr_mint);
    let ix = Instruction::new_with_bytes(
        env.pid,
        &mintr::instruction::Seed { usdc_amount, mintr_amount }.data(),
        mintr::accounts::Seed {
            config: env.config,
            mintr_mint: env.mintr_mint,
            reserve_vault: env.reserve_vault,
            owner: env.owner.pubkey(),
            owner_usdc,
            owner_mintr,
            token_program: TOKEN_PROGRAM_ID,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &[ix], &env.owner, &[&env.owner]).unwrap();
    owner_mintr
}

fn buy(env: &mut Env, buyer: &Keypair, buyer_usdc: Pubkey, usdc_in: u64, min_out: u64) -> Result<(), String> {
    let buyer_mintr = get_associated_token_address(&buyer.pubkey(), &env.mintr_mint);
    let ix = Instruction::new_with_bytes(
        env.pid,
        &mintr::instruction::Buy { usdc_in, min_out }.data(),
        mintr::accounts::Buy {
            config: env.config,
            mintr_mint: env.mintr_mint,
            reserve_vault: env.reserve_vault,
            buyer: buyer.pubkey(),
            buyer_usdc,
            buyer_mintr,
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &[ix], buyer, &[buyer])
}

fn sell(env: &mut Env, seller: &Keypair, seller_usdc: Pubkey, mintr_in: u64, min_usdc: u64) -> Result<(), String> {
    let seller_mintr = get_associated_token_address(&seller.pubkey(), &env.mintr_mint);
    let ix = Instruction::new_with_bytes(
        env.pid,
        &mintr::instruction::Sell { mintr_in, min_usdc }.data(),
        mintr::accounts::Sell {
            config: env.config,
            mintr_mint: env.mintr_mint,
            reserve_vault: env.reserve_vault,
            seller: seller.pubkey(),
            seller_mintr,
            usdc_mint: env.usdc,
            seller_usdc,
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &[ix], seller, &[seller])
}

fn set_fees(env: &mut Env, caller: &Keypair, buy_fee_bps: u16, sell_fee_bps: u16) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        env.pid,
        &mintr::instruction::SetFees { buy_fee_bps, sell_fee_bps }.data(),
        mintr::accounts::OnlyOwner { config: env.config, owner: caller.pubkey() }.to_account_metas(None),
    );
    send(&mut env.svm, &[ix], caller, &[caller])
}

// reserve_a/supply_a <= reserve_b/supply_b via cross-multiply (no float).
fn price_non_decreasing(r_a: u64, s_a: u64, r_b: u64, s_b: u64) -> bool {
    (r_a as u128) * (s_b as u128) <= (r_b as u128) * (s_a as u128)
}

#[test]
fn seed_sets_price_and_backs_the_supply() {
    let mut env = setup();
    let owner_mintr = seed(&mut env, SEED_USDC, SEED_MINTR);

    let c = read_config(&env.svm, &env.config);
    assert!(c.seeded);
    assert_eq!(c.reserve, SEED_USDC);
    assert_eq!(c.buy_fee_bps, 100);
    assert_eq!(c.sell_fee_bps, 100);
    assert_eq!(supply(&env.svm, &env.mintr_mint), SEED_MINTR);
    assert_eq!(token_balance(&env.svm, &owner_mintr), SEED_MINTR);
    // The vault holds exactly the seeded USDC.
    assert_eq!(token_balance(&env.svm, &env.reserve_vault), SEED_USDC);
}

#[test]
fn buy_mints_at_backing_and_lifts_the_price() {
    let mut env = setup();
    seed(&mut env, SEED_USDC, SEED_MINTR);

    let alice = funded_user(&mut env.svm);
    let alice_usdc = create_ata(&mut env.svm, &alice, &alice.pubkey(), &env.usdc);
    give_usdc(&mut env.svm, &env.owner, &env.usdc, &env.owner, &alice_usdc, 500_000_000);

    let (r0, s0) = {
        let c = read_config(&env.svm, &env.config);
        (c.reserve, supply(&env.svm, &env.mintr_mint))
    };
    // Buy 100 USDC at 1% fee: net 99, out = 99 * 100000/1000 = 9,900 MINTR.
    buy(&mut env, &alice, alice_usdc, 100_000_000, 0).unwrap();

    let alice_mintr = get_associated_token_address(&alice.pubkey(), &env.mintr_mint);
    assert_eq!(token_balance(&env.svm, &alice_mintr), 9_900_000_000);

    let c = read_config(&env.svm, &env.config);
    assert_eq!(c.reserve, r0 + 100_000_000); // full usdc_in stays in reserve
    let s1 = supply(&env.svm, &env.mintr_mint);
    assert_eq!(s1, s0 + 9_900_000_000);
    assert!(price_non_decreasing(r0, s0, c.reserve, s1));
    assert!(!price_non_decreasing(c.reserve, s1, r0, s0)); // strictly up
}

#[test]
fn round_trip_leaves_the_price_higher_than_it_started() {
    let mut env = setup();
    seed(&mut env, SEED_USDC, SEED_MINTR);

    let alice = funded_user(&mut env.svm);
    let alice_usdc = create_ata(&mut env.svm, &alice, &alice.pubkey(), &env.usdc);
    give_usdc(&mut env.svm, &env.owner, &env.usdc, &env.owner, &alice_usdc, 500_000_000);

    buy(&mut env, &alice, alice_usdc, 100_000_000, 0).unwrap();
    let alice_mintr = get_associated_token_address(&alice.pubkey(), &env.mintr_mint);
    let bought = token_balance(&env.svm, &alice_mintr);

    // Sell it all straight back. Two 1% fees mean she gets less than she paid.
    let before_usdc = token_balance(&env.svm, &alice_usdc);
    sell(&mut env, &alice, alice_usdc, bought, 0).unwrap();
    let got = token_balance(&env.svm, &alice_usdc) - before_usdc;
    assert!(got < 100_000_000, "round-trip should cost fees, got {got}");

    // Supply is back to the seed; reserve is higher -> backing per token rose.
    assert_eq!(supply(&env.svm, &env.mintr_mint), SEED_MINTR);
    let c = read_config(&env.svm, &env.config);
    assert!(c.reserve > SEED_USDC, "fees should have grown the reserve: {}", c.reserve);
    assert!(price_non_decreasing(SEED_USDC, SEED_MINTR, c.reserve, SEED_MINTR));
}

#[test]
fn slippage_guard_blocks_a_bad_fill() {
    let mut env = setup();
    seed(&mut env, SEED_USDC, SEED_MINTR);
    let alice = funded_user(&mut env.svm);
    let alice_usdc = create_ata(&mut env.svm, &alice, &alice.pubkey(), &env.usdc);
    give_usdc(&mut env.svm, &env.owner, &env.usdc, &env.owner, &alice_usdc, 500_000_000);

    // Demand far more MINTR than 100 USDC can buy.
    let r = buy(&mut env, &alice, alice_usdc, 100_000_000, 1_000_000_000_000);
    assert!(r.is_err(), "min_out above the quote must revert");
    // And the failed buy took nothing.
    assert_eq!(token_balance(&env.svm, &alice_usdc), 500_000_000);
}

#[test]
fn only_the_owner_can_set_fees_and_bounds_hold() {
    let mut env = setup();
    seed(&mut env, SEED_USDC, SEED_MINTR);

    let stranger = funded_user(&mut env.svm);
    assert!(set_fees(&mut env, &stranger, 200, 200).is_err(), "non-owner blocked");

    // Owner can, within bounds.
    let owner = env.owner.insecure_clone();
    assert!(set_fees(&mut env, &owner, 250, 250).is_ok());
    let c = read_config(&env.svm, &env.config);
    assert_eq!((c.buy_fee_bps, c.sell_fee_bps), (250, 250));

    // Zero backing fee breaks monotonicity -> rejected. Over the 3% cap -> rejected.
    assert!(set_fees(&mut env, &owner, 0, 250).is_err());
    assert!(set_fees(&mut env, &owner, 250, 301).is_err());
}

#[test]
fn cannot_seed_twice() {
    let mut env = setup();
    seed(&mut env, SEED_USDC, SEED_MINTR);

    // The owner's ATAs already exist from the first seed; reuse them. seed()
    // reverts on the `seeded` check before any transfer, so no USDC is needed.
    let owner_usdc = get_associated_token_address(&env.owner.pubkey(), &env.usdc);
    let owner_mintr = get_associated_token_address(&env.owner.pubkey(), &env.mintr_mint);
    let ix = Instruction::new_with_bytes(
        env.pid,
        &mintr::instruction::Seed { usdc_amount: SEED_USDC, mintr_amount: SEED_MINTR }.data(),
        mintr::accounts::Seed {
            config: env.config,
            mintr_mint: env.mintr_mint,
            reserve_vault: env.reserve_vault,
            owner: env.owner.pubkey(),
            owner_usdc,
            owner_mintr,
            token_program: TOKEN_PROGRAM_ID,
        }
        .to_account_metas(None),
    );
    let owner = env.owner.insecure_clone();
    assert!(send(&mut env.svm, &[ix], &owner, &[&owner]).is_err());
}

#[test]
fn full_exit_does_not_underflow() {
    let mut env = setup();
    let owner_mintr = seed(&mut env, SEED_USDC, SEED_MINTR);

    // Owner holds the entire supply. The owner USDC ATA already exists (emptied
    // into the vault by seed); reuse it to receive the sell proceeds.
    let owner_usdc = get_associated_token_address(&env.owner.pubkey(), &env.usdc);
    let owner = env.owner.insecure_clone();
    sell(&mut env, &owner, owner_usdc, SEED_MINTR, 0).unwrap();

    // Supply is zero; the 1% sell fee remains as stranded backing, no underflow.
    assert_eq!(supply(&env.svm, &env.mintr_mint), 0);
    assert_eq!(token_balance(&env.svm, &owner_mintr), 0);
    let c = read_config(&env.svm, &env.config);
    // gross = full reserve (1000 USDC); user got 99%; 1% (10 USDC) stays.
    assert_eq!(c.reserve, 10_000_000);
    assert_eq!(token_balance(&env.svm, &env.reserve_vault), 10_000_000);
}
