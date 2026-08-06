// ----------------------------------------------------------------------------
// MINTR on Solana: a fully-backed reserve token. Port of the Stable MINTR.
//
// price = reserve / supply (backing per token). Buy with USDC mints MINTR; sell
// MINTR burns it and pays USDC. A fee on each side (1% in, 1% out) STAYS in the
// reserve while the sold tokens are burned, so backing-per-token is
// mathematically non-decreasing. There is deliberately NO withdraw instruction:
// USDC leaves only via sell() paying a redeemer. The owner can adjust fees
// within a bounded range but can never touch the backing.
//
// Two Solana-specific rules this file lives by (see docs/plans/mintr-solana.md):
//   1. All price math is done in u128 with checked ops; u64 products overflow.
//   2. The reserve is an internal field, NEVER the vault's token balance:
//      anyone can donate USDC into the vault, which would otherwise distort
//      the price. This mirrors the EVM version never reading balanceOf.
//
// Immutability (the "owner can never touch the backing" guarantee at the code
// level) is completed at deploy time by removing the program's upgrade
// authority. Until that step, this program is upgradeable like any other.
// ----------------------------------------------------------------------------
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer},
};

declare_id!("EFsoTfU9fZyji1ip3owHqkPg1EdZcULnsFdeyxZHWqpk");

const BPS_DENOM: u128 = 10_000;
const MAX_FEE_BPS: u16 = 300; // 3% ceiling on each side
const MINTR_DECIMALS: u8 = 6; // match USDC so price is a clean 1:1-scaled ratio

const CONFIG_SEED: &[u8] = b"config";
const MINT_SEED: &[u8] = b"mintr_mint";
const VAULT_SEED: &[u8] = b"reserve_vault";

// The price math, pulled out of the handlers so it can be tested without a VM.
// Both floor, so rounding dust is always kept by the reserve (price up, never
// down). All intermediates are u128: a u64 product like usdc_in * supply
// overflows at ordinary sizes, which is the single most likely way to ship a
// broken port. Returns None on overflow so the caller reverts.

/// MINTR minted for `usdc_in`, at the pre-trade `reserve`/`supply`. `net` is the
/// portion that actually buys tokens; the buy fee is not spent here but is still
/// added to the reserve by the caller, which is what lifts backing-per-token.
pub fn calc_buy_out(reserve: u64, supply: u64, buy_fee_bps: u16, usdc_in: u64) -> Option<u64> {
    let net = (usdc_in as u128)
        .checked_mul(BPS_DENOM - buy_fee_bps as u128)?
        .checked_div(BPS_DENOM)?;
    net.checked_mul(supply as u128)?
        .checked_div(reserve as u128)?
        .try_into()
        .ok()
}

/// USDC paid for `mintr_in`, at the pre-trade `reserve`/`supply`, net of the
/// sell fee. The fee (gross - result) stays in the reserve.
pub fn calc_sell_out(reserve: u64, supply: u64, sell_fee_bps: u16, mintr_in: u64) -> Option<u64> {
    let gross = (mintr_in as u128)
        .checked_mul(reserve as u128)?
        .checked_div(supply as u128)?;
    gross
        .checked_mul(BPS_DENOM - sell_fee_bps as u128)?
        .checked_div(BPS_DENOM)?
        .try_into()
        .ok()
}

#[program]
pub mod mintr {
    use super::*;

    /// Creates the Config PDA, the MINTR mint (PDA authority = config), and the
    /// USDC reserve vault (PDA authority = config). Fees default to 1% / 1%.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.owner = ctx.accounts.owner.key();
        c.mintr_mint = ctx.accounts.mintr_mint.key();
        c.usdc_mint = ctx.accounts.usdc_mint.key();
        c.reserve_vault = ctx.accounts.reserve_vault.key();
        c.reserve = 0;
        c.buy_fee_bps = 100;
        c.sell_fee_bps = 100;
        c.seeded = false;
        c.config_bump = ctx.bumps.config;
        Ok(())
    }

    /// One-time seed: deposits the initial USDC reserve and mints the initial
    /// supply to the owner, fixing the starting price = usdc_amount / mintr_amount.
    pub fn seed(ctx: Context<Seed>, usdc_amount: u64, mintr_amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.seeded, MintrError::AlreadySeeded);
        require!(usdc_amount > 0 && mintr_amount > 0, MintrError::ZeroAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.owner_usdc.to_account_info(),
                    to: ctx.accounts.reserve_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            usdc_amount,
        )?;

        let bump = ctx.accounts.config.config_bump;
        let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[bump]]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.mintr_mint.to_account_info(),
                    to: ctx.accounts.owner_mintr.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            mintr_amount,
        )?;

        let c = &mut ctx.accounts.config;
        c.reserve = usdc_amount;
        c.seeded = true;
        emit!(Seeded { usdc_amount, mintr_amount });
        Ok(())
    }

    /// Buy MINTR with USDC. The buy fee is included in the USDC pulled into the
    /// vault, so it stays in the reserve and lifts backing-per-token.
    pub fn buy(ctx: Context<Buy>, usdc_in: u64, min_out: u64) -> Result<()> {
        require!(ctx.accounts.config.seeded, MintrError::NotSeeded);
        require!(usdc_in > 0, MintrError::ZeroAmount);

        let mintr_out = calc_buy_out(
            ctx.accounts.config.reserve,
            ctx.accounts.mintr_mint.supply,
            ctx.accounts.config.buy_fee_bps,
            usdc_in,
        )
        .ok_or(MintrError::MathOverflow)?;
        require!(mintr_out >= min_out, MintrError::Slippage);
        require!(mintr_out > 0, MintrError::Dust);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.buyer_usdc.to_account_info(),
                    to: ctx.accounts.reserve_vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            usdc_in,
        )?;

        let bump = ctx.accounts.config.config_bump;
        let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[bump]]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.mintr_mint.to_account_info(),
                    to: ctx.accounts.buyer_mintr.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            mintr_out,
        )?;

        let c = &mut ctx.accounts.config;
        c.reserve = c
            .reserve
            .checked_add(usdc_in)
            .ok_or(MintrError::MathOverflow)?;
        emit!(Bought {
            buyer: ctx.accounts.buyer.key(),
            usdc_in,
            mintr_out,
        });
        Ok(())
    }

    /// Sell MINTR back for USDC at current backing minus the sell fee. The sell
    /// fee stays in the reserve while the tokens are burned, lifting backing.
    pub fn sell(ctx: Context<Sell>, mintr_in: u64, min_usdc: u64) -> Result<()> {
        require!(ctx.accounts.config.seeded, MintrError::NotSeeded);
        require!(mintr_in > 0, MintrError::ZeroAmount);

        let user_gets = calc_sell_out(
            ctx.accounts.config.reserve,
            ctx.accounts.mintr_mint.supply,
            ctx.accounts.config.sell_fee_bps,
            mintr_in,
        )
        .ok_or(MintrError::MathOverflow)?;
        require!(user_gets >= min_usdc, MintrError::Slippage);
        require!(user_gets > 0, MintrError::Dust);
        // Only user_gets leaves the vault; the sell fee (gross - user_gets)
        // stays, so backing per token rises.
        require!(user_gets <= ctx.accounts.config.reserve, MintrError::ReserveInsufficient);

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.mintr_mint.to_account_info(),
                    from: ctx.accounts.seller_mintr.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            mintr_in,
        )?;

        let bump = ctx.accounts.config.config_bump;
        let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.reserve_vault.to_account_info(),
                    to: ctx.accounts.seller_usdc.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            user_gets,
        )?;

        let c = &mut ctx.accounts.config;
        c.reserve = c
            .reserve
            .checked_sub(user_gets)
            .ok_or(MintrError::MathOverflow)?;
        emit!(Sold {
            seller: ctx.accounts.seller.key(),
            mintr_in,
            usdc_out: user_gets,
        });
        Ok(())
    }

    /// Owner-only. Both backing fees must stay > 0 to keep the curve monotonic,
    /// and each is capped at MAX_FEE_BPS. There is no path here to the reserve.
    pub fn set_fees(ctx: Context<OnlyOwner>, buy_fee_bps: u16, sell_fee_bps: u16) -> Result<()> {
        require!(
            buy_fee_bps > 0 && sell_fee_bps > 0,
            MintrError::NeedBackingFees
        );
        require!(
            buy_fee_bps <= MAX_FEE_BPS && sell_fee_bps <= MAX_FEE_BPS,
            MintrError::FeeCap
        );
        let c = &mut ctx.accounts.config;
        c.buy_fee_bps = buy_fee_bps;
        c.sell_fee_bps = sell_fee_bps;
        Ok(())
    }

    pub fn transfer_ownership(ctx: Context<OnlyOwner>, new_owner: Pubkey) -> Result<()> {
        require!(new_owner != Pubkey::default(), MintrError::ZeroAddress);
        ctx.accounts.config.owner = new_owner;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = owner,
        seeds = [MINT_SEED],
        bump,
        mint::decimals = MINTR_DECIMALS,
        mint::authority = config,
    )]
    pub mintr_mint: Account<'info, Mint>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = owner,
        seeds = [VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = config,
    )]
    pub reserve_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Seed<'info> {
    #[account(mut, has_one = owner, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mintr_mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub reserve_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = owner)]
    pub owner_usdc: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mintr_mint, token::authority = owner)]
    pub owner_mintr: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mintr_mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub reserve_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = buyer)]
    pub buyer_usdc: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mintr_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_mintr: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MINT_SEED], bump)]
    pub mintr_mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub reserve_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, token::mint = mintr_mint, token::authority = seller)]
    pub seller_mintr: Account<'info, TokenAccount>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = usdc_mint,
        associated_token::authority = seller,
    )]
    pub seller_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OnlyOwner<'info> {
    #[account(mut, has_one = owner, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,
    pub owner: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub owner: Pubkey,
    pub mintr_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub reserve_vault: Pubkey,
    pub reserve: u64,
    pub buy_fee_bps: u16,
    pub sell_fee_bps: u16,
    pub seeded: bool,
    pub config_bump: u8,
}

#[event]
pub struct Seeded {
    pub usdc_amount: u64,
    pub mintr_amount: u64,
}

#[event]
pub struct Bought {
    pub buyer: Pubkey,
    pub usdc_in: u64,
    pub mintr_out: u64,
}

#[event]
pub struct Sold {
    pub seller: Pubkey,
    pub mintr_in: u64,
    pub usdc_out: u64,
}

#[error_code]
pub enum MintrError {
    #[msg("already seeded")]
    AlreadySeeded,
    #[msg("not seeded")]
    NotSeeded,
    #[msg("zero amount")]
    ZeroAmount,
    #[msg("slippage")]
    Slippage,
    #[msg("dust")]
    Dust,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("reserve insufficient")]
    ReserveInsufficient,
    #[msg("backing fees must be > 0")]
    NeedBackingFees,
    #[msg("fee exceeds cap")]
    FeeCap,
    #[msg("zero address")]
    ZeroAddress,
}

#[cfg(test)]
mod tests {
    use super::*;

    // reserve_a/supply_a <= reserve_b/supply_b, by cross-multiplication in u128
    // so there is no float rounding in the assertion itself.
    fn price_non_decreasing(r_a: u64, s_a: u64, r_b: u64, s_b: u64) -> bool {
        (r_a as u128) * (s_b as u128) <= (r_b as u128) * (s_a as u128)
    }

    #[test]
    fn known_buy_example() {
        // reserve 1000 USDC, supply 100k MINTR (both 6-dec) -> price $0.01.
        // Buy 100 USDC at 1% fee: net 99 USDC, out = 99 * 100000 / 1000 = 9,900.
        let out = calc_buy_out(1_000_000_000, 100_000_000_000, 100, 100_000_000).unwrap();
        assert_eq!(out, 9_900_000_000);
    }

    #[test]
    fn known_sell_example() {
        // Same pool. Sell 9,900 MINTR at 1% fee: gross = 9900 * 1000/100000 =
        // 99 USDC, minus 1% = 98.01 USDC.
        let out = calc_sell_out(1_000_000_000, 100_000_000_000, 100, 9_900_000_000).unwrap();
        assert_eq!(out, 98_010_000);
    }

    #[test]
    fn a_single_buy_raises_the_price() {
        let (r0, s0) = (1_000_000_000u64, 100_000_000_000u64);
        let out = calc_buy_out(r0, s0, 100, 100_000_000).unwrap();
        let (r1, s1) = (r0 + 100_000_000, s0 + out); // handler deltas
        assert!(price_non_decreasing(r0, s0, r1, s1));
        assert!(!price_non_decreasing(r1, s1, r0, s0)); // strictly up
    }

    #[test]
    fn a_single_sell_raises_the_price() {
        let (r0, s0) = (1_000_000_000u64, 100_000_000_000u64);
        let mintr_in = 5_000_000_000u64;
        let out = calc_sell_out(r0, s0, 100, mintr_in).unwrap();
        let (r1, s1) = (r0 - out, s0 - mintr_in); // handler deltas
        assert!(price_non_decreasing(r0, s0, r1, s1));
        assert!(!price_non_decreasing(r1, s1, r0, s0)); // strictly up
    }

    // The core invariant: across a long random sequence of buys and sells of
    // random sizes, backing-per-token never falls. This is the whole product.
    #[test]
    fn price_is_monotonic_under_fuzzed_trading() {
        let mut seed = 0x9E3779B97F4A7C15u64;
        let mut next = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            seed >> 33
        };

        // Start deep so a long run doesn't drain to dust: 1M USDC, 100M MINTR.
        let mut reserve: u64 = 1_000_000_000_000;
        let mut supply: u64 = 100_000_000_000_000;
        let buy_fee = 100u16;
        let sell_fee = 100u16;

        for _ in 0..50_000 {
            let r0 = reserve;
            let s0 = supply;
            if next() % 2 == 0 {
                // Buy between 1 and 10,000 USDC.
                let usdc_in = 1 + (next() % 10_000_000_000);
                if let Some(out) = calc_buy_out(reserve, supply, buy_fee, usdc_in) {
                    if out == 0 {
                        continue;
                    }
                    reserve = reserve.checked_add(usdc_in).unwrap();
                    supply = supply.checked_add(out).unwrap();
                }
            } else {
                // Sell up to a quarter of supply.
                let mintr_in = 1 + (next() % (supply / 4).max(1));
                if let Some(out) = calc_sell_out(reserve, supply, sell_fee, mintr_in) {
                    if out == 0 || out > reserve || mintr_in >= supply {
                        continue;
                    }
                    reserve = reserve.checked_sub(out).unwrap();
                    supply = supply.checked_sub(mintr_in).unwrap();
                }
            }
            assert!(
                price_non_decreasing(r0, s0, reserve, supply),
                "price fell: {}/{} -> {}/{}",
                r0,
                s0,
                reserve,
                supply
            );
        }
    }

    // A whale-sized input must not overflow the u128 math into a wrong answer;
    // it either returns a value that fits u64 or None (caller reverts).
    #[test]
    fn extreme_inputs_do_not_wrap() {
        // Near-max supply and reserve, large buy. Should be Some(fits) or None.
        let _ = calc_buy_out(u64::MAX, u64::MAX, 100, u64::MAX); // must not panic
        let _ = calc_sell_out(u64::MAX, u64::MAX, 100, u64::MAX); // must not panic
        // A realistic large trade still computes.
        let out = calc_buy_out(1_000_000_000_000, 100_000_000_000_000, 100, 1_000_000_000_000);
        assert!(out.is_some());
    }
}
