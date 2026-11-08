#!/usr/bin/env python3
"""Closed Linux SVM data admission (C11 immutable publisher reference). No download, build or product execution.

These exact bytes are the independently read-back C11 prerequisite artifact,
not Darwin aliases. A caller must first validate its reviewed request and remote
artifact receipt. This module cannot approve native execution or erase Agave
stack warnings. Its copier only creates verified, nonlinked owned files.
"""
from __future__ import annotations
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import stat
import struct

SOURCE_COMMIT = '3fb04be890fe7ca5e7856450771fbc94f85e5f15'
ARTIFACT_ID = 13585207575
ARTIFACT_NAME = 'svm-linux-prerequisites-42400044013-1'
ARTIFACT_BYTES = 327973116
ARTIFACT_SHA256 = ('3a9d5ac4c4b4e4958ad1db3e13ab906' 'bb71e0be7eef50570e41f5737dcb38b55')
AGAVE_BYTES = 417020742
PLATFORM = 'linux-x86_64'
# name: (exact publisher member bytes, SHA-256, copied mode).
AGAVE = {
    '.crates.toml': (99, ('a1f1b8d4393fe6768faccc28379ea441' '9e5d23e8f2f854b74b28407a1fbca34e'), 420),
    '.crates2.json': (471, ('10607ec00257e68bee8b5c81dd554907' '35353f472fd1deb9411cead25ac23046'), 420),
    'bin/agave-install': (12025736, ('547c0009245156414821aa1dd66a4a8d' '488028589ab5066aa4504dfa4d6cb9b2'), 493),
    'bin/agave-install-init': (11309200, ('935c3468a313b2a0677e624181c8d22d' '639477387e602d7f769d32daf2dd5dfb'), 493),
    'bin/agave-ledger-tool': (57743824, ('c29155e9435aa1beac30dc922895c797' 'edbc0155d231e53c16f37cebfc31bcd9'), 493),
    'bin/cargo-build-sbf': (19231584, ('3d4a99ca06ce66ca2e3614f6937e2fb0' 'dd1f89968e34ff5010afc12a935b359a'), 493),
    'bin/cargo-test-sbf': (4074488, ('652983bfffd09b57b182b3a31c6853aa' '8bc4a68ba5eb56a2f2d213cd0d40241e'), 493),
    'bin/perf-libs/.version': (10, ('6936b18a269690d674af59370aee66a6' '5fec0bdc2d514c22ff9ae19068b55457'), 420),
    'bin/perf-libs/cuda-10.0/cuda-version.txt': (22, ('9f240db5d5d1f807dca2bd8011c64417' '6605650aacdb83f820510adb8886d332'), 420),
    'bin/perf-libs/cuda-10.0/libcl-crypt.so': (413408, ('0022b2973d2584dae1c5b5ef2cf0e9b1' '0f05afcb01b686248fb45b7ff32939a9'), 493),
    'bin/perf-libs/cuda-10.0/libcuda-crypt.so': (32116896, ('755bb2386dd4018cc5e7b42c97c26acf' '2de882e56a851cc07f751b1f1b69a71b'), 493),
    'bin/perf-libs/cuda-10.1/cuda-version.txt': (22, ('f6a85471bde09e91b258824d95a238fa' '128aebe150abd093418c30b1aa748359'), 420),
    'bin/perf-libs/cuda-10.1/libcl-crypt.so': (413408, ('0022b2973d2584dae1c5b5ef2cf0e9b1' '0f05afcb01b686248fb45b7ff32939a9'), 493),
    'bin/perf-libs/cuda-10.1/libcuda-crypt.so': (31995184, ('0898d0e2d57f94afef5f39ecc19ced83' '4472bfae7b056276393170f12d60b3bf'), 493),
    'bin/perf-libs/cuda-10.2/cuda-version.txt': (21, ('d0f6b9edfbce5f829c295fbefd789462' '5ab50a186fc9ebb7ca8e8a29a071d6fb'), 420),
    'bin/perf-libs/cuda-10.2/libcl-crypt.so': (413408, ('0022b2973d2584dae1c5b5ef2cf0e9b1' '0f05afcb01b686248fb45b7ff32939a9'), 493),
    'bin/perf-libs/cuda-10.2/libcuda-crypt.so': (33169456, ('2678cd4abc325cf2a3b25b8bcd8a6e39' '6fd36df0fbdc5b70b1ce2d7f38ab06c9'), 493),
    'bin/perf-libs/libpoh-simd.so': (344448, ('e43a4b70fa85f49463fc872fd6a73531' '7f3468010d1e656e68f4801e7998e9f9'), 493),
    'bin/perf-libs/libsigning.so': (32048, ('c2ab07d51405c2377d9246319f351f20' '27b9ec3bc4031bbcb7af039cb75f901b'), 493),
    'bin/perf-libs/signing.signed.so': (1034552, ('36681f827d6e1ccfc100e5d9dbcad032' '433f001806e626ed579fa08c88ecdfb2'), 420),
    'bin/perf-libs/signing.so': (1034552, ('c5f8d73e4d65742a26d77de078f14020' '5cc2c637e4786c21bd18e2e14fe12fe2'), 493),
    'bin/perf-libs/signing_public.h': (2678, ('54249d57d587c66d1983e7f3ae1f56f3' 'e47bee6817d8c85f348b45cb3c050bf4'), 420),
    'bin/perf-libs/signing_test': (76288, ('ecfb705c8b5887123bd3dcdea25914fc' 'a8354ac2d891caa65d31741f8d1c35e7'), 493),
    'bin/perf-libs/solana-perf-HEAD.txt': (41, ('7554ba7a6a538bfc6d1077f15e0eee95' '221fb88ebd0463300ba0084e2eee8940'), 420),
    'bin/perf-libs/solana-perf.tgz': (64391893, ('5850dc8ba63017cdb0c97357cc0e26e6' '0f445abc1ef3c95a61b88e59afae71a4'), 420),
    'bin/platform-tools-sdk/sbf/c/README.md': (1030, ('06a36b4517d8a1f5ca005385601e5c14' '827baefc87ce45719681f65436c0335c'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/deserialize_deprecated.h': (39, ('76c96c25637df160388fac89f265c0af' '946dae909fa37fbb0d979cb35946b03e'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/alt_bn128.h': (1625, ('aa05959b4147805bc08fc64d46c125bf' 'dff127d8b442fb4bfd99067ee46e4145'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/alt_bn128_compression.h': (2056, ('047178eb076f59cb09c3780b2e18c1c1' '946829e0b4953cd686dacd8240b52c75'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/assert.h': (1299, ('d488f2eb8453488e298482a0db2daf7f' '40dfcecc939a3a7253e680503feca36e'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/big_mod_exp.h': (857, ('8b2a539d43050b758527af9eb1bfc78a' '0cab0e2eccf4c25e9644c3dfcc8a42ec'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/blake3.h': (921, ('1685b4195b4e83a9e0c7cd0bb22cd1e0' '2a4a3dc7fac364be77609c59c977e204'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/compute_units.h': (901, ('98fdaeccd35479de916296eb6d95e11a' '16b84382f3ac0b5e5983691472107fe0'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/constants.h': (801, ('7dd040c41526b0676d0f2ab7e2a91370' '65106e83a4d83a375b95d28d52307b5b'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/cpi.h': (3841, ('96c75b02b43a4aa7e90696e5812e9772' '174a5b1f80fa229874a4437b2ffb8384'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/deserialize.h': (4137, ('505785cdbc64d74372ab71791adcd2a8' '305fb298c201dbca979e0dfca291bb53'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/deserialize_deprecated.h': (3420, ('113d2f4577684caa2ff6f4607e985370' '79c597349db145aab6c457715076feaa'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/entrypoint.h': (1663, ('2f99d265e925adf204041008ccfae848' '44a486bfe456f75ee03e2c04ee9374ab'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/alt_bn128.inc': (1032, ('6ae92d1138161ced53ffbd2c5e0a78c4' '49bb902db679e95ffd4dbb015cd43a3c'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/alt_bn128_compression.inc': (1316, ('e067415bc4c61431e0f16f551c3f44ba' '6cd731f89f7bd3d2ab70bf01ff662c7a'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/assert.inc': (828, ('88e6625a05acf6d09588eca6f1a15205' '7fb0565e164a7033ad4dc6a7f311e4b2'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/big_mod_exp.inc': (390, ('472ec9728c281669071eae3784ecf255' 'f651468713b85e8084a7f7f464a8e2ba'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/blake3.inc': (455, ('03b3fe35b02e906d109c30c7bab66db7' 'dd6b0a1f0c78b1c12af744a66101aa50'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/compute_units.inc': (432, ('d2d0ea287f00664012d4676b403bb4b2' '217c5d47e1318ee9f84b15d5d9a15f4b'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/cpi.inc': (3193, ('d932d0400803f42f20191732565a7c42' '140347ef855109efd9afccd3bd516adc'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/keccak.inc': (452, ('fc9b740a99bb48aa42cb8aa54240e4b0' 'f05165a3f85f352bcdb71e8f1997d252'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/last_restart_slot.inc': (261, ('06548830c844182b6ace88f2598872c5' '170af73f03c73d71483d6e6d21a9af4f'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/log.inc': (2590, ('a6aef93e86a3ed71dabc0670506bc460' '3b64144b355948b3c2fc3f1837b55736'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/poseidon.inc': (1229, ('c083b4fffc6ab62a9aaffab07c6fdfd0' 'a95817e8fcf93ec8de69f25e852447d9'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/pubkey.inc': (2336, ('038379d439f4fd72bebd4caed69f8e26' 'c8267d1a20c87a56aa792c85b0da953f'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/return_data.inc': (875, ('5fbf73f745893a4205d0ba7ea0e12811' 'bdbdcfa549db23b87d2524b7f785ecea'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/secp256k1.inc': (1205, ('ec843427e8277dbcacaef96c2b71a9d7' '237b01b63ea1c86be62c5f7bb2ecccee'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/inc/sha.inc': (446, ('288faee6eb253def269b4127eeb7d429' 'b4e6f41c8eab11ae7e9ee44714ca87d7'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/keccak.h': (925, ('0058f9ef7e2de1be77a3b713dbd355ed' '00a4ef4afd88ba971b76aa11d69da5f4'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/last_restart_slot.h': (750, ('dd66d2188ec0e7cd88654e9fed0167c6' 'a40252db54417042ad3f20584cb85585'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/log.h': (4308, ('aabc490bc3e40512d6aa57a47eb90b9f' 'cffe6dd30acf5a7f9b021040df681dd0'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/poseidon.h': (1916, ('8bb9c176f125545b73af9a7723ca1a8f' 'd5eb8f428452592f9a9aa8ad84e21596'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/pubkey.h': (4021, ('e7490aecae4ccc3a5f1dab8f4c64907e' '97f3def927ffedd7eb61d760b50bfd2b'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/return_data.h': (1863, ('4595e26096f93cf97939747a6d74978c' 'fd0be74303c13aca3dc641cc4921ac2d'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/secp256k1.h': (1781, ('fd580acfc83b513b4f1593bfd6e6ae2e' 'ae1fea3bfe6ae5ce3e62b7865ef58da4'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/sha.h': (897, ('4683a97894efea38058b602edacceeaa' 'c045baba12c2bdf70530168a41047bc4'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/string.h': (2069, ('1fb1db89fba24801dc0c014fdd6543c9' '6ebddd051787f768005e069122df5461'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sol/types.h': (3883, ('e52965f8bd283e8ac7b504022d394b71' '8dd2ba77270e9ce34f6b64acd555326e'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/solana_sdk.h': (515, ('cf7f5762db7a87677bfb62b357c6950c' 'ba6d1146bc2a4e3adc8eacab7bde1d44'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/stdio.h': (81, ('b05557a562439eb2981507f79f90855a' '72aaf716cc068a4d96727b958162fdf1'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/stdlib.h': (37, ('866e40d29930b07886fba1a881cf11cb' '43a1e19ce00e656d67c6f6e528afdf83'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/string.h': (116, ('1fa8b80022c45e01274e452964efad09' 'dd7e7951e060874a3c8ca03bab320635'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/sys/param.h': (13, ('b3adf106d95b8934f690943f2921308b' '90be5b766c4c8ba250c792de56400201'), 420),
    'bin/platform-tools-sdk/sbf/c/inc/wchar.h': (13, ('b3adf106d95b8934f690943f2921308b' '90be5b766c4c8ba250c792de56400201'), 420),
    'bin/platform-tools-sdk/sbf/c/sbf.ld': (452, ('a7feb3b4a201045e44c3cce9f3c1087a' '2bf2fb6d1974aa84f55ed4a65b6f1380'), 420),
    'bin/platform-tools-sdk/sbf/c/sbf.mk': (9411, ('5087a38789eb0aed6931ff9fca78ff71' '66fcbd2f89b4367c707b77ef8f82f5c7'), 420),
    'bin/platform-tools-sdk/sbf/env.sh': (499, ('ff2f69a21002d52c154c839057c52252' 'b0bf784bbba4d7a3e26e660233e552f2'), 420),
    'bin/platform-tools-sdk/sbf/scripts/dump.sh': (1016, ('1a10c293944672576a4d840f7fd5a093' 'd59781ea094f19dee1e19386185f3f07'), 493),
    'bin/platform-tools-sdk/sbf/scripts/install.sh': (3477, ('081e6702566535ee565f3e7c20d15582' '0bd8c0585eabed140f85c3d587904fd6'), 493),
    'bin/platform-tools-sdk/sbf/scripts/objcopy.sh': (209, ('7425a852c14baa9706c360d1ecbdbd69' '6dd8ce6cd0cb12050b3bde888f9f7160'), 493),
    'bin/platform-tools-sdk/sbf/scripts/package.sh': (354, ('b8651c7f1fc35911f24254e5fb6993ae' 'fc4ee750c782b399a9388c9be9b81019'), 493),
    'bin/platform-tools-sdk/sbf/scripts/strip.sh': (510, ('aa6fad201d4301e8d9adf92359c951a8' '28002679ed043703477a3b333c171ead'), 493),
    'bin/platform-tools-sdk/sbf/syscalls.txt': (0, ('e3b0c44298fc1c149afbf4c8996fb924' '27ae41e4649b934ca495991b7852b855'), 420),
    'bin/solana': (28313504, ('92ea14b1007481adbaf0821a2b2a972d' 'e7d181569e4b853b3acc1cb4f4985d71'), 493),
    'bin/solana-keygen': (2809272, ('36694aaaabc3a24a7f3de402c167f355' '235dc4f8eb78ac6a55431aa9f7de685a'), 493),
    'bin/solana-stake-accounts': (9074304, ('5cda0109845e9969137a445508b8b5f5' '6fd7877a5acc554c4ee234661be84f94'), 493),
    'bin/solana-test-validator': (73928168, ('80f3bc0e3fa6a3090e69bafbfe00b249' 'eaa655c5874ac83aebb6acdb157140ab'), 493),
    'bin/solana-tokens': (9888008, ('c778368286c9fe989fdc7dd8981fa8df' '4cdf0ec966ba45a152980146e08cac9f'), 493),
    'bin/spl-token': (23104904, ('a5def9223582dc00e68976aaa8d37246' 'f2cb3dfe54cbdba9c6f9e6d5299f6a61'), 493),
    'version.yml': (99, ('bb639257afbc5b3255c8c177658ab41a' '89a41174967c70fd5f4a7e18ea89573e'), 420),
}
# Source-built nine programs use sbpf V3; four publisher SPL programs use V0.
PROGRAMS = {
    'hyperlane_sealevel_composite_ism.so': (263904, ('bf3ddf7d4509f6e44421dc7ae86a3459' '848e47e1243be2f172a56495a6b612e7'), 263),
    'hyperlane_sealevel_igp.so': (359112, ('c1231e30a3522e056b512f5dda07be35' '58885d4e1e1fa2faa92b186f3cbc68fa'), 263),
    'hyperlane_sealevel_mailbox.so': (176632, ('acad59de4d6037d961cdd8ba325ac476' '262ac45f7afe49f6b6175edfd5b8b920'), 263),
    'hyperlane_sealevel_multisig_ism_message_id.so': (165968, ('6b000f877b87eca41d874799605496e6' 'ad59310b250b57256e741eafef040dfa'), 263),
    'hyperlane_sealevel_token.so': (402824, ('db6d310a9ff2cdbcecd62ecf4de979af' '37844db645e229ad64be9ce3594bcd1c'), 263),
    'hyperlane_sealevel_token_collateral.so': (404968, ('ef5af5a890a9cce5fe3459e68d0c9e5f' 'f9f22498364e5eb344ec4ed3dc419bc3'), 263),
    'hyperlane_sealevel_token_cross_collateral.so': (525344, ('fb515f5f34cb15d9cdf985a574ae942e' '9e356c4482b5a6018c2841d9dd5f24c0'), 263),
    'hyperlane_sealevel_token_native.so': (378016, ('0cb36ef874d54135e458ffc0230810f5' '5a96c23b140dffab2758236bd0f47706'), 263),
    'hyperlane_sealevel_validator_announce.so': (130000, ('269243e2632ff9a6a9ef60ac6c037a90' 'aad650bf41a5d3435035229de5e040ab'), 263),
    'spl_associated_token_account.so': (138208, ('554abef861b44db2f6f35bb584a5a763' '4a6b41f14161ca7a4ca0561c173d8c88'), 247),
    'spl_noop.so': (20528, ('7c6f261b1b3be46f1687fc3e63624441' '9f9e29e2ae2bbe9deeb8a34b35584787'), 247),
    'spl_token.so': (119536, ('1bce52289083b12a76ac488afdbe9f8a' '1c5f190f36d2ff2940ce352b0a91cd43'), 247),
    'spl_token_2022.so': (622280, ('ba79205fc8e6d8004802db382bcbf22e' '6349e964e8ed5cc62cf3d3c268e524d5'), 247),
}
CLIENT = (392498296, ('91959e519012e2c08fb4edd63e7dd41e' 'eba50a14a3402c178fa3fdc91df10619'))
SPL = (29569848, ('7abbac72d1f4cfd36d7bfa8e570af748' '17662742ef1243527ad2646d3c447756'))
ENVIRONMENT = ('accounts/test_deployer-account.json', 'accounts/test_deployer-keypair.json', 'composite-ism/sealeveltest1/program-ids.json', 'gas-oracle-configs.json', 'mock-registry/chains/metadata.yaml', 'sealeveltest1/core/keys/hyperlane_sealevel_igp-keypair.json', 'sealeveltest1/core/keys/hyperlane_sealevel_mailbox-keypair.json', 'sealeveltest1/core/keys/hyperlane_sealevel_multisig_ism_message_id-keypair.json', 'sealeveltest1/core/keys/hyperlane_sealevel_validator_announce-keypair.json', 'sealeveltest1/core/program-ids.json', 'sealeveltest2/core/keys/hyperlane_sealevel_igp-keypair.json', 'sealeveltest2/core/keys/hyperlane_sealevel_mailbox-keypair.json', 'sealeveltest2/core/keys/hyperlane_sealevel_multisig_ism_message_id-keypair.json', 'sealeveltest2/core/keys/hyperlane_sealevel_validator_announce-keypair.json', 'sealeveltest2/core/program-ids.json', 'sealeveltest3/core/keys/hyperlane_sealevel_igp-keypair.json', 'sealeveltest3/core/keys/hyperlane_sealevel_mailbox-keypair.json', 'sealeveltest3/core/keys/hyperlane_sealevel_multisig_ism_message_id-keypair.json', 'sealeveltest3/core/keys/hyperlane_sealevel_validator_announce-keypair.json', 'sealeveltest3/core/program-ids.json', 'warp-routes/testwarproute/keys/hyperlane_sealevel_token-sealeveltest2-keypair.json', 'warp-routes/testwarproute/keys/hyperlane_sealevel_token-sealeveltest3-keypair.json', 'warp-routes/testwarproute/keys/hyperlane_sealevel_token_native-sealeveltest1-keypair.json', 'warp-routes/testwarproute/program-ids.json', 'warp-routes/testwarproute/token-config.json')

SOURCE_SCOPES = ('rust/sealevel', 'rust/main/hyperlane-core',
                 'rust/main/applications/hyperlane-application',
                 'rust/main/Cargo.toml', 'rust/main/Cargo.lock')


def require(value, message):
    if not value:
        raise ValueError(message)


def pin(path):
    path = Path(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
            'SVM input must be a nonlinked regular file')
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path': str(path), 'bytes': info.st_size, 'sha256': digest}


def member(root, relative):
    value = PurePosixPath(relative)
    require(isinstance(relative, str) and relative and '\\' not in relative
            and str(value) == relative and not value.is_absolute()
            and '..' not in value.parts, 'Unsafe SVM member path')
    root = Path(root)
    require(root.is_absolute() and root.is_dir() and not root.is_symlink()
            and root.resolve() == root, 'Canonical nonlinked SVM root required')
    current = root
    for part in value.parts:
        current /= part
        require(not current.is_symlink(), 'SVM symlink path component')
    pin(current)
    return current


def closed_members(root, expected):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), 'SVM member root missing')
    files = set()
    pending = [root]
    count = 0
    while pending:
        for path in pending.pop().iterdir():
            count += 1
            require(count <= 512, 'SVM file/directory bound')
            info = path.lstat()
            require(not stat.S_ISLNK(info.st_mode), 'SVM member symlink')
            if stat.S_ISDIR(info.st_mode):
                pending.append(path)
            else:
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                        'SVM special/hardlinked member')
                files.add(path.relative_to(root).as_posix())
    require(files == set(expected), 'Missing/extra closed SVM member')


def elf_header(header, program):
    require(len(header) >= 64 and header[:7] == b'\x7fELF\x02\x01\x01'
            and (header[7] == 0 if program else header[7] in {0, 3}),
            'Linux SVM ELF64 little-endian System-V/GNU native header required')
    kind, machine = struct.unpack_from('<HH', header, 16)
    require((kind == 3 and machine in {247, 263}) if program else
            (kind in {2, 3} and machine == 62),
            'Linux SVM native/SBF ELF type or machine differs')
    return machine


def verify_file(path, expected, *, machine=None, executable=False):
    actual = pin(path)
    require((actual['bytes'], actual['sha256']) == tuple(expected[:2]),
            'SVM member bytes/hash differs')
    if executable:
        require(path.stat().st_mode & 0o111, 'SVM executable mode absent')
    if machine is not None:
        with path.open('rb') as stream:
            observed = elf_header(stream.read(64), machine != 62)
        require(observed == machine, 'Recorded SVM ELF machine differs')
    return actual


def inspect_export(directory, expected_source=SOURCE_COMMIT):
    """Read only an already safely extracted exact C11 artifact.

    The caller must bind the ZIP digest/ID/run and successful remote producer job
    before calling. Returned descriptors are data pins, never native admission.
    """
    directory = Path(directory)
    published = directory / 'published'
    require(isinstance(expected_source, str) and re.fullmatch('[0-9a-f]{40}', expected_source), 'Exact SVM producer Source required')
    result_path = member(directory, 'result.json')
    require(result_path.stat().st_size <= 4 * 1024**2, 'SVM producer result bound')
    result = json.loads(result_path.read_text())
    require(result.get('checkout_commit') == expected_source
            and result.get('passed') is True and result.get('Source_unchanged') is True
            and result.get('error') is None and result.get('owned_absent') is True
            and result.get('actual_owner_signals') == [] and result.get('forced_cleanup') is False,
            'Actual successful C11 owned producer evidence required')
    require(result.get('component_only') is True and result.get('native_case_credit') is False
            and result.get('linux_profile_admitted') is False and result.get('performance_credit') is False,
            'SVM prerequisite result must not invent native/performance credit')
    commands = result.get('commands')
    require(isinstance(commands, list) and len(commands) == 31
            and all(r.get('actual_wait_observed') is True and type(r.get('exit_code')) is int
                    and r['exit_code'] == 0 for r in commands),
            'Every actual C11 producer command must have successful wait')
    closed_members(published / 'agave', AGAVE)
    closed_members(published / 'programs', PROGRAMS)
    product_path = member(published, 'products.json')
    require(product_path.stat().st_size <= 65536, 'SVM product manifest bound')
    products = json.loads(product_path.read_text())
    require(products == result.get('products') and set(products) == {'programs', 'client', 'spl'}
            and set(products['programs']) == set(PROGRAMS),
            'Actual successful Source product manifest differs')
    def product_row(row, maximum, machine):
        require(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256', 'elf_class', 'elf_machine'}
                and type(row['bytes']) is int and 64 <= row['bytes'] <= maximum
                and isinstance(row['sha256'], str) and re.fullmatch('[0-9a-f]{64}', row['sha256'])
                and row['elf_class'] == 64 and row['elf_machine'] == machine,
                'Typed bounded SVM producer product required')
        return row['bytes'], row['sha256'], machine
    files = {}
    for name, expected in AGAVE.items():
        path = member(published, 'agave/' + name)
        files['agave/' + name] = verify_file(path, expected,
            machine=62 if name in {'bin/solana', 'bin/solana-test-validator'} else None)
    require(sum(r['bytes'] for n, r in files.items()) == AGAVE_BYTES,
            'Linux85 Agave total differs')
    for name, reference in PROGRAMS.items():
        expected = product_row(products['programs'][name], 32 * 1024**2, reference[2])
        files['programs/' + name] = verify_file(member(published, 'programs/' + name),
                                               expected, machine=expected[2])
    files['client/hyperlane-sealevel-client'] = verify_file(
        member(published, 'hyperlane-sealevel-client'), product_row(products['client'], 512 * 1024**2, 62), machine=62)
    files['home/.cargo/bin/spl-token'] = verify_file(
        member(published, 'spl-token'), product_row(products['spl'], 128 * 1024**2, 62), machine=62)
    return {'schema': 1, 'platform': PLATFORM, 'source_commit': expected_source,
            'producer_result': pin(result_path), 'product_manifest': pin(product_path), 'files': files,
            'native_case_acceptance': False, 'performance_credit': False,
            'nonfatal_stack_warnings_require_real_VM_execution': True,
            'transport_mode_normalization': 'Only new byte-verified owned copies receive exact publisher/native executable modes; extracted originals remain unchanged'}


def copy_owned(source, expected, destination, mode):
    """Exclusive, nonlinked copy; never changes the published Source bytes."""
    source = Path(source)
    destination = Path(destination)
    verify_file(source, (expected['bytes'], expected['sha256']))
    require(destination.is_absolute() and '..' not in destination.parts
            and not destination.exists() and not destination.is_symlink(),
            'Exclusive owned SVM destination required')
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    for parent in destination.parents:
        require(not parent.is_symlink(), 'SVM copy destination symlink parent')
    with source.open('rb') as src, destination.open('xb') as dst:
        for block in iter(lambda: src.read(1024**2), b''):
            dst.write(block)
        dst.flush()
        os.fsync(dst.fileno())
    destination.chmod(mode)
    actual = verify_file(destination, (expected['bytes'], expected['sha256']))
    require(stat.S_IMODE(destination.stat().st_mode) == mode, 'SVM copied mode differs')
    return actual


def stage_files(inspected, task_root):
    """Create only fixed owned SVM assets; public environment/gate comes later.

    No root_approved flag is manufactured here. A reviewed case request and exact
    source-cohort gate must still authorize this dataset before native execution.
    """
    require(inspected.get('platform') == PLATFORM and isinstance(inspected.get('source_commit'), str) and re.fullmatch('[0-9a-f]{40}', inspected['source_commit'])
            and inspected.get('native_case_acceptance') is False,
            'Validated C11 dataset required')
    expected = {'agave/' + n for n in AGAVE} | {'programs/' + n for n in PROGRAMS}
    expected |= {'client/hyperlane-sealevel-client', 'home/.cargo/bin/spl-token'}
    require(set(inspected['files']) == expected, 'Closed staged SVM file list differs')
    # Rebind every returned pin to the immutable actual producer manifest, not
    # a caller-mutated in-memory map or historical C11 binary aliases.
    product_pin = inspected.get('product_manifest')
    require(isinstance(product_pin, dict) and pin(Path(product_pin['path'])) == product_pin,
            'Pinned actual SVM product manifest required')
    products = json.loads(Path(product_pin['path']).read_text())
    for name, row in inspected['files'].items():
        if name.startswith('agave/'):
            expected_row = AGAVE[name[6:]][:2]
        else:
            wanted = products['programs'][name[9:]] if name.startswith('programs/') else products[
                'client' if name == 'client/hyperlane-sealevel-client' else 'spl']
            expected_row = wanted['bytes'], wanted['sha256']
        require((row.get('bytes'), row.get('sha256')) == tuple(expected_row),
                'Staged SVM descriptor differs from the actual pinned dataset')
    task_root = Path(task_root)
    require(task_root.is_absolute() and task_root.is_dir() and not task_root.is_symlink()
            and task_root.resolve() == task_root, 'Canonical owned task root required')
    svm_root = task_root / 'tools/svm'
    require(not svm_root.exists() and not svm_root.is_symlink(), 'New fixed SVM tools root required')
    records = {}
    for name, expected in inspected['files'].items():
        destination = task_root / name if name.startswith('home/') else svm_root / name
        mode = 0o755 if name in {'home/.cargo/bin/spl-token', 'client/hyperlane-sealevel-client'} else (
            AGAVE[name[6:]][2] if name.startswith('agave/') else 0o644)
        records[name] = copy_owned(Path(expected['path']), expected, destination, mode)
    closed_members(svm_root / 'agave', AGAVE)
    closed_members(svm_root / 'programs', PROGRAMS)
    return records


def source_environment(repo, source_before):
    """Verify the exact public Source25 fixture inputs, without exposing keys.

    source_before must come from the pinned successful prerequisite artifact.
    The caller separately proves all consumed compiled-input scopes and canonical
    locks unchanged. This function is data equality, never that compiled proof.
    """
    repo = Path(repo)
    records = {}
    for name in ENVIRONMENT:
        relative = 'rust/sealevel/environments/local-e2e/' + name
        expected = source_before.get(relative)
        require(isinstance(expected, dict) and set(expected) == {'path', 'bytes', 'sha256'},
                'Pinned producer public environment input missing')
        path = member(repo, relative)
        actual = pin(path)
        require((actual['bytes'], actual['sha256']) == (expected['bytes'], expected['sha256']),
                'Public Source environment input changed: ' + name)
        require(actual['bytes'] <= 1024**2, 'Public SVM environment input bound')
        records[name] = actual
    return records


def stage_environment(records, task_root):
    require(set(records) == set(ENVIRONMENT), 'Exact public Source25 environment inputs required')
    destination = Path(task_root) / 'tools/svm/environment-inputs'
    require(not destination.exists() and not destination.is_symlink(),
            'New fixed public environment input root required')
    output = {}
    for name in ENVIRONMENT:
        output[name] = copy_owned(Path(records[name]['path']), records[name], destination / name, 0o600)
    closed_members(destination, ENVIRONMENT)
    return output


def bundle(records, environment, task_root, component_gate):
    """Build schema2 descriptor only; no gate approval is generated here."""
    task_root = Path(task_root)
    require(set(environment) == set(ENVIRONMENT), 'Exact Source25 environment map required')
    require(set(records) == {'agave/' + n for n in AGAVE} | {'programs/' + n for n in PROGRAMS}
            | {'client/hyperlane-sealevel-client', 'home/.cargo/bin/spl-token'},
            'Exact staged Linux SVM dataset required')
    for name, row in records.items():
        expected = task_root / name if name.startswith('home/') else task_root / 'tools/svm' / name
        require(row['path'] == str(expected) and pin(expected) == row,
                'Staged SVM artifact changed or path differs')
    for name, row in environment.items():
        expected = task_root / 'tools/svm/environment-inputs' / name
        require(row['path'] == str(expected) and pin(expected) == row,
                'Staged public environment changed or path differs')
    require(pin(Path(component_gate['path'])) == component_gate,
            'Existing reviewed component gate descriptor required')
    return {'schema': 2, 'platform': PLATFORM, 'agave_version': '3.0.14',
            'platform_tools_version': 'v1.51', 'spl_release': '2024-08-23',
            'spl_token_revision': 'e101cca', 'root': str(task_root / 'tools/svm'),
            'agave_files': {name: records['agave/' + name] for name in AGAVE},
            'programs': {name: records['programs/' + name] for name in PROGRAMS},
            'client': records['client/hyperlane-sealevel-client'],
            'spl_token': records['home/.cargo/bin/spl-token'],
            'environment_inputs': environment, 'component_gate': component_gate}


def public_profile(scenario, payer):
    """Exact Source corpus and public account identity; no custody capability."""
    require(scenario in {'sealevel', 'sealevel-composite'}, 'Only exact Source SVM families')
    # Same public test-validator account on all three chains; never derive or copy
    # a signing key into case metadata. The Source25 staged keypair remains owned.
    require(payer == 'E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty',
            'Source public Sealevel payer differs')
    composite = scenario == 'sealevel-composite'
    names = ['sealeveltest1', 'sealeveltest2'] + ([] if composite else ['sealeveltest3'])
    return {'schema': 1, 'scenario': scenario, 'chain_names': names,
            'domain_names': {str(13375 + i): name for i, name in enumerate(names)},
            'initial_corpus': {'dispatches': 2 if composite else 13,
                               'deliveries': 2 if composite else 12,
                               'unpaid': 0 if composite else 1},
            'payments_supported': True,
            'relayer_addresses': {name: payer for name in names},
            'validator_addresses': {'sealeveltest1': '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'},
            # Actual Factory.cap(u64,maxInt(u64)) default, not an invented fee cap.
            'native_limits': {name: {'maximum_fee': 2**64 - 1} for name in names}}


def fixture_roles(scenario):
    require(scenario in {'sealevel', 'sealevel-composite'}, 'Exact SVM fixture graph required')
    return ['fixture-svm-SOL'] + (['fixture-docker'] if scenario == 'sealevel' else [])


def node_arguments(argv, task_root):
    """Validate Source argv; bind-address does not control RPC/PubSub in Agave3.0.14."""
    require(isinstance(argv, list) and argv and all(isinstance(v, str) for v in argv),
            'Native SVM argv required')
    pairs = [('--bind-address', '127.0.0.1'), ('--rpc-port', '8899'),
             ('--faucet-port', '9900'), ('--gossip-port', '8001'),
             ('--dynamic-port-range', '8002-8033'),
             ('--faucet-per-time-sol-cap', '0'), ('--faucet-per-request-sol-cap', '0')]
    for flag, expected in pairs:
        indices = [i for i, value in enumerate(argv) if value == flag]
        require(len(indices) == 1 and indices[0] + 1 < len(argv)
                and argv[indices[0] + 1] == expected, 'Source SVM argument differs: ' + flag)
    indices = [i for i, value in enumerate(argv) if value == '--ledger']
    require(len(indices) == 1 and indices[0] + 1 < len(argv), 'Exact owned SVM ledger required')
    ledger = Path(argv[indices[0] + 1])
    root = Path(task_root)
    require(ledger.is_absolute() and '..' not in ledger.parts
            and ledger.resolve(strict=True).is_relative_to(root)
            and not any(parent.is_symlink() for parent in [ledger, *ledger.parents]),
            'SVM ledger escaped owned case')
    return str(ledger)


def listener_rows(pid, raw, udp=False):
    """Exact owned PID/fd; IPv4 wildcard TCP only RPC8899/PubSub8900/faucet9900."""
    import ipaddress
    require(type(pid) is int and pid > 0 and isinstance(raw, str) and len(raw) <= 65536,
            'Bounded native SVM lsof observation required')
    seen_pid = False
    descriptor = None
    sockets = []
    for line in raw.splitlines():
        require(line, 'Empty native SVM lsof field')
        if line.startswith('p'):
            require(not seen_pid and line[1:].isdigit() and int(line[1:]) == pid,
                    'Foreign/duplicate native SVM listener PID')
            seen_pid = True
        elif line.startswith('f'):
            require(seen_pid and descriptor is None and line[1:].isdigit(),
                    'SVM socket needs a numeric fd')
            descriptor = int(line[1:])
        elif line.startswith('n'):
            require(seen_pid and descriptor is not None, 'SVM socket lacks PID/fd')
            descriptor = None
            value = line[1:]
            parts = value.split('->')
            require(len(parts) <= 2, 'Malformed SVM socket endpoint')
            parsed = []
            for text in parts:
                host, port = text.rsplit(':', 1)
                require(port.isdigit() and 0 < int(port) <= 65535, 'Invalid SVM socket port')
                host = host.strip('[]')
                if host == '*': host = '0.0.0.0'
                address = ipaddress.ip_address(host)
                parsed.append((address, int(port)))
            local = parsed[0]
            require((local[0].is_loopback and 8001 <= local[1] <= 8033) if udp else
                    (local[0].is_loopback or
                     (str(local[0]) == '0.0.0.0' and local[1] in (8899, 8900, 9900))),
                    'Native SVM listener escaped fixed local authority: '+json.dumps({
                        'udp':udp,'local_scope':'loopback' if local[0].is_loopback else 'wildcard' if local[0].is_unspecified else 'other',
                        'local_port':local[1],'connected':len(parsed)==2,
                        'peer_scope':None if len(parsed)==1 else 'loopback' if parsed[1][0].is_loopback else 'wildcard' if parsed[1][0].is_unspecified else 'other',
                        'peer_port':None if len(parsed)==1 else parsed[1][1]},sort_keys=True))
            require(not udp or len(parsed) == 1 or parsed[1][0].is_loopback,
                    'SVM UDP remote escaped loopback')
            require(udp or len(parsed) == 1, 'SVM TCP observation is not a listener')
            sockets.append((str(local[0]), local[1]))
        else:
            raise ValueError('Unknown native SVM lsof field')
    require(descriptor is None, 'Incomplete native SVM lsof observation')
    return sockets


def required_listener_rows(tcp, udp, *, allow_pending=False):
    """Only absent startup sockets may be pending; wrong bindings remain errors."""
    import ipaddress
    require(type(allow_pending) is bool, 'Literal startup-pending scope required')
    require(all(host == '0.0.0.0' for host, port in tcp if port in (8899, 8900, 9900)),
            'Actual SVM Source wildcard RPC/WS/faucet endpoints absent')
    tcp_ready = {('0.0.0.0', port) for port in (8899, 8900, 9900)} <= set(tcp)
    udp_ready = any(port == 8001 and ipaddress.ip_address(host).is_loopback for host, port in udp)
    if allow_pending and not (tcp_ready and udp_ready):
        return False
    require(tcp_ready, 'Actual SVM Source wildcard RPC/WS/faucet endpoints absent')
    require(udp_ready, 'Actual SVM loopback gossip endpoint absent')
    return True
