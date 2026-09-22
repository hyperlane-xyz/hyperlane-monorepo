use anchor_lang::prelude::*;

declare_id!("YourProgramId1111111111111111111111111111111");

#[program]
pub mod onchain_checkpoint {
    use super::*;

    pub fn publish_checkpoint(ctx: Context<PublishCheckpoint>, checkpoint: Vec<u8>) -> Result<()> {
        let account = &mut ctx.accounts.checkpoint_account;
        account.owner = *ctx.accounts.authority.key;
        account.data = checkpoint;
        emit!(CheckpointPublished {
            owner: *ctx.accounts.authority.key,
            data_hash: hash(&account.data).to_bytes(),
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct PublishCheckpoint<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 4 + 1024, // owner + data length + data
        seeds = [b"checkpoint", authority.key.as_ref()],
        bump
    )]
    pub checkpoint_account: Account<'info, CheckpointAccount>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct CheckpointAccount {
    pub owner: Pubkey,
    pub data: Vec<u8>,
}

#[event]
pub struct CheckpointPublished {
    pub owner: Pubkey,
    pub data_hash: [u8; 32],
}
