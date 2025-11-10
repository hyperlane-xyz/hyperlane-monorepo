import ism_manager.aleo;
program mailbox.aleo;

struct Mailbox:
    local_domain as u32;
    nonce as u32;
    process_count as u32;
    default_ism as address;
    default_hook as address;
    required_hook as address;
    dispatch_proxy as address;
    mailbox_owner as address;

struct Message:
    version as u8;
    nonce as u32;
    origin_domain as u32;
    sender as [u8; 32u32];
    destination_domain as u32;
    recipient as [u8; 32u32];
    body as [u128; 8u32];

struct Delivery:
    processor as address;
    block_number as u32;

struct DeliveryKey:
    id as [u128; 2u32];

struct EthAddress:
    bytes as [u8; 20u32];

mapping deliveries:
    key as DeliveryKey.public;
    value as Delivery.public;

mapping dispatch_events:
    key as u32.public;
    value as Message.public;

mapping dispatch_id_events:
    key as u32.public;
    value as [u128; 2u32].public;

mapping process_events:
    key as u32.public;
    value as [u128; 2u32].public;

mapping mailbox:
    key as boolean.public;
    value as Mailbox.public;

mapping process_event_index:
    key as u32.public;
    value as u32.public;

mapping dispatch_event_index:
    key as u32.public;
    value as u32.public;

mapping registered_applications:
    key as address.public;
    value as [u8; 128u32].public;

function init:
    input r0 as u32.private;
    async init r0 self.caller into r1;
    output r1 as mailbox.aleo/init.future;

finalize init:
    input r0 as u32.public;
    input r1 as address.public;
    contains mailbox[true] into r2;
    not r2 into r3;
    assert.eq r3 true;
    cast r0 0u32 0u32 aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc r1 into r4 as Mailbox;
    set r4 into mailbox[true];

function get_address:
    output mailbox.aleo as address.private;

function set_dispatch_proxy:
    input r0 as address.private;
    async set_dispatch_proxy self.caller r0 into r1;
    output r1 as mailbox.aleo/set_dispatch_proxy.future;

finalize set_dispatch_proxy:
    input r0 as address.public;
    input r1 as address.public;
    get mailbox[true] into r2;
    assert.eq r2.mailbox_owner r0;
    cast r2.local_domain r2.nonce r2.process_count r2.default_ism r2.default_hook r2.required_hook r1 r2.mailbox_owner into r3 as Mailbox;
    set r3 into mailbox[true];

function set_owner:
    input r0 as address.private;
    async set_owner self.caller r0 into r1;
    output r1 as mailbox.aleo/set_owner.future;

finalize set_owner:
    input r0 as address.public;
    input r1 as address.public;
    get mailbox[true] into r2;
    assert.eq r2.mailbox_owner r0;
    cast r2.local_domain r2.nonce r2.process_count r2.default_ism r2.default_hook r2.required_hook r2.dispatch_proxy r1 into r3 as Mailbox;
    set r3 into mailbox[true];

function set_default_ism:
    input r0 as address.private;
    async set_default_ism self.caller r0 into r1;
    output r1 as mailbox.aleo/set_default_ism.future;

finalize set_default_ism:
    input r0 as address.public;
    input r1 as address.public;
    get mailbox[true] into r2;
    assert.eq r2.mailbox_owner r0;
    cast r2.local_domain r2.nonce r2.process_count r1 r2.default_hook r2.required_hook r2.dispatch_proxy r2.mailbox_owner into r3 as Mailbox;
    set r3 into mailbox[true];

function set_default_hook:
    input r0 as address.private;
    async set_default_hook self.caller r0 into r1;
    output r1 as mailbox.aleo/set_default_hook.future;

finalize set_default_hook:
    input r0 as address.public;
    input r1 as address.public;
    get mailbox[true] into r2;
    assert.eq r2.mailbox_owner r0;
    cast r2.local_domain r2.nonce r2.process_count r2.default_ism r1 r2.required_hook r2.dispatch_proxy r2.mailbox_owner into r3 as Mailbox;
    set r3 into mailbox[true];

function set_required_hook:
    input r0 as address.private;
    async set_required_hook self.caller r0 into r1;
    output r1 as mailbox.aleo/set_required_hook.future;

finalize set_required_hook:
    input r0 as address.public;
    input r1 as address.public;
    get mailbox[true] into r2;
    assert.eq r2.mailbox_owner r0;
    cast r2.local_domain r2.nonce r2.process_count r2.default_ism r2.default_hook r1 r2.dispatch_proxy r2.mailbox_owner into r3 as Mailbox;
    set r3 into mailbox[true];

function register_application:
    input r0 as [u8; 128u32].private;
    async register_application r0 self.caller into r1;
    output r1 as mailbox.aleo/register_application.future;

finalize register_application:
    input r0 as [u8; 128u32].public;
    input r1 as address.public;
    contains mailbox[true] into r2;
    assert.eq r2 true;
    contains registered_applications[r1] into r3;
    not r3 into r4;
    assert.eq r4 true;
    set r0 into registered_applications[r1];

function process:
    input r0 as address.public;
    input r1 as Message.public;
    input r2 as u32.public;
    input r3 as [u128; 2u32].public;
    input r4 as [u8; 512u32].public;
    call ism_manager.aleo/verify r0 r1 r3 r4 into r5;
    async process r0 r1 r2 r3 self.caller r5 into r6;
    output r6 as mailbox.aleo/process.future;

finalize process:
    input r0 as address.public;
    input r1 as Message.public;
    input r2 as u32.public;
    input r3 as [u128; 2u32].public;
    input r4 as address.public;
    input r5 as ism_manager.aleo/verify.future;
    contains mailbox[true] into r6;
    assert.eq r6 true;
    gte r2 77u32 into r7;
    assert.eq r7 true;
    sub r2 77u32 into r8;
    rem r8 8u32 into r9;
    is.eq r9 0u32 into r10;
    assert.eq r10 true;
    cast 0u128 0u128 into r11 as [u128; 2u32];
    shr r1.nonce 24u32 into r12;
    cast r12 into r13 as u8;
    shr r1.nonce 16u32 into r14;
    rem r14 256u32 into r15;
    cast r15 into r16 as u8;
    shr r1.nonce 8u32 into r17;
    rem r17 256u32 into r18;
    cast r18 into r19 as u8;
    rem r1.nonce 256u32 into r20;
    cast r20 into r21 as u8;
    cast r13 r16 r19 r21 into r22 as [u8; 4u32];
    shr r1.origin_domain 24u32 into r23;
    cast r23 into r24 as u8;
    shr r1.origin_domain 16u32 into r25;
    rem r25 256u32 into r26;
    cast r26 into r27 as u8;
    shr r1.origin_domain 8u32 into r28;
    rem r28 256u32 into r29;
    cast r29 into r30 as u8;
    rem r1.origin_domain 256u32 into r31;
    cast r31 into r32 as u8;
    cast r24 r27 r30 r32 into r33 as [u8; 4u32];
    shr r1.destination_domain 24u32 into r34;
    cast r34 into r35 as u8;
    shr r1.destination_domain 16u32 into r36;
    rem r36 256u32 into r37;
    cast r37 into r38 as u8;
    shr r1.destination_domain 8u32 into r39;
    rem r39 256u32 into r40;
    cast r40 into r41 as u8;
    rem r1.destination_domain 256u32 into r42;
    cast r42 into r43 as u8;
    cast r35 r38 r41 r43 into r44 as [u8; 4u32];
    serialize.bits.raw r1.body[0u32] (u128) into r45 ([boolean; 128u32]);
    deserialize.bits.raw r45 ([boolean; 128u32]) into r46 ([u8; 16u32]);
    serialize.bits.raw r1.body[1u32] (u128) into r47 ([boolean; 128u32]);
    deserialize.bits.raw r47 ([boolean; 128u32]) into r48 ([u8; 16u32]);
    serialize.bits.raw r1.body[2u32] (u128) into r49 ([boolean; 128u32]);
    deserialize.bits.raw r49 ([boolean; 128u32]) into r50 ([u8; 16u32]);
    serialize.bits.raw r1.body[3u32] (u128) into r51 ([boolean; 128u32]);
    deserialize.bits.raw r51 ([boolean; 128u32]) into r52 ([u8; 16u32]);
    serialize.bits.raw r1.body[4u32] (u128) into r53 ([boolean; 128u32]);
    deserialize.bits.raw r53 ([boolean; 128u32]) into r54 ([u8; 16u32]);
    serialize.bits.raw r1.body[5u32] (u128) into r55 ([boolean; 128u32]);
    deserialize.bits.raw r55 ([boolean; 128u32]) into r56 ([u8; 16u32]);
    serialize.bits.raw r1.body[6u32] (u128) into r57 ([boolean; 128u32]);
    deserialize.bits.raw r57 ([boolean; 128u32]) into r58 ([u8; 16u32]);
    serialize.bits.raw r1.body[7u32] (u128) into r59 ([boolean; 128u32]);
    deserialize.bits.raw r59 ([boolean; 128u32]) into r60 ([u8; 16u32]);
    cast r1.version r22[0u32] r22[1u32] r22[2u32] r22[3u32] r33[0u32] r33[1u32] r33[2u32] r33[3u32] r1.sender[0u32] r1.sender[1u32] r1.sender[2u32] r1.sender[3u32] r1.sender[4u32] r1.sender[5u32] r1.sender[6u32] r1.sender[7u32] r1.sender[8u32] r1.sender[9u32] r1.sender[10u32] r1.sender[11u32] r1.sender[12u32] r1.sender[13u32] r1.sender[14u32] r1.sender[15u32] r1.sender[16u32] r1.sender[17u32] r1.sender[18u32] r1.sender[19u32] r1.sender[20u32] r1.sender[21u32] r1.sender[22u32] r1.sender[23u32] r1.sender[24u32] r1.sender[25u32] r1.sender[26u32] r1.sender[27u32] r1.sender[28u32] r1.sender[29u32] r1.sender[30u32] r1.sender[31u32] r44[0u32] r44[1u32] r44[2u32] r44[3u32] r1.recipient[0u32] r1.recipient[1u32] r1.recipient[2u32] r1.recipient[3u32] r1.recipient[4u32] r1.recipient[5u32] r1.recipient[6u32] r1.recipient[7u32] r1.recipient[8u32] r1.recipient[9u32] r1.recipient[10u32] r1.recipient[11u32] r1.recipient[12u32] r1.recipient[13u32] r1.recipient[14u32] r1.recipient[15u32] r1.recipient[16u32] r1.recipient[17u32] r1.recipient[18u32] r1.recipient[19u32] r1.recipient[20u32] r1.recipient[21u32] r1.recipient[22u32] r1.recipient[23u32] r1.recipient[24u32] r1.recipient[25u32] r1.recipient[26u32] r1.recipient[27u32] r1.recipient[28u32] r1.recipient[29u32] r1.recipient[30u32] r1.recipient[31u32] r46[0u32] r46[1u32] r46[2u32] r46[3u32] r46[4u32] r46[5u32] r46[6u32] r46[7u32] r46[8u32] r46[9u32] r46[10u32] r46[11u32] r46[12u32] r46[13u32] r46[14u32] r46[15u32] r48[0u32] r48[1u32] r48[2u32] r48[3u32] r48[4u32] r48[5u32] r48[6u32] r48[7u32] r48[8u32] r48[9u32] r48[10u32] r48[11u32] r48[12u32] r48[13u32] r48[14u32] r48[15u32] r50[0u32] r50[1u32] r50[2u32] r50[3u32] r50[4u32] r50[5u32] r50[6u32] r50[7u32] r50[8u32] r50[9u32] r50[10u32] r50[11u32] r50[12u32] r50[13u32] r50[14u32] r50[15u32] r52[0u32] r52[1u32] r52[2u32] r52[3u32] r52[4u32] r52[5u32] r52[6u32] r52[7u32] r52[8u32] r52[9u32] r52[10u32] r52[11u32] r52[12u32] r52[13u32] r52[14u32] r52[15u32] r54[0u32] r54[1u32] r54[2u32] r54[3u32] r54[4u32] r54[5u32] r54[6u32] r54[7u32] r54[8u32] r54[9u32] r54[10u32] r54[11u32] r54[12u32] r54[13u32] r54[14u32] r54[15u32] r56[0u32] r56[1u32] r56[2u32] r56[3u32] r56[4u32] r56[5u32] r56[6u32] r56[7u32] r56[8u32] r56[9u32] r56[10u32] r56[11u32] r56[12u32] r56[13u32] r56[14u32] r56[15u32] r58[0u32] r58[1u32] r58[2u32] r58[3u32] r58[4u32] r58[5u32] r58[6u32] r58[7u32] r58[8u32] r58[9u32] r58[10u32] r58[11u32] r58[12u32] r58[13u32] r58[14u32] r58[15u32] r60[0u32] r60[1u32] r60[2u32] r60[3u32] r60[4u32] r60[5u32] r60[6u32] r60[7u32] r60[8u32] r60[9u32] r60[10u32] r60[11u32] r60[12u32] r60[13u32] r60[14u32] r60[15u32] into r61 as [u8; 205u32];
    is.eq r2 77u32 into r62;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] into r63 as [u8; 77u32];
    hash.keccak256.native.raw r63 into r64 as [boolean; 256u32];
    deserialize.bits.raw r64 ([boolean; 256u32]) into r65 ([u128; 2u32]);
    is.eq r2 85u32 into r66;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] into r67 as [u8; 85u32];
    hash.keccak256.native.raw r67 into r68 as [boolean; 256u32];
    deserialize.bits.raw r68 ([boolean; 256u32]) into r69 ([u128; 2u32]);
    is.eq r2 93u32 into r70;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] into r71 as [u8; 93u32];
    hash.keccak256.native.raw r71 into r72 as [boolean; 256u32];
    deserialize.bits.raw r72 ([boolean; 256u32]) into r73 ([u128; 2u32]);
    is.eq r2 101u32 into r74;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] r61[93u32] r61[94u32] r61[95u32] r61[96u32] r61[97u32] r61[98u32] r61[99u32] r61[100u32] into r75 as [u8; 101u32];
    hash.keccak256.native.raw r75 into r76 as [boolean; 256u32];
    deserialize.bits.raw r76 ([boolean; 256u32]) into r77 ([u128; 2u32]);
    is.eq r2 109u32 into r78;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] r61[93u32] r61[94u32] r61[95u32] r61[96u32] r61[97u32] r61[98u32] r61[99u32] r61[100u32] r61[101u32] r61[102u32] r61[103u32] r61[104u32] r61[105u32] r61[106u32] r61[107u32] r61[108u32] into r79 as [u8; 109u32];
    hash.keccak256.native.raw r79 into r80 as [boolean; 256u32];
    deserialize.bits.raw r80 ([boolean; 256u32]) into r81 ([u128; 2u32]);
    is.eq r2 117u32 into r82;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] r61[93u32] r61[94u32] r61[95u32] r61[96u32] r61[97u32] r61[98u32] r61[99u32] r61[100u32] r61[101u32] r61[102u32] r61[103u32] r61[104u32] r61[105u32] r61[106u32] r61[107u32] r61[108u32] r61[109u32] r61[110u32] r61[111u32] r61[112u32] r61[113u32] r61[114u32] r61[115u32] r61[116u32] into r83 as [u8; 117u32];
    hash.keccak256.native.raw r83 into r84 as [boolean; 256u32];
    deserialize.bits.raw r84 ([boolean; 256u32]) into r85 ([u128; 2u32]);
    is.eq r2 125u32 into r86;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] r61[93u32] r61[94u32] r61[95u32] r61[96u32] r61[97u32] r61[98u32] r61[99u32] r61[100u32] r61[101u32] r61[102u32] r61[103u32] r61[104u32] r61[105u32] r61[106u32] r61[107u32] r61[108u32] r61[109u32] r61[110u32] r61[111u32] r61[112u32] r61[113u32] r61[114u32] r61[115u32] r61[116u32] r61[117u32] r61[118u32] r61[119u32] r61[120u32] r61[121u32] r61[122u32] r61[123u32] r61[124u32] into r87 as [u8; 125u32];
    hash.keccak256.native.raw r87 into r88 as [boolean; 256u32];
    deserialize.bits.raw r88 ([boolean; 256u32]) into r89 ([u128; 2u32]);
    is.eq r2 133u32 into r90;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] r61[93u32] r61[94u32] r61[95u32] r61[96u32] r61[97u32] r61[98u32] r61[99u32] r61[100u32] r61[101u32] r61[102u32] r61[103u32] r61[104u32] r61[105u32] r61[106u32] r61[107u32] r61[108u32] r61[109u32] r61[110u32] r61[111u32] r61[112u32] r61[113u32] r61[114u32] r61[115u32] r61[116u32] r61[117u32] r61[118u32] r61[119u32] r61[120u32] r61[121u32] r61[122u32] r61[123u32] r61[124u32] r61[125u32] r61[126u32] r61[127u32] r61[128u32] r61[129u32] r61[130u32] r61[131u32] r61[132u32] into r91 as [u8; 133u32];
    hash.keccak256.native.raw r91 into r92 as [boolean; 256u32];
    deserialize.bits.raw r92 ([boolean; 256u32]) into r93 ([u128; 2u32]);
    is.eq r2 141u32 into r94;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] r61[93u32] r61[94u32] r61[95u32] r61[96u32] r61[97u32] r61[98u32] r61[99u32] r61[100u32] r61[101u32] r61[102u32] r61[103u32] r61[104u32] r61[105u32] r61[106u32] r61[107u32] r61[108u32] r61[109u32] r61[110u32] r61[111u32] r61[112u32] r61[113u32] r61[114u32] r61[115u32] r61[116u32] r61[117u32] r61[118u32] r61[119u32] r61[120u32] r61[121u32] r61[122u32] r61[123u32] r61[124u32] r61[125u32] r61[126u32] r61[127u32] r61[128u32] r61[129u32] r61[130u32] r61[131u32] r61[132u32] r61[133u32] r61[134u32] r61[135u32] r61[136u32] r61[137u32] r61[138u32] r61[139u32] r61[140u32] into r95 as [u8; 141u32];
    hash.keccak256.native.raw r95 into r96 as [boolean; 256u32];
    deserialize.bits.raw r96 ([boolean; 256u32]) into r97 ([u128; 2u32]);
    is.eq r2 149u32 into r98;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] r61[93u32] r61[94u32] r61[95u32] r61[96u32] r61[97u32] r61[98u32] r61[99u32] r61[100u32] r61[101u32] r61[102u32] r61[103u32] r61[104u32] r61[105u32] r61[106u32] r61[107u32] r61[108u32] r61[109u32] r61[110u32] r61[111u32] r61[112u32] r61[113u32] r61[114u32] r61[115u32] r61[116u32] r61[117u32] r61[118u32] r61[119u32] r61[120u32] r61[121u32] r61[122u32] r61[123u32] r61[124u32] r61[125u32] r61[126u32] r61[127u32] r61[128u32] r61[129u32] r61[130u32] r61[131u32] r61[132u32] r61[133u32] r61[134u32] r61[135u32] r61[136u32] r61[137u32] r61[138u32] r61[139u32] r61[140u32] r61[141u32] r61[142u32] r61[143u32] r61[144u32] r61[145u32] r61[146u32] r61[147u32] r61[148u32] into r99 as [u8; 149u32];
    hash.keccak256.native.raw r99 into r100 as [boolean; 256u32];
    deserialize.bits.raw r100 ([boolean; 256u32]) into r101 ([u128; 2u32]);
    is.eq r2 157u32 into r102;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] r61[93u32] r61[94u32] r61[95u32] r61[96u32] r61[97u32] r61[98u32] r61[99u32] r61[100u32] r61[101u32] r61[102u32] r61[103u32] r61[104u32] r61[105u32] r61[106u32] r61[107u32] r61[108u32] r61[109u32] r61[110u32] r61[111u32] r61[112u32] r61[113u32] r61[114u32] r61[115u32] r61[116u32] r61[117u32] r61[118u32] r61[119u32] r61[120u32] r61[121u32] r61[122u32] r61[123u32] r61[124u32] r61[125u32] r61[126u32] r61[127u32] r61[128u32] r61[129u32] r61[130u32] r61[131u32] r61[132u32] r61[133u32] r61[134u32] r61[135u32] r61[136u32] r61[137u32] r61[138u32] r61[139u32] r61[140u32] r61[141u32] r61[142u32] r61[143u32] r61[144u32] r61[145u32] r61[146u32] r61[147u32] r61[148u32] r61[149u32] r61[150u32] r61[151u32] r61[152u32] r61[153u32] r61[154u32] r61[155u32] r61[156u32] into r103 as [u8; 157u32];
    hash.keccak256.native.raw r103 into r104 as [boolean; 256u32];
    deserialize.bits.raw r104 ([boolean; 256u32]) into r105 ([u128; 2u32]);
    is.eq r2 165u32 into r106;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] r61[93u32] r61[94u32] r61[95u32] r61[96u32] r61[97u32] r61[98u32] r61[99u32] r61[100u32] r61[101u32] r61[102u32] r61[103u32] r61[104u32] r61[105u32] r61[106u32] r61[107u32] r61[108u32] r61[109u32] r61[110u32] r61[111u32] r61[112u32] r61[113u32] r61[114u32] r61[115u32] r61[116u32] r61[117u32] r61[118u32] r61[119u32] r61[120u32] r61[121u32] r61[122u32] r61[123u32] r61[124u32] r61[125u32] r61[126u32] r61[127u32] r61[128u32] r61[129u32] r61[130u32] r61[131u32] r61[132u32] r61[133u32] r61[134u32] r61[135u32] r61[136u32] r61[137u32] r61[138u32] r61[139u32] r61[140u32] r61[141u32] r61[142u32] r61[143u32] r61[144u32] r61[145u32] r61[146u32] r61[147u32] r61[148u32] r61[149u32] r61[150u32] r61[151u32] r61[152u32] r61[153u32] r61[154u32] r61[155u32] r61[156u32] r61[157u32] r61[158u32] r61[159u32] r61[160u32] r61[161u32] r61[162u32] r61[163u32] r61[164u32] into r107 as [u8; 165u32];
    hash.keccak256.native.raw r107 into r108 as [boolean; 256u32];
    deserialize.bits.raw r108 ([boolean; 256u32]) into r109 ([u128; 2u32]);
    is.eq r2 173u32 into r110;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] r61[93u32] r61[94u32] r61[95u32] r61[96u32] r61[97u32] r61[98u32] r61[99u32] r61[100u32] r61[101u32] r61[102u32] r61[103u32] r61[104u32] r61[105u32] r61[106u32] r61[107u32] r61[108u32] r61[109u32] r61[110u32] r61[111u32] r61[112u32] r61[113u32] r61[114u32] r61[115u32] r61[116u32] r61[117u32] r61[118u32] r61[119u32] r61[120u32] r61[121u32] r61[122u32] r61[123u32] r61[124u32] r61[125u32] r61[126u32] r61[127u32] r61[128u32] r61[129u32] r61[130u32] r61[131u32] r61[132u32] r61[133u32] r61[134u32] r61[135u32] r61[136u32] r61[137u32] r61[138u32] r61[139u32] r61[140u32] r61[141u32] r61[142u32] r61[143u32] r61[144u32] r61[145u32] r61[146u32] r61[147u32] r61[148u32] r61[149u32] r61[150u32] r61[151u32] r61[152u32] r61[153u32] r61[154u32] r61[155u32] r61[156u32] r61[157u32] r61[158u32] r61[159u32] r61[160u32] r61[161u32] r61[162u32] r61[163u32] r61[164u32] r61[165u32] r61[166u32] r61[167u32] r61[168u32] r61[169u32] r61[170u32] r61[171u32] r61[172u32] into r111 as [u8; 173u32];
    hash.keccak256.native.raw r111 into r112 as [boolean; 256u32];
    deserialize.bits.raw r112 ([boolean; 256u32]) into r113 ([u128; 2u32]);
    is.eq r2 181u32 into r114;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] r61[93u32] r61[94u32] r61[95u32] r61[96u32] r61[97u32] r61[98u32] r61[99u32] r61[100u32] r61[101u32] r61[102u32] r61[103u32] r61[104u32] r61[105u32] r61[106u32] r61[107u32] r61[108u32] r61[109u32] r61[110u32] r61[111u32] r61[112u32] r61[113u32] r61[114u32] r61[115u32] r61[116u32] r61[117u32] r61[118u32] r61[119u32] r61[120u32] r61[121u32] r61[122u32] r61[123u32] r61[124u32] r61[125u32] r61[126u32] r61[127u32] r61[128u32] r61[129u32] r61[130u32] r61[131u32] r61[132u32] r61[133u32] r61[134u32] r61[135u32] r61[136u32] r61[137u32] r61[138u32] r61[139u32] r61[140u32] r61[141u32] r61[142u32] r61[143u32] r61[144u32] r61[145u32] r61[146u32] r61[147u32] r61[148u32] r61[149u32] r61[150u32] r61[151u32] r61[152u32] r61[153u32] r61[154u32] r61[155u32] r61[156u32] r61[157u32] r61[158u32] r61[159u32] r61[160u32] r61[161u32] r61[162u32] r61[163u32] r61[164u32] r61[165u32] r61[166u32] r61[167u32] r61[168u32] r61[169u32] r61[170u32] r61[171u32] r61[172u32] r61[173u32] r61[174u32] r61[175u32] r61[176u32] r61[177u32] r61[178u32] r61[179u32] r61[180u32] into r115 as [u8; 181u32];
    hash.keccak256.native.raw r115 into r116 as [boolean; 256u32];
    deserialize.bits.raw r116 ([boolean; 256u32]) into r117 ([u128; 2u32]);
    is.eq r2 189u32 into r118;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] r61[93u32] r61[94u32] r61[95u32] r61[96u32] r61[97u32] r61[98u32] r61[99u32] r61[100u32] r61[101u32] r61[102u32] r61[103u32] r61[104u32] r61[105u32] r61[106u32] r61[107u32] r61[108u32] r61[109u32] r61[110u32] r61[111u32] r61[112u32] r61[113u32] r61[114u32] r61[115u32] r61[116u32] r61[117u32] r61[118u32] r61[119u32] r61[120u32] r61[121u32] r61[122u32] r61[123u32] r61[124u32] r61[125u32] r61[126u32] r61[127u32] r61[128u32] r61[129u32] r61[130u32] r61[131u32] r61[132u32] r61[133u32] r61[134u32] r61[135u32] r61[136u32] r61[137u32] r61[138u32] r61[139u32] r61[140u32] r61[141u32] r61[142u32] r61[143u32] r61[144u32] r61[145u32] r61[146u32] r61[147u32] r61[148u32] r61[149u32] r61[150u32] r61[151u32] r61[152u32] r61[153u32] r61[154u32] r61[155u32] r61[156u32] r61[157u32] r61[158u32] r61[159u32] r61[160u32] r61[161u32] r61[162u32] r61[163u32] r61[164u32] r61[165u32] r61[166u32] r61[167u32] r61[168u32] r61[169u32] r61[170u32] r61[171u32] r61[172u32] r61[173u32] r61[174u32] r61[175u32] r61[176u32] r61[177u32] r61[178u32] r61[179u32] r61[180u32] r61[181u32] r61[182u32] r61[183u32] r61[184u32] r61[185u32] r61[186u32] r61[187u32] r61[188u32] into r119 as [u8; 189u32];
    hash.keccak256.native.raw r119 into r120 as [boolean; 256u32];
    deserialize.bits.raw r120 ([boolean; 256u32]) into r121 ([u128; 2u32]);
    is.eq r2 197u32 into r122;
    cast r61[0u32] r61[1u32] r61[2u32] r61[3u32] r61[4u32] r61[5u32] r61[6u32] r61[7u32] r61[8u32] r61[9u32] r61[10u32] r61[11u32] r61[12u32] r61[13u32] r61[14u32] r61[15u32] r61[16u32] r61[17u32] r61[18u32] r61[19u32] r61[20u32] r61[21u32] r61[22u32] r61[23u32] r61[24u32] r61[25u32] r61[26u32] r61[27u32] r61[28u32] r61[29u32] r61[30u32] r61[31u32] r61[32u32] r61[33u32] r61[34u32] r61[35u32] r61[36u32] r61[37u32] r61[38u32] r61[39u32] r61[40u32] r61[41u32] r61[42u32] r61[43u32] r61[44u32] r61[45u32] r61[46u32] r61[47u32] r61[48u32] r61[49u32] r61[50u32] r61[51u32] r61[52u32] r61[53u32] r61[54u32] r61[55u32] r61[56u32] r61[57u32] r61[58u32] r61[59u32] r61[60u32] r61[61u32] r61[62u32] r61[63u32] r61[64u32] r61[65u32] r61[66u32] r61[67u32] r61[68u32] r61[69u32] r61[70u32] r61[71u32] r61[72u32] r61[73u32] r61[74u32] r61[75u32] r61[76u32] r61[77u32] r61[78u32] r61[79u32] r61[80u32] r61[81u32] r61[82u32] r61[83u32] r61[84u32] r61[85u32] r61[86u32] r61[87u32] r61[88u32] r61[89u32] r61[90u32] r61[91u32] r61[92u32] r61[93u32] r61[94u32] r61[95u32] r61[96u32] r61[97u32] r61[98u32] r61[99u32] r61[100u32] r61[101u32] r61[102u32] r61[103u32] r61[104u32] r61[105u32] r61[106u32] r61[107u32] r61[108u32] r61[109u32] r61[110u32] r61[111u32] r61[112u32] r61[113u32] r61[114u32] r61[115u32] r61[116u32] r61[117u32] r61[118u32] r61[119u32] r61[120u32] r61[121u32] r61[122u32] r61[123u32] r61[124u32] r61[125u32] r61[126u32] r61[127u32] r61[128u32] r61[129u32] r61[130u32] r61[131u32] r61[132u32] r61[133u32] r61[134u32] r61[135u32] r61[136u32] r61[137u32] r61[138u32] r61[139u32] r61[140u32] r61[141u32] r61[142u32] r61[143u32] r61[144u32] r61[145u32] r61[146u32] r61[147u32] r61[148u32] r61[149u32] r61[150u32] r61[151u32] r61[152u32] r61[153u32] r61[154u32] r61[155u32] r61[156u32] r61[157u32] r61[158u32] r61[159u32] r61[160u32] r61[161u32] r61[162u32] r61[163u32] r61[164u32] r61[165u32] r61[166u32] r61[167u32] r61[168u32] r61[169u32] r61[170u32] r61[171u32] r61[172u32] r61[173u32] r61[174u32] r61[175u32] r61[176u32] r61[177u32] r61[178u32] r61[179u32] r61[180u32] r61[181u32] r61[182u32] r61[183u32] r61[184u32] r61[185u32] r61[186u32] r61[187u32] r61[188u32] r61[189u32] r61[190u32] r61[191u32] r61[192u32] r61[193u32] r61[194u32] r61[195u32] r61[196u32] into r123 as [u8; 197u32];
    hash.keccak256.native.raw r123 into r124 as [boolean; 256u32];
    deserialize.bits.raw r124 ([boolean; 256u32]) into r125 ([u128; 2u32]);
    is.eq r2 205u32 into r126;
    hash.keccak256.native.raw r61 into r127 as [boolean; 256u32];
    deserialize.bits.raw r127 ([boolean; 256u32]) into r128 ([u128; 2u32]);
    ternary r126 r128[0u32] r11[0u32] into r129;
    ternary r126 r128[1u32] r11[1u32] into r130;
    cast r129 r130 into r131 as [u128; 2u32];
    ternary r122 r125[0u32] r131[0u32] into r132;
    ternary r122 r125[1u32] r131[1u32] into r133;
    cast r132 r133 into r134 as [u128; 2u32];
    ternary r118 r121[0u32] r134[0u32] into r135;
    ternary r118 r121[1u32] r134[1u32] into r136;
    cast r135 r136 into r137 as [u128; 2u32];
    ternary r114 r117[0u32] r137[0u32] into r138;
    ternary r114 r117[1u32] r137[1u32] into r139;
    cast r138 r139 into r140 as [u128; 2u32];
    ternary r110 r113[0u32] r140[0u32] into r141;
    ternary r110 r113[1u32] r140[1u32] into r142;
    cast r141 r142 into r143 as [u128; 2u32];
    ternary r106 r109[0u32] r143[0u32] into r144;
    ternary r106 r109[1u32] r143[1u32] into r145;
    cast r144 r145 into r146 as [u128; 2u32];
    ternary r102 r105[0u32] r146[0u32] into r147;
    ternary r102 r105[1u32] r146[1u32] into r148;
    cast r147 r148 into r149 as [u128; 2u32];
    ternary r98 r101[0u32] r149[0u32] into r150;
    ternary r98 r101[1u32] r149[1u32] into r151;
    cast r150 r151 into r152 as [u128; 2u32];
    ternary r94 r97[0u32] r152[0u32] into r153;
    ternary r94 r97[1u32] r152[1u32] into r154;
    cast r153 r154 into r155 as [u128; 2u32];
    ternary r90 r93[0u32] r155[0u32] into r156;
    ternary r90 r93[1u32] r155[1u32] into r157;
    cast r156 r157 into r158 as [u128; 2u32];
    ternary r86 r89[0u32] r158[0u32] into r159;
    ternary r86 r89[1u32] r158[1u32] into r160;
    cast r159 r160 into r161 as [u128; 2u32];
    ternary r82 r85[0u32] r161[0u32] into r162;
    ternary r82 r85[1u32] r161[1u32] into r163;
    cast r162 r163 into r164 as [u128; 2u32];
    ternary r78 r81[0u32] r164[0u32] into r165;
    ternary r78 r81[1u32] r164[1u32] into r166;
    cast r165 r166 into r167 as [u128; 2u32];
    ternary r74 r77[0u32] r167[0u32] into r168;
    ternary r74 r77[1u32] r167[1u32] into r169;
    cast r168 r169 into r170 as [u128; 2u32];
    ternary r70 r73[0u32] r170[0u32] into r171;
    ternary r70 r73[1u32] r170[1u32] into r172;
    cast r171 r172 into r173 as [u128; 2u32];
    ternary r66 r69[0u32] r173[0u32] into r174;
    ternary r66 r69[1u32] r173[1u32] into r175;
    cast r174 r175 into r176 as [u128; 2u32];
    ternary r62 r65[0u32] r176[0u32] into r177;
    ternary r62 r65[1u32] r176[1u32] into r178;
    cast r177 r178 into r179 as [u128; 2u32];
    assert.eq r179 r3;
    get mailbox[true] into r180;
    await r5;
    serialize.bits.raw r4 (address) into r181 ([boolean; 253u32]);
    cast false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false into r182 as [boolean; 256u32];
    cast r181[0u32] r181[1u32] r181[2u32] r181[3u32] r181[4u32] r181[5u32] r181[6u32] r181[7u32] r181[8u32] r181[9u32] r181[10u32] r181[11u32] r181[12u32] r181[13u32] r181[14u32] r181[15u32] r181[16u32] r181[17u32] r181[18u32] r181[19u32] r181[20u32] r181[21u32] r181[22u32] r181[23u32] r181[24u32] r181[25u32] r181[26u32] r181[27u32] r181[28u32] r181[29u32] r181[30u32] r181[31u32] r181[32u32] r181[33u32] r181[34u32] r181[35u32] r181[36u32] r181[37u32] r181[38u32] r181[39u32] r181[40u32] r181[41u32] r181[42u32] r181[43u32] r181[44u32] r181[45u32] r181[46u32] r181[47u32] r181[48u32] r181[49u32] r181[50u32] r181[51u32] r181[52u32] r181[53u32] r181[54u32] r181[55u32] r181[56u32] r181[57u32] r181[58u32] r181[59u32] r181[60u32] r181[61u32] r181[62u32] r181[63u32] r181[64u32] r181[65u32] r181[66u32] r181[67u32] r181[68u32] r181[69u32] r181[70u32] r181[71u32] r181[72u32] r181[73u32] r181[74u32] r181[75u32] r181[76u32] r181[77u32] r181[78u32] r181[79u32] r181[80u32] r181[81u32] r181[82u32] r181[83u32] r181[84u32] r181[85u32] r181[86u32] r181[87u32] r181[88u32] r181[89u32] r181[90u32] r181[91u32] r181[92u32] r181[93u32] r181[94u32] r181[95u32] r181[96u32] r181[97u32] r181[98u32] r181[99u32] r181[100u32] r181[101u32] r181[102u32] r181[103u32] r181[104u32] r181[105u32] r181[106u32] r181[107u32] r181[108u32] r181[109u32] r181[110u32] r181[111u32] r181[112u32] r181[113u32] r181[114u32] r181[115u32] r181[116u32] r181[117u32] r181[118u32] r181[119u32] r181[120u32] r181[121u32] r181[122u32] r181[123u32] r181[124u32] r181[125u32] r181[126u32] r181[127u32] r181[128u32] r181[129u32] r181[130u32] r181[131u32] r181[132u32] r181[133u32] r181[134u32] r181[135u32] r181[136u32] r181[137u32] r181[138u32] r181[139u32] r181[140u32] r181[141u32] r181[142u32] r181[143u32] r181[144u32] r181[145u32] r181[146u32] r181[147u32] r181[148u32] r181[149u32] r181[150u32] r181[151u32] r181[152u32] r181[153u32] r181[154u32] r181[155u32] r181[156u32] r181[157u32] r181[158u32] r181[159u32] r181[160u32] r181[161u32] r181[162u32] r181[163u32] r181[164u32] r181[165u32] r181[166u32] r181[167u32] r181[168u32] r181[169u32] r181[170u32] r181[171u32] r181[172u32] r181[173u32] r181[174u32] r181[175u32] r181[176u32] r181[177u32] r181[178u32] r181[179u32] r181[180u32] r181[181u32] r181[182u32] r181[183u32] r181[184u32] r181[185u32] r181[186u32] r181[187u32] r181[188u32] r181[189u32] r181[190u32] r181[191u32] r181[192u32] r181[193u32] r181[194u32] r181[195u32] r181[196u32] r181[197u32] r181[198u32] r181[199u32] r181[200u32] r181[201u32] r181[202u32] r181[203u32] r181[204u32] r181[205u32] r181[206u32] r181[207u32] r181[208u32] r181[209u32] r181[210u32] r181[211u32] r181[212u32] r181[213u32] r181[214u32] r181[215u32] r181[216u32] r181[217u32] r181[218u32] r181[219u32] r181[220u32] r181[221u32] r181[222u32] r181[223u32] r181[224u32] r181[225u32] r181[226u32] r181[227u32] r181[228u32] r181[229u32] r181[230u32] r181[231u32] r181[232u32] r181[233u32] r181[234u32] r181[235u32] r181[236u32] r181[237u32] r181[238u32] r181[239u32] r181[240u32] r181[241u32] r181[242u32] r181[243u32] r181[244u32] r181[245u32] r181[246u32] r181[247u32] r181[248u32] r181[249u32] r181[250u32] r181[251u32] r181[252u32] r182[253u32] r182[254u32] r182[255u32] into r183 as [boolean; 256u32];
    deserialize.bits.raw r183 ([boolean; 256u32]) into r184 ([u8; 32u32]);
    assert.eq r1.recipient r184;
    assert.eq r1.version 3u8;
    assert.eq r1.destination_domain r180.local_domain;
    cast r3 into r185 as DeliveryKey;
    contains deliveries[r185] into r186;
    not r186 into r187;
    assert.eq r187 true;
    cast r4 block.height into r188 as Delivery;
    set r188 into deliveries[r185];
    set r3 into process_events[r180.process_count];
    set r180.process_count into dispatch_event_index[block.height];
    add r180.process_count 1u32 into r189;
    cast r180.local_domain r180.nonce r189 r180.default_ism r180.default_hook r180.required_hook r180.dispatch_proxy r180.mailbox_owner into r190 as Mailbox;
    set r190 into mailbox[true];

function dispatch:
    input r0 as u32.public;
    input r1 as [u8; 32u32].public;
    input r2 as [u128; 8u32].public;
    input r3 as address.public;
    async dispatch r0 r1 r2 r3 self.caller into r4;
    output r4 as mailbox.aleo/dispatch.future;

finalize dispatch:
    input r0 as u32.public;
    input r1 as [u8; 32u32].public;
    input r2 as [u128; 8u32].public;
    input r3 as address.public;
    input r4 as address.public;
    contains mailbox[true] into r5;
    assert.eq r5 true;
    get mailbox[true] into r6;
    assert.eq r4 r6.dispatch_proxy;
    serialize.bits.raw r3 (address) into r7 ([boolean; 253u32]);
    cast false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false into r8 as [boolean; 256u32];
    cast r7[0u32] r7[1u32] r7[2u32] r7[3u32] r7[4u32] r7[5u32] r7[6u32] r7[7u32] r7[8u32] r7[9u32] r7[10u32] r7[11u32] r7[12u32] r7[13u32] r7[14u32] r7[15u32] r7[16u32] r7[17u32] r7[18u32] r7[19u32] r7[20u32] r7[21u32] r7[22u32] r7[23u32] r7[24u32] r7[25u32] r7[26u32] r7[27u32] r7[28u32] r7[29u32] r7[30u32] r7[31u32] r7[32u32] r7[33u32] r7[34u32] r7[35u32] r7[36u32] r7[37u32] r7[38u32] r7[39u32] r7[40u32] r7[41u32] r7[42u32] r7[43u32] r7[44u32] r7[45u32] r7[46u32] r7[47u32] r7[48u32] r7[49u32] r7[50u32] r7[51u32] r7[52u32] r7[53u32] r7[54u32] r7[55u32] r7[56u32] r7[57u32] r7[58u32] r7[59u32] r7[60u32] r7[61u32] r7[62u32] r7[63u32] r7[64u32] r7[65u32] r7[66u32] r7[67u32] r7[68u32] r7[69u32] r7[70u32] r7[71u32] r7[72u32] r7[73u32] r7[74u32] r7[75u32] r7[76u32] r7[77u32] r7[78u32] r7[79u32] r7[80u32] r7[81u32] r7[82u32] r7[83u32] r7[84u32] r7[85u32] r7[86u32] r7[87u32] r7[88u32] r7[89u32] r7[90u32] r7[91u32] r7[92u32] r7[93u32] r7[94u32] r7[95u32] r7[96u32] r7[97u32] r7[98u32] r7[99u32] r7[100u32] r7[101u32] r7[102u32] r7[103u32] r7[104u32] r7[105u32] r7[106u32] r7[107u32] r7[108u32] r7[109u32] r7[110u32] r7[111u32] r7[112u32] r7[113u32] r7[114u32] r7[115u32] r7[116u32] r7[117u32] r7[118u32] r7[119u32] r7[120u32] r7[121u32] r7[122u32] r7[123u32] r7[124u32] r7[125u32] r7[126u32] r7[127u32] r7[128u32] r7[129u32] r7[130u32] r7[131u32] r7[132u32] r7[133u32] r7[134u32] r7[135u32] r7[136u32] r7[137u32] r7[138u32] r7[139u32] r7[140u32] r7[141u32] r7[142u32] r7[143u32] r7[144u32] r7[145u32] r7[146u32] r7[147u32] r7[148u32] r7[149u32] r7[150u32] r7[151u32] r7[152u32] r7[153u32] r7[154u32] r7[155u32] r7[156u32] r7[157u32] r7[158u32] r7[159u32] r7[160u32] r7[161u32] r7[162u32] r7[163u32] r7[164u32] r7[165u32] r7[166u32] r7[167u32] r7[168u32] r7[169u32] r7[170u32] r7[171u32] r7[172u32] r7[173u32] r7[174u32] r7[175u32] r7[176u32] r7[177u32] r7[178u32] r7[179u32] r7[180u32] r7[181u32] r7[182u32] r7[183u32] r7[184u32] r7[185u32] r7[186u32] r7[187u32] r7[188u32] r7[189u32] r7[190u32] r7[191u32] r7[192u32] r7[193u32] r7[194u32] r7[195u32] r7[196u32] r7[197u32] r7[198u32] r7[199u32] r7[200u32] r7[201u32] r7[202u32] r7[203u32] r7[204u32] r7[205u32] r7[206u32] r7[207u32] r7[208u32] r7[209u32] r7[210u32] r7[211u32] r7[212u32] r7[213u32] r7[214u32] r7[215u32] r7[216u32] r7[217u32] r7[218u32] r7[219u32] r7[220u32] r7[221u32] r7[222u32] r7[223u32] r7[224u32] r7[225u32] r7[226u32] r7[227u32] r7[228u32] r7[229u32] r7[230u32] r7[231u32] r7[232u32] r7[233u32] r7[234u32] r7[235u32] r7[236u32] r7[237u32] r7[238u32] r7[239u32] r7[240u32] r7[241u32] r7[242u32] r7[243u32] r7[244u32] r7[245u32] r7[246u32] r7[247u32] r7[248u32] r7[249u32] r7[250u32] r7[251u32] r7[252u32] r8[253u32] r8[254u32] r8[255u32] into r9 as [boolean; 256u32];
    deserialize.bits.raw r9 ([boolean; 256u32]) into r10 ([u8; 32u32]);
    cast 3u8 r6.nonce r6.local_domain r10 r0 r1 r2 into r11 as Message;
    shr r11.nonce 24u32 into r12;
    cast r12 into r13 as u8;
    shr r11.nonce 16u32 into r14;
    rem r14 256u32 into r15;
    cast r15 into r16 as u8;
    shr r11.nonce 8u32 into r17;
    rem r17 256u32 into r18;
    cast r18 into r19 as u8;
    rem r11.nonce 256u32 into r20;
    cast r20 into r21 as u8;
    cast r13 r16 r19 r21 into r22 as [u8; 4u32];
    shr r11.origin_domain 24u32 into r23;
    cast r23 into r24 as u8;
    shr r11.origin_domain 16u32 into r25;
    rem r25 256u32 into r26;
    cast r26 into r27 as u8;
    shr r11.origin_domain 8u32 into r28;
    rem r28 256u32 into r29;
    cast r29 into r30 as u8;
    rem r11.origin_domain 256u32 into r31;
    cast r31 into r32 as u8;
    cast r24 r27 r30 r32 into r33 as [u8; 4u32];
    shr r11.destination_domain 24u32 into r34;
    cast r34 into r35 as u8;
    shr r11.destination_domain 16u32 into r36;
    rem r36 256u32 into r37;
    cast r37 into r38 as u8;
    shr r11.destination_domain 8u32 into r39;
    rem r39 256u32 into r40;
    cast r40 into r41 as u8;
    rem r11.destination_domain 256u32 into r42;
    cast r42 into r43 as u8;
    cast r35 r38 r41 r43 into r44 as [u8; 4u32];
    serialize.bits.raw r11.body[0u32] (u128) into r45 ([boolean; 128u32]);
    deserialize.bits.raw r45 ([boolean; 128u32]) into r46 ([u8; 16u32]);
    serialize.bits.raw r11.body[1u32] (u128) into r47 ([boolean; 128u32]);
    deserialize.bits.raw r47 ([boolean; 128u32]) into r48 ([u8; 16u32]);
    serialize.bits.raw r11.body[2u32] (u128) into r49 ([boolean; 128u32]);
    deserialize.bits.raw r49 ([boolean; 128u32]) into r50 ([u8; 16u32]);
    serialize.bits.raw r11.body[3u32] (u128) into r51 ([boolean; 128u32]);
    deserialize.bits.raw r51 ([boolean; 128u32]) into r52 ([u8; 16u32]);
    serialize.bits.raw r11.body[4u32] (u128) into r53 ([boolean; 128u32]);
    deserialize.bits.raw r53 ([boolean; 128u32]) into r54 ([u8; 16u32]);
    serialize.bits.raw r11.body[5u32] (u128) into r55 ([boolean; 128u32]);
    deserialize.bits.raw r55 ([boolean; 128u32]) into r56 ([u8; 16u32]);
    serialize.bits.raw r11.body[6u32] (u128) into r57 ([boolean; 128u32]);
    deserialize.bits.raw r57 ([boolean; 128u32]) into r58 ([u8; 16u32]);
    serialize.bits.raw r11.body[7u32] (u128) into r59 ([boolean; 128u32]);
    deserialize.bits.raw r59 ([boolean; 128u32]) into r60 ([u8; 16u32]);
    cast r11.version r22[0u32] r22[1u32] r22[2u32] r22[3u32] r33[0u32] r33[1u32] r33[2u32] r33[3u32] r11.sender[0u32] r11.sender[1u32] r11.sender[2u32] r11.sender[3u32] r11.sender[4u32] r11.sender[5u32] r11.sender[6u32] r11.sender[7u32] r11.sender[8u32] r11.sender[9u32] r11.sender[10u32] r11.sender[11u32] r11.sender[12u32] r11.sender[13u32] r11.sender[14u32] r11.sender[15u32] r11.sender[16u32] r11.sender[17u32] r11.sender[18u32] r11.sender[19u32] r11.sender[20u32] r11.sender[21u32] r11.sender[22u32] r11.sender[23u32] r11.sender[24u32] r11.sender[25u32] r11.sender[26u32] r11.sender[27u32] r11.sender[28u32] r11.sender[29u32] r11.sender[30u32] r11.sender[31u32] r44[0u32] r44[1u32] r44[2u32] r44[3u32] r11.recipient[0u32] r11.recipient[1u32] r11.recipient[2u32] r11.recipient[3u32] r11.recipient[4u32] r11.recipient[5u32] r11.recipient[6u32] r11.recipient[7u32] r11.recipient[8u32] r11.recipient[9u32] r11.recipient[10u32] r11.recipient[11u32] r11.recipient[12u32] r11.recipient[13u32] r11.recipient[14u32] r11.recipient[15u32] r11.recipient[16u32] r11.recipient[17u32] r11.recipient[18u32] r11.recipient[19u32] r11.recipient[20u32] r11.recipient[21u32] r11.recipient[22u32] r11.recipient[23u32] r11.recipient[24u32] r11.recipient[25u32] r11.recipient[26u32] r11.recipient[27u32] r11.recipient[28u32] r11.recipient[29u32] r11.recipient[30u32] r11.recipient[31u32] r46[0u32] r46[1u32] r46[2u32] r46[3u32] r46[4u32] r46[5u32] r46[6u32] r46[7u32] r46[8u32] r46[9u32] r46[10u32] r46[11u32] r46[12u32] r46[13u32] r46[14u32] r46[15u32] r48[0u32] r48[1u32] r48[2u32] r48[3u32] r48[4u32] r48[5u32] r48[6u32] r48[7u32] r48[8u32] r48[9u32] r48[10u32] r48[11u32] r48[12u32] r48[13u32] r48[14u32] r48[15u32] r50[0u32] r50[1u32] r50[2u32] r50[3u32] r50[4u32] r50[5u32] r50[6u32] r50[7u32] r50[8u32] r50[9u32] r50[10u32] r50[11u32] r50[12u32] r50[13u32] r50[14u32] r50[15u32] r52[0u32] r52[1u32] r52[2u32] r52[3u32] r52[4u32] r52[5u32] r52[6u32] r52[7u32] r52[8u32] r52[9u32] r52[10u32] r52[11u32] r52[12u32] r52[13u32] r52[14u32] r52[15u32] r54[0u32] r54[1u32] r54[2u32] r54[3u32] r54[4u32] r54[5u32] r54[6u32] r54[7u32] r54[8u32] r54[9u32] r54[10u32] r54[11u32] r54[12u32] r54[13u32] r54[14u32] r54[15u32] r56[0u32] r56[1u32] r56[2u32] r56[3u32] r56[4u32] r56[5u32] r56[6u32] r56[7u32] r56[8u32] r56[9u32] r56[10u32] r56[11u32] r56[12u32] r56[13u32] r56[14u32] r56[15u32] r58[0u32] r58[1u32] r58[2u32] r58[3u32] r58[4u32] r58[5u32] r58[6u32] r58[7u32] r58[8u32] r58[9u32] r58[10u32] r58[11u32] r58[12u32] r58[13u32] r58[14u32] r58[15u32] r60[0u32] r60[1u32] r60[2u32] r60[3u32] r60[4u32] r60[5u32] r60[6u32] r60[7u32] r60[8u32] r60[9u32] r60[10u32] r60[11u32] r60[12u32] r60[13u32] r60[14u32] r60[15u32] into r61 as [u8; 205u32];
    hash.keccak256.native.raw r61 into r62 as [boolean; 256u32];
    deserialize.bits.raw r62 ([boolean; 256u32]) into r63 ([u128; 2u32]);
    set r11 into dispatch_events[r6.nonce];
    set r63 into dispatch_id_events[r6.nonce];
    set r6.nonce into dispatch_event_index[block.height];
    add r6.nonce 1u32 into r64;
    cast r6.local_domain r64 r6.process_count r6.default_ism r6.default_hook r6.required_hook r6.dispatch_proxy r6.mailbox_owner into r65 as Mailbox;
    set r65 into mailbox[true];

constructor:
    assert.eq edition 0u16;
