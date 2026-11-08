"""Closed Linux Tron CLI/package and TRE image admission; no native execution."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat

GIB=1024**3
SOURCE_IMAGE='tronbox/tre@sha256:f4332e11df12a9f360639a4546fd0465' '93909630fda48af00b30410c144342f0'
IMAGE_IDS={'amd64':'sha256:bf3a2b631ff2a1834530f69fcb90508c' '40970203aa1240b692223308cc90cae0','arm64':'sha256:a29467ffe0610ea009363aa2037650f0' '24d94ebd46ffa19507df97edc67bcab9'}
COMMAND=['./quickstart','v2.0.0']
CLI_POLICY={'schema':1,'name':'hyperlane','version':'45.1.0','node_version':'26.12.1','pnpm_version':'12.3.0','full_original_tsconfig':True,'EVM_solc':'0.8.33','TVM_solc':'0.8.24','owned_full_package_graph':True}
MUTABLE_REGISTRY=('test-configs/tron/chains/anvil1/addresses.yaml','test-configs/tron/chains/anvil2/addresses.yaml')
PACKAGE_ROOTS=('typescript/tsconfig', 'typescript/utils', 'solhint-plugin', 'solidity', 'typescript/provider-sdk', 'typescript/aleo-sdk', 'typescript/cosmos-types', 'typescript/cosmos-sdk', 'typescript/radix-sdk', 'typescript/forking-sdk', 'typescript/svm-sdk', 'starknet', 'typescript/starknet-sdk', 'typescript/tron-sdk', 'typescript/deploy-sdk', 'typescript/sdk', 'typescript/http-registry-server', 'typescript/metrics', 'typescript/keyfunder', 'typescript/relayer', 'typescript/rebalancer', 'typescript/infra', 'typescript/cli')
ROOT_PAYLOADS=('vectors','scripts','patches','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.nvmrc','turbo.json','.registryrc')
OPTIONAL_ROOT_PAYLOADS=('.npmrc','.pnpmfile.cjs')
SOURCE_SBF_DATA={'typescript/svm-sdk/src/testing/fixtures/spl_token_2022_v10.so':{'bytes':506896,'sha256':('a794161408080f690dac00832f45b3c3e' '2b71f1339586667ad1f979cf91d5b68'),'machine':263}}
NPM_PREBUILD_DATA={
    'node_modules/.pnpm/bufferutil@4.1.0/node_modules/bufferutil/prebuilds/darwin-arm64/bufferutil.node': {
        'package': 'bufferutil@4.1.0',
        'platform': 'darwin',
        'architectures': ['arm64'],
        'bytes': 34064,
        'sha256': ('688f957f5a989f6406e5caa26382e213' 'c8b7316eb600303307dc95be60c287c0'),
        'header20_hex': 'cffaedfe0c00000100000000080000000e000000',
        'mode': 420,
    },
    'node_modules/.pnpm/bufferutil@4.1.0/node_modules/bufferutil/prebuilds/darwin-x64/bufferutil.node': {
        'package': 'bufferutil@4.1.0',
        'platform': 'darwin',
        'architectures': ['x64'],
        'bytes': 9072,
        'sha256': ('f1c90f748d9149cc42f6a00fa846add1' '4c056403d2e67fc8179c1a53a4f22b1b'),
        'header20_hex': 'cffaedfe0700000103000000080000000c000000',
        'mode': 420,
    },
    'node_modules/.pnpm/bufferutil@4.1.0/node_modules/bufferutil/prebuilds/linux-x64/bufferutil.node': {
        'package': 'bufferutil@4.1.0',
        'platform': 'linux',
        'architectures': ['x64'],
        'bytes': 14584,
        'sha256': ('9d0bce137193c8630da7679759674236' '8798f72d1564d43be0d716ac74312bda'),
        'header20_hex': '7f454c4602010100000000000000000003003e00',
        'mode': 420,
    },
    'node_modules/.pnpm/bufferutil@4.1.0/node_modules/bufferutil/prebuilds/win32-ia32/bufferutil.node': {
        'package': 'bufferutil@4.1.0',
        'platform': 'win32',
        'architectures': ['ia32'],
        'bytes': 129024,
        'sha256': ('d3cc72764c09f4b2a7f885f5167811fd' '22dd3728b59bb1a18fa5a6f504317689'),
        'header20_hex': '4d5a90000300000004000000ffff0000b8000000',
        'mode': 420,
    },
    'node_modules/.pnpm/bufferutil@4.1.0/node_modules/bufferutil/prebuilds/win32-x64/bufferutil.node': {
        'package': 'bufferutil@4.1.0',
        'platform': 'win32',
        'architectures': ['x64'],
        'bytes': 155136,
        'sha256': ('9bf6ec4d84b75403a50f22d9bdba2cfb' '287f12472374c9d5eb736c963a997ee9'),
        'header20_hex': '4d5a90000300000004000000ffff0000b8000000',
        'mode': 420,
    },
    'node_modules/.pnpm/utf-8-validate@5.0.10/node_modules/utf-8-validate/prebuilds/darwin-x64+arm64/node.napi.node': {
        'package': 'utf-8-validate@5.0.10',
        'platform': 'darwin',
        'architectures': ['x64', 'arm64'],
        'bytes': 116000,
        'sha256': ('0ed3fef7154849143b7b064d33e32b33' '9b86590c0f5719cee8b46b150e83a3e5'),
        'header20_hex': 'cafebabe00000002010000070000000300004000',
        'mode': 420,
    },
    'node_modules/.pnpm/utf-8-validate@5.0.10/node_modules/utf-8-validate/prebuilds/linux-x64/node.napi.node': {
        'package': 'utf-8-validate@5.0.10',
        'platform': 'linux',
        'architectures': ['x64'],
        'bytes': 6232,
        'sha256': ('08c0737834fb5c2ca38efe64e274c107' '2d7edd18415275f9e0573df5bcdd0e27'),
        'header20_hex': '7f454c4602010100000000000000000003003e00',
        'mode': 420,
    },
    'node_modules/.pnpm/utf-8-validate@5.0.10/node_modules/utf-8-validate/prebuilds/win32-ia32/node.napi.node': {
        'package': 'utf-8-validate@5.0.10',
        'platform': 'win32',
        'architectures': ['ia32'],
        'bytes': 121856,
        'sha256': ('0808ab542c43b9df85b668a02f070552' '9b7bb9ac79e26b0776682657c6005352'),
        'header20_hex': '4d5a90000300000004000000ffff0000b8000000',
        'mode': 420,
    },
    'node_modules/.pnpm/utf-8-validate@5.0.10/node_modules/utf-8-validate/prebuilds/win32-x64/node.napi.node': {
        'package': 'utf-8-validate@5.0.10',
        'platform': 'win32',
        'architectures': ['x64'],
        'bytes': 150528,
        'sha256': ('48b7275f47cd44a05d349eb4fdb6cfc4' '51ccbf609a4a56fa34452bcf231c1208'),
        'header20_hex': '4d5a90000300000004000000ffff0000b8000000',
        'mode': 420,
    },
    'node_modules/.pnpm/utf-8-validate@6.0.6/node_modules/utf-8-validate/prebuilds/linux-x64/utf-8-validate.musl.node': {
        'package': 'utf-8-validate@6.0.6',
        'platform': 'linux',
        'architectures': ['x64'],
        'bytes': 34656,
        'sha256': ('2c52b81a656cda0a9f874f8ce163f2cc' 'ad60707391a50ff23738e48d657287ee'),
        'header20_hex': '7f454c4602010100000000000000000003003e00',
        'mode': 420,
    },
    'node_modules/.pnpm/utf-8-validate@6.0.6/node_modules/utf-8-validate/prebuilds/darwin-arm64/utf-8-validate.node': {
        'package': 'utf-8-validate@6.0.6',
        'platform': 'darwin',
        'architectures': ['arm64'],
        'bytes': 36256,
        'sha256': ('3aa78e7e2eda10bb968a98f96d713981' 'fa6e9316efce0c750af1b3e8fe50170f'),
        'header20_hex': 'cffaedfe0c00000100000000080000000e000000',
        'mode': 420,
    },
    'node_modules/.pnpm/utf-8-validate@6.0.6/node_modules/utf-8-validate/prebuilds/darwin-x64/utf-8-validate.node': {
        'package': 'utf-8-validate@6.0.6',
        'platform': 'darwin',
        'architectures': ['x64'],
        'bytes': 20216,
        'sha256': ('84d42dc1e7d811271d803d2374aeb1d2' '439d02a2a2b9cfd59b190d9acd73cac4'),
        'header20_hex': 'cffaedfe0700000103000000080000000c000000',
        'mode': 420,
    },
    'node_modules/.pnpm/utf-8-validate@6.0.6/node_modules/utf-8-validate/prebuilds/linux-x64/utf-8-validate.node': {
        'package': 'utf-8-validate@6.0.6',
        'platform': 'linux',
        'architectures': ['x64'],
        'bytes': 31200,
        'sha256': ('428fa0b3a3c52ddf28cce7d4ad95a680' '23200f9514328d2d0e4a11f0633d3610'),
        'header20_hex': '7f454c4602010100000000000000000003003e00',
        'mode': 420,
    },
    'node_modules/.pnpm/utf-8-validate@6.0.6/node_modules/utf-8-validate/prebuilds/win32-ia32/utf-8-validate.node': {
        'package': 'utf-8-validate@6.0.6',
        'platform': 'win32',
        'architectures': ['ia32'],
        'bytes': 139264,
        'sha256': ('0fc404bf0e45866c66c99d5fce490446' 'e8b0703af57f10c7e5292db28ac98ecd'),
        'header20_hex': '4d5a90000300000004000000ffff0000b8000000',
        'mode': 420,
    },
    'node_modules/.pnpm/utf-8-validate@6.0.6/node_modules/utf-8-validate/prebuilds/win32-x64/utf-8-validate.node': {
        'package': 'utf-8-validate@6.0.6',
        'platform': 'win32',
        'architectures': ['x64'],
        'bytes': 174592,
        'sha256': ('563ad0209336017a68e14d40fa8964f0' '9021ed33cccc6b26414e1331b4fead99'),
        'header20_hex': '4d5a90000300000004000000ffff0000b8000000',
        'mode': 420,
    },
    'node_modules/.pnpm/@trufflesuite+bigint-buffer@1.1.9/node_modules/@trufflesuite/bigint-buffer/prebuilds/darwin-x64/node.napi.node': {'package': '@trufflesuite/bigint-buffer@1.1.9', 'platform': 'darwin', 'architectures': ['x64'], 'bytes': 34088, 'sha256': ('fce720ccc5a4217e05c283a61b925074' '420ca66d8a7ce5dedf63f2cc0e54ce3d'), 'header20_hex': 'cffaedfe0700000103000000080000000d000000', 'mode': 420},
    'node_modules/.pnpm/@trufflesuite+bigint-buffer@1.1.9/node_modules/@trufflesuite/bigint-buffer/prebuilds/linux-x64/node.napi.node': {'package': '@trufflesuite/bigint-buffer@1.1.9', 'platform': 'linux', 'architectures': ['x64'], 'bytes': 14640, 'sha256': ('e39405c5e0712cff82bd5e8f5709e077' '3b315c784003f1560d9ee6743dd1b950'), 'header20_hex': '7f454c4602010100000000000000000003003e00', 'mode': 420},
    'node_modules/.pnpm/@trufflesuite+bigint-buffer@1.1.9/node_modules/@trufflesuite/bigint-buffer/prebuilds/win32-x64/node.napi.node': {'package': '@trufflesuite/bigint-buffer@1.1.9', 'platform': 'win32', 'architectures': ['x64'], 'bytes': 150528, 'sha256': ('8f73d12ef98aef14b1f4f4f67f73166a' 'b6d9124b15a90f5e460337f1487cf877'), 'header20_hex': '4d5a90000300000004000000ffff0000b8000000', 'mode': 420},
}
NPM_PREBUILD_LOADERS={
    'bufferutil@4.1.0': {
        'root': 'node_modules/.pnpm/bufferutil@4.1.0/node_modules/bufferutil',
        'files': {
            'index.js': {
                'bytes': 136,
                'sha256': ('70846a43c2bd3b1077461563194e4d24' '07b18e7d767d6fd8785ea9b7d6ddd044'),
            },
            'package.json': {
                'bytes': 815,
                'sha256': ('73f8333d4bf76ac969c65581b8017f56' 'ec579a0346d6beef1d0bcc88d5174474'),
            },
        },
    },
    'utf-8-validate@5.0.10': {
        'root': 'node_modules/.pnpm/utf-8-validate@5.0.10/node_modules/utf-8-validate',
        'files': {
            'index.js': {
                'bytes': 136,
                'sha256': ('70846a43c2bd3b1077461563194e4d24' '07b18e7d767d6fd8785ea9b7d6ddd044'),
            },
            'package.json': {
                'bytes': 947,
                'sha256': ('4638f6a95ec1fca2a158f8a5989bc90a' '898f4e267588f3c13d7ca052b9b94b94'),
            },
        },
    },
    'utf-8-validate@6.0.6': {
        'root': 'node_modules/.pnpm/utf-8-validate@6.0.6/node_modules/utf-8-validate',
        'files': {
            'index.js': {
                'bytes': 136,
                'sha256': ('70846a43c2bd3b1077461563194e4d24' '07b18e7d767d6fd8785ea9b7d6ddd044'),
            },
            'package.json': {
                'bytes': 1199,
                'sha256': ('75c6c1c5441fcc22114f12ddd202de79' '7f606c1dc056f6c5181ed0abd4cda329'),
            },
        },
    },
    '@trufflesuite/bigint-buffer@1.1.9': {'root': 'node_modules/.pnpm', 'files': {'@trufflesuite+bigint-buffer@1.1.9/node_modules/@trufflesuite/bigint-buffer/package.json': {'bytes': 2875, 'sha256': ('bf66841b3059cbc1f2dd872b205abe0e' 'fd543de288224b3343cdb5d7e0b360c6')}, '@trufflesuite+bigint-buffer@1.1.9/node_modules/@trufflesuite/bigint-buffer/dist/node.js': {'bytes': 2579, 'sha256': ('c0e8dc3bf640856cbbe2b1bc16fd6a24' '2eda429c74abd7daebb43128a697036d')}, '@trufflesuite+bigint-buffer@1.1.9/node_modules/node-gyp-build/package.json': {'bytes': 772, 'sha256': ('7c4e373dd5c75c2c25edbaafdef7ef5d' 'bda6f1e80c0319f46ec27f8c20b28654')}, '@trufflesuite+bigint-buffer@1.1.9/node_modules/node-gyp-build/index.js': {'bytes': 5859, 'sha256': ('ede0167b54af835e768c2bc81ca7deaa' 'c035b8766620f6a34fb840cee0f1fecf')}}},
}
NPM_EDR_DATA={'node_modules/.pnpm/@nomicfoundation+edr-darwin-arm64@0.12.0-next.23/node_modules/@nomicfoundation/edr-darwin-arm64/edr.darwin-arm64.node': {'platform': 'darwin',
                                                                                                                                              'architecture': 'arm64',
                                                                                                                                              'bytes': 21472160,
                                                                                                                                              'sha256': ('cffdeee018ea297d63ca2c09e8b00348' 'cdc575825e36e97d1d70c075626bd024'),
                                                                                                                                              'header20_hex': 'cffaedfe0c000001000000000600000014000000',
                                                                                                                                              'package_manifest': 'node_modules/.pnpm/@nomicfoundation+edr-darwin-arm64@0.12.0-next.23/node_modules/@nomicfoundation/edr-darwin-arm64/package.json',
                                                                                                                                              'package_manifest_pin': {'bytes': 319,
                                                                                                                                                                       'sha256': ('852bac6c7a3c6c64ff2430c16623f5a6' 'e401c02c9de3d3c3355ec05b7ea8370e')}},
 'node_modules/.pnpm/@nomicfoundation+edr-darwin-x64@0.12.0-next.23/node_modules/@nomicfoundation/edr-darwin-x64/edr.darwin-x64.node': {'platform': 'darwin',
                                                                                                                                        'architecture': 'amd64',
                                                                                                                                        'bytes': 25615972,
                                                                                                                                        'sha256': ('a32054d40ab1bdc0850490a68cf23e34' '41c278da229273232efd3a1cfde84c5f'),
                                                                                                                                        'header20_hex': 'cffaedfe07000001030000000600000012000000',
                                                                                                                                        'package_manifest': 'node_modules/.pnpm/@nomicfoundation+edr-darwin-x64@0.12.0-next.23/node_modules/@nomicfoundation/edr-darwin-x64/package.json',
                                                                                                                                        'package_manifest_pin': {'bytes': 313,
                                                                                                                                                                 'sha256': ('288f7dfc8ab0877146f70a0ad47394d9' 'cf6ba5e0d7eac92f86a9ed9ba7429c18')}},
 'node_modules/.pnpm/@nomicfoundation+edr-linux-arm64-gnu@0.12.0-next.23/node_modules/@nomicfoundation/edr-linux-arm64-gnu/edr.linux-arm64-gnu.node': {'platform': 'linux',
                                                                                                                                                       'architecture': 'arm64',
                                                                                                                                                       'bytes': 34649712,
                                                                                                                                                       'sha256': ('17e6d355e924c5aa05b0e162ab63a15f' '62833408f03913aec497c886d8163ebc'),
                                                                                                                                                       'header20_hex': '7f454c460201010000000000000000000300b700',
                                                                                                                                                       'package_manifest': 'node_modules/.pnpm/@nomicfoundation+edr-linux-arm64-gnu@0.12.0-next.23/node_modules/@nomicfoundation/edr-linux-arm64-gnu/package.json',
                                                                                                                                                       'package_manifest_pin': {'bytes': 328,
                                                                                                                                                                                'sha256': ('f252ea1534448e09198fb725840a1d58' '65517dbaf3ebe81c8f6bec971bc05931')}},
 'node_modules/.pnpm/@nomicfoundation+edr-linux-arm64-musl@0.12.0-next.23/node_modules/@nomicfoundation/edr-linux-arm64-musl/edr.linux-arm64-musl.node': {'platform': 'linux',
                                                                                                                                                          'architecture': 'arm64',
                                                                                                                                                          'bytes': 34707344,
                                                                                                                                                          'sha256': ('1e6af38c03c23c7868032b9c16e782da' 'a7bc57872fd42edb138aee98b59a38ee'),
                                                                                                                                                          'header20_hex': '7f454c460201010000000000000000000300b700',
                                                                                                                                                          'package_manifest': 'node_modules/.pnpm/@nomicfoundation+edr-linux-arm64-musl@0.12.0-next.23/node_modules/@nomicfoundation/edr-linux-arm64-musl/package.json',
                                                                                                                                                          'package_manifest_pin': {'bytes': 331,
                                                                                                                                                                                   'sha256': ('ca01c09f5f9555836ec423bd9d4a8628' '6e2a66076aee94f16ca7a589b8b6895f')}},
 'node_modules/.pnpm/@nomicfoundation+edr-linux-x64-gnu@0.12.0-next.23/node_modules/@nomicfoundation/edr-linux-x64-gnu/edr.linux-x64-gnu.node': {'platform': 'linux',
                                                                                                                                                 'architecture': 'amd64',
                                                                                                                                                 'bytes': 38264024,
                                                                                                                                                 'sha256': ('cf163a301fcabbe14a0a915ed12af317' 'f10e973463dc6b335e88212ac8e2cf11'),
                                                                                                                                                 'header20_hex': '7f454c4602010100000000000000000003003e00',
                                                                                                                                                 'package_manifest': 'node_modules/.pnpm/@nomicfoundation+edr-linux-x64-gnu@0.12.0-next.23/node_modules/@nomicfoundation/edr-linux-x64-gnu/package.json',
                                                                                                                                                 'package_manifest_pin': {'bytes': 322,
                                                                                                                                                                          'sha256': ('82721bb2f2b8d54b4a28a94364bef161' 'e6187c551b6a7441b83c8dcc8ebffcbd')}},
 'node_modules/.pnpm/@nomicfoundation+edr-linux-x64-musl@0.12.0-next.23/node_modules/@nomicfoundation/edr-linux-x64-musl/edr.linux-x64-musl.node': {'platform': 'linux',
                                                                                                                                                    'architecture': 'amd64',
                                                                                                                                                    'bytes': 38322128,
                                                                                                                                                    'sha256': ('da36f32e01c046352ae26583770e5aae' '83c5c4025e194a304107975d9448b3e2'),
                                                                                                                                                    'header20_hex': '7f454c4602010100000000000000000003003e00',
                                                                                                                                                    'package_manifest': 'node_modules/.pnpm/@nomicfoundation+edr-linux-x64-musl@0.12.0-next.23/node_modules/@nomicfoundation/edr-linux-x64-musl/package.json',
                                                                                                                                                    'package_manifest_pin': {'bytes': 325,
                                                                                                                                                                             'sha256': ('b5e7e7e79e9431a1f8c8d72ba0237657' '03a12148dc9e4a25cb8504cce176f21f')}},
 'node_modules/.pnpm/@nomicfoundation+edr-win32-x64-msvc@0.12.0-next.23/node_modules/@nomicfoundation/edr-win32-x64-msvc/edr.win32-x64-msvc.node': {'platform': 'win32',
                                                                                                                                                    'architecture': 'amd64',
                                                                                                                                                    'bytes': 25113600,
                                                                                                                                                    'sha256': ('d17fb5896b4644c590f34a4be5983f50' 'e630ec2c1ed0083e75b2446e3a43b25e'),
                                                                                                                                                    'header20_hex': '4d5a90000300000004000000ffff0000b8000000',
                                                                                                                                                    'package_manifest': 'node_modules/.pnpm/@nomicfoundation+edr-win32-x64-msvc@0.12.0-next.23/node_modules/@nomicfoundation/edr-win32-x64-msvc/package.json',
                                                                                                                                                    'package_manifest_pin': {'bytes': 325,
                                                                                                                                                                             'sha256': ('cd485bb32745e74dc3dfd414a0979cc7' '007658764a2714646aec88b31e6d66c7')}}}
NPM_EDR_LOADER={'root': 'node_modules/.pnpm/@nomicfoundation+edr@0.12.0-next.23/node_modules/@nomicfoundation/edr',
 'files': {'index.js': {'bytes': 14711,
                        'sha256': ('d62c2566498c3883b3809e4ece1569a4' 'fb9cac66d048c223c498e1535ca47614')},
           'package.json': {'bytes': 3166,
                            'sha256': ('0ef28b78df13aa3075004e72a377563e' '30b427e58d0fc1783cb998fc3579c7f3')}}}
MAX_FILES=200000
MAX_BYTES=4*GIB
MAX_UNSUPPORTED_ROWS=512
MAX_UNSUPPORTED_REPORT_BYTES=512*1024


def require(value,message):
    if not value:raise ValueError(message)


def pin(path):
    require(path.is_file()and not path.is_symlink(),'Regular nonsymlink Tron input required')
    with path.open('rb')as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    return {'path':str(path),'bytes':path.stat().st_size,'sha256':digest}


def checked(row):
    require(isinstance(row,dict)and set(row)=={'path','bytes','sha256'},'Exact Tron artifact descriptor required')
    path=Path(row['path']);require(path.is_absolute()and '..'not in path.parts and pin(path)==row,'Tron artifact changed');return path


def validate_policy(prerequisites,architecture):
    require(architecture in IMAGE_IDS and prerequisites['tron_cli']==CLI_POLICY and all(type(prerequisites['tron_cli'][key])is type(expected)for key,expected in CLI_POLICY.items()),'Exact Source CLI45.1.0/Node26.12.1/pnpm12.3.0/full build policy required')
    row=prerequisites['tron_tre'];require(set(row)=={'schema','architecture','source_image','canonical_digest','image_id','command','entrypoint'}and type(row['schema'])is int and row['schema']==2 and row['architecture']==architecture and row['source_image']==row['canonical_digest']==SOURCE_IMAGE and row['image_id']==IMAGE_IDS[architecture]and row['command']==COMMAND and row['entrypoint']is None,'Exact official native-platform TRE2.0.0 identity required')
    return row


def image_inspect(rows,policy):
    require(isinstance(rows,list)and len(rows)==2,'Inspect both immutable Source reference and native config ID')
    validate_policy({'tron_cli':CLI_POLICY,'tron_tre':policy},policy['architecture'])
    for row in rows:
        require(row.get('Id')==policy['image_id']and row.get('Os')=='linux'and row.get('Architecture')==policy['architecture']and SOURCE_IMAGE in row.get('RepoDigests',[])and row.get('Config',{}).get('Cmd')==COMMAND and row['Config'].get('Entrypoint')is None,'Actual TRE ID/RepoDigest/platform/entrypoint differs')
        require(not row['Config'].get('Volumes'),'Unaccounted image volumes rejected')


def cli_source(repo):
    package=json.loads((repo/'typescript/cli/package.json').read_text())
    require(package['name']=='@hyperlane-xyz/cli'and package['version']=='45.1.0'and package['scripts']['hyperlane']=='node ./dist/cli.js','Exact full CLI package/entrypoint required')
    require((repo/'typescript/cli/src/version.ts').read_text().strip()=="export const VERSION = '45.1.0';",'Do not run version:update or rewrite VERSION')
    require(json.loads((repo/'package.json').read_text())['packageManager'].split('+',1)[0]=='pnpm@12.3.0','Exact pnpm lock consumer required')
    require((repo/'.nvmrc').read_text().strip().lstrip('v')=='26.12.1','Exact actual Node prerequisite required')
    for name in ['anvil1','anvil2']:
        path=repo/'typescript/cli/test-configs/tron/chains'/name/'metadata.yaml';text=path.read_text()
        require('chainId: 3360022319'in text and 'domainId: '+str(1212538670+(name=='anvil2'))in text and 'protocol: tron'in text and 'http://127.0.0.1:9090/jsonrpc'in text,'Actual two-chain TRE9090 Source corpus differs')
    return package



def source_SBF_data(relative,row,mode,header):
    policy=SOURCE_SBF_DATA.get(relative)
    if policy is None:return False
    require(row['bytes']==policy['bytes']and row['sha256']==policy['sha256']and stat.S_IMODE(mode)==0o644,'Exact immutable nonexecutable Source SBF fixture required')
    require(header[:8]==b'\x7fELF\x02\x01\x01\x00'and int.from_bytes(header[16:18],'little')==3 and int.from_bytes(header[18:20],'little')==policy['machine'],'Exact Source SBF data header required')
    return True



def unselected_prebuild_data(repo,relative,row,mode,header,architecture):
    policy=NPM_PREBUILD_DATA.get(relative)
    if policy is None:return False
    require(row['bytes']==policy['bytes']and row['sha256']==policy['sha256']and stat.S_IMODE(mode)==policy['mode']and header[:20].hex()==policy['header20_hex'],'Exact Source-locked prebuild payload required')
    loader=NPM_PREBUILD_LOADERS[policy['package']]
    for name,expected in loader['files'].items():
        value=pin(repo/loader['root']/name)
        require(value['bytes']==expected['bytes']and value['sha256']==expected['sha256'],'Source-locked platform-selecting package loader changed')
    # Current Linux host addons stay subject to all existing native ELF checks.
    return policy['platform']!='linux'or{'amd64':'x64','arm64':'arm64'}[architecture]not in policy['architectures']


def unselected_EDR_data(repo,relative,row,mode,header,architecture):
    policy=NPM_EDR_DATA.get(relative)
    if policy is None:return False
    require(architecture in {'amd64','arm64'},'Exact Linux EDR host architecture required')
    # The pinned NAPI selector gates platform+arch BEFORE its libc branch.
    # Both same-arch Linux GNU/musl candidates retain normal host ELF checks.
    if policy['platform']=='linux'and policy['architecture']==architecture:return False
    require(row['bytes']==policy['bytes']and row['sha256']==policy['sha256']and stat.S_IMODE(mode)==0o644 and header.hex()==policy['header20_hex'],'Exact nonexecutable Source-locked dormant EDR payload required')
    for name,expected in NPM_EDR_LOADER['files'].items():
        actual=pin(repo/NPM_EDR_LOADER['root']/name)
        require(all(actual[key]==expected[key]for key in ('bytes','sha256')),'Source EDR platform/architecture selector changed')
    actual=pin(repo/policy['package_manifest']);expected=policy['package_manifest_pin']
    require(all(actual[key]==expected[key]for key in ('bytes','sha256')),'Source EDR platform package identity changed')
    return True


def payload_diagnostic(relative,row,header):
    require(len(relative)<=4096,'Bounded package payload name required')
    return json.dumps({'path':relative,'bytes':row['bytes'],'sha256':row['sha256'],'header20_hex':header[:20].hex(),'ELF_class':header[4]if len(header)>4 else None,'ELF_endian':header[5]if len(header)>5 else None,'ELF_machine':int.from_bytes(header[18:20],'little')if len(header)>=20 else None},sort_keys=True,separators=(',',':'))


def graph(repo,package_roots,architecture):
    """Pin every installed payload/link, internal package and compiled CLI output.

    Never follow a workspace link during enumeration. Targets must resolve into
    this ONE Linux workspace; there are no borrowed Mac products or old SDKs.
    """
    require(repo.is_absolute()and not repo.is_symlink()and repo.resolve()==repo and architecture in IMAGE_IDS,'Canonical Linux package root required')
    require(list(package_roots)==list(PACKAGE_ROOTS),'Exact ordered full CLI package closure required');roots=['node_modules',*package_roots,*ROOT_PAYLOADS,*[name for name in OPTIONAL_ROOT_PAYLOADS if(repo/name).exists()]]
    for name in package_roots:
        require(not Path(name).is_absolute()and '..'not in Path(name).parts,'Closed relative workspace packages required')
        require((repo/name/'package.json').is_file(),'Workspace package manifest missing')
    entries={};total=0;unsupported=[];stack=[repo/name for name in roots]
    while stack:
        path=stack.pop();relative=str(path.relative_to(repo));require(len(entries)<MAX_FILES,'Bounded full CLI graph file count')
        if relative in entries:continue
        require(path.exists()or path.is_symlink(),'Missing full installed dependency graph')
        mode=path.lstat().st_mode
        if stat.S_ISLNK(mode):
            target=os.readlink(path);require(not os.path.isabs(target)and path.resolve(strict=True).is_relative_to(repo),'External/absolute/dangling graph link rejected')
            entries[relative]={'kind':'symlink','target':target,'resolved':str(path.resolve().relative_to(repo))}
        elif stat.S_ISDIR(mode):
            entries[relative]={'kind':'directory'}
            for child in sorted(path.iterdir(),reverse=True):
                if child.name!='.git':stack.append(child)
        else:
            require(stat.S_ISREG(mode),'Special package payload rejected')
            row=pin(path);total+=row['bytes'];require(total<=MAX_BYTES,'Full Linux CLI copies exceed original4GiB case cap')
            with path.open('rb')as source:header=source.read(20)
            guest_data=source_SBF_data(relative,row,mode,header);foreign_data=unselected_prebuild_data(repo,relative,row,mode,header,architecture)or unselected_EDR_data(repo,relative,row,mode,header,architecture);data_only=guest_data or foreign_data
            if not data_only:
                reasons=[]
                if header[:4]in {b'\xcf\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xca\xfe\xba\xbe',b'\xbe\xba\xfe\xca'}:reasons.append('Mac executable payload cannot be a Linux package product')
                if header[:4]==b'\x7fELF'and not(header[4:6]==b'\x02\x01'and int.from_bytes(header[18:20],'little')=={'amd64':62,'arm64':183}[architecture]):reasons.append('Foreign native dependency payload')
                if path.suffix=='.node'and header[:4]!=b'\x7fELF':reasons.append('Native addon must be actual Linux ELF')
                if reasons:
                    # Diagnostic only: all existing unsafe-link, exact Source
                    # pin, file-count and byte guards remain immediate failures.
                    unsupported.append({**json.loads(payload_diagnostic(relative,row,header)),'mode':stat.S_IMODE(mode),'reasons':reasons})
                    require(len(unsupported)<=MAX_UNSUPPORTED_ROWS and len(json.dumps(unsupported,separators=(',',':')).encode())<=MAX_UNSUPPORTED_REPORT_BYTES,'Unsupported native payload inventory bound exceeded; complete=false; admission=false')
            entries[relative]={'kind':'file','bytes':row['bytes'],'sha256':row['sha256'],'mode':stat.S_IMODE(mode),**({'Source_SBF_data_only':True}if guest_data else {}),**({'unselected_Source_locked_platform_data':True}if foreign_data else {})}
    require('typescript/cli/dist/cli.js'in entries and any(n.startswith('solidity/dist/tron/typechain/factories/')for n in entries)and 'solidity/dist/buildArtifact.json'in entries,'Actual CLI/core EVM/TVM artifacts required')
    for row in entries.values():
        if row['kind']=='symlink':require(row['resolved']in entries,'Symlink target missing from complete admitted graph')
    if unsupported:
        report={'schema':1,'kind':'unsupported-native-payload-inventory','complete':True,'admission':False,'native_case_acceptance':False,'count':len(unsupported),'entries':sorted(unsupported,key=lambda value:value['path'])}
        wire=json.dumps(report,sort_keys=True,separators=(',',':'));require(len(wire.encode())<=MAX_UNSUPPORTED_REPORT_BYTES,'Unsupported native payload inventory report bound exceeded; complete=false; admission=false')
        raise ValueError('Unsupported native dependency payload inventory: '+wire)
    return {'schema':1,'architecture':architecture,'root':str(repo),'package_roots':package_roots,'entries':dict(sorted(entries.items())),'regular_payload_bytes':total,'native_case_acceptance':False,'scope':'Full exact Linux workspace/package closure, not SDK/CLI evaluation or native delivery'}


def verify_graph(value):
    require(value['schema']==1 and value['native_case_acceptance']is False,'Exact non-native package receipt required')
    actual=graph(Path(value['root']),value['package_roots'],value['architecture']);require(actual==value,'Installed Linux CLI graph changed');return actual


def read_graph(row):
    path=checked(row);require(path.stat().st_size<=64*1024**2,'Bounded CLI payload manifest required');value=json.loads(path.read_text());verify_graph(value);return value


def copy_charge(value,fragment):
    require(type(fragment)is int and 0<fragment<=1024**2,'Actual bounded target filesystem fragment required')
    def charge(name,row):
        if row['kind']=='file':return max(fragment,((row['bytes']+fragment-1)//fragment)*fragment)
        return fragment
    total=sum(charge(name,row)for name,row in value['entries'].items())
    prefixes=('typescript/cli/dist/','typescript/cli/test-configs/tron/')
    total+=sum(charge(name,row)for name,row in value['entries'].items()if name.startswith(prefixes)or name=='typescript/cli/package.json')
    # Root dirs plus bounded graph/copy/required-input metadata. The original
    # owner additionally charges exact2GiB PG tmpfs; reserve it BEFORE copying.
    return total+32*fragment+256*1024**2


def materialize(value,destination,existing_case_allocated):
    verify_graph(value);source=Path(value['root']);require(destination.is_absolute()and not destination.exists()and not destination.is_symlink(),'Fresh owned case/tron-cli copy required')
    charge=copy_charge(value,os.statvfs(destination.parent).f_frsize)
    require(shutil.disk_usage(destination.parent).free>=6*GIB+charge,'Full owned CLI copies must preserve6GiB floor')
    require(type(existing_case_allocated)is int and existing_case_allocated>=0 and existing_case_allocated+charge+2*GIB<=MAX_BYTES,'Existing case/CLI allocation/metadata plus2GiB PG tmpfs exceeds original4GiB cap')
    destination.mkdir(mode=0o700);workspace=destination/'.workspace';workspace.mkdir()
    for name,row in value['entries'].items():
        path=workspace/name
        if row['kind']=='directory':path.mkdir(parents=True,exist_ok=True)
        elif row['kind']=='file':
            path.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/name,path);path.chmod(row['mode']);require(pin(path)['sha256']==row['sha256'],'Owned CLI payload changed during copy')
        else:path.parent.mkdir(parents=True,exist_ok=True);path.symlink_to(row['target'])
    copied={**value,'root':str(workspace)};verify_graph(copied)
    # The Rust checked_owned_path entrypoint has NO symlink parent. pnpm package
    # resolution may use only relative links into the already pinned own graph.
    shutil.copytree(workspace/'typescript/cli/dist',destination/'dist',symlinks=False)
    shutil.copytree(workspace/'typescript/cli/test-configs/tron',destination/'test-configs/tron',symlinks=False)
    shutil.copyfile(workspace/'typescript/cli/package.json',destination/'package.json')
    (destination/'node_modules').symlink_to('.workspace/typescript/cli/node_modules')
    immutable=[]
    for root in [destination/'dist',destination/'test-configs/tron']:
        for path in sorted(root.rglob('*')):
            require(not path.is_symlink(),'CLI data/dist may not introduce link parents')
            if path.is_file()and str(path.relative_to(destination))not in MUTABLE_REGISTRY:immutable.append(pin(path))
    immutable.append(pin(destination/'package.json'))
    return {'schema':1,'root':str(destination),'workspace':copied,'entrypoint':pin(destination/'dist/cli.js'),'immutable_files':immutable,'mutable_registry_slots':[str(destination/name)for name in MUTABLE_REGISTRY],'native_case_acceptance':False}


def verify_materialized(value):
    require(value['schema']==1 and value['native_case_acceptance']is False,'Owned CLI graph receipt required');root=Path(value['root']);require(root.is_absolute()and not root.is_symlink(),'Owned CLI root differs');verify_graph(value['workspace'])
    require((root/'node_modules').is_symlink()and os.readlink(root/'node_modules')=='.workspace/typescript/cli/node_modules','Owned CLI dependency alias changed')
    checked(value['entrypoint'])
    for row in value['immutable_files']:checked(row)
    require(value['mutable_registry_slots']==[str(root/name)for name in MUTABLE_REGISTRY],'Only the two Source registry address files may mutate')
    actual=[]
    for base in [root/'dist',root/'test-configs/tron']:
        for path in sorted(base.rglob('*')):
            require(not path.is_symlink(),'CLI writable registry/dist link appeared')
            if path.is_file()and str(path.relative_to(root))not in MUTABLE_REGISTRY:actual.append(pin(path))
    actual.append(pin(root/'package.json'));require(actual==value['immutable_files'],'Owned CLI new/removed/changed immutable payload')
    require({path.name for path in root.iterdir()}=={'.workspace','dist','test-configs','package.json','node_modules'},'Unexpected CLI root mutation')
    return value


def read_materialized(row):
    path=checked(row);require(path.stat().st_size<=64*1024**2,'Bounded owned CLI closure required');return verify_materialized(json.loads(path.read_text()))
