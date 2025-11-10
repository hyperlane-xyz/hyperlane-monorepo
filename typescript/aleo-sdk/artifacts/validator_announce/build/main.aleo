program validator_announce.aleo;

struct EthAddress:
    bytes as [u8; 20u32];

struct StorageLocationKey:
    validator as [u8; 20u32];
    index as u8;

struct ValidatorAnnounce:
    mailbox as [u8; 32u32];
    local_domain as u32;

struct HashKey:
    hash as [u8; 32u32];

mapping storage_sequences:
    key as EthAddress.public;
    value as u8.public;

mapping storage_locations:
    key as StorageLocationKey.public;
    value as [u8; 480u32].public;

mapping replay_protection:
    key as HashKey.public;
    value as boolean.public;

mapping validator_announce:
    key as boolean.public;
    value as ValidatorAnnounce.public;

function init:
    input r0 as address.private;
    input r1 as u32.private;
    serialize.bits.raw r0 (address) into r2 ([boolean; 253u32]);
    cast false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false false into r3 as [boolean; 256u32];
    cast r2[0u32] r2[1u32] r2[2u32] r2[3u32] r2[4u32] r2[5u32] r2[6u32] r2[7u32] r2[8u32] r2[9u32] r2[10u32] r2[11u32] r2[12u32] r2[13u32] r2[14u32] r2[15u32] r2[16u32] r2[17u32] r2[18u32] r2[19u32] r2[20u32] r2[21u32] r2[22u32] r2[23u32] r2[24u32] r2[25u32] r2[26u32] r2[27u32] r2[28u32] r2[29u32] r2[30u32] r2[31u32] r2[32u32] r2[33u32] r2[34u32] r2[35u32] r2[36u32] r2[37u32] r2[38u32] r2[39u32] r2[40u32] r2[41u32] r2[42u32] r2[43u32] r2[44u32] r2[45u32] r2[46u32] r2[47u32] r2[48u32] r2[49u32] r2[50u32] r2[51u32] r2[52u32] r2[53u32] r2[54u32] r2[55u32] r2[56u32] r2[57u32] r2[58u32] r2[59u32] r2[60u32] r2[61u32] r2[62u32] r2[63u32] r2[64u32] r2[65u32] r2[66u32] r2[67u32] r2[68u32] r2[69u32] r2[70u32] r2[71u32] r2[72u32] r2[73u32] r2[74u32] r2[75u32] r2[76u32] r2[77u32] r2[78u32] r2[79u32] r2[80u32] r2[81u32] r2[82u32] r2[83u32] r2[84u32] r2[85u32] r2[86u32] r2[87u32] r2[88u32] r2[89u32] r2[90u32] r2[91u32] r2[92u32] r2[93u32] r2[94u32] r2[95u32] r2[96u32] r2[97u32] r2[98u32] r2[99u32] r2[100u32] r2[101u32] r2[102u32] r2[103u32] r2[104u32] r2[105u32] r2[106u32] r2[107u32] r2[108u32] r2[109u32] r2[110u32] r2[111u32] r2[112u32] r2[113u32] r2[114u32] r2[115u32] r2[116u32] r2[117u32] r2[118u32] r2[119u32] r2[120u32] r2[121u32] r2[122u32] r2[123u32] r2[124u32] r2[125u32] r2[126u32] r2[127u32] r2[128u32] r2[129u32] r2[130u32] r2[131u32] r2[132u32] r2[133u32] r2[134u32] r2[135u32] r2[136u32] r2[137u32] r2[138u32] r2[139u32] r2[140u32] r2[141u32] r2[142u32] r2[143u32] r2[144u32] r2[145u32] r2[146u32] r2[147u32] r2[148u32] r2[149u32] r2[150u32] r2[151u32] r2[152u32] r2[153u32] r2[154u32] r2[155u32] r2[156u32] r2[157u32] r2[158u32] r2[159u32] r2[160u32] r2[161u32] r2[162u32] r2[163u32] r2[164u32] r2[165u32] r2[166u32] r2[167u32] r2[168u32] r2[169u32] r2[170u32] r2[171u32] r2[172u32] r2[173u32] r2[174u32] r2[175u32] r2[176u32] r2[177u32] r2[178u32] r2[179u32] r2[180u32] r2[181u32] r2[182u32] r2[183u32] r2[184u32] r2[185u32] r2[186u32] r2[187u32] r2[188u32] r2[189u32] r2[190u32] r2[191u32] r2[192u32] r2[193u32] r2[194u32] r2[195u32] r2[196u32] r2[197u32] r2[198u32] r2[199u32] r2[200u32] r2[201u32] r2[202u32] r2[203u32] r2[204u32] r2[205u32] r2[206u32] r2[207u32] r2[208u32] r2[209u32] r2[210u32] r2[211u32] r2[212u32] r2[213u32] r2[214u32] r2[215u32] r2[216u32] r2[217u32] r2[218u32] r2[219u32] r2[220u32] r2[221u32] r2[222u32] r2[223u32] r2[224u32] r2[225u32] r2[226u32] r2[227u32] r2[228u32] r2[229u32] r2[230u32] r2[231u32] r2[232u32] r2[233u32] r2[234u32] r2[235u32] r2[236u32] r2[237u32] r2[238u32] r2[239u32] r2[240u32] r2[241u32] r2[242u32] r2[243u32] r2[244u32] r2[245u32] r2[246u32] r2[247u32] r2[248u32] r2[249u32] r2[250u32] r2[251u32] r2[252u32] r3[253u32] r3[254u32] r3[255u32] into r4 as [boolean; 256u32];
    deserialize.bits.raw r4 ([boolean; 256u32]) into r5 ([u8; 32u32]);
    async init r5 r1 into r6;
    output r6 as validator_announce.aleo/init.future;

finalize init:
    input r0 as [u8; 32u32].public;
    input r1 as u32.public;
    contains validator_announce[true] into r2;
    not r2 into r3;
    assert.eq r3 true;
    cast r0 r1 into r4 as ValidatorAnnounce;
    set r4 into validator_announce[true];

function get_address:
    output validator_announce.aleo as address.private;

function announce:
    input r0 as [u8; 20u32].private;
    input r1 as [u8; 480u32].private;
    input r2 as [u8; 65u32].private;
    async announce r0 r1 r2 into r3;
    output r3 as validator_announce.aleo/announce.future;

finalize announce:
    input r0 as [u8; 20u32].public;
    input r1 as [u8; 480u32].public;
    input r2 as [u8; 65u32].public;
    contains validator_announce[true] into r3;
    assert.eq r3 true;
    get validator_announce[true] into r4;
    cast r0[0u32] r0[1u32] r0[2u32] r0[3u32] r0[4u32] r0[5u32] r0[6u32] r0[7u32] r0[8u32] r0[9u32] r0[10u32] r0[11u32] r0[12u32] r0[13u32] r0[14u32] r0[15u32] r0[16u32] r0[17u32] r0[18u32] r0[19u32] r1[0u32] r1[1u32] r1[2u32] r1[3u32] r1[4u32] r1[5u32] r1[6u32] r1[7u32] r1[8u32] r1[9u32] r1[10u32] r1[11u32] r1[12u32] r1[13u32] r1[14u32] r1[15u32] r1[16u32] r1[17u32] r1[18u32] r1[19u32] r1[20u32] r1[21u32] r1[22u32] r1[23u32] r1[24u32] r1[25u32] r1[26u32] r1[27u32] r1[28u32] r1[29u32] r1[30u32] r1[31u32] r1[32u32] r1[33u32] r1[34u32] r1[35u32] r1[36u32] r1[37u32] r1[38u32] r1[39u32] r1[40u32] r1[41u32] r1[42u32] r1[43u32] r1[44u32] r1[45u32] r1[46u32] r1[47u32] r1[48u32] r1[49u32] r1[50u32] r1[51u32] r1[52u32] r1[53u32] r1[54u32] r1[55u32] r1[56u32] r1[57u32] r1[58u32] r1[59u32] r1[60u32] r1[61u32] r1[62u32] r1[63u32] r1[64u32] r1[65u32] r1[66u32] r1[67u32] r1[68u32] r1[69u32] r1[70u32] r1[71u32] r1[72u32] r1[73u32] r1[74u32] r1[75u32] r1[76u32] r1[77u32] r1[78u32] r1[79u32] r1[80u32] r1[81u32] r1[82u32] r1[83u32] r1[84u32] r1[85u32] r1[86u32] r1[87u32] r1[88u32] r1[89u32] r1[90u32] r1[91u32] r1[92u32] r1[93u32] r1[94u32] r1[95u32] r1[96u32] r1[97u32] r1[98u32] r1[99u32] r1[100u32] r1[101u32] r1[102u32] r1[103u32] r1[104u32] r1[105u32] r1[106u32] r1[107u32] r1[108u32] r1[109u32] r1[110u32] r1[111u32] r1[112u32] r1[113u32] r1[114u32] r1[115u32] r1[116u32] r1[117u32] r1[118u32] r1[119u32] r1[120u32] r1[121u32] r1[122u32] r1[123u32] r1[124u32] r1[125u32] r1[126u32] r1[127u32] r1[128u32] r1[129u32] r1[130u32] r1[131u32] r1[132u32] r1[133u32] r1[134u32] r1[135u32] r1[136u32] r1[137u32] r1[138u32] r1[139u32] r1[140u32] r1[141u32] r1[142u32] r1[143u32] r1[144u32] r1[145u32] r1[146u32] r1[147u32] r1[148u32] r1[149u32] r1[150u32] r1[151u32] r1[152u32] r1[153u32] r1[154u32] r1[155u32] r1[156u32] r1[157u32] r1[158u32] r1[159u32] r1[160u32] r1[161u32] r1[162u32] r1[163u32] r1[164u32] r1[165u32] r1[166u32] r1[167u32] r1[168u32] r1[169u32] r1[170u32] r1[171u32] r1[172u32] r1[173u32] r1[174u32] r1[175u32] r1[176u32] r1[177u32] r1[178u32] r1[179u32] into r5 as [u8; 200u32];
    hash.keccak256.native.raw r5 into r6 as [boolean; 256u32];
    deserialize.bits.raw r6 ([boolean; 256u32]) into r7 ([u8; 32u32]);
    cast r7 into r8 as HashKey;
    contains replay_protection[r8] into r9;
    not r9 into r10;
    assert.eq r10 true;
    cast r0 into r11 as EthAddress;
    get.or_use storage_sequences[r11] 0u8 into r12;
    shr r4.local_domain 24u32 into r13;
    cast r13 into r14 as u8;
    shr r4.local_domain 16u32 into r15;
    rem r15 256u32 into r16;
    cast r16 into r17 as u8;
    shr r4.local_domain 8u32 into r18;
    rem r18 256u32 into r19;
    cast r19 into r20 as u8;
    rem r4.local_domain 256u32 into r21;
    cast r21 into r22 as u8;
    cast r14 r17 r20 r22 r4.mailbox[0u32] r4.mailbox[1u32] r4.mailbox[2u32] r4.mailbox[3u32] r4.mailbox[4u32] r4.mailbox[5u32] r4.mailbox[6u32] r4.mailbox[7u32] r4.mailbox[8u32] r4.mailbox[9u32] r4.mailbox[10u32] r4.mailbox[11u32] r4.mailbox[12u32] r4.mailbox[13u32] r4.mailbox[14u32] r4.mailbox[15u32] r4.mailbox[16u32] r4.mailbox[17u32] r4.mailbox[18u32] r4.mailbox[19u32] r4.mailbox[20u32] r4.mailbox[21u32] r4.mailbox[22u32] r4.mailbox[23u32] r4.mailbox[24u32] r4.mailbox[25u32] r4.mailbox[26u32] r4.mailbox[27u32] r4.mailbox[28u32] r4.mailbox[29u32] r4.mailbox[30u32] r4.mailbox[31u32] 72u8 89u8 80u8 69u8 82u8 76u8 65u8 78u8 69u8 95u8 65u8 78u8 78u8 79u8 85u8 78u8 67u8 69u8 77u8 69u8 78u8 84u8 into r23 as [u8; 58u32];
    hash.keccak256.native.raw r23 into r24 as [boolean; 256u32];
    deserialize.bits.raw r24 ([boolean; 256u32]) into r25 ([u8; 32u32]);
    cast r25[0u32] r25[1u32] r25[2u32] r25[3u32] r25[4u32] r25[5u32] r25[6u32] r25[7u32] r25[8u32] r25[9u32] r25[10u32] r25[11u32] r25[12u32] r25[13u32] r25[14u32] r25[15u32] r25[16u32] r25[17u32] r25[18u32] r25[19u32] r25[20u32] r25[21u32] r25[22u32] r25[23u32] r25[24u32] r25[25u32] r25[26u32] r25[27u32] r25[28u32] r25[29u32] r25[30u32] r25[31u32] r1[0u32] r1[1u32] r1[2u32] r1[3u32] r1[4u32] r1[5u32] r1[6u32] r1[7u32] r1[8u32] r1[9u32] r1[10u32] r1[11u32] r1[12u32] r1[13u32] r1[14u32] r1[15u32] r1[16u32] r1[17u32] r1[18u32] r1[19u32] r1[20u32] r1[21u32] r1[22u32] r1[23u32] r1[24u32] r1[25u32] r1[26u32] r1[27u32] r1[28u32] r1[29u32] r1[30u32] r1[31u32] r1[32u32] r1[33u32] r1[34u32] r1[35u32] r1[36u32] r1[37u32] r1[38u32] r1[39u32] r1[40u32] r1[41u32] r1[42u32] r1[43u32] r1[44u32] r1[45u32] r1[46u32] r1[47u32] r1[48u32] r1[49u32] r1[50u32] r1[51u32] r1[52u32] r1[53u32] r1[54u32] r1[55u32] r1[56u32] r1[57u32] r1[58u32] r1[59u32] r1[60u32] r1[61u32] r1[62u32] r1[63u32] r1[64u32] r1[65u32] r1[66u32] r1[67u32] r1[68u32] r1[69u32] r1[70u32] r1[71u32] r1[72u32] r1[73u32] r1[74u32] r1[75u32] r1[76u32] r1[77u32] r1[78u32] r1[79u32] r1[80u32] r1[81u32] r1[82u32] r1[83u32] r1[84u32] r1[85u32] r1[86u32] r1[87u32] r1[88u32] r1[89u32] r1[90u32] r1[91u32] r1[92u32] r1[93u32] r1[94u32] r1[95u32] r1[96u32] r1[97u32] r1[98u32] r1[99u32] r1[100u32] r1[101u32] r1[102u32] r1[103u32] r1[104u32] r1[105u32] r1[106u32] r1[107u32] r1[108u32] r1[109u32] r1[110u32] r1[111u32] r1[112u32] r1[113u32] r1[114u32] r1[115u32] r1[116u32] r1[117u32] r1[118u32] r1[119u32] r1[120u32] r1[121u32] r1[122u32] r1[123u32] r1[124u32] r1[125u32] r1[126u32] r1[127u32] r1[128u32] r1[129u32] r1[130u32] r1[131u32] r1[132u32] r1[133u32] r1[134u32] r1[135u32] r1[136u32] r1[137u32] r1[138u32] r1[139u32] r1[140u32] r1[141u32] r1[142u32] r1[143u32] r1[144u32] r1[145u32] r1[146u32] r1[147u32] r1[148u32] r1[149u32] r1[150u32] r1[151u32] r1[152u32] r1[153u32] r1[154u32] r1[155u32] r1[156u32] r1[157u32] r1[158u32] r1[159u32] r1[160u32] r1[161u32] r1[162u32] r1[163u32] r1[164u32] r1[165u32] r1[166u32] r1[167u32] r1[168u32] r1[169u32] r1[170u32] r1[171u32] r1[172u32] r1[173u32] r1[174u32] r1[175u32] r1[176u32] r1[177u32] r1[178u32] r1[179u32] r1[180u32] r1[181u32] r1[182u32] r1[183u32] r1[184u32] r1[185u32] r1[186u32] r1[187u32] r1[188u32] r1[189u32] r1[190u32] r1[191u32] r1[192u32] r1[193u32] r1[194u32] r1[195u32] r1[196u32] r1[197u32] r1[198u32] r1[199u32] r1[200u32] r1[201u32] r1[202u32] r1[203u32] r1[204u32] r1[205u32] r1[206u32] r1[207u32] r1[208u32] r1[209u32] r1[210u32] r1[211u32] r1[212u32] r1[213u32] r1[214u32] r1[215u32] r1[216u32] r1[217u32] r1[218u32] r1[219u32] r1[220u32] r1[221u32] r1[222u32] r1[223u32] r1[224u32] r1[225u32] r1[226u32] r1[227u32] r1[228u32] r1[229u32] r1[230u32] r1[231u32] r1[232u32] r1[233u32] r1[234u32] r1[235u32] r1[236u32] r1[237u32] r1[238u32] r1[239u32] r1[240u32] r1[241u32] r1[242u32] r1[243u32] r1[244u32] r1[245u32] r1[246u32] r1[247u32] r1[248u32] r1[249u32] r1[250u32] r1[251u32] r1[252u32] r1[253u32] r1[254u32] r1[255u32] r1[256u32] r1[257u32] r1[258u32] r1[259u32] r1[260u32] r1[261u32] r1[262u32] r1[263u32] r1[264u32] r1[265u32] r1[266u32] r1[267u32] r1[268u32] r1[269u32] r1[270u32] r1[271u32] r1[272u32] r1[273u32] r1[274u32] r1[275u32] r1[276u32] r1[277u32] r1[278u32] r1[279u32] r1[280u32] r1[281u32] r1[282u32] r1[283u32] r1[284u32] r1[285u32] r1[286u32] r1[287u32] r1[288u32] r1[289u32] r1[290u32] r1[291u32] r1[292u32] r1[293u32] r1[294u32] r1[295u32] r1[296u32] r1[297u32] r1[298u32] r1[299u32] r1[300u32] r1[301u32] r1[302u32] r1[303u32] r1[304u32] r1[305u32] r1[306u32] r1[307u32] r1[308u32] r1[309u32] r1[310u32] r1[311u32] r1[312u32] r1[313u32] r1[314u32] r1[315u32] r1[316u32] r1[317u32] r1[318u32] r1[319u32] r1[320u32] r1[321u32] r1[322u32] r1[323u32] r1[324u32] r1[325u32] r1[326u32] r1[327u32] r1[328u32] r1[329u32] r1[330u32] r1[331u32] r1[332u32] r1[333u32] r1[334u32] r1[335u32] r1[336u32] r1[337u32] r1[338u32] r1[339u32] r1[340u32] r1[341u32] r1[342u32] r1[343u32] r1[344u32] r1[345u32] r1[346u32] r1[347u32] r1[348u32] r1[349u32] r1[350u32] r1[351u32] r1[352u32] r1[353u32] r1[354u32] r1[355u32] r1[356u32] r1[357u32] r1[358u32] r1[359u32] r1[360u32] r1[361u32] r1[362u32] r1[363u32] r1[364u32] r1[365u32] r1[366u32] r1[367u32] r1[368u32] r1[369u32] r1[370u32] r1[371u32] r1[372u32] r1[373u32] r1[374u32] r1[375u32] r1[376u32] r1[377u32] r1[378u32] r1[379u32] r1[380u32] r1[381u32] r1[382u32] r1[383u32] r1[384u32] r1[385u32] r1[386u32] r1[387u32] r1[388u32] r1[389u32] r1[390u32] r1[391u32] r1[392u32] r1[393u32] r1[394u32] r1[395u32] r1[396u32] r1[397u32] r1[398u32] r1[399u32] r1[400u32] r1[401u32] r1[402u32] r1[403u32] r1[404u32] r1[405u32] r1[406u32] r1[407u32] r1[408u32] r1[409u32] r1[410u32] r1[411u32] r1[412u32] r1[413u32] r1[414u32] r1[415u32] r1[416u32] r1[417u32] r1[418u32] r1[419u32] r1[420u32] r1[421u32] r1[422u32] r1[423u32] r1[424u32] r1[425u32] r1[426u32] r1[427u32] r1[428u32] r1[429u32] r1[430u32] r1[431u32] r1[432u32] r1[433u32] r1[434u32] r1[435u32] r1[436u32] r1[437u32] r1[438u32] r1[439u32] r1[440u32] r1[441u32] r1[442u32] r1[443u32] r1[444u32] r1[445u32] r1[446u32] r1[447u32] r1[448u32] r1[449u32] r1[450u32] r1[451u32] r1[452u32] r1[453u32] r1[454u32] r1[455u32] r1[456u32] r1[457u32] r1[458u32] r1[459u32] r1[460u32] r1[461u32] r1[462u32] r1[463u32] r1[464u32] r1[465u32] r1[466u32] r1[467u32] r1[468u32] r1[469u32] r1[470u32] r1[471u32] r1[472u32] r1[473u32] r1[474u32] r1[475u32] r1[476u32] r1[477u32] r1[478u32] r1[479u32] into r26 as [u8; 512u32];
    hash.keccak256.native.raw r26 into r27 as [boolean; 256u32];
    deserialize.bits.raw r27 ([boolean; 256u32]) into r28 ([u8; 32u32]);
    cast 25u8 69u8 116u8 104u8 101u8 114u8 101u8 117u8 109u8 32u8 83u8 105u8 103u8 110u8 101u8 100u8 32u8 77u8 101u8 115u8 115u8 97u8 103u8 101u8 58u8 10u8 51u8 50u8 r28[0u32] r28[1u32] r28[2u32] r28[3u32] r28[4u32] r28[5u32] r28[6u32] r28[7u32] r28[8u32] r28[9u32] r28[10u32] r28[11u32] r28[12u32] r28[13u32] r28[14u32] r28[15u32] r28[16u32] r28[17u32] r28[18u32] r28[19u32] r28[20u32] r28[21u32] r28[22u32] r28[23u32] r28[24u32] r28[25u32] r28[26u32] r28[27u32] r28[28u32] r28[29u32] r28[30u32] r28[31u32] into r29 as [u8; 60u32];
    hash.keccak256.native.raw r29 into r30 as [boolean; 256u32];
    deserialize.bits.raw r30 ([boolean; 256u32]) into r31 ([u8; 32u32]);
    ecdsa.verify.digest.eth r2 r0 r31 into r32;
    assert.eq r32 true;
    cast r0 r12 into r33 as StorageLocationKey;
    add r12 1u8 into r34;
    set true into replay_protection[r8];
    set r1 into storage_locations[r33];
    set r34 into storage_sequences[r11];

constructor:
    assert.eq edition 0u16;
