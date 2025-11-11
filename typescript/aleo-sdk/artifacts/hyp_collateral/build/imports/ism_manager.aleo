program ism_manager.aleo;

struct Message:
    version as u8;
    nonce as u32;
    origin_domain as u32;
    sender as [u8; 32u32];
    destination_domain as u32;
    recipient as [u8; 32u32];
    body as [u128; 8u32];

struct EthAddress:
    bytes as [u8; 20u32];

struct MessageIdMultisigIsm:
    validators as [EthAddress; 6u32];
    validator_count as u8;
    threshold as u8;
    nonce as u32;

struct DomainRoutingIsm:
    ism_owner as address;
    nonce as u32;

struct NoopIsm:
    nonce as u32;

struct IsmRouteKey:
    ism as address;
    domain as u32;

struct RouteIndexKey:
    ism as address;
    index as u32;

mapping nonce:
    key as boolean.public;
    value as u32.public;

mapping domain_routing_isms:
    key as address.public;
    value as DomainRoutingIsm.public;

mapping routes:
    key as IsmRouteKey.public;
    value as address.public;

mapping route_iter:
    key as RouteIndexKey.public;
    value as IsmRouteKey.public;

mapping route_length:
    key as address.public;
    value as u32.public;

mapping message_id_multisigs:
    key as address.public;
    value as MessageIdMultisigIsm.public;

mapping ism_addresses:
    key as u32.public;
    value as address.public;

mapping isms:
    key as address.public;
    value as u8.public;

function init_noop:
    async init_noop into r0;
    output r0 as ism_manager.aleo/init_noop.future;

finalize init_noop:
    get.or_use nonce[true] 0u32 into r0;
    cast r0 into r1 as NoopIsm;
    hash.bhp256 r1 into r2 as address;
    contains isms[r2] into r3;
    not r3 into r4;
    assert.eq r4 true;
    add r0 1u32 into r5;
    set r5 into nonce[true];
    set 6u8 into isms[r2];
    set r2 into ism_addresses[r0];

function init_message_id_multisig:
    input r0 as [EthAddress; 6u32].private;
    input r1 as u8.private;
    input r2 as u8.private;
    async init_message_id_multisig r0 r1 r2 into r3;
    output r3 as ism_manager.aleo/init_message_id_multisig.future;

finalize init_message_id_multisig:
    input r0 as [EthAddress; 6u32].public;
    input r1 as u8.public;
    input r2 as u8.public;
    gt r2 0u8 into r3;
    assert.eq r3 true;
    lte r2 6u8 into r4;
    assert.eq r4 true;
    lte r1 6u8 into r5;
    assert.eq r5 true;
    get.or_use nonce[true] 0u32 into r6;
    cast r0 r1 r2 r6 into r7 as MessageIdMultisigIsm;
    hash.bhp256 r7 into r8 as address;
    contains message_id_multisigs[r8] into r9;
    not r9 into r10;
    assert.eq r10 true;
    set r7 into message_id_multisigs[r8];
    add r6 1u32 into r11;
    set r11 into nonce[true];
    set 5u8 into isms[r8];
    set r8 into ism_addresses[r6];

function init_domain_routing:
    async init_domain_routing self.caller into r0;
    output r0 as ism_manager.aleo/init_domain_routing.future;

finalize init_domain_routing:
    input r0 as address.public;
    get.or_use nonce[true] 0u32 into r1;
    cast r0 r1 into r2 as DomainRoutingIsm;
    hash.bhp256 r2 into r3 as address;
    contains domain_routing_isms[r3] into r4;
    not r4 into r5;
    assert.eq r5 true;
    set r2 into domain_routing_isms[r3];
    add r1 1u32 into r6;
    set r6 into nonce[true];
    set 1u8 into isms[r3];
    set r3 into ism_addresses[r1];

function set_domain:
    input r0 as address.private;
    input r1 as u32.private;
    input r2 as address.private;
    async set_domain r0 r1 r2 self.caller into r3;
    output r3 as ism_manager.aleo/set_domain.future;

finalize set_domain:
    input r0 as address.public;
    input r1 as u32.public;
    input r2 as address.public;
    input r3 as address.public;
    contains domain_routing_isms[r0] into r4;
    assert.eq r4 true;
    get domain_routing_isms[r0] into r5;
    assert.eq r5.ism_owner r3;
    cast r0 r1 into r6 as IsmRouteKey;
    contains routes[r6] into r7;
    not r7 into r8;
    branch.eq r8 false to end_then_0_0;
    get.or_use route_length[r0] 0u32 into r9;
    cast r0 r9 into r10 as RouteIndexKey;
    set r6 into route_iter[r10];
    add r9 1u32 into r11;
    set r11 into route_length[r0];
    branch.eq true true to end_otherwise_0_1;
    position end_then_0_0;
    position end_otherwise_0_1;
    set r2 into routes[r6];

function remove_domain:
    input r0 as address.private;
    input r1 as u32.private;
    async remove_domain r0 r1 self.caller into r2;
    output r2 as ism_manager.aleo/remove_domain.future;

finalize remove_domain:
    input r0 as address.public;
    input r1 as u32.public;
    input r2 as address.public;
    contains domain_routing_isms[r0] into r3;
    assert.eq r3 true;
    get domain_routing_isms[r0] into r4;
    assert.eq r4.ism_owner r2;
    cast r0 r1 into r5 as IsmRouteKey;
    remove routes[r5];

function transfer_routing_ism_ownership:
    input r0 as address.private;
    input r1 as address.private;
    async transfer_routing_ism_ownership r0 self.caller r1 into r2;
    output r2 as ism_manager.aleo/transfer_routing_ism_ownership.future;

finalize transfer_routing_ism_ownership:
    input r0 as address.public;
    input r1 as address.public;
    input r2 as address.public;
    contains domain_routing_isms[r0] into r3;
    assert.eq r3 true;
    get domain_routing_isms[r0] into r4;
    assert.eq r4.ism_owner r1;
    cast r2 r4.nonce into r5 as DomainRoutingIsm;
    set r5 into domain_routing_isms[r0];

function verify:
    input r0 as address.public;
    input r1 as Message.public;
    input r2 as [u128; 2u32].public;
    input r3 as [u8; 512u32].public;
    async verify r0 r1 r2 r3 into r4;
    output r4 as ism_manager.aleo/verify.future;

finalize verify:
    input r0 as address.public;
    input r1 as Message.public;
    input r2 as [u128; 2u32].public;
    input r3 as [u8; 512u32].public;
    cast r3[68u32] r3[69u32] r3[70u32] r3[71u32] r3[72u32] r3[73u32] r3[74u32] r3[75u32] r3[76u32] r3[77u32] r3[78u32] r3[79u32] r3[80u32] r3[81u32] r3[82u32] r3[83u32] r3[84u32] r3[85u32] r3[86u32] r3[87u32] r3[88u32] r3[89u32] r3[90u32] r3[91u32] r3[92u32] r3[93u32] r3[94u32] r3[95u32] r3[96u32] r3[97u32] r3[98u32] r3[99u32] r3[100u32] r3[101u32] r3[102u32] r3[103u32] r3[104u32] r3[105u32] r3[106u32] r3[107u32] r3[108u32] r3[109u32] r3[110u32] r3[111u32] r3[112u32] r3[113u32] r3[114u32] r3[115u32] r3[116u32] r3[117u32] r3[118u32] r3[119u32] r3[120u32] r3[121u32] r3[122u32] r3[123u32] r3[124u32] r3[125u32] r3[126u32] r3[127u32] r3[128u32] r3[129u32] r3[130u32] r3[131u32] r3[132u32] into r4 as [u8; 65u32];
    cast r3[133u32] r3[134u32] r3[135u32] r3[136u32] r3[137u32] r3[138u32] r3[139u32] r3[140u32] r3[141u32] r3[142u32] r3[143u32] r3[144u32] r3[145u32] r3[146u32] r3[147u32] r3[148u32] r3[149u32] r3[150u32] r3[151u32] r3[152u32] r3[153u32] r3[154u32] r3[155u32] r3[156u32] r3[157u32] r3[158u32] r3[159u32] r3[160u32] r3[161u32] r3[162u32] r3[163u32] r3[164u32] r3[165u32] r3[166u32] r3[167u32] r3[168u32] r3[169u32] r3[170u32] r3[171u32] r3[172u32] r3[173u32] r3[174u32] r3[175u32] r3[176u32] r3[177u32] r3[178u32] r3[179u32] r3[180u32] r3[181u32] r3[182u32] r3[183u32] r3[184u32] r3[185u32] r3[186u32] r3[187u32] r3[188u32] r3[189u32] r3[190u32] r3[191u32] r3[192u32] r3[193u32] r3[194u32] r3[195u32] r3[196u32] r3[197u32] into r5 as [u8; 65u32];
    cast r3[198u32] r3[199u32] r3[200u32] r3[201u32] r3[202u32] r3[203u32] r3[204u32] r3[205u32] r3[206u32] r3[207u32] r3[208u32] r3[209u32] r3[210u32] r3[211u32] r3[212u32] r3[213u32] r3[214u32] r3[215u32] r3[216u32] r3[217u32] r3[218u32] r3[219u32] r3[220u32] r3[221u32] r3[222u32] r3[223u32] r3[224u32] r3[225u32] r3[226u32] r3[227u32] r3[228u32] r3[229u32] r3[230u32] r3[231u32] r3[232u32] r3[233u32] r3[234u32] r3[235u32] r3[236u32] r3[237u32] r3[238u32] r3[239u32] r3[240u32] r3[241u32] r3[242u32] r3[243u32] r3[244u32] r3[245u32] r3[246u32] r3[247u32] r3[248u32] r3[249u32] r3[250u32] r3[251u32] r3[252u32] r3[253u32] r3[254u32] r3[255u32] r3[256u32] r3[257u32] r3[258u32] r3[259u32] r3[260u32] r3[261u32] r3[262u32] into r6 as [u8; 65u32];
    cast r3[263u32] r3[264u32] r3[265u32] r3[266u32] r3[267u32] r3[268u32] r3[269u32] r3[270u32] r3[271u32] r3[272u32] r3[273u32] r3[274u32] r3[275u32] r3[276u32] r3[277u32] r3[278u32] r3[279u32] r3[280u32] r3[281u32] r3[282u32] r3[283u32] r3[284u32] r3[285u32] r3[286u32] r3[287u32] r3[288u32] r3[289u32] r3[290u32] r3[291u32] r3[292u32] r3[293u32] r3[294u32] r3[295u32] r3[296u32] r3[297u32] r3[298u32] r3[299u32] r3[300u32] r3[301u32] r3[302u32] r3[303u32] r3[304u32] r3[305u32] r3[306u32] r3[307u32] r3[308u32] r3[309u32] r3[310u32] r3[311u32] r3[312u32] r3[313u32] r3[314u32] r3[315u32] r3[316u32] r3[317u32] r3[318u32] r3[319u32] r3[320u32] r3[321u32] r3[322u32] r3[323u32] r3[324u32] r3[325u32] r3[326u32] r3[327u32] into r7 as [u8; 65u32];
    cast r3[328u32] r3[329u32] r3[330u32] r3[331u32] r3[332u32] r3[333u32] r3[334u32] r3[335u32] r3[336u32] r3[337u32] r3[338u32] r3[339u32] r3[340u32] r3[341u32] r3[342u32] r3[343u32] r3[344u32] r3[345u32] r3[346u32] r3[347u32] r3[348u32] r3[349u32] r3[350u32] r3[351u32] r3[352u32] r3[353u32] r3[354u32] r3[355u32] r3[356u32] r3[357u32] r3[358u32] r3[359u32] r3[360u32] r3[361u32] r3[362u32] r3[363u32] r3[364u32] r3[365u32] r3[366u32] r3[367u32] r3[368u32] r3[369u32] r3[370u32] r3[371u32] r3[372u32] r3[373u32] r3[374u32] r3[375u32] r3[376u32] r3[377u32] r3[378u32] r3[379u32] r3[380u32] r3[381u32] r3[382u32] r3[383u32] r3[384u32] r3[385u32] r3[386u32] r3[387u32] r3[388u32] r3[389u32] r3[390u32] r3[391u32] r3[392u32] into r8 as [u8; 65u32];
    cast r3[393u32] r3[394u32] r3[395u32] r3[396u32] r3[397u32] r3[398u32] r3[399u32] r3[400u32] r3[401u32] r3[402u32] r3[403u32] r3[404u32] r3[405u32] r3[406u32] r3[407u32] r3[408u32] r3[409u32] r3[410u32] r3[411u32] r3[412u32] r3[413u32] r3[414u32] r3[415u32] r3[416u32] r3[417u32] r3[418u32] r3[419u32] r3[420u32] r3[421u32] r3[422u32] r3[423u32] r3[424u32] r3[425u32] r3[426u32] r3[427u32] r3[428u32] r3[429u32] r3[430u32] r3[431u32] r3[432u32] r3[433u32] r3[434u32] r3[435u32] r3[436u32] r3[437u32] r3[438u32] r3[439u32] r3[440u32] r3[441u32] r3[442u32] r3[443u32] r3[444u32] r3[445u32] r3[446u32] r3[447u32] r3[448u32] r3[449u32] r3[450u32] r3[451u32] r3[452u32] r3[453u32] r3[454u32] r3[455u32] r3[456u32] r3[457u32] into r9 as [u8; 65u32];
    cast r4 r5 r6 r7 r8 r9 into r10 as [[u8; 65u32]; 6u32];
    cast r3[0u32] r3[1u32] r3[2u32] r3[3u32] r3[4u32] r3[5u32] r3[6u32] r3[7u32] r3[8u32] r3[9u32] r3[10u32] r3[11u32] r3[12u32] r3[13u32] r3[14u32] r3[15u32] r3[16u32] r3[17u32] r3[18u32] r3[19u32] r3[20u32] r3[21u32] r3[22u32] r3[23u32] r3[24u32] r3[25u32] r3[26u32] r3[27u32] r3[28u32] r3[29u32] r3[30u32] r3[31u32] into r11 as [u8; 32u32];
    shr r1.origin_domain 24u32 into r12;
    cast r12 into r13 as u8;
    shr r1.origin_domain 16u32 into r14;
    rem r14 256u32 into r15;
    cast r15 into r16 as u8;
    shr r1.origin_domain 8u32 into r17;
    rem r17 256u32 into r18;
    cast r18 into r19 as u8;
    rem r1.origin_domain 256u32 into r20;
    cast r20 into r21 as u8;
    cast r13 r16 r19 r21 r11[0u32] r11[1u32] r11[2u32] r11[3u32] r11[4u32] r11[5u32] r11[6u32] r11[7u32] r11[8u32] r11[9u32] r11[10u32] r11[11u32] r11[12u32] r11[13u32] r11[14u32] r11[15u32] r11[16u32] r11[17u32] r11[18u32] r11[19u32] r11[20u32] r11[21u32] r11[22u32] r11[23u32] r11[24u32] r11[25u32] r11[26u32] r11[27u32] r11[28u32] r11[29u32] r11[30u32] r11[31u32] 72u8 89u8 80u8 69u8 82u8 76u8 65u8 78u8 69u8 into r22 as [u8; 45u32];
    hash.keccak256.native.raw r22 into r23 as [boolean; 256u32];
    deserialize.bits.raw r23 ([boolean; 256u32]) into r24 ([u8; 32u32]);
    serialize.bits.raw r2[0u32] (u128) into r25 ([boolean; 128u32]);
    serialize.bits.raw r2[1u32] (u128) into r26 ([boolean; 128u32]);
    cast r25[0u32] r25[1u32] r25[2u32] r25[3u32] r25[4u32] r25[5u32] r25[6u32] r25[7u32] r25[8u32] r25[9u32] r25[10u32] r25[11u32] r25[12u32] r25[13u32] r25[14u32] r25[15u32] r25[16u32] r25[17u32] r25[18u32] r25[19u32] r25[20u32] r25[21u32] r25[22u32] r25[23u32] r25[24u32] r25[25u32] r25[26u32] r25[27u32] r25[28u32] r25[29u32] r25[30u32] r25[31u32] r25[32u32] r25[33u32] r25[34u32] r25[35u32] r25[36u32] r25[37u32] r25[38u32] r25[39u32] r25[40u32] r25[41u32] r25[42u32] r25[43u32] r25[44u32] r25[45u32] r25[46u32] r25[47u32] r25[48u32] r25[49u32] r25[50u32] r25[51u32] r25[52u32] r25[53u32] r25[54u32] r25[55u32] r25[56u32] r25[57u32] r25[58u32] r25[59u32] r25[60u32] r25[61u32] r25[62u32] r25[63u32] r25[64u32] r25[65u32] r25[66u32] r25[67u32] r25[68u32] r25[69u32] r25[70u32] r25[71u32] r25[72u32] r25[73u32] r25[74u32] r25[75u32] r25[76u32] r25[77u32] r25[78u32] r25[79u32] r25[80u32] r25[81u32] r25[82u32] r25[83u32] r25[84u32] r25[85u32] r25[86u32] r25[87u32] r25[88u32] r25[89u32] r25[90u32] r25[91u32] r25[92u32] r25[93u32] r25[94u32] r25[95u32] r25[96u32] r25[97u32] r25[98u32] r25[99u32] r25[100u32] r25[101u32] r25[102u32] r25[103u32] r25[104u32] r25[105u32] r25[106u32] r25[107u32] r25[108u32] r25[109u32] r25[110u32] r25[111u32] r25[112u32] r25[113u32] r25[114u32] r25[115u32] r25[116u32] r25[117u32] r25[118u32] r25[119u32] r25[120u32] r25[121u32] r25[122u32] r25[123u32] r25[124u32] r25[125u32] r25[126u32] r25[127u32] r26[0u32] r26[1u32] r26[2u32] r26[3u32] r26[4u32] r26[5u32] r26[6u32] r26[7u32] r26[8u32] r26[9u32] r26[10u32] r26[11u32] r26[12u32] r26[13u32] r26[14u32] r26[15u32] r26[16u32] r26[17u32] r26[18u32] r26[19u32] r26[20u32] r26[21u32] r26[22u32] r26[23u32] r26[24u32] r26[25u32] r26[26u32] r26[27u32] r26[28u32] r26[29u32] r26[30u32] r26[31u32] r26[32u32] r26[33u32] r26[34u32] r26[35u32] r26[36u32] r26[37u32] r26[38u32] r26[39u32] r26[40u32] r26[41u32] r26[42u32] r26[43u32] r26[44u32] r26[45u32] r26[46u32] r26[47u32] r26[48u32] r26[49u32] r26[50u32] r26[51u32] r26[52u32] r26[53u32] r26[54u32] r26[55u32] r26[56u32] r26[57u32] r26[58u32] r26[59u32] r26[60u32] r26[61u32] r26[62u32] r26[63u32] r26[64u32] r26[65u32] r26[66u32] r26[67u32] r26[68u32] r26[69u32] r26[70u32] r26[71u32] r26[72u32] r26[73u32] r26[74u32] r26[75u32] r26[76u32] r26[77u32] r26[78u32] r26[79u32] r26[80u32] r26[81u32] r26[82u32] r26[83u32] r26[84u32] r26[85u32] r26[86u32] r26[87u32] r26[88u32] r26[89u32] r26[90u32] r26[91u32] r26[92u32] r26[93u32] r26[94u32] r26[95u32] r26[96u32] r26[97u32] r26[98u32] r26[99u32] r26[100u32] r26[101u32] r26[102u32] r26[103u32] r26[104u32] r26[105u32] r26[106u32] r26[107u32] r26[108u32] r26[109u32] r26[110u32] r26[111u32] r26[112u32] r26[113u32] r26[114u32] r26[115u32] r26[116u32] r26[117u32] r26[118u32] r26[119u32] r26[120u32] r26[121u32] r26[122u32] r26[123u32] r26[124u32] r26[125u32] r26[126u32] r26[127u32] into r27 as [boolean; 256u32];
    deserialize.bits.raw r27 ([boolean; 256u32]) into r28 ([u8; 32u32]);
    cast r24[0u32] r24[1u32] r24[2u32] r24[3u32] r24[4u32] r24[5u32] r24[6u32] r24[7u32] r24[8u32] r24[9u32] r24[10u32] r24[11u32] r24[12u32] r24[13u32] r24[14u32] r24[15u32] r24[16u32] r24[17u32] r24[18u32] r24[19u32] r24[20u32] r24[21u32] r24[22u32] r24[23u32] r24[24u32] r24[25u32] r24[26u32] r24[27u32] r24[28u32] r24[29u32] r24[30u32] r24[31u32] r3[32u32] r3[33u32] r3[34u32] r3[35u32] r3[36u32] r3[37u32] r3[38u32] r3[39u32] r3[40u32] r3[41u32] r3[42u32] r3[43u32] r3[44u32] r3[45u32] r3[46u32] r3[47u32] r3[48u32] r3[49u32] r3[50u32] r3[51u32] r3[52u32] r3[53u32] r3[54u32] r3[55u32] r3[56u32] r3[57u32] r3[58u32] r3[59u32] r3[60u32] r3[61u32] r3[62u32] r3[63u32] r3[64u32] r3[65u32] r3[66u32] r3[67u32] r28[0u32] r28[1u32] r28[2u32] r28[3u32] r28[4u32] r28[5u32] r28[6u32] r28[7u32] r28[8u32] r28[9u32] r28[10u32] r28[11u32] r28[12u32] r28[13u32] r28[14u32] r28[15u32] r28[16u32] r28[17u32] r28[18u32] r28[19u32] r28[20u32] r28[21u32] r28[22u32] r28[23u32] r28[24u32] r28[25u32] r28[26u32] r28[27u32] r28[28u32] r28[29u32] r28[30u32] r28[31u32] into r29 as [u8; 100u32];
    hash.keccak256.native.raw r29 into r30 as [boolean; 256u32];
    deserialize.bits.raw r30 ([boolean; 256u32]) into r31 ([u8; 32u32]);
    cast 25u8 69u8 116u8 104u8 101u8 114u8 101u8 117u8 109u8 32u8 83u8 105u8 103u8 110u8 101u8 100u8 32u8 77u8 101u8 115u8 115u8 97u8 103u8 101u8 58u8 10u8 51u8 50u8 r31[0u32] r31[1u32] r31[2u32] r31[3u32] r31[4u32] r31[5u32] r31[6u32] r31[7u32] r31[8u32] r31[9u32] r31[10u32] r31[11u32] r31[12u32] r31[13u32] r31[14u32] r31[15u32] r31[16u32] r31[17u32] r31[18u32] r31[19u32] r31[20u32] r31[21u32] r31[22u32] r31[23u32] r31[24u32] r31[25u32] r31[26u32] r31[27u32] r31[28u32] r31[29u32] r31[30u32] r31[31u32] into r32 as [u8; 60u32];
    hash.keccak256.native.raw r32 into r33 as [boolean; 256u32];
    deserialize.bits.raw r33 ([boolean; 256u32]) into r34 ([u8; 32u32]);
    get isms[r0] into r35;
    contains isms[r0] into r36;
    assert.eq r36 true;
    is.eq r35 5u8 into r37;
    branch.eq r37 false to end_then_0_2;
    get message_id_multisigs[r0] into r38;
    ecdsa.verify.digest.eth r10[0u32] r38.validators[0u32].bytes r34 into r39;
    ternary r39 1u8 0u8 into r40;
    add 0u8 r40 into r41;
    ecdsa.verify.digest.eth r10[1u32] r38.validators[1u32].bytes r34 into r42;
    ternary r42 1u8 0u8 into r43;
    add r41 r43 into r44;
    ecdsa.verify.digest.eth r10[2u32] r38.validators[2u32].bytes r34 into r45;
    ternary r45 1u8 0u8 into r46;
    add r44 r46 into r47;
    ecdsa.verify.digest.eth r10[3u32] r38.validators[3u32].bytes r34 into r48;
    ternary r48 1u8 0u8 into r49;
    add r47 r49 into r50;
    ecdsa.verify.digest.eth r10[4u32] r38.validators[4u32].bytes r34 into r51;
    ternary r51 1u8 0u8 into r52;
    add r50 r52 into r53;
    ecdsa.verify.digest.eth r10[5u32] r38.validators[5u32].bytes r34 into r54;
    ternary r54 1u8 0u8 into r55;
    add r53 r55 into r56;
    gte r56 r38.threshold into r57;
    assert.eq r57 true;
    branch.eq true true to end_otherwise_0_3;
    position end_then_0_2;
    is.eq r35 6u8 into r58;
    is.eq r35 1u8 into r59;
    or r58 r59 into r60;
    branch.eq r60 false to end_then_1_4;
    branch.eq true true to end_otherwise_1_5;
    position end_then_1_4;
    assert.eq false true;
    position end_otherwise_1_5;
    position end_otherwise_0_3;
    cast r0 r1.origin_domain into r61 as IsmRouteKey;
    get.or_use routes[r61] r0 into r62;
    get isms[r62] into r63;
    contains isms[r62] into r64;
    assert.eq r64 true;
    is.eq r63 5u8 into r65;
    branch.eq r65 false to end_then_0_6;
    get message_id_multisigs[r62] into r66;
    ecdsa.verify.digest.eth r10[0u32] r66.validators[0u32].bytes r34 into r67;
    ternary r67 1u8 0u8 into r68;
    add 0u8 r68 into r69;
    ecdsa.verify.digest.eth r10[1u32] r66.validators[1u32].bytes r34 into r70;
    ternary r70 1u8 0u8 into r71;
    add r69 r71 into r72;
    ecdsa.verify.digest.eth r10[2u32] r66.validators[2u32].bytes r34 into r73;
    ternary r73 1u8 0u8 into r74;
    add r72 r74 into r75;
    ecdsa.verify.digest.eth r10[3u32] r66.validators[3u32].bytes r34 into r76;
    ternary r76 1u8 0u8 into r77;
    add r75 r77 into r78;
    ecdsa.verify.digest.eth r10[4u32] r66.validators[4u32].bytes r34 into r79;
    ternary r79 1u8 0u8 into r80;
    add r78 r80 into r81;
    ecdsa.verify.digest.eth r10[5u32] r66.validators[5u32].bytes r34 into r82;
    ternary r82 1u8 0u8 into r83;
    add r81 r83 into r84;
    gte r84 r66.threshold into r85;
    assert.eq r85 true;
    branch.eq true true to end_otherwise_0_7;
    position end_then_0_6;
    is.eq r63 6u8 into r86;
    is.eq r63 1u8 into r87;
    or r86 r87 into r88;
    branch.eq r88 false to end_then_1_8;
    branch.eq true true to end_otherwise_1_9;
    position end_then_1_8;
    assert.eq false true;
    position end_otherwise_1_9;
    position end_otherwise_0_7;
    cast r62 r1.origin_domain into r89 as IsmRouteKey;
    get.or_use routes[r89] r62 into r90;
    get isms[r90] into r91;
    contains isms[r90] into r92;
    assert.eq r92 true;
    is.eq r91 5u8 into r93;
    branch.eq r93 false to end_then_0_10;
    get message_id_multisigs[r90] into r94;
    ecdsa.verify.digest.eth r10[0u32] r94.validators[0u32].bytes r34 into r95;
    ternary r95 1u8 0u8 into r96;
    add 0u8 r96 into r97;
    ecdsa.verify.digest.eth r10[1u32] r94.validators[1u32].bytes r34 into r98;
    ternary r98 1u8 0u8 into r99;
    add r97 r99 into r100;
    ecdsa.verify.digest.eth r10[2u32] r94.validators[2u32].bytes r34 into r101;
    ternary r101 1u8 0u8 into r102;
    add r100 r102 into r103;
    ecdsa.verify.digest.eth r10[3u32] r94.validators[3u32].bytes r34 into r104;
    ternary r104 1u8 0u8 into r105;
    add r103 r105 into r106;
    ecdsa.verify.digest.eth r10[4u32] r94.validators[4u32].bytes r34 into r107;
    ternary r107 1u8 0u8 into r108;
    add r106 r108 into r109;
    ecdsa.verify.digest.eth r10[5u32] r94.validators[5u32].bytes r34 into r110;
    ternary r110 1u8 0u8 into r111;
    add r109 r111 into r112;
    gte r112 r94.threshold into r113;
    assert.eq r113 true;
    branch.eq true true to end_otherwise_0_11;
    position end_then_0_10;
    is.eq r91 6u8 into r114;
    is.eq r91 1u8 into r115;
    or r114 r115 into r116;
    branch.eq r116 false to end_then_1_12;
    branch.eq true true to end_otherwise_1_13;
    position end_then_1_12;
    assert.eq false true;
    position end_otherwise_1_13;
    position end_otherwise_0_11;
    cast r90 r1.origin_domain into r117 as IsmRouteKey;
    get.or_use routes[r117] r90 into r118;
    get isms[r118] into r119;
    contains isms[r118] into r120;
    assert.eq r120 true;
    is.eq r119 5u8 into r121;
    branch.eq r121 false to end_then_0_14;
    get message_id_multisigs[r118] into r122;
    ecdsa.verify.digest.eth r10[0u32] r122.validators[0u32].bytes r34 into r123;
    ternary r123 1u8 0u8 into r124;
    add 0u8 r124 into r125;
    ecdsa.verify.digest.eth r10[1u32] r122.validators[1u32].bytes r34 into r126;
    ternary r126 1u8 0u8 into r127;
    add r125 r127 into r128;
    ecdsa.verify.digest.eth r10[2u32] r122.validators[2u32].bytes r34 into r129;
    ternary r129 1u8 0u8 into r130;
    add r128 r130 into r131;
    ecdsa.verify.digest.eth r10[3u32] r122.validators[3u32].bytes r34 into r132;
    ternary r132 1u8 0u8 into r133;
    add r131 r133 into r134;
    ecdsa.verify.digest.eth r10[4u32] r122.validators[4u32].bytes r34 into r135;
    ternary r135 1u8 0u8 into r136;
    add r134 r136 into r137;
    ecdsa.verify.digest.eth r10[5u32] r122.validators[5u32].bytes r34 into r138;
    ternary r138 1u8 0u8 into r139;
    add r137 r139 into r140;
    gte r140 r122.threshold into r141;
    assert.eq r141 true;
    branch.eq true true to end_otherwise_0_15;
    position end_then_0_14;
    is.eq r119 6u8 into r142;
    is.eq r119 1u8 into r143;
    or r142 r143 into r144;
    branch.eq r144 false to end_then_1_16;
    branch.eq true true to end_otherwise_1_17;
    position end_then_1_16;
    assert.eq false true;
    position end_otherwise_1_17;
    position end_otherwise_0_15;
    cast r118 r1.origin_domain into r145 as IsmRouteKey;
    get.or_use routes[r145] r118 into r146;
    get isms[r146] into r147;
    is.eq r147 1u8 into r148;
    branch.eq r148 false to end_then_0_18;
    assert.eq false true;
    branch.eq true true to end_otherwise_0_19;
    position end_then_0_18;
    position end_otherwise_0_19;

constructor:
    assert.eq edition 0u16;
