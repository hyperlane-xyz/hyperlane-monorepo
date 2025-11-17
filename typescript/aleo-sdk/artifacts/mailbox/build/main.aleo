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
    body as [u128; 16u32];

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
    lte r2 333u32 into r8;
    and r7 r8 into r9;
    assert.eq r9 true;
    sub r2 77u32 into r10;
    rem r10 16u32 into r11;
    is.eq r11 0u32 into r12;
    is.eq r2 206u32 into r13;
    or r12 r13 into r14;
    is.eq r2 149u32 into r15;
    or r14 r15 into r16;
    is.eq r2 167u32 into r17;
    or r16 r17 into r18;
    assert.eq r18 true;
    cast 0u128 0u128 into r19 as [u128; 2u32];
    shr r1.nonce 24u32 into r20;
    cast r20 into r21 as u8;
    shr r1.nonce 16u32 into r22;
    rem r22 256u32 into r23;
    cast r23 into r24 as u8;
    shr r1.nonce 8u32 into r25;
    rem r25 256u32 into r26;
    cast r26 into r27 as u8;
    rem r1.nonce 256u32 into r28;
    cast r28 into r29 as u8;
    cast r21 r24 r27 r29 into r30 as [u8; 4u32];
    shr r1.origin_domain 24u32 into r31;
    cast r31 into r32 as u8;
    shr r1.origin_domain 16u32 into r33;
    rem r33 256u32 into r34;
    cast r34 into r35 as u8;
    shr r1.origin_domain 8u32 into r36;
    rem r36 256u32 into r37;
    cast r37 into r38 as u8;
    rem r1.origin_domain 256u32 into r39;
    cast r39 into r40 as u8;
    cast r32 r35 r38 r40 into r41 as [u8; 4u32];
    shr r1.destination_domain 24u32 into r42;
    cast r42 into r43 as u8;
    shr r1.destination_domain 16u32 into r44;
    rem r44 256u32 into r45;
    cast r45 into r46 as u8;
    shr r1.destination_domain 8u32 into r47;
    rem r47 256u32 into r48;
    cast r48 into r49 as u8;
    rem r1.destination_domain 256u32 into r50;
    cast r50 into r51 as u8;
    cast r43 r46 r49 r51 into r52 as [u8; 4u32];
    serialize.bits.raw r1.body[0u32] (u128) into r53 ([boolean; 128u32]);
    deserialize.bits.raw r53 ([boolean; 128u32]) into r54 ([u8; 16u32]);
    serialize.bits.raw r1.body[1u32] (u128) into r55 ([boolean; 128u32]);
    deserialize.bits.raw r55 ([boolean; 128u32]) into r56 ([u8; 16u32]);
    serialize.bits.raw r1.body[2u32] (u128) into r57 ([boolean; 128u32]);
    deserialize.bits.raw r57 ([boolean; 128u32]) into r58 ([u8; 16u32]);
    serialize.bits.raw r1.body[3u32] (u128) into r59 ([boolean; 128u32]);
    deserialize.bits.raw r59 ([boolean; 128u32]) into r60 ([u8; 16u32]);
    serialize.bits.raw r1.body[4u32] (u128) into r61 ([boolean; 128u32]);
    deserialize.bits.raw r61 ([boolean; 128u32]) into r62 ([u8; 16u32]);
    serialize.bits.raw r1.body[5u32] (u128) into r63 ([boolean; 128u32]);
    deserialize.bits.raw r63 ([boolean; 128u32]) into r64 ([u8; 16u32]);
    serialize.bits.raw r1.body[6u32] (u128) into r65 ([boolean; 128u32]);
    deserialize.bits.raw r65 ([boolean; 128u32]) into r66 ([u8; 16u32]);
    serialize.bits.raw r1.body[7u32] (u128) into r67 ([boolean; 128u32]);
    deserialize.bits.raw r67 ([boolean; 128u32]) into r68 ([u8; 16u32]);
    serialize.bits.raw r1.body[8u32] (u128) into r69 ([boolean; 128u32]);
    deserialize.bits.raw r69 ([boolean; 128u32]) into r70 ([u8; 16u32]);
    serialize.bits.raw r1.body[9u32] (u128) into r71 ([boolean; 128u32]);
    deserialize.bits.raw r71 ([boolean; 128u32]) into r72 ([u8; 16u32]);
    serialize.bits.raw r1.body[10u32] (u128) into r73 ([boolean; 128u32]);
    deserialize.bits.raw r73 ([boolean; 128u32]) into r74 ([u8; 16u32]);
    serialize.bits.raw r1.body[11u32] (u128) into r75 ([boolean; 128u32]);
    deserialize.bits.raw r75 ([boolean; 128u32]) into r76 ([u8; 16u32]);
    serialize.bits.raw r1.body[12u32] (u128) into r77 ([boolean; 128u32]);
    deserialize.bits.raw r77 ([boolean; 128u32]) into r78 ([u8; 16u32]);
    serialize.bits.raw r1.body[13u32] (u128) into r79 ([boolean; 128u32]);
    deserialize.bits.raw r79 ([boolean; 128u32]) into r80 ([u8; 16u32]);
    serialize.bits.raw r1.body[14u32] (u128) into r81 ([boolean; 128u32]);
    deserialize.bits.raw r81 ([boolean; 128u32]) into r82 ([u8; 16u32]);
    serialize.bits.raw r1.body[15u32] (u128) into r83 ([boolean; 128u32]);
    deserialize.bits.raw r83 ([boolean; 128u32]) into r84 ([u8; 16u32]);
    cast r1.version r30[0u32] r30[1u32] r30[2u32] r30[3u32] r41[0u32] r41[1u32] r41[2u32] r41[3u32] r1.sender[0u32] r1.sender[1u32] r1.sender[2u32] r1.sender[3u32] r1.sender[4u32] r1.sender[5u32] r1.sender[6u32] r1.sender[7u32] r1.sender[8u32] r1.sender[9u32] r1.sender[10u32] r1.sender[11u32] r1.sender[12u32] r1.sender[13u32] r1.sender[14u32] r1.sender[15u32] r1.sender[16u32] r1.sender[17u32] r1.sender[18u32] r1.sender[19u32] r1.sender[20u32] r1.sender[21u32] r1.sender[22u32] r1.sender[23u32] r1.sender[24u32] r1.sender[25u32] r1.sender[26u32] r1.sender[27u32] r1.sender[28u32] r1.sender[29u32] r1.sender[30u32] r1.sender[31u32] r52[0u32] r52[1u32] r52[2u32] r52[3u32] r1.recipient[0u32] r1.recipient[1u32] r1.recipient[2u32] r1.recipient[3u32] r1.recipient[4u32] r1.recipient[5u32] r1.recipient[6u32] r1.recipient[7u32] r1.recipient[8u32] r1.recipient[9u32] r1.recipient[10u32] r1.recipient[11u32] r1.recipient[12u32] r1.recipient[13u32] r1.recipient[14u32] r1.recipient[15u32] r1.recipient[16u32] r1.recipient[17u32] r1.recipient[18u32] r1.recipient[19u32] r1.recipient[20u32] r1.recipient[21u32] r1.recipient[22u32] r1.recipient[23u32] r1.recipient[24u32] r1.recipient[25u32] r1.recipient[26u32] r1.recipient[27u32] r1.recipient[28u32] r1.recipient[29u32] r1.recipient[30u32] r1.recipient[31u32] r54[0u32] r54[1u32] r54[2u32] r54[3u32] r54[4u32] r54[5u32] r54[6u32] r54[7u32] r54[8u32] r54[9u32] r54[10u32] r54[11u32] r54[12u32] r54[13u32] r54[14u32] r54[15u32] r56[0u32] r56[1u32] r56[2u32] r56[3u32] r56[4u32] r56[5u32] r56[6u32] r56[7u32] r56[8u32] r56[9u32] r56[10u32] r56[11u32] r56[12u32] r56[13u32] r56[14u32] r56[15u32] r58[0u32] r58[1u32] r58[2u32] r58[3u32] r58[4u32] r58[5u32] r58[6u32] r58[7u32] r58[8u32] r58[9u32] r58[10u32] r58[11u32] r58[12u32] r58[13u32] r58[14u32] r58[15u32] r60[0u32] r60[1u32] r60[2u32] r60[3u32] r60[4u32] r60[5u32] r60[6u32] r60[7u32] r60[8u32] r60[9u32] r60[10u32] r60[11u32] r60[12u32] r60[13u32] r60[14u32] r60[15u32] r62[0u32] r62[1u32] r62[2u32] r62[3u32] r62[4u32] r62[5u32] r62[6u32] r62[7u32] r62[8u32] r62[9u32] r62[10u32] r62[11u32] r62[12u32] r62[13u32] r62[14u32] r62[15u32] r64[0u32] r64[1u32] r64[2u32] r64[3u32] r64[4u32] r64[5u32] r64[6u32] r64[7u32] r64[8u32] r64[9u32] r64[10u32] r64[11u32] r64[12u32] r64[13u32] r64[14u32] r64[15u32] r66[0u32] r66[1u32] r66[2u32] r66[3u32] r66[4u32] r66[5u32] r66[6u32] r66[7u32] r66[8u32] r66[9u32] r66[10u32] r66[11u32] r66[12u32] r66[13u32] r66[14u32] r66[15u32] r68[0u32] r68[1u32] r68[2u32] r68[3u32] r68[4u32] r68[5u32] r68[6u32] r68[7u32] r68[8u32] r68[9u32] r68[10u32] r68[11u32] r68[12u32] r68[13u32] r68[14u32] r68[15u32] r70[0u32] r70[1u32] r70[2u32] r70[3u32] r70[4u32] r70[5u32] r70[6u32] r70[7u32] r70[8u32] r70[9u32] r70[10u32] r70[11u32] r70[12u32] r70[13u32] r70[14u32] r70[15u32] r72[0u32] r72[1u32] r72[2u32] r72[3u32] r72[4u32] r72[5u32] r72[6u32] r72[7u32] r72[8u32] r72[9u32] r72[10u32] r72[11u32] r72[12u32] r72[13u32] r72[14u32] r72[15u32] r74[0u32] r74[1u32] r74[2u32] r74[3u32] r74[4u32] r74[5u32] r74[6u32] r74[7u32] r74[8u32] r74[9u32] r74[10u32] r74[11u32] r74[12u32] r74[13u32] r74[14u32] r74[15u32] r76[0u32] r76[1u32] r76[2u32] r76[3u32] r76[4u32] r76[5u32] r76[6u32] r76[7u32] r76[8u32] r76[9u32] r76[10u32] r76[11u32] r76[12u32] r76[13u32] r76[14u32] r76[15u32] r78[0u32] r78[1u32] r78[2u32] r78[3u32] r78[4u32] r78[5u32] r78[6u32] r78[7u32] r78[8u32] r78[9u32] r78[10u32] r78[11u32] r78[12u32] r78[13u32] r78[14u32] r78[15u32] r80[0u32] r80[1u32] r80[2u32] r80[3u32] r80[4u32] r80[5u32] r80[6u32] r80[7u32] r80[8u32] r80[9u32] r80[10u32] r80[11u32] r80[12u32] r80[13u32] r80[14u32] r80[15u32] r82[0u32] r82[1u32] r82[2u32] r82[3u32] r82[4u32] r82[5u32] r82[6u32] r82[7u32] r82[8u32] r82[9u32] r82[10u32] r82[11u32] r82[12u32] r82[13u32] r82[14u32] r82[15u32] r84[0u32] r84[1u32] r84[2u32] r84[3u32] r84[4u32] r84[5u32] r84[6u32] r84[7u32] r84[8u32] r84[9u32] r84[10u32] r84[11u32] r84[12u32] r84[13u32] r84[14u32] r84[15u32] into r85 as [u8; 333u32];
    is.eq r2 77u32 into r86;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] into r87 as [u8; 77u32];
    hash.keccak256.native.raw r87 into r88 as [boolean; 256u32];
    deserialize.bits.raw r88 ([boolean; 256u32]) into r89 ([u128; 2u32]);
    is.eq r2 93u32 into r90;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] into r91 as [u8; 93u32];
    hash.keccak256.native.raw r91 into r92 as [boolean; 256u32];
    deserialize.bits.raw r92 ([boolean; 256u32]) into r93 ([u128; 2u32]);
    is.eq r2 109u32 into r94;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] into r95 as [u8; 109u32];
    hash.keccak256.native.raw r95 into r96 as [boolean; 256u32];
    deserialize.bits.raw r96 ([boolean; 256u32]) into r97 ([u128; 2u32]);
    is.eq r2 125u32 into r98;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] into r99 as [u8; 125u32];
    hash.keccak256.native.raw r99 into r100 as [boolean; 256u32];
    deserialize.bits.raw r100 ([boolean; 256u32]) into r101 ([u128; 2u32]);
    is.eq r2 141u32 into r102;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] into r103 as [u8; 141u32];
    hash.keccak256.native.raw r103 into r104 as [boolean; 256u32];
    deserialize.bits.raw r104 ([boolean; 256u32]) into r105 ([u128; 2u32]);
    is.eq r2 157u32 into r106;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] r85[149u32] r85[150u32] r85[151u32] r85[152u32] r85[153u32] r85[154u32] r85[155u32] r85[156u32] into r107 as [u8; 157u32];
    hash.keccak256.native.raw r107 into r108 as [boolean; 256u32];
    deserialize.bits.raw r108 ([boolean; 256u32]) into r109 ([u128; 2u32]);
    is.eq r2 173u32 into r110;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] r85[149u32] r85[150u32] r85[151u32] r85[152u32] r85[153u32] r85[154u32] r85[155u32] r85[156u32] r85[157u32] r85[158u32] r85[159u32] r85[160u32] r85[161u32] r85[162u32] r85[163u32] r85[164u32] r85[165u32] r85[166u32] r85[167u32] r85[168u32] r85[169u32] r85[170u32] r85[171u32] r85[172u32] into r111 as [u8; 173u32];
    hash.keccak256.native.raw r111 into r112 as [boolean; 256u32];
    deserialize.bits.raw r112 ([boolean; 256u32]) into r113 ([u128; 2u32]);
    is.eq r2 189u32 into r114;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] r85[149u32] r85[150u32] r85[151u32] r85[152u32] r85[153u32] r85[154u32] r85[155u32] r85[156u32] r85[157u32] r85[158u32] r85[159u32] r85[160u32] r85[161u32] r85[162u32] r85[163u32] r85[164u32] r85[165u32] r85[166u32] r85[167u32] r85[168u32] r85[169u32] r85[170u32] r85[171u32] r85[172u32] r85[173u32] r85[174u32] r85[175u32] r85[176u32] r85[177u32] r85[178u32] r85[179u32] r85[180u32] r85[181u32] r85[182u32] r85[183u32] r85[184u32] r85[185u32] r85[186u32] r85[187u32] r85[188u32] into r115 as [u8; 189u32];
    hash.keccak256.native.raw r115 into r116 as [boolean; 256u32];
    deserialize.bits.raw r116 ([boolean; 256u32]) into r117 ([u128; 2u32]);
    is.eq r2 205u32 into r118;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] r85[149u32] r85[150u32] r85[151u32] r85[152u32] r85[153u32] r85[154u32] r85[155u32] r85[156u32] r85[157u32] r85[158u32] r85[159u32] r85[160u32] r85[161u32] r85[162u32] r85[163u32] r85[164u32] r85[165u32] r85[166u32] r85[167u32] r85[168u32] r85[169u32] r85[170u32] r85[171u32] r85[172u32] r85[173u32] r85[174u32] r85[175u32] r85[176u32] r85[177u32] r85[178u32] r85[179u32] r85[180u32] r85[181u32] r85[182u32] r85[183u32] r85[184u32] r85[185u32] r85[186u32] r85[187u32] r85[188u32] r85[189u32] r85[190u32] r85[191u32] r85[192u32] r85[193u32] r85[194u32] r85[195u32] r85[196u32] r85[197u32] r85[198u32] r85[199u32] r85[200u32] r85[201u32] r85[202u32] r85[203u32] r85[204u32] into r119 as [u8; 205u32];
    hash.keccak256.native.raw r119 into r120 as [boolean; 256u32];
    deserialize.bits.raw r120 ([boolean; 256u32]) into r121 ([u128; 2u32]);
    is.eq r2 221u32 into r122;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] r85[149u32] r85[150u32] r85[151u32] r85[152u32] r85[153u32] r85[154u32] r85[155u32] r85[156u32] r85[157u32] r85[158u32] r85[159u32] r85[160u32] r85[161u32] r85[162u32] r85[163u32] r85[164u32] r85[165u32] r85[166u32] r85[167u32] r85[168u32] r85[169u32] r85[170u32] r85[171u32] r85[172u32] r85[173u32] r85[174u32] r85[175u32] r85[176u32] r85[177u32] r85[178u32] r85[179u32] r85[180u32] r85[181u32] r85[182u32] r85[183u32] r85[184u32] r85[185u32] r85[186u32] r85[187u32] r85[188u32] r85[189u32] r85[190u32] r85[191u32] r85[192u32] r85[193u32] r85[194u32] r85[195u32] r85[196u32] r85[197u32] r85[198u32] r85[199u32] r85[200u32] r85[201u32] r85[202u32] r85[203u32] r85[204u32] r85[205u32] r85[206u32] r85[207u32] r85[208u32] r85[209u32] r85[210u32] r85[211u32] r85[212u32] r85[213u32] r85[214u32] r85[215u32] r85[216u32] r85[217u32] r85[218u32] r85[219u32] r85[220u32] into r123 as [u8; 221u32];
    hash.keccak256.native.raw r123 into r124 as [boolean; 256u32];
    deserialize.bits.raw r124 ([boolean; 256u32]) into r125 ([u128; 2u32]);
    is.eq r2 237u32 into r126;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] r85[149u32] r85[150u32] r85[151u32] r85[152u32] r85[153u32] r85[154u32] r85[155u32] r85[156u32] r85[157u32] r85[158u32] r85[159u32] r85[160u32] r85[161u32] r85[162u32] r85[163u32] r85[164u32] r85[165u32] r85[166u32] r85[167u32] r85[168u32] r85[169u32] r85[170u32] r85[171u32] r85[172u32] r85[173u32] r85[174u32] r85[175u32] r85[176u32] r85[177u32] r85[178u32] r85[179u32] r85[180u32] r85[181u32] r85[182u32] r85[183u32] r85[184u32] r85[185u32] r85[186u32] r85[187u32] r85[188u32] r85[189u32] r85[190u32] r85[191u32] r85[192u32] r85[193u32] r85[194u32] r85[195u32] r85[196u32] r85[197u32] r85[198u32] r85[199u32] r85[200u32] r85[201u32] r85[202u32] r85[203u32] r85[204u32] r85[205u32] r85[206u32] r85[207u32] r85[208u32] r85[209u32] r85[210u32] r85[211u32] r85[212u32] r85[213u32] r85[214u32] r85[215u32] r85[216u32] r85[217u32] r85[218u32] r85[219u32] r85[220u32] r85[221u32] r85[222u32] r85[223u32] r85[224u32] r85[225u32] r85[226u32] r85[227u32] r85[228u32] r85[229u32] r85[230u32] r85[231u32] r85[232u32] r85[233u32] r85[234u32] r85[235u32] r85[236u32] into r127 as [u8; 237u32];
    hash.keccak256.native.raw r127 into r128 as [boolean; 256u32];
    deserialize.bits.raw r128 ([boolean; 256u32]) into r129 ([u128; 2u32]);
    is.eq r2 253u32 into r130;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] r85[149u32] r85[150u32] r85[151u32] r85[152u32] r85[153u32] r85[154u32] r85[155u32] r85[156u32] r85[157u32] r85[158u32] r85[159u32] r85[160u32] r85[161u32] r85[162u32] r85[163u32] r85[164u32] r85[165u32] r85[166u32] r85[167u32] r85[168u32] r85[169u32] r85[170u32] r85[171u32] r85[172u32] r85[173u32] r85[174u32] r85[175u32] r85[176u32] r85[177u32] r85[178u32] r85[179u32] r85[180u32] r85[181u32] r85[182u32] r85[183u32] r85[184u32] r85[185u32] r85[186u32] r85[187u32] r85[188u32] r85[189u32] r85[190u32] r85[191u32] r85[192u32] r85[193u32] r85[194u32] r85[195u32] r85[196u32] r85[197u32] r85[198u32] r85[199u32] r85[200u32] r85[201u32] r85[202u32] r85[203u32] r85[204u32] r85[205u32] r85[206u32] r85[207u32] r85[208u32] r85[209u32] r85[210u32] r85[211u32] r85[212u32] r85[213u32] r85[214u32] r85[215u32] r85[216u32] r85[217u32] r85[218u32] r85[219u32] r85[220u32] r85[221u32] r85[222u32] r85[223u32] r85[224u32] r85[225u32] r85[226u32] r85[227u32] r85[228u32] r85[229u32] r85[230u32] r85[231u32] r85[232u32] r85[233u32] r85[234u32] r85[235u32] r85[236u32] r85[237u32] r85[238u32] r85[239u32] r85[240u32] r85[241u32] r85[242u32] r85[243u32] r85[244u32] r85[245u32] r85[246u32] r85[247u32] r85[248u32] r85[249u32] r85[250u32] r85[251u32] r85[252u32] into r131 as [u8; 253u32];
    hash.keccak256.native.raw r131 into r132 as [boolean; 256u32];
    deserialize.bits.raw r132 ([boolean; 256u32]) into r133 ([u128; 2u32]);
    is.eq r2 269u32 into r134;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] r85[149u32] r85[150u32] r85[151u32] r85[152u32] r85[153u32] r85[154u32] r85[155u32] r85[156u32] r85[157u32] r85[158u32] r85[159u32] r85[160u32] r85[161u32] r85[162u32] r85[163u32] r85[164u32] r85[165u32] r85[166u32] r85[167u32] r85[168u32] r85[169u32] r85[170u32] r85[171u32] r85[172u32] r85[173u32] r85[174u32] r85[175u32] r85[176u32] r85[177u32] r85[178u32] r85[179u32] r85[180u32] r85[181u32] r85[182u32] r85[183u32] r85[184u32] r85[185u32] r85[186u32] r85[187u32] r85[188u32] r85[189u32] r85[190u32] r85[191u32] r85[192u32] r85[193u32] r85[194u32] r85[195u32] r85[196u32] r85[197u32] r85[198u32] r85[199u32] r85[200u32] r85[201u32] r85[202u32] r85[203u32] r85[204u32] r85[205u32] r85[206u32] r85[207u32] r85[208u32] r85[209u32] r85[210u32] r85[211u32] r85[212u32] r85[213u32] r85[214u32] r85[215u32] r85[216u32] r85[217u32] r85[218u32] r85[219u32] r85[220u32] r85[221u32] r85[222u32] r85[223u32] r85[224u32] r85[225u32] r85[226u32] r85[227u32] r85[228u32] r85[229u32] r85[230u32] r85[231u32] r85[232u32] r85[233u32] r85[234u32] r85[235u32] r85[236u32] r85[237u32] r85[238u32] r85[239u32] r85[240u32] r85[241u32] r85[242u32] r85[243u32] r85[244u32] r85[245u32] r85[246u32] r85[247u32] r85[248u32] r85[249u32] r85[250u32] r85[251u32] r85[252u32] r85[253u32] r85[254u32] r85[255u32] r85[256u32] r85[257u32] r85[258u32] r85[259u32] r85[260u32] r85[261u32] r85[262u32] r85[263u32] r85[264u32] r85[265u32] r85[266u32] r85[267u32] r85[268u32] into r135 as [u8; 269u32];
    hash.keccak256.native.raw r135 into r136 as [boolean; 256u32];
    deserialize.bits.raw r136 ([boolean; 256u32]) into r137 ([u128; 2u32]);
    is.eq r2 285u32 into r138;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] r85[149u32] r85[150u32] r85[151u32] r85[152u32] r85[153u32] r85[154u32] r85[155u32] r85[156u32] r85[157u32] r85[158u32] r85[159u32] r85[160u32] r85[161u32] r85[162u32] r85[163u32] r85[164u32] r85[165u32] r85[166u32] r85[167u32] r85[168u32] r85[169u32] r85[170u32] r85[171u32] r85[172u32] r85[173u32] r85[174u32] r85[175u32] r85[176u32] r85[177u32] r85[178u32] r85[179u32] r85[180u32] r85[181u32] r85[182u32] r85[183u32] r85[184u32] r85[185u32] r85[186u32] r85[187u32] r85[188u32] r85[189u32] r85[190u32] r85[191u32] r85[192u32] r85[193u32] r85[194u32] r85[195u32] r85[196u32] r85[197u32] r85[198u32] r85[199u32] r85[200u32] r85[201u32] r85[202u32] r85[203u32] r85[204u32] r85[205u32] r85[206u32] r85[207u32] r85[208u32] r85[209u32] r85[210u32] r85[211u32] r85[212u32] r85[213u32] r85[214u32] r85[215u32] r85[216u32] r85[217u32] r85[218u32] r85[219u32] r85[220u32] r85[221u32] r85[222u32] r85[223u32] r85[224u32] r85[225u32] r85[226u32] r85[227u32] r85[228u32] r85[229u32] r85[230u32] r85[231u32] r85[232u32] r85[233u32] r85[234u32] r85[235u32] r85[236u32] r85[237u32] r85[238u32] r85[239u32] r85[240u32] r85[241u32] r85[242u32] r85[243u32] r85[244u32] r85[245u32] r85[246u32] r85[247u32] r85[248u32] r85[249u32] r85[250u32] r85[251u32] r85[252u32] r85[253u32] r85[254u32] r85[255u32] r85[256u32] r85[257u32] r85[258u32] r85[259u32] r85[260u32] r85[261u32] r85[262u32] r85[263u32] r85[264u32] r85[265u32] r85[266u32] r85[267u32] r85[268u32] r85[269u32] r85[270u32] r85[271u32] r85[272u32] r85[273u32] r85[274u32] r85[275u32] r85[276u32] r85[277u32] r85[278u32] r85[279u32] r85[280u32] r85[281u32] r85[282u32] r85[283u32] r85[284u32] into r139 as [u8; 285u32];
    hash.keccak256.native.raw r139 into r140 as [boolean; 256u32];
    deserialize.bits.raw r140 ([boolean; 256u32]) into r141 ([u128; 2u32]);
    is.eq r2 301u32 into r142;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] r85[149u32] r85[150u32] r85[151u32] r85[152u32] r85[153u32] r85[154u32] r85[155u32] r85[156u32] r85[157u32] r85[158u32] r85[159u32] r85[160u32] r85[161u32] r85[162u32] r85[163u32] r85[164u32] r85[165u32] r85[166u32] r85[167u32] r85[168u32] r85[169u32] r85[170u32] r85[171u32] r85[172u32] r85[173u32] r85[174u32] r85[175u32] r85[176u32] r85[177u32] r85[178u32] r85[179u32] r85[180u32] r85[181u32] r85[182u32] r85[183u32] r85[184u32] r85[185u32] r85[186u32] r85[187u32] r85[188u32] r85[189u32] r85[190u32] r85[191u32] r85[192u32] r85[193u32] r85[194u32] r85[195u32] r85[196u32] r85[197u32] r85[198u32] r85[199u32] r85[200u32] r85[201u32] r85[202u32] r85[203u32] r85[204u32] r85[205u32] r85[206u32] r85[207u32] r85[208u32] r85[209u32] r85[210u32] r85[211u32] r85[212u32] r85[213u32] r85[214u32] r85[215u32] r85[216u32] r85[217u32] r85[218u32] r85[219u32] r85[220u32] r85[221u32] r85[222u32] r85[223u32] r85[224u32] r85[225u32] r85[226u32] r85[227u32] r85[228u32] r85[229u32] r85[230u32] r85[231u32] r85[232u32] r85[233u32] r85[234u32] r85[235u32] r85[236u32] r85[237u32] r85[238u32] r85[239u32] r85[240u32] r85[241u32] r85[242u32] r85[243u32] r85[244u32] r85[245u32] r85[246u32] r85[247u32] r85[248u32] r85[249u32] r85[250u32] r85[251u32] r85[252u32] r85[253u32] r85[254u32] r85[255u32] r85[256u32] r85[257u32] r85[258u32] r85[259u32] r85[260u32] r85[261u32] r85[262u32] r85[263u32] r85[264u32] r85[265u32] r85[266u32] r85[267u32] r85[268u32] r85[269u32] r85[270u32] r85[271u32] r85[272u32] r85[273u32] r85[274u32] r85[275u32] r85[276u32] r85[277u32] r85[278u32] r85[279u32] r85[280u32] r85[281u32] r85[282u32] r85[283u32] r85[284u32] r85[285u32] r85[286u32] r85[287u32] r85[288u32] r85[289u32] r85[290u32] r85[291u32] r85[292u32] r85[293u32] r85[294u32] r85[295u32] r85[296u32] r85[297u32] r85[298u32] r85[299u32] r85[300u32] into r143 as [u8; 301u32];
    hash.keccak256.native.raw r143 into r144 as [boolean; 256u32];
    deserialize.bits.raw r144 ([boolean; 256u32]) into r145 ([u128; 2u32]);
    is.eq r2 317u32 into r146;
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] r85[149u32] r85[150u32] r85[151u32] r85[152u32] r85[153u32] r85[154u32] r85[155u32] r85[156u32] r85[157u32] r85[158u32] r85[159u32] r85[160u32] r85[161u32] r85[162u32] r85[163u32] r85[164u32] r85[165u32] r85[166u32] r85[167u32] r85[168u32] r85[169u32] r85[170u32] r85[171u32] r85[172u32] r85[173u32] r85[174u32] r85[175u32] r85[176u32] r85[177u32] r85[178u32] r85[179u32] r85[180u32] r85[181u32] r85[182u32] r85[183u32] r85[184u32] r85[185u32] r85[186u32] r85[187u32] r85[188u32] r85[189u32] r85[190u32] r85[191u32] r85[192u32] r85[193u32] r85[194u32] r85[195u32] r85[196u32] r85[197u32] r85[198u32] r85[199u32] r85[200u32] r85[201u32] r85[202u32] r85[203u32] r85[204u32] r85[205u32] r85[206u32] r85[207u32] r85[208u32] r85[209u32] r85[210u32] r85[211u32] r85[212u32] r85[213u32] r85[214u32] r85[215u32] r85[216u32] r85[217u32] r85[218u32] r85[219u32] r85[220u32] r85[221u32] r85[222u32] r85[223u32] r85[224u32] r85[225u32] r85[226u32] r85[227u32] r85[228u32] r85[229u32] r85[230u32] r85[231u32] r85[232u32] r85[233u32] r85[234u32] r85[235u32] r85[236u32] r85[237u32] r85[238u32] r85[239u32] r85[240u32] r85[241u32] r85[242u32] r85[243u32] r85[244u32] r85[245u32] r85[246u32] r85[247u32] r85[248u32] r85[249u32] r85[250u32] r85[251u32] r85[252u32] r85[253u32] r85[254u32] r85[255u32] r85[256u32] r85[257u32] r85[258u32] r85[259u32] r85[260u32] r85[261u32] r85[262u32] r85[263u32] r85[264u32] r85[265u32] r85[266u32] r85[267u32] r85[268u32] r85[269u32] r85[270u32] r85[271u32] r85[272u32] r85[273u32] r85[274u32] r85[275u32] r85[276u32] r85[277u32] r85[278u32] r85[279u32] r85[280u32] r85[281u32] r85[282u32] r85[283u32] r85[284u32] r85[285u32] r85[286u32] r85[287u32] r85[288u32] r85[289u32] r85[290u32] r85[291u32] r85[292u32] r85[293u32] r85[294u32] r85[295u32] r85[296u32] r85[297u32] r85[298u32] r85[299u32] r85[300u32] r85[301u32] r85[302u32] r85[303u32] r85[304u32] r85[305u32] r85[306u32] r85[307u32] r85[308u32] r85[309u32] r85[310u32] r85[311u32] r85[312u32] r85[313u32] r85[314u32] r85[315u32] r85[316u32] into r147 as [u8; 317u32];
    hash.keccak256.native.raw r147 into r148 as [boolean; 256u32];
    deserialize.bits.raw r148 ([boolean; 256u32]) into r149 ([u128; 2u32]);
    is.eq r2 333u32 into r150;
    hash.keccak256.native.raw r85 into r151 as [boolean; 256u32];
    deserialize.bits.raw r151 ([boolean; 256u32]) into r152 ([u128; 2u32]);
    ternary r150 r152[0u32] r19[0u32] into r153;
    ternary r150 r152[1u32] r19[1u32] into r154;
    cast r153 r154 into r155 as [u128; 2u32];
    ternary r146 r149[0u32] r155[0u32] into r156;
    ternary r146 r149[1u32] r155[1u32] into r157;
    cast r156 r157 into r158 as [u128; 2u32];
    ternary r142 r145[0u32] r158[0u32] into r159;
    ternary r142 r145[1u32] r158[1u32] into r160;
    cast r159 r160 into r161 as [u128; 2u32];
    ternary r138 r141[0u32] r161[0u32] into r162;
    ternary r138 r141[1u32] r161[1u32] into r163;
    cast r162 r163 into r164 as [u128; 2u32];
    ternary r134 r137[0u32] r164[0u32] into r165;
    ternary r134 r137[1u32] r164[1u32] into r166;
    cast r165 r166 into r167 as [u128; 2u32];
    ternary r130 r133[0u32] r167[0u32] into r168;
    ternary r130 r133[1u32] r167[1u32] into r169;
    cast r168 r169 into r170 as [u128; 2u32];
    ternary r126 r129[0u32] r170[0u32] into r171;
    ternary r126 r129[1u32] r170[1u32] into r172;
    cast r171 r172 into r173 as [u128; 2u32];
    ternary r122 r125[0u32] r173[0u32] into r174;
    ternary r122 r125[1u32] r173[1u32] into r175;
    cast r174 r175 into r176 as [u128; 2u32];
    ternary r118 r121[0u32] r176[0u32] into r177;
    ternary r118 r121[1u32] r176[1u32] into r178;
    cast r177 r178 into r179 as [u128; 2u32];
    ternary r114 r117[0u32] r179[0u32] into r180;
    ternary r114 r117[1u32] r179[1u32] into r181;
    cast r180 r181 into r182 as [u128; 2u32];
    ternary r110 r113[0u32] r182[0u32] into r183;
    ternary r110 r113[1u32] r182[1u32] into r184;
    cast r183 r184 into r185 as [u128; 2u32];
    ternary r106 r109[0u32] r185[0u32] into r186;
    ternary r106 r109[1u32] r185[1u32] into r187;
    cast r186 r187 into r188 as [u128; 2u32];
    ternary r102 r105[0u32] r188[0u32] into r189;
    ternary r102 r105[1u32] r188[1u32] into r190;
    cast r189 r190 into r191 as [u128; 2u32];
    ternary r98 r101[0u32] r191[0u32] into r192;
    ternary r98 r101[1u32] r191[1u32] into r193;
    cast r192 r193 into r194 as [u128; 2u32];
    ternary r94 r97[0u32] r194[0u32] into r195;
    ternary r94 r97[1u32] r194[1u32] into r196;
    cast r195 r196 into r197 as [u128; 2u32];
    ternary r90 r93[0u32] r197[0u32] into r198;
    ternary r90 r93[1u32] r197[1u32] into r199;
    cast r198 r199 into r200 as [u128; 2u32];
    ternary r86 r89[0u32] r200[0u32] into r201;
    ternary r86 r89[1u32] r200[1u32] into r202;
    cast r201 r202 into r203 as [u128; 2u32];
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] r85[149u32] r85[150u32] r85[151u32] r85[152u32] r85[153u32] r85[154u32] r85[155u32] r85[156u32] r85[157u32] r85[158u32] r85[159u32] r85[160u32] r85[161u32] r85[162u32] r85[163u32] r85[164u32] r85[165u32] r85[166u32] r85[167u32] r85[168u32] r85[169u32] r85[170u32] r85[171u32] r85[172u32] r85[173u32] r85[174u32] r85[175u32] r85[176u32] r85[177u32] r85[178u32] r85[179u32] r85[180u32] r85[181u32] r85[182u32] r85[183u32] r85[184u32] r85[185u32] r85[186u32] r85[187u32] r85[188u32] r85[189u32] r85[190u32] r85[191u32] r85[192u32] r85[193u32] r85[194u32] r85[195u32] r85[196u32] r85[197u32] r85[198u32] r85[199u32] r85[200u32] r85[201u32] r85[202u32] r85[203u32] r85[204u32] r85[205u32] into r204 as [u8; 206u32];
    hash.keccak256.native.raw r204 into r205 as [boolean; 256u32];
    deserialize.bits.raw r205 ([boolean; 256u32]) into r206 ([u128; 2u32]);
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] into r207 as [u8; 149u32];
    hash.keccak256.native.raw r207 into r208 as [boolean; 256u32];
    deserialize.bits.raw r208 ([boolean; 256u32]) into r209 ([u128; 2u32]);
    cast r85[0u32] r85[1u32] r85[2u32] r85[3u32] r85[4u32] r85[5u32] r85[6u32] r85[7u32] r85[8u32] r85[9u32] r85[10u32] r85[11u32] r85[12u32] r85[13u32] r85[14u32] r85[15u32] r85[16u32] r85[17u32] r85[18u32] r85[19u32] r85[20u32] r85[21u32] r85[22u32] r85[23u32] r85[24u32] r85[25u32] r85[26u32] r85[27u32] r85[28u32] r85[29u32] r85[30u32] r85[31u32] r85[32u32] r85[33u32] r85[34u32] r85[35u32] r85[36u32] r85[37u32] r85[38u32] r85[39u32] r85[40u32] r85[41u32] r85[42u32] r85[43u32] r85[44u32] r85[45u32] r85[46u32] r85[47u32] r85[48u32] r85[49u32] r85[50u32] r85[51u32] r85[52u32] r85[53u32] r85[54u32] r85[55u32] r85[56u32] r85[57u32] r85[58u32] r85[59u32] r85[60u32] r85[61u32] r85[62u32] r85[63u32] r85[64u32] r85[65u32] r85[66u32] r85[67u32] r85[68u32] r85[69u32] r85[70u32] r85[71u32] r85[72u32] r85[73u32] r85[74u32] r85[75u32] r85[76u32] r85[77u32] r85[78u32] r85[79u32] r85[80u32] r85[81u32] r85[82u32] r85[83u32] r85[84u32] r85[85u32] r85[86u32] r85[87u32] r85[88u32] r85[89u32] r85[90u32] r85[91u32] r85[92u32] r85[93u32] r85[94u32] r85[95u32] r85[96u32] r85[97u32] r85[98u32] r85[99u32] r85[100u32] r85[101u32] r85[102u32] r85[103u32] r85[104u32] r85[105u32] r85[106u32] r85[107u32] r85[108u32] r85[109u32] r85[110u32] r85[111u32] r85[112u32] r85[113u32] r85[114u32] r85[115u32] r85[116u32] r85[117u32] r85[118u32] r85[119u32] r85[120u32] r85[121u32] r85[122u32] r85[123u32] r85[124u32] r85[125u32] r85[126u32] r85[127u32] r85[128u32] r85[129u32] r85[130u32] r85[131u32] r85[132u32] r85[133u32] r85[134u32] r85[135u32] r85[136u32] r85[137u32] r85[138u32] r85[139u32] r85[140u32] r85[141u32] r85[142u32] r85[143u32] r85[144u32] r85[145u32] r85[146u32] r85[147u32] r85[148u32] r85[149u32] r85[150u32] r85[151u32] r85[152u32] r85[153u32] r85[154u32] r85[155u32] r85[156u32] r85[157u32] r85[158u32] r85[159u32] r85[160u32] r85[161u32] r85[162u32] r85[163u32] r85[164u32] r85[165u32] r85[166u32] into r210 as [u8; 167u32];
    hash.keccak256.native.raw r210 into r211 as [boolean; 256u32];
    deserialize.bits.raw r211 ([boolean; 256u32]) into r212 ([u128; 2u32]);
    ternary r17 r212[0u32] r203[0u32] into r213;
    ternary r17 r212[1u32] r203[1u32] into r214;
    cast r213 r214 into r215 as [u128; 2u32];
    ternary r15 r209[0u32] r215[0u32] into r216;
    ternary r15 r209[1u32] r215[1u32] into r217;
    cast r216 r217 into r218 as [u128; 2u32];
    ternary r13 r206[0u32] r218[0u32] into r219;
    ternary r13 r206[1u32] r218[1u32] into r220;
    cast r219 r220 into r221 as [u128; 2u32];
    assert.eq r221 r3;
    get mailbox[true] into r222;
    await r5;
    serialize.bits.raw r4 (address) into r223 ([boolean; 253u32]);
    cast false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false into r224 as [boolean; 256u32];
    cast r223[0u32] r223[1u32] r223[2u32] r223[3u32] r223[4u32] r223[5u32] r223[6u32] r223[7u32] r223[8u32] r223[9u32] r223[10u32] r223[11u32] r223[12u32] r223[13u32] r223[14u32] r223[15u32] r223[16u32] r223[17u32] r223[18u32] r223[19u32] r223[20u32] r223[21u32] r223[22u32] r223[23u32] r223[24u32] r223[25u32] r223[26u32] r223[27u32] r223[28u32] r223[29u32] r223[30u32] r223[31u32] r223[32u32] r223[33u32] r223[34u32] r223[35u32] r223[36u32] r223[37u32] r223[38u32] r223[39u32] r223[40u32] r223[41u32] r223[42u32] r223[43u32] r223[44u32] r223[45u32] r223[46u32] r223[47u32] r223[48u32] r223[49u32] r223[50u32] r223[51u32] r223[52u32] r223[53u32] r223[54u32] r223[55u32] r223[56u32] r223[57u32] r223[58u32] r223[59u32] r223[60u32] r223[61u32] r223[62u32] r223[63u32] r223[64u32] r223[65u32] r223[66u32] r223[67u32] r223[68u32] r223[69u32] r223[70u32] r223[71u32] r223[72u32] r223[73u32] r223[74u32] r223[75u32] r223[76u32] r223[77u32] r223[78u32] r223[79u32] r223[80u32] r223[81u32] r223[82u32] r223[83u32] r223[84u32] r223[85u32] r223[86u32] r223[87u32] r223[88u32] r223[89u32] r223[90u32] r223[91u32] r223[92u32] r223[93u32] r223[94u32] r223[95u32] r223[96u32] r223[97u32] r223[98u32] r223[99u32] r223[100u32] r223[101u32] r223[102u32] r223[103u32] r223[104u32] r223[105u32] r223[106u32] r223[107u32] r223[108u32] r223[109u32] r223[110u32] r223[111u32] r223[112u32] r223[113u32] r223[114u32] r223[115u32] r223[116u32] r223[117u32] r223[118u32] r223[119u32] r223[120u32] r223[121u32] r223[122u32] r223[123u32] r223[124u32] r223[125u32] r223[126u32] r223[127u32] r223[128u32] r223[129u32] r223[130u32] r223[131u32] r223[132u32] r223[133u32] r223[134u32] r223[135u32] r223[136u32] r223[137u32] r223[138u32] r223[139u32] r223[140u32] r223[141u32] r223[142u32] r223[143u32] r223[144u32] r223[145u32] r223[146u32] r223[147u32] r223[148u32] r223[149u32] r223[150u32] r223[151u32] r223[152u32] r223[153u32] r223[154u32] r223[155u32] r223[156u32] r223[157u32] r223[158u32] r223[159u32] r223[160u32] r223[161u32] r223[162u32] r223[163u32] r223[164u32] r223[165u32] r223[166u32] r223[167u32] r223[168u32] r223[169u32] r223[170u32] r223[171u32] r223[172u32] r223[173u32] r223[174u32] r223[175u32] r223[176u32] r223[177u32] r223[178u32] r223[179u32] r223[180u32] r223[181u32] r223[182u32] r223[183u32] r223[184u32] r223[185u32] r223[186u32] r223[187u32] r223[188u32] r223[189u32] r223[190u32] r223[191u32] r223[192u32] r223[193u32] r223[194u32] r223[195u32] r223[196u32] r223[197u32] r223[198u32] r223[199u32] r223[200u32] r223[201u32] r223[202u32] r223[203u32] r223[204u32] r223[205u32] r223[206u32] r223[207u32] r223[208u32] r223[209u32] r223[210u32] r223[211u32] r223[212u32] r223[213u32] r223[214u32] r223[215u32] r223[216u32] r223[217u32] r223[218u32] r223[219u32] r223[220u32] r223[221u32] r223[222u32] r223[223u32] r223[224u32] r223[225u32] r223[226u32] r223[227u32] r223[228u32] r223[229u32] r223[230u32] r223[231u32] r223[232u32] r223[233u32] r223[234u32] r223[235u32] r223[236u32] r223[237u32] r223[238u32] r223[239u32] r223[240u32] r223[241u32] r223[242u32] r223[243u32] r223[244u32] r223[245u32] r223[246u32] r223[247u32] r223[248u32] r223[249u32] r223[250u32] r223[251u32] r223[252u32] r224[253u32] r224[254u32] r224[255u32] into r225 as [boolean; 256u32];
    deserialize.bits.raw r225 ([boolean; 256u32]) into r226 ([u8; 32u32]);
    assert.eq r1.recipient r226;
    assert.eq r1.version 3u8;
    assert.eq r1.destination_domain r222.local_domain;
    cast r3 into r227 as DeliveryKey;
    contains deliveries[r227] into r228;
    not r228 into r229;
    assert.eq r229 true;
    cast r4 block.height into r230 as Delivery;
    set r230 into deliveries[r227];
    set r3 into process_events[r222.process_count];
    set r222.process_count into process_event_index[block.height];
    add r222.process_count 1u32 into r231;
    cast r222.local_domain r222.nonce r231 r222.default_ism r222.default_hook r222.required_hook r222.dispatch_proxy r222.mailbox_owner into r232 as Mailbox;
    set r232 into mailbox[true];

function dispatch:
    input r0 as u32.public;
    input r1 as [u8; 32u32].public;
    input r2 as [u128; 16u32].public;
    input r3 as address.public;
    async dispatch r0 r1 r2 r3 self.caller into r4;
    output r4 as mailbox.aleo/dispatch.future;

finalize dispatch:
    input r0 as u32.public;
    input r1 as [u8; 32u32].public;
    input r2 as [u128; 16u32].public;
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
    serialize.bits.raw r11.body[8u32] (u128) into r61 ([boolean; 128u32]);
    deserialize.bits.raw r61 ([boolean; 128u32]) into r62 ([u8; 16u32]);
    serialize.bits.raw r11.body[9u32] (u128) into r63 ([boolean; 128u32]);
    deserialize.bits.raw r63 ([boolean; 128u32]) into r64 ([u8; 16u32]);
    serialize.bits.raw r11.body[10u32] (u128) into r65 ([boolean; 128u32]);
    deserialize.bits.raw r65 ([boolean; 128u32]) into r66 ([u8; 16u32]);
    serialize.bits.raw r11.body[11u32] (u128) into r67 ([boolean; 128u32]);
    deserialize.bits.raw r67 ([boolean; 128u32]) into r68 ([u8; 16u32]);
    serialize.bits.raw r11.body[12u32] (u128) into r69 ([boolean; 128u32]);
    deserialize.bits.raw r69 ([boolean; 128u32]) into r70 ([u8; 16u32]);
    serialize.bits.raw r11.body[13u32] (u128) into r71 ([boolean; 128u32]);
    deserialize.bits.raw r71 ([boolean; 128u32]) into r72 ([u8; 16u32]);
    serialize.bits.raw r11.body[14u32] (u128) into r73 ([boolean; 128u32]);
    deserialize.bits.raw r73 ([boolean; 128u32]) into r74 ([u8; 16u32]);
    serialize.bits.raw r11.body[15u32] (u128) into r75 ([boolean; 128u32]);
    deserialize.bits.raw r75 ([boolean; 128u32]) into r76 ([u8; 16u32]);
    cast r11.version r22[0u32] r22[1u32] r22[2u32] r22[3u32] r33[0u32] r33[1u32] r33[2u32] r33[3u32] r11.sender[0u32] r11.sender[1u32] r11.sender[2u32] r11.sender[3u32] r11.sender[4u32] r11.sender[5u32] r11.sender[6u32] r11.sender[7u32] r11.sender[8u32] r11.sender[9u32] r11.sender[10u32] r11.sender[11u32] r11.sender[12u32] r11.sender[13u32] r11.sender[14u32] r11.sender[15u32] r11.sender[16u32] r11.sender[17u32] r11.sender[18u32] r11.sender[19u32] r11.sender[20u32] r11.sender[21u32] r11.sender[22u32] r11.sender[23u32] r11.sender[24u32] r11.sender[25u32] r11.sender[26u32] r11.sender[27u32] r11.sender[28u32] r11.sender[29u32] r11.sender[30u32] r11.sender[31u32] r44[0u32] r44[1u32] r44[2u32] r44[3u32] r11.recipient[0u32] r11.recipient[1u32] r11.recipient[2u32] r11.recipient[3u32] r11.recipient[4u32] r11.recipient[5u32] r11.recipient[6u32] r11.recipient[7u32] r11.recipient[8u32] r11.recipient[9u32] r11.recipient[10u32] r11.recipient[11u32] r11.recipient[12u32] r11.recipient[13u32] r11.recipient[14u32] r11.recipient[15u32] r11.recipient[16u32] r11.recipient[17u32] r11.recipient[18u32] r11.recipient[19u32] r11.recipient[20u32] r11.recipient[21u32] r11.recipient[22u32] r11.recipient[23u32] r11.recipient[24u32] r11.recipient[25u32] r11.recipient[26u32] r11.recipient[27u32] r11.recipient[28u32] r11.recipient[29u32] r11.recipient[30u32] r11.recipient[31u32] r46[0u32] r46[1u32] r46[2u32] r46[3u32] r46[4u32] r46[5u32] r46[6u32] r46[7u32] r46[8u32] r46[9u32] r46[10u32] r46[11u32] r46[12u32] r46[13u32] r46[14u32] r46[15u32] r48[0u32] r48[1u32] r48[2u32] r48[3u32] r48[4u32] r48[5u32] r48[6u32] r48[7u32] r48[8u32] r48[9u32] r48[10u32] r48[11u32] r48[12u32] r48[13u32] r48[14u32] r48[15u32] r50[0u32] r50[1u32] r50[2u32] r50[3u32] r50[4u32] r50[5u32] r50[6u32] r50[7u32] r50[8u32] r50[9u32] r50[10u32] r50[11u32] r50[12u32] r50[13u32] r50[14u32] r50[15u32] r52[0u32] r52[1u32] r52[2u32] r52[3u32] r52[4u32] r52[5u32] r52[6u32] r52[7u32] r52[8u32] r52[9u32] r52[10u32] r52[11u32] r52[12u32] r52[13u32] r52[14u32] r52[15u32] r54[0u32] r54[1u32] r54[2u32] r54[3u32] r54[4u32] r54[5u32] r54[6u32] r54[7u32] r54[8u32] r54[9u32] r54[10u32] r54[11u32] r54[12u32] r54[13u32] r54[14u32] r54[15u32] r56[0u32] r56[1u32] r56[2u32] r56[3u32] r56[4u32] r56[5u32] r56[6u32] r56[7u32] r56[8u32] r56[9u32] r56[10u32] r56[11u32] r56[12u32] r56[13u32] r56[14u32] r56[15u32] r58[0u32] r58[1u32] r58[2u32] r58[3u32] r58[4u32] r58[5u32] r58[6u32] r58[7u32] r58[8u32] r58[9u32] r58[10u32] r58[11u32] r58[12u32] r58[13u32] r58[14u32] r58[15u32] r60[0u32] r60[1u32] r60[2u32] r60[3u32] r60[4u32] r60[5u32] r60[6u32] r60[7u32] r60[8u32] r60[9u32] r60[10u32] r60[11u32] r60[12u32] r60[13u32] r60[14u32] r60[15u32] r62[0u32] r62[1u32] r62[2u32] r62[3u32] r62[4u32] r62[5u32] r62[6u32] r62[7u32] r62[8u32] r62[9u32] r62[10u32] r62[11u32] r62[12u32] r62[13u32] r62[14u32] r62[15u32] r64[0u32] r64[1u32] r64[2u32] r64[3u32] r64[4u32] r64[5u32] r64[6u32] r64[7u32] r64[8u32] r64[9u32] r64[10u32] r64[11u32] r64[12u32] r64[13u32] r64[14u32] r64[15u32] r66[0u32] r66[1u32] r66[2u32] r66[3u32] r66[4u32] r66[5u32] r66[6u32] r66[7u32] r66[8u32] r66[9u32] r66[10u32] r66[11u32] r66[12u32] r66[13u32] r66[14u32] r66[15u32] r68[0u32] r68[1u32] r68[2u32] r68[3u32] r68[4u32] r68[5u32] r68[6u32] r68[7u32] r68[8u32] r68[9u32] r68[10u32] r68[11u32] r68[12u32] r68[13u32] r68[14u32] r68[15u32] r70[0u32] r70[1u32] r70[2u32] r70[3u32] r70[4u32] r70[5u32] r70[6u32] r70[7u32] r70[8u32] r70[9u32] r70[10u32] r70[11u32] r70[12u32] r70[13u32] r70[14u32] r70[15u32] r72[0u32] r72[1u32] r72[2u32] r72[3u32] r72[4u32] r72[5u32] r72[6u32] r72[7u32] r72[8u32] r72[9u32] r72[10u32] r72[11u32] r72[12u32] r72[13u32] r72[14u32] r72[15u32] r74[0u32] r74[1u32] r74[2u32] r74[3u32] r74[4u32] r74[5u32] r74[6u32] r74[7u32] r74[8u32] r74[9u32] r74[10u32] r74[11u32] r74[12u32] r74[13u32] r74[14u32] r74[15u32] r76[0u32] r76[1u32] r76[2u32] r76[3u32] r76[4u32] r76[5u32] r76[6u32] r76[7u32] r76[8u32] r76[9u32] r76[10u32] r76[11u32] r76[12u32] r76[13u32] r76[14u32] r76[15u32] into r77 as [u8; 333u32];
    hash.keccak256.native.raw r77 into r78 as [boolean; 256u32];
    deserialize.bits.raw r78 ([boolean; 256u32]) into r79 ([u128; 2u32]);
    set r11 into dispatch_events[r6.nonce];
    set r79 into dispatch_id_events[r6.nonce];
    set r6.nonce into dispatch_event_index[block.height];
    add r6.nonce 1u32 into r80;
    cast r6.local_domain r80 r6.process_count r6.default_ism r6.default_hook r6.required_hook r6.dispatch_proxy r6.mailbox_owner into r81 as Mailbox;
    set r81 into mailbox[true];

constructor:
    assert.eq edition 0u16;
