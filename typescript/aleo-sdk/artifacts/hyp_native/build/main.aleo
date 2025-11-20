import credits.aleo;
import ism_manager.aleo;
import mailbox.aleo;
import hook_manager.aleo;
import dispatch_proxy.aleo;
program hyp_native.aleo;

struct RemoteRouter:
    domain as u32;
    recipient as [u8; 32u32];
    gas as u128;

struct Metadata:
    token_type as u8;
    token_owner as address;
    ism as address;
    hook as address;
    scale as u8;

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

struct CreditAllowance:
    spender as address;
    amount as u64;

struct HookMetadata:
    gas_limit as u128;
    extra_data as [u8; 64u32];

struct Tree:
    branch as [[u128; 2u32]; 32u32];
    count as u32;

struct DomainGasConfig:
    gas_overhead as u128;
    exchange_rate as u128;
    gas_price as u128;

struct MailboxState:
    default_ism as address;
    default_hook as address;
    required_hook as address;

mapping remote_routers:
    key as u32.public;
    value as RemoteRouter.public;

mapping remote_router_iter:
    key as u32.public;
    value as u32.public;

mapping remote_router_length:
    key as boolean.public;
    value as u32.public;

mapping token_metadata:
    key as boolean.public;
    value as Metadata.public;

function init:
    input r0 as [u8; 128u32].public;
    input r1 as u8.public;
    lte r1 19u8 into r2;
    assert.eq r2 true;
    call mailbox.aleo/register_application r0 into r3;
    async init self.caller r1 r3 into r4;
    output r4 as hyp_native.aleo/init.future;

finalize init:
    input r0 as address.public;
    input r1 as u8.public;
    input r2 as mailbox.aleo/register_application.future;
    contains token_metadata[true] into r3;
    assert.eq r3 false;
    cast 0u8 r0 aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc r1 into r4 as Metadata;
    set r4 into token_metadata[true];
    await r2;

function get_address:
    output hyp_native.aleo as address.private;

function set_custom_hook:
    input r0 as address.private;
    async set_custom_hook self.caller r0 into r1;
    output r1 as hyp_native.aleo/set_custom_hook.future;

finalize set_custom_hook:
    input r0 as address.public;
    input r1 as address.public;
    get token_metadata[true] into r2;
    assert.eq r2.token_owner r0;
    cast r2.token_type r2.token_owner r2.ism r1 r2.scale into r3 as Metadata;
    set r3 into token_metadata[true];

function set_custom_ism:
    input r0 as address.private;
    async set_custom_ism self.caller r0 into r1;
    output r1 as hyp_native.aleo/set_custom_ism.future;

finalize set_custom_ism:
    input r0 as address.public;
    input r1 as address.public;
    get token_metadata[true] into r2;
    assert.eq r2.token_owner r0;
    cast r2.token_type r2.token_owner r1 r2.hook r2.scale into r3 as Metadata;
    set r3 into token_metadata[true];

function set_owner:
    input r0 as address.private;
    async set_owner self.caller r0 into r1;
    output r1 as hyp_native.aleo/set_owner.future;

finalize set_owner:
    input r0 as address.public;
    input r1 as address.public;
    get token_metadata[true] into r2;
    assert.eq r2.token_owner r0;
    cast r2.token_type r1 r2.ism r2.hook r2.scale into r3 as Metadata;
    set r3 into token_metadata[true];

function enroll_remote_router:
    input r0 as u32.private;
    input r1 as [u8; 32u32].private;
    input r2 as u128.private;
    async enroll_remote_router self.caller r0 r1 r2 into r3;
    output r3 as hyp_native.aleo/enroll_remote_router.future;

finalize enroll_remote_router:
    input r0 as address.public;
    input r1 as u32.public;
    input r2 as [u8; 32u32].public;
    input r3 as u128.public;
    get token_metadata[true] into r4;
    assert.eq r4.token_owner r0;
    contains remote_routers[r1] into r5;
    not r5 into r6;
    branch.eq r6 false to end_then_0_0;
    get.or_use remote_router_length[true] 0u32 into r7;
    set r1 into remote_router_iter[r7];
    add r7 1u32 into r8;
    set r8 into remote_router_length[true];
    branch.eq true true to end_otherwise_0_1;
    position end_then_0_0;
    position end_otherwise_0_1;
    cast r1 r2 r3 into r9 as RemoteRouter;
    set r9 into remote_routers[r1];

function unroll_remote_router:
    input r0 as u32.private;
    async unroll_remote_router self.caller r0 into r1;
    output r1 as hyp_native.aleo/unroll_remote_router.future;

finalize unroll_remote_router:
    input r0 as address.public;
    input r1 as u32.public;
    get token_metadata[true] into r2;
    assert.eq r2.token_owner r0;
    remove remote_routers[r1];

function transfer_remote:
    input r0 as Metadata.public;
    input r1 as MailboxState.public;
    input r2 as RemoteRouter.public;
    input r3 as u32.public;
    input r4 as [u128; 2u32].public;
    input r5 as u64.public;
    input r6 as [CreditAllowance; 4u32].public;
    cast 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 0u8 into r7 as [u8; 64u32];
    cast r2.gas r7 into r8 as HookMetadata;
    pow 10u64 r0.scale into r9;
    cast r5 into r10 as u128;
    cast r9 into r11 as u128;
    mul r10 r11 into r12;
    shr r12 0u8 into r13;
    rem r13 256u128 into r14;
    shl r14 120u8 into r15;
    add 0u128 r15 into r16;
    shr r12 8u8 into r17;
    rem r17 256u128 into r18;
    shl r18 112u8 into r19;
    add r16 r19 into r20;
    shr r12 16u8 into r21;
    rem r21 256u128 into r22;
    shl r22 104u8 into r23;
    add r20 r23 into r24;
    shr r12 24u8 into r25;
    rem r25 256u128 into r26;
    shl r26 96u8 into r27;
    add r24 r27 into r28;
    shr r12 32u8 into r29;
    rem r29 256u128 into r30;
    shl r30 88u8 into r31;
    add r28 r31 into r32;
    shr r12 40u8 into r33;
    rem r33 256u128 into r34;
    shl r34 80u8 into r35;
    add r32 r35 into r36;
    shr r12 48u8 into r37;
    rem r37 256u128 into r38;
    shl r38 72u8 into r39;
    add r36 r39 into r40;
    shr r12 56u8 into r41;
    rem r41 256u128 into r42;
    shl r42 64u8 into r43;
    add r40 r43 into r44;
    shr r12 64u8 into r45;
    rem r45 256u128 into r46;
    shl r46 56u8 into r47;
    add r44 r47 into r48;
    shr r12 72u8 into r49;
    rem r49 256u128 into r50;
    shl r50 48u8 into r51;
    add r48 r51 into r52;
    shr r12 80u8 into r53;
    rem r53 256u128 into r54;
    shl r54 40u8 into r55;
    add r52 r55 into r56;
    shr r12 88u8 into r57;
    rem r57 256u128 into r58;
    shl r58 32u8 into r59;
    add r56 r59 into r60;
    shr r12 96u8 into r61;
    rem r61 256u128 into r62;
    shl r62 24u8 into r63;
    add r60 r63 into r64;
    shr r12 104u8 into r65;
    rem r65 256u128 into r66;
    shl r66 16u8 into r67;
    add r64 r67 into r68;
    shr r12 112u8 into r69;
    rem r69 256u128 into r70;
    shl r70 8u8 into r71;
    add r68 r71 into r72;
    shr r12 120u8 into r73;
    rem r73 256u128 into r74;
    shl r74 0u8 into r75;
    add r72 r75 into r76;
    cast 0u128 r76 into r77 as [u128; 2u32];
    cast 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 into r78 as [u128; 16u32];
    cast r4[0u32] r4[1u32] r77[0u32] r77[1u32] r78[4u32] r78[5u32] r78[6u32] r78[7u32] r78[8u32] r78[9u32] r78[10u32] r78[11u32] r78[12u32] r78[13u32] r78[14u32] r78[15u32] into r79 as [u128; 16u32];
    call dispatch_proxy.aleo/dispatch r1 r3 r2.recipient r79 r0.hook r8 r6 into r80;
    call credits.aleo/transfer_public_as_signer hyp_native.aleo r5 into r81;
    async transfer_remote r80 r81 r0 r2 r3 into r82;
    output r82 as hyp_native.aleo/transfer_remote.future;

finalize transfer_remote:
    input r0 as dispatch_proxy.aleo/dispatch.future;
    input r1 as credits.aleo/transfer_public_as_signer.future;
    input r2 as Metadata.public;
    input r3 as RemoteRouter.public;
    input r4 as u32.public;
    get remote_routers[r4] into r5;
    assert.eq r5 r3;
    get token_metadata[true] into r6;
    assert.eq r6 r2;
    await r0;
    await r1;

function transfer_remote_with_hook:
    input r0 as Metadata.public;
    input r1 as MailboxState.public;
    input r2 as RemoteRouter.public;
    input r3 as u32.public;
    input r4 as [u128; 2u32].public;
    input r5 as u64.public;
    input r6 as [CreditAllowance; 4u32].public;
    input r7 as address.public;
    input r8 as HookMetadata.public;
    is.eq r8.gas_limit 0u128 into r9;
    ternary r9 r2.gas r8.gas_limit into r10;
    pow 10u64 r0.scale into r11;
    cast r5 into r12 as u128;
    cast r11 into r13 as u128;
    mul r12 r13 into r14;
    shr r14 0u8 into r15;
    rem r15 256u128 into r16;
    shl r16 120u8 into r17;
    add 0u128 r17 into r18;
    shr r14 8u8 into r19;
    rem r19 256u128 into r20;
    shl r20 112u8 into r21;
    add r18 r21 into r22;
    shr r14 16u8 into r23;
    rem r23 256u128 into r24;
    shl r24 104u8 into r25;
    add r22 r25 into r26;
    shr r14 24u8 into r27;
    rem r27 256u128 into r28;
    shl r28 96u8 into r29;
    add r26 r29 into r30;
    shr r14 32u8 into r31;
    rem r31 256u128 into r32;
    shl r32 88u8 into r33;
    add r30 r33 into r34;
    shr r14 40u8 into r35;
    rem r35 256u128 into r36;
    shl r36 80u8 into r37;
    add r34 r37 into r38;
    shr r14 48u8 into r39;
    rem r39 256u128 into r40;
    shl r40 72u8 into r41;
    add r38 r41 into r42;
    shr r14 56u8 into r43;
    rem r43 256u128 into r44;
    shl r44 64u8 into r45;
    add r42 r45 into r46;
    shr r14 64u8 into r47;
    rem r47 256u128 into r48;
    shl r48 56u8 into r49;
    add r46 r49 into r50;
    shr r14 72u8 into r51;
    rem r51 256u128 into r52;
    shl r52 48u8 into r53;
    add r50 r53 into r54;
    shr r14 80u8 into r55;
    rem r55 256u128 into r56;
    shl r56 40u8 into r57;
    add r54 r57 into r58;
    shr r14 88u8 into r59;
    rem r59 256u128 into r60;
    shl r60 32u8 into r61;
    add r58 r61 into r62;
    shr r14 96u8 into r63;
    rem r63 256u128 into r64;
    shl r64 24u8 into r65;
    add r62 r65 into r66;
    shr r14 104u8 into r67;
    rem r67 256u128 into r68;
    shl r68 16u8 into r69;
    add r66 r69 into r70;
    shr r14 112u8 into r71;
    rem r71 256u128 into r72;
    shl r72 8u8 into r73;
    add r70 r73 into r74;
    shr r14 120u8 into r75;
    rem r75 256u128 into r76;
    shl r76 0u8 into r77;
    add r74 r77 into r78;
    cast 0u128 r78 into r79 as [u128; 2u32];
    cast 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 0u128 into r80 as [u128; 16u32];
    cast r4[0u32] r4[1u32] r79[0u32] r79[1u32] r80[4u32] r80[5u32] r80[6u32] r80[7u32] r80[8u32] r80[9u32] r80[10u32] r80[11u32] r80[12u32] r80[13u32] r80[14u32] r80[15u32] into r81 as [u128; 16u32];
    cast r10 r8.extra_data into r82 as HookMetadata;
    call dispatch_proxy.aleo/dispatch r1 r3 r2.recipient r81 r7 r82 r6 into r83;
    call credits.aleo/transfer_public_as_signer hyp_native.aleo r5 into r84;
    async transfer_remote_with_hook r83 r84 r0 r2 r3 into r85;
    output r85 as hyp_native.aleo/transfer_remote_with_hook.future;

finalize transfer_remote_with_hook:
    input r0 as dispatch_proxy.aleo/dispatch.future;
    input r1 as credits.aleo/transfer_public_as_signer.future;
    input r2 as Metadata.public;
    input r3 as RemoteRouter.public;
    input r4 as u32.public;
    get remote_routers[r4] into r5;
    assert.eq r5 r3;
    get token_metadata[true] into r6;
    assert.eq r6 r2;
    await r0;
    await r1;

function process:
    input r0 as address.public;
    input r1 as Metadata.public;
    input r2 as Message.public;
    input r3 as u32.public;
    input r4 as [u128; 2u32].public;
    input r5 as [u8; 512u32].public;
    cast r2.body[2u32] r2.body[3u32] into r6 as [u128; 2u32];
    pow 10u64 r1.scale into r7;
    serialize.bits.raw r6 ([u128; 2u32]) into r8 ([boolean; 256u32]);
    deserialize.bits.raw r8 ([boolean; 256u32]) into r9 ([u8; 32u32]);
    cast r9[0u32] into r10 as u64;
    shl r10 56u32 into r11;
    add 0u64 r11 into r12;
    cast r9[1u32] into r13 as u64;
    shl r13 48u32 into r14;
    add r12 r14 into r15;
    cast r9[2u32] into r16 as u64;
    shl r16 40u32 into r17;
    add r15 r17 into r18;
    cast r9[3u32] into r19 as u64;
    shl r19 32u32 into r20;
    add r18 r20 into r21;
    cast r9[4u32] into r22 as u64;
    shl r22 24u32 into r23;
    add r21 r23 into r24;
    cast r9[5u32] into r25 as u64;
    shl r25 16u32 into r26;
    add r24 r26 into r27;
    cast r9[6u32] into r28 as u64;
    shl r28 8u32 into r29;
    add r27 r29 into r30;
    cast r9[7u32] into r31 as u64;
    shl r31 0u32 into r32;
    add r30 r32 into r33;
    cast r9[8u32] into r34 as u64;
    shl r34 56u32 into r35;
    add 0u64 r35 into r36;
    cast r9[9u32] into r37 as u64;
    shl r37 48u32 into r38;
    add r36 r38 into r39;
    cast r9[10u32] into r40 as u64;
    shl r40 40u32 into r41;
    add r39 r41 into r42;
    cast r9[11u32] into r43 as u64;
    shl r43 32u32 into r44;
    add r42 r44 into r45;
    cast r9[12u32] into r46 as u64;
    shl r46 24u32 into r47;
    add r45 r47 into r48;
    cast r9[13u32] into r49 as u64;
    shl r49 16u32 into r50;
    add r48 r50 into r51;
    cast r9[14u32] into r52 as u64;
    shl r52 8u32 into r53;
    add r51 r53 into r54;
    cast r9[15u32] into r55 as u64;
    shl r55 0u32 into r56;
    add r54 r56 into r57;
    cast r9[16u32] into r58 as u64;
    shl r58 56u32 into r59;
    add 0u64 r59 into r60;
    cast r9[17u32] into r61 as u64;
    shl r61 48u32 into r62;
    add r60 r62 into r63;
    cast r9[18u32] into r64 as u64;
    shl r64 40u32 into r65;
    add r63 r65 into r66;
    cast r9[19u32] into r67 as u64;
    shl r67 32u32 into r68;
    add r66 r68 into r69;
    cast r9[20u32] into r70 as u64;
    shl r70 24u32 into r71;
    add r69 r71 into r72;
    cast r9[21u32] into r73 as u64;
    shl r73 16u32 into r74;
    add r72 r74 into r75;
    cast r9[22u32] into r76 as u64;
    shl r76 8u32 into r77;
    add r75 r77 into r78;
    cast r9[23u32] into r79 as u64;
    shl r79 0u32 into r80;
    add r78 r80 into r81;
    cast r9[24u32] into r82 as u64;
    shl r82 56u32 into r83;
    add 0u64 r83 into r84;
    cast r9[25u32] into r85 as u64;
    shl r85 48u32 into r86;
    add r84 r86 into r87;
    cast r9[26u32] into r88 as u64;
    shl r88 40u32 into r89;
    add r87 r89 into r90;
    cast r9[27u32] into r91 as u64;
    shl r91 32u32 into r92;
    add r90 r92 into r93;
    cast r9[28u32] into r94 as u64;
    shl r94 24u32 into r95;
    add r93 r95 into r96;
    cast r9[29u32] into r97 as u64;
    shl r97 16u32 into r98;
    add r96 r98 into r99;
    cast r9[30u32] into r100 as u64;
    shl r100 8u32 into r101;
    add r99 r101 into r102;
    cast r9[31u32] into r103 as u64;
    shl r103 0u32 into r104;
    add r102 r104 into r105;
    shl 0u128 64u32 into r106;
    cast r33 into r107 as u128;
    or r106 r107 into r108;
    cast r7 into r109 as u128;
    div r108 r109 into r110;
    cast r110 into r111 as u64;
    cast r7 into r112 as u128;
    rem r108 r112 into r113;
    shl r113 64u32 into r114;
    cast r57 into r115 as u128;
    or r114 r115 into r116;
    cast r7 into r117 as u128;
    div r116 r117 into r118;
    cast r118 into r119 as u64;
    cast r7 into r120 as u128;
    rem r116 r120 into r121;
    shl r121 64u32 into r122;
    cast r81 into r123 as u128;
    or r122 r123 into r124;
    cast r7 into r125 as u128;
    div r124 r125 into r126;
    cast r126 into r127 as u64;
    cast r7 into r128 as u128;
    rem r124 r128 into r129;
    shl r129 64u32 into r130;
    cast r105 into r131 as u128;
    or r130 r131 into r132;
    cast r7 into r133 as u128;
    div r132 r133 into r134;
    cast r134 into r135 as u64;
    cast r7 into r136 as u128;
    rem r132 r136 into r137;
    assert.eq r111 0u64;
    assert.eq r119 0u64;
    assert.eq r127 0u64;
    call mailbox.aleo/process r0 r2 r3 r4 r5 into r138;
    cast r2.body[0u32] r2.body[1u32] into r139 as [u128; 2u32];
    serialize.bits.raw r139 ([u128; 2u32]) into r140 ([boolean; 256u32]);
    cast r140[0u32] r140[1u32] r140[2u32] r140[3u32] r140[4u32] r140[5u32] r140[6u32] r140[7u32] r140[8u32] r140[9u32] r140[10u32] r140[11u32] r140[12u32] r140[13u32] r140[14u32] r140[15u32] r140[16u32] r140[17u32] r140[18u32] r140[19u32] r140[20u32] r140[21u32] r140[22u32] r140[23u32] r140[24u32] r140[25u32] r140[26u32] r140[27u32] r140[28u32] r140[29u32] r140[30u32] r140[31u32] r140[32u32] r140[33u32] r140[34u32] r140[35u32] r140[36u32] r140[37u32] r140[38u32] r140[39u32] r140[40u32] r140[41u32] r140[42u32] r140[43u32] r140[44u32] r140[45u32] r140[46u32] r140[47u32] r140[48u32] r140[49u32] r140[50u32] r140[51u32] r140[52u32] r140[53u32] r140[54u32] r140[55u32] r140[56u32] r140[57u32] r140[58u32] r140[59u32] r140[60u32] r140[61u32] r140[62u32] r140[63u32] r140[64u32] r140[65u32] r140[66u32] r140[67u32] r140[68u32] r140[69u32] r140[70u32] r140[71u32] r140[72u32] r140[73u32] r140[74u32] r140[75u32] r140[76u32] r140[77u32] r140[78u32] r140[79u32] r140[80u32] r140[81u32] r140[82u32] r140[83u32] r140[84u32] r140[85u32] r140[86u32] r140[87u32] r140[88u32] r140[89u32] r140[90u32] r140[91u32] r140[92u32] r140[93u32] r140[94u32] r140[95u32] r140[96u32] r140[97u32] r140[98u32] r140[99u32] r140[100u32] r140[101u32] r140[102u32] r140[103u32] r140[104u32] r140[105u32] r140[106u32] r140[107u32] r140[108u32] r140[109u32] r140[110u32] r140[111u32] r140[112u32] r140[113u32] r140[114u32] r140[115u32] r140[116u32] r140[117u32] r140[118u32] r140[119u32] r140[120u32] r140[121u32] r140[122u32] r140[123u32] r140[124u32] r140[125u32] r140[126u32] r140[127u32] r140[128u32] r140[129u32] r140[130u32] r140[131u32] r140[132u32] r140[133u32] r140[134u32] r140[135u32] r140[136u32] r140[137u32] r140[138u32] r140[139u32] r140[140u32] r140[141u32] r140[142u32] r140[143u32] r140[144u32] r140[145u32] r140[146u32] r140[147u32] r140[148u32] r140[149u32] r140[150u32] r140[151u32] r140[152u32] r140[153u32] r140[154u32] r140[155u32] r140[156u32] r140[157u32] r140[158u32] r140[159u32] r140[160u32] r140[161u32] r140[162u32] r140[163u32] r140[164u32] r140[165u32] r140[166u32] r140[167u32] r140[168u32] r140[169u32] r140[170u32] r140[171u32] r140[172u32] r140[173u32] r140[174u32] r140[175u32] r140[176u32] r140[177u32] r140[178u32] r140[179u32] r140[180u32] r140[181u32] r140[182u32] r140[183u32] r140[184u32] r140[185u32] r140[186u32] r140[187u32] r140[188u32] r140[189u32] r140[190u32] r140[191u32] r140[192u32] r140[193u32] r140[194u32] r140[195u32] r140[196u32] r140[197u32] r140[198u32] r140[199u32] r140[200u32] r140[201u32] r140[202u32] r140[203u32] r140[204u32] r140[205u32] r140[206u32] r140[207u32] r140[208u32] r140[209u32] r140[210u32] r140[211u32] r140[212u32] r140[213u32] r140[214u32] r140[215u32] r140[216u32] r140[217u32] r140[218u32] r140[219u32] r140[220u32] r140[221u32] r140[222u32] r140[223u32] r140[224u32] r140[225u32] r140[226u32] r140[227u32] r140[228u32] r140[229u32] r140[230u32] r140[231u32] r140[232u32] r140[233u32] r140[234u32] r140[235u32] r140[236u32] r140[237u32] r140[238u32] r140[239u32] r140[240u32] r140[241u32] r140[242u32] r140[243u32] r140[244u32] r140[245u32] r140[246u32] r140[247u32] r140[248u32] r140[249u32] r140[250u32] r140[251u32] r140[252u32] into r141 as [boolean; 253u32];
    deserialize.bits.raw r141 ([boolean; 253u32]) into r142 (address);
    cast r135 into r143 as u64;
    call credits.aleo/transfer_public r142 r143 into r144;
    async process r138 r1 r2 r144 r0 into r145;
    output r145 as hyp_native.aleo/process.future;

finalize process:
    input r0 as mailbox.aleo/process.future;
    input r1 as Metadata.public;
    input r2 as Message.public;
    input r3 as credits.aleo/transfer_public.future;
    input r4 as address.public;
    get token_metadata[true] into r5;
    assert.eq r5 r1;
    get mailbox.aleo/mailbox[true] into r6;
    is.eq r5.ism aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc into r7;
    ternary r7 r6.default_ism r5.ism into r8;
    assert.eq r8 r4;
    get remote_routers[r2.origin_domain] into r9;
    assert.eq r9.recipient r2.sender;
    await r0;
    await r3;

constructor:
    assert.eq edition 0u16;
