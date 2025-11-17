import credits.aleo;
import ism_manager.aleo;
import mailbox.aleo;
import hook_manager.aleo;
program dispatch_proxy.aleo;

struct MailboxState:
    default_ism as address;
    default_hook as address;
    required_hook as address;

struct Message:
    version as u8;
    nonce as u32;
    origin_domain as u32;
    sender as [u8; 32u32];
    destination_domain as u32;
    recipient as [u8; 32u32];
    body as [u128; 16u32];

struct EthAddress:
    bytes as [u8; 20u32];

struct Mailbox:
    local_domain as u32;
    nonce as u32;
    process_count as u32;
    default_ism as address;
    default_hook as address;
    required_hook as address;
    dispatch_proxy as address;
    mailbox_owner as address;

struct Tree:
    branch as [[u128; 2u32]; 32u32];
    count as u32;

struct DomainGasConfig:
    gas_overhead as u128;
    exchange_rate as u128;
    gas_price as u128;

struct CreditAllowance:
    spender as address;
    amount as u64;

struct HookMetadata:
    gas_limit as u128;
    extra_data as [u8; 64u32];

function get_address:
    output dispatch_proxy.aleo as address.private;

function dispatch:
    input r0 as MailboxState.public;
    input r1 as u32.public;
    input r2 as [u8; 32u32].public;
    input r3 as [u128; 16u32].public;
    input r4 as address.public;
    input r5 as HookMetadata.public;
    input r6 as [CreditAllowance; 4u32].public;
    assert.neq r0.default_hook aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc;
    assert.neq r0.required_hook aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc;
    is.eq r4 aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc into r7;
    ternary r7 r0.default_hook r4 into r8;
    call mailbox.aleo/dispatch r1 r2 r3 self.caller into r9;
    call hook_manager.aleo/post_dispatch r8 r5 r6 into r10;
    call hook_manager.aleo/post_dispatch r0.required_hook r5 r6 into r11;
    async dispatch r0 r9 r10 r11 into r12;
    output r12 as dispatch_proxy.aleo/dispatch.future;

finalize dispatch:
    input r0 as MailboxState.public;
    input r1 as mailbox.aleo/dispatch.future;
    input r2 as hook_manager.aleo/post_dispatch.future;
    input r3 as hook_manager.aleo/post_dispatch.future;
    get mailbox.aleo/mailbox[true] into r4;
    assert.eq r4.default_ism r0.default_ism;
    assert.eq r4.default_hook r0.default_hook;
    assert.eq r4.required_hook r0.required_hook;
    await r1;
    await r2;
    await r3;

constructor:
    assert.eq edition 0u16;
