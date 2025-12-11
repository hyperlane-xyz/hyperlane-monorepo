import { ValidatorBaseChainConfigMap } from '../../../src/config/agent/validator.js';
import { Contexts } from '../../contexts.js';
import { getReorgPeriod } from '../../registry.js';
import { validatorBaseConfigsFn } from '../utils.js';

import { environment } from './chains.js';

export const validatorChainConfig = (
  context: Contexts,
): ValidatorBaseChainConfigMap => {
  const validatorsConfig = validatorBaseConfigsFn(environment, context);
  return {
    ancient8: {
      interval: 5,
      reorgPeriod: getReorgPeriod('ancient8'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xbb5842ae0e05215b53df4787a29144efb7e67551'],
          [Contexts.ReleaseCandidate]: [
            '0xaae4d879a04e3d8b956eb4ffbefd57fdbed09cae',
          ],
          [Contexts.Neutron]: [],
        },
        'ancient8',
      ),
    },
    celo: {
      interval: 5,
      reorgPeriod: getReorgPeriod('celo'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x63478422679303c3e4fc611b771fa4a707ef7f4a'],
          [Contexts.ReleaseCandidate]: [
            '0xb51768c1388e976486a43dbbbbf9ce04cf45e990',
            '0x6325de37b33e20089c091950518a471e29c52883',
            '0xd796c1d4fcfb3c63acfa6e4113aa6ae1399b337c',
          ],
          [Contexts.Neutron]: [],
        },
        'celo',
      ),
    },
    ethereum: {
      interval: 5,
      reorgPeriod: getReorgPeriod('ethereum'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x03c842db86a6a3e524d4a6615390c1ea8e2b9541'],
          [Contexts.ReleaseCandidate]: [
            '0x0580884289890805802012b9872afa5ae41a5fa6',
            '0xa5465cb5095a2e6093587e644d6121d6ed55c632',
            '0x87cf8a85465118aff9ec728ca157798201b1e368',
          ],
          [Contexts.Neutron]: [],
        },
        'ethereum',
      ),
    },
    avalanche: {
      interval: 5,
      reorgPeriod: getReorgPeriod('avalanche'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3fb8263859843bffb02950c492d492cae169f4cf'],
          [Contexts.ReleaseCandidate]: [
            '0x2c7cf6d1796e37676ba95f056ff21bf536c6c2d3',
            '0xcd250d48d16e2ce4b939d44b5215f9e978975152',
            '0x26691cd3e9c1b8a82588606b31d9d69b14cb2729',
          ],
          [Contexts.Neutron]: [],
        },
        'avalanche',
      ),
    },
    worldchain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('worldchain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x31048785845325b22817448b68d08f8a8fe36854'],
          [Contexts.ReleaseCandidate]: [
            '0x385a2452930a0681d3ea4e40fb7722095142afcc',
          ],
          [Contexts.Neutron]: [],
        },
        'worldchain',
      ),
    },
    xlayer: {
      interval: 5,
      reorgPeriod: getReorgPeriod('xlayer'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xa2ae7c594703e988f23d97220717c513db638ea3'],
          [Contexts.ReleaseCandidate]: [
            '0xa68e98cb98190485847581c8004b40ee81cbc723',
          ],
          [Contexts.Neutron]: [],
        },
        'xlayer',
      ),
    },
    polygon: {
      interval: 5,
      reorgPeriod: getReorgPeriod('polygon'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x12ecb319c7f4e8ac5eb5226662aeb8528c5cefac'],
          [Contexts.ReleaseCandidate]: [
            '0xf0a990959f833ccde624c8bcd4c7669286a57a0f',
            '0x456b636bdde99d69176261d7a4fba42c16f57f56',
            '0xe78d3681d4f59e0768be8b1171f920ed4d52409f',
          ],
          [Contexts.Neutron]: [],
        },
        'polygon',
      ),
    },
    bsc: {
      interval: 5,
      reorgPeriod: getReorgPeriod('bsc'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x570af9b7b36568c8877eebba6c6727aa9dab7268'],
          [Contexts.ReleaseCandidate]: [
            '0x911dfcc19dd5b723e84be452f6af52adef020bc8',
            '0xee2d4fd5fe2170e51c6279552297117feaeb19e1',
            '0x50ff94984161976a13e9ec3b2a7647da5319448f',
          ],
          [Contexts.Neutron]: [],
        },
        'bsc',
      ),
    },
    arbitrum: {
      interval: 5,
      reorgPeriod: getReorgPeriod('arbitrum'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4d966438fe9e2b1e7124c87bbb90cb4f0f6c59a1'],
          [Contexts.ReleaseCandidate]: [
            '0xb4c18167c163391facb345bb069d12d0430a6a89',
            '0x2f6dc057ae079997f76205903b85c8302164a78c',
            '0x229d4dc6a740212da746b0e35314419a24bc2a5b',
          ],
          [Contexts.Neutron]: [],
        },
        'arbitrum',
      ),
    },
    optimism: {
      interval: 5,
      reorgPeriod: getReorgPeriod('optimism'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x20349eadc6c72e94ce38268b96692b1a5c20de4f'],
          [Contexts.ReleaseCandidate]: [
            '0x7e4391786e0b5b0cbaada12d32c931e46e44f104',
            '0x138ca73e805afa14e85d80f6e35c46e6f235429e',
            '0x2d58cdb2bed9aac57b488b1bad06839ddc280a78',
          ],
          [Contexts.Neutron]: [],
        },
        'optimism',
      ),
    },
    osmosis: {
      interval: 5,
      reorgPeriod: getReorgPeriod('osmosis'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xea483af11c19fa41b16c31d1534c2a486a92bcac'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'osmosis',
      ),
    },
    moonbeam: {
      interval: 5,
      reorgPeriod: getReorgPeriod('moonbeam'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x2225e2f4e9221049456da93b71d2de41f3b6b2a8'],
          [Contexts.ReleaseCandidate]: [
            '0x75e3cd4e909089ae6c9f3a42b1468b33eec84161',
            '0xc28418d0858a82a46a11e07db75f8bf4eed43881',
            '0xcaa9c6e6efa35e4a8b47565f3ce98845fa638bf3',
          ],
          [Contexts.Neutron]: [],
        },
        'moonbeam',
      ),
    },
    gnosis: {
      interval: 5,
      reorgPeriod: getReorgPeriod('gnosis'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xd4df66a859585678f2ea8357161d896be19cc1ca'],
          [Contexts.ReleaseCandidate]: [
            '0xd5122daa0c3dfc94a825ae928f3ea138cdb6a2e1',
            '0x2d1f367e942585f8a1c25c742397dc8be9a61dee',
            '0x2111141b7f985d305f392c502ad52dd74ef9c569',
          ],
          [Contexts.Neutron]: [],
        },
        'gnosis',
      ),
    },
    base: {
      interval: 5,
      reorgPeriod: getReorgPeriod('base'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xb9453d675e0fa3c178a17b4ce1ad5b1a279b3af9'],
          [Contexts.ReleaseCandidate]: [
            '0xa8363570749080c7faa1de714e0782ff444af4cc',
            '0x3b55d9febe02a9038ef8c867fa8bbfdd8d70f9b8',
            '0xed7703e06572768bb09e03d88e6b788d8800b9fb',
          ],
          [Contexts.Neutron]: [],
        },
        'base',
      ),
    },
    bob: {
      interval: 5,
      reorgPeriod: getReorgPeriod('bob'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x20f283be1eb0e81e22f51705dcb79883cfdd34aa'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'bob',
      ),
    },
    injective: {
      interval: 5,
      reorgPeriod: getReorgPeriod('injective'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xbfb8911b72cfb138c7ce517c57d9c691535dc517'],
          [Contexts.ReleaseCandidate]: [
            '0xca024623ee6fe281639aee91c4390b0c4e053918',
          ],
          [Contexts.Neutron]: [],
        },
        'injective',
      ),
    },
    inevm: {
      interval: 5,
      reorgPeriod: getReorgPeriod('inevm'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xf9e35ee88e4448a3673b4676a4e153e3584a08eb'],
          [Contexts.ReleaseCandidate]: [
            '0x52a0376903294c796c091c785a66c62943d99aa8',
            '0xc2ea1799664f753bedb9872d617e3ebc60b2e0ab',
            '0xe83d36fd00d9ef86243d9f7147b29e98d11df0ee',
          ],
          [Contexts.Neutron]: [],
        },
        'inevm',
      ),
    },
    fraxtal: {
      interval: 5,
      reorgPeriod: getReorgPeriod('fraxtal'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4bce180dac6da60d0f3a2bdf036ffe9004f944c1'],
          [Contexts.ReleaseCandidate]: [
            '0x8c772b730c8deb333dded14cb462e577a06283da',
          ],
          [Contexts.Neutron]: [],
        },
        'fraxtal',
      ),
    },
    linea: {
      interval: 5,
      reorgPeriod: getReorgPeriod('linea'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xf2d5409a59e0f5ae7635aff73685624904a77d94'],
          [Contexts.ReleaseCandidate]: [
            '0xad4886b6f5f5088c7ae53b69d1ff5cfc2a17bec4',
          ],
          [Contexts.Neutron]: [],
        },
        'linea',
      ),
    },
    mantle: {
      interval: 5,
      reorgPeriod: getReorgPeriod('mantle'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xf930636c5a1a8bf9302405f72e3af3c96ebe4a52'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'mantle',
      ),
    },
    sei: {
      interval: 5,
      reorgPeriod: getReorgPeriod('sei'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x9920d2dbf6c85ffc228fdc2e810bf895732c6aa5'],
          [Contexts.ReleaseCandidate]: [
            '0x846e48a7e85e5403cc690a347e1ad3c3dca11b6e',
          ],
          [Contexts.Neutron]: [],
        },
        'sei',
      ),
    },
    scroll: {
      interval: 5,
      reorgPeriod: getReorgPeriod('scroll'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xad557170a9f2f21c35e03de07cb30dcbcc3dff63'],
          [Contexts.ReleaseCandidate]: [
            '0x11387d89856219cf685f22781bf4e85e00468d54',
            '0x64b98b96ccae6e660ecf373b5dd61bcc34fd19ee',
            '0x07c2f32a402543badc3141f6b98969d75ef2ac28',
          ],
          [Contexts.Neutron]: [],
        },
        'scroll',
      ),
    },
    solanamainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('solanamainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x28464752829b3ea59a497fca0bdff575c534c3ff'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'solanamainnet',
      ),
    },
    eclipsemainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('eclipsemainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xebb52d7eaa3ff7a5a6260bfe5111ce52d57401d0'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'eclipsemainnet',
      ),
    },
    taiko: {
      interval: 5,
      reorgPeriod: getReorgPeriod('taiko'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xa930073c8f2d0b2f7423ea32293e0d1362e65d79'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'taiko',
      ),
    },
    polygonzkevm: {
      interval: 5,
      reorgPeriod: getReorgPeriod('polygonzkevm'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x86f2a44592bb98da766e880cfd70d3bbb295e61a'],
          [Contexts.ReleaseCandidate]: [
            '0x75cffb90391d7ecf58a84e9e70c67e7b306211c0',
            '0x82c10acb56f3d7ed6738b61668111a6b5250283e',
            '0x1cd73544c000fd519784f56e59bc380a5fef53d6',
          ],
          [Contexts.Neutron]: [],
        },
        'polygonzkevm',
      ),
    },
    paradex: {
      interval: 5,
      reorgPeriod: getReorgPeriod('paradex'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x0ede747b84071ac24b60c08f8d59ad55d23f8a5c'],
        },
        'paradex',
      ),
    },
    neutron: {
      interval: 5,
      reorgPeriod: getReorgPeriod('neutron'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xa9b8c1f4998f781f958c63cfcd1708d02f004ff0'],
          [Contexts.ReleaseCandidate]: [
            '0x307a8fe091b8273c7ce3d277b161b4a2167279b1',
            '0xb825c1bd020cb068f477b320f591b32e26814b5b',
            '0x0a5b31090d4c3c207b9ea6708f938e328f895fce',
          ],
          [Contexts.Neutron]: [],
        },
        'neutron',
      ),
    },
    mantapacific: {
      interval: 5,
      reorgPeriod: getReorgPeriod('mantapacific'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x8e668c97ad76d0e28375275c41ece4972ab8a5bc'],
          [Contexts.ReleaseCandidate]: [
            '0x84fcb05e6e5961df2dfd9f36e8f2b3e87ede7d76',
            '0x45f3e2655a08feda821ee7b495cf2595401e1569',
            '0x4cfccfd66dbb702b643b56f6986a928ed1b50c7e',
          ],
          [Contexts.Neutron]: [],
        },
        'mantapacific',
      ),
    },
    viction: {
      interval: 5,
      reorgPeriod: getReorgPeriod('viction'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x1f87c368f8e05a85ef9126d984a980a20930cb9c'],
          [Contexts.ReleaseCandidate]: [
            '0xe858971cd865b11d3e8fb6b6af72db0d85881baf',
            '0xad94659e2383214e4a1c4e8d3c17caffb75bc31b',
            '0x0f9e5775ac4d3b73dd28e5a3f8394443186cb70c',
          ],
          [Contexts.Neutron]: [],
        },
        'viction',
      ),
    },
    blast: {
      interval: 5,
      reorgPeriod: getReorgPeriod('blast'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xf20c0b09f597597c8d2430d3d72dfddaf09177d1'],
          [Contexts.ReleaseCandidate]: [
            '0x5b32f226e472da6ca19abfe1a29d5d28102a2d1a',
          ],
          [Contexts.Neutron]: [],
        },
        'blast',
      ),
    },
    mode: {
      interval: 5,
      reorgPeriod: getReorgPeriod('mode'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x7eb2e1920a4166c19d6884c1cec3d2cf356fc9b7'],
          [Contexts.ReleaseCandidate]: [
            '0x2f04ed30b1c27ef8e9e6acd360728d9bd5c3a9e2',
          ],
          [Contexts.Neutron]: [],
        },
        'mode',
      ),
    },
    redstone: {
      interval: 5,
      reorgPeriod: getReorgPeriod('redstone'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x1400b9737007f7978d8b4bbafb4a69c83f0641a7'],
          [Contexts.ReleaseCandidate]: [
            '0x51ed7127c0afc0513a0f141e910c5e02b2a9a4b5',
          ],
          [Contexts.Neutron]: [],
        },
        'redstone',
      ),
    },
    zetachain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('zetachain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xa3bca0b80317dbf9c7dce16a16ac89f4ff2b23ef'],
          [Contexts.ReleaseCandidate]: [
            '0xa13d146b47242671466e4041f5fe68d22a2ffe09',
          ],
          [Contexts.Neutron]: [],
        },
        'zetachain',
      ),
    },
    endurance: {
      interval: 5,
      reorgPeriod: getReorgPeriod('endurance'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x28c5b322da06f184ebf68693c5d19df4d4af13e5'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'endurance',
      ),
    },
    fusemainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('fusemainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x770c8ec9aac8cec4b2ead583b49acfbc5a1cf8a9'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'fusemainnet',
      ),
    },
    zoramainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('zoramainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x35130945b625bb69b28aee902a3b9a76fa67125f'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'zoramainnet',
      ),
    },
    zircuit: {
      interval: 5,
      reorgPeriod: getReorgPeriod('zircuit'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x169ec400cc758fef3df6a0d6c51fbc6cdd1015bb'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'zircuit',
      ),
    },
    cyber: {
      interval: 5,
      reorgPeriod: getReorgPeriod('cyber'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x94d7119ceeb802173b6924e6cc8c4cd731089a27'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'cyber',
      ),
    },
    degenchain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('degenchain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x433e311f19524cd64fb2123ad0aa1579a4e1fc83'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'degenchain',
      ),
    },
    lisk: {
      interval: 5,
      reorgPeriod: getReorgPeriod('lisk'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xc0b282aa5bac43fee83cf71dc3dd1797c1090ea5'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'lisk',
      ),
    },
    lukso: {
      interval: 5,
      reorgPeriod: getReorgPeriod('lukso'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xa5e953701dcddc5b958b5defb677a829d908df6d'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'lukso',
      ),
    },
    merlin: {
      interval: 5,
      reorgPeriod: getReorgPeriod('merlin'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xc1d6600cb9326ed2198cc8c4ba8d6668e8671247'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'merlin',
      ),
    },
    metis: {
      interval: 5,
      reorgPeriod: getReorgPeriod('metis'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xc4a3d25107060e800a43842964546db508092260'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'metis',
      ),
    },
    mint: {
      interval: 5,
      reorgPeriod: getReorgPeriod('mint'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xfed01ccdd7a65e8a6ad867b7fb03b9eb47777ac9'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'mint',
      ),
    },
    tangle: {
      interval: 5,
      reorgPeriod: getReorgPeriod('tangle'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x1ee52cbbfacd7dcb0ba4e91efaa6fbc61602b15b'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'tangle',
      ),
    },
    xai: {
      interval: 5,
      reorgPeriod: getReorgPeriod('xai'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xe993f01fea86eb64cda45ae5af1d5be40ac0c7e9'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'xai',
      ),
    },
    astar: {
      interval: 5,
      reorgPeriod: getReorgPeriod('astar'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4d1b2cade01ee3493f44304653d8e352c66ec3e7'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'astar',
      ),
    },
    bitlayer: {
      interval: 5,
      reorgPeriod: getReorgPeriod('bitlayer'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x1d9b0f4ea80dbfc71cb7d64d8005eccf7c41e75f'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'bitlayer',
      ),
    },
    coredao: {
      interval: 5,
      reorgPeriod: getReorgPeriod('coredao'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xbd6e158a3f5830d99d7d2bce192695bc4a148de2'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'coredao',
      ),
    },
    dogechain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('dogechain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xe43f742c37858746e6d7e458bc591180d0cba440'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'dogechain',
      ),
    },
    flare: {
      interval: 5,
      reorgPeriod: getReorgPeriod('flare'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xb65e52be342dba3ab2c088ceeb4290c744809134'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'flare',
      ),
    },
    molten: {
      interval: 5,
      reorgPeriod: getReorgPeriod('molten'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xad5aa33f0d67f6fa258abbe75458ea4908f1dc9f'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'molten',
      ),
    },
    shibarium: {
      interval: 5,
      reorgPeriod: getReorgPeriod('shibarium'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xfa33391ee38597cbeef72ccde8c9e13e01e78521'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'shibarium',
      ),
    },
    everclear: {
      interval: 5,
      reorgPeriod: getReorgPeriod('everclear'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xeff20ae3d5ab90abb11e882cfce4b92ea6c74837'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'everclear',
      ),
    },
    oortmainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('oortmainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x9b7ff56cd9aa69006f73f1c5b8c63390c706a5d7'],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'oortmainnet',
      ),
    },
    zeronetwork: {
      interval: 5,
      reorgPeriod: getReorgPeriod('zeronetwork'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x1bd9e3f8a90ea1a13b0f2838a1858046368aad87'],
        },
        'zeronetwork',
      ),
    },
    zksync: {
      interval: 5,
      reorgPeriod: getReorgPeriod('zksync'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xadd1d39ce7a687e32255ac457cf99a6d8c5b5d1a'],
        },
        'zksync',
      ),
    },
    apechain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('apechain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x773d7fe6ffb1ba4de814c28044ff9a2d83a48221'],
        },
        'apechain',
      ),
    },
    arbitrumnova: {
      interval: 5,
      reorgPeriod: getReorgPeriod('arbitrumnova'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xd2a5e9123308d187383c87053811a2c21bd8af1f'],
        },
        'arbitrumnova',
      ),
    },
    b3: {
      interval: 5,
      reorgPeriod: getReorgPeriod('b3'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xd77b516730a836fc41934e7d5864e72c165b934e'],
        },
        'b3',
      ),
    },
    fantom: {
      interval: 5,
      reorgPeriod: getReorgPeriod('fantom'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xa779572028e634e16f26af5dfd4fa685f619457d'],
        },
        'fantom',
      ),
    },
    gravity: {
      interval: 5,
      reorgPeriod: getReorgPeriod('gravity'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x23d549bf757a02a6f6068e9363196ecd958c974e'],
        },
        'gravity',
      ),
    },
    harmony: {
      interval: 5,
      reorgPeriod: getReorgPeriod('harmony'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xd677803a67651974b1c264171b5d7ca8838db8d5'],
        },
        'harmony',
      ),
    },
    kaia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('kaia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x9de0b3abb221d19719882fa4d61f769fdc2be9a4'],
        },
        'kaia',
      ),
    },
    morph: {
      interval: 5,
      reorgPeriod: getReorgPeriod('morph'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4884535f393151ec419add872100d352f71af380'],
        },
        'morph',
      ),
    },
    orderly: {
      interval: 5,
      reorgPeriod: getReorgPeriod('orderly'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xec3dc91f9fa2ad35edf5842aa764d5573b778bb6'],
        },
        'orderly',
      ),
    },
    chilizmainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('chilizmainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x7403e5d58b48b0f5f715d9c78fbc581f01a625cb'],
        },
        'chilizmainnet',
      ),
    },
    flowmainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('flowmainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xe132235c958ca1f3f24d772e5970dd58da4c0f6e'],
        },
        'flowmainnet',
      ),
    },
    immutablezkevmmainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('immutablezkevmmainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xbdda85b19a5efbe09e52a32db1a072f043dd66da'],
        },
        'immutablezkevmmainnet',
      ),
    },
    metal: {
      interval: 5,
      reorgPeriod: getReorgPeriod('metal'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xd9f7f1a05826197a93df51e86cefb41dfbfb896a'],
        },
        'metal',
      ),
    },
    polynomialfi: {
      interval: 5,
      reorgPeriod: getReorgPeriod('polynomialfi'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x23d348c2d365040e56f3fee07e6897122915f513'],
        },
        'polynomialfi',
      ),
    },
    rarichain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('rarichain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xeac012df7530720dd7d6f9b727e4fe39807d1516'],
        },
        'rarichain',
      ),
    },
    superpositionmainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('superpositionmainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3f489acdd341c6b4dd86293fa2cc5ecc8ccf4f84'],
        },
        'superpositionmainnet',
      ),
    },
    prom: {
      interval: 5,
      reorgPeriod: getReorgPeriod('prom'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xb0c4042b7c9a95345be8913f4cdbf4043b923d98'],
        },
        'prom',
      ),
    },
    boba: {
      interval: 5,
      reorgPeriod: getReorgPeriod('boba'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xebeb92c94ca8408e73aa16fd554cb3a7df075c59'],
        },
        'boba',
      ),
    },
    superseed: {
      interval: 5,
      reorgPeriod: getReorgPeriod('superseed'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xdc2b87cb555411bb138d3a4e5f7832c87fae2b88'],
        },
        'superseed',
      ),
    },
    unichain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('unichain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x9773a382342ebf604a2e5de0a1f462fb499e28b1'],
        },
        'unichain',
      ),
    },
    vana: {
      interval: 5,
      reorgPeriod: getReorgPeriod('vana'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xfdf3b0dfd4b822d10cacb15c8ae945ea269e7534'],
        },
        'vana',
      ),
    },
    bsquared: {
      interval: 5,
      reorgPeriod: getReorgPeriod('bsquared'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xcadc90933c9fbe843358a4e70e46ad2db78e28aa'],
        },
        'bsquared',
      ),
    },
    lumiaprism: {
      interval: 5,
      reorgPeriod: getReorgPeriod('lumiaprism'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xb69731640ffd4338a2c9358a935b0274c6463f85'],
        },
        'lumiaprism',
      ),
    },
    swell: {
      interval: 5,
      reorgPeriod: getReorgPeriod('swell'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4f51e4f4c7fb45d82f91568480a1a2cfb69216ed'],
        },
        'swell',
      ),
    },
    appchain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('appchain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x0531251bbadc1f9f19ccce3ca6b3f79f08eae1be'],
        },
        'appchain',
      ),
    },
    aurora: {
      interval: 5,
      reorgPeriod: getReorgPeriod('aurora'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x37105aec3ff37c7bb0abdb0b1d75112e1e69fa86'],
        },
        'aurora',
      ),
    },
    form: {
      interval: 5,
      reorgPeriod: getReorgPeriod('form'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x58554b2e76167993b5fc000d0070a2f883cd333a'],
        },
        'form',
      ),
    },
    ink: {
      interval: 5,
      reorgPeriod: getReorgPeriod('ink'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xb533b8b104522958b984fb258e0684dec0f1a6a5'],
        },
        'ink',
      ),
    },
    soneium: {
      interval: 5,
      reorgPeriod: getReorgPeriod('soneium'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xd4b7af853ed6a2bfc329ecef545df90c959cbee8'],
        },
        'soneium',
      ),
    },
    sonic: {
      interval: 5,
      reorgPeriod: getReorgPeriod('sonic'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xa313d72dbbd3fa51a2ed1611ea50c37946fa42f7'],
        },
        'sonic',
      ),
    },
    soon: {
      interval: 5,
      reorgPeriod: getReorgPeriod('soon'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x0E6723b3C1eD3Db0C24347AA2cf16D28BC2a1F76'],
        },
        'soon',
      ),
    },
    stride: {
      interval: 5,
      reorgPeriod: getReorgPeriod('stride'),
      validators: validatorsConfig(
        {
          [Contexts.ReleaseCandidate]: [
            '0x1edadb2330c77769a7e9b48d990289ccdcafa430',
          ],
        },
        'stride',
      ),
    },
    torus: {
      interval: 5,
      reorgPeriod: getReorgPeriod('torus'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x96982a325c28a842bc8cf61b63000737bb9f1f7d'],
        },
        'torus',
      ),
    },
    artela: {
      interval: 5,
      reorgPeriod: getReorgPeriod('artela'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x8fcc1ebd4c0b463618db13f83e4565af3e166b00'],
        },
        'artela',
      ),
    },
    hemi: {
      interval: 5,
      reorgPeriod: getReorgPeriod('hemi'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x312dc72c17d01f3fd0abd31dd9b569bc473266dd'],
        },
        'hemi',
      ),
    },
    abstract: {
      interval: 5,
      reorgPeriod: getReorgPeriod('abstract'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x2ef8ece5b51562e65970c7d36007baa43a1de685'],
        },
        'abstract',
      ),
    },
    matchain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('matchain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x8a052f7934b0626105f34f980c875ec03aaf82e8'],
        },
        'matchain',
      ),
    },
    sonicsvm: {
      interval: 5,
      reorgPeriod: getReorgPeriod('sonicsvm'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xf21f46905d8d09f76bc8c503f856e5466bc5ffea'],
        },
        'sonicsvm',
      ),
    },
    berachain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('berachain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x0190915c55d9c7555e6d2cb838f04d18b5e2260e'],
        },
        'berachain',
      ),
    },
    arcadia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('arcadia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xe16ee9618f138cc2dcf9f9a95462099a8bf33a38'],
        },
        'arcadia',
      ),
    },
    ronin: {
      interval: 5,
      reorgPeriod: getReorgPeriod('ronin'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xa3e11929317e4a871c3d47445ea7bb8c4976fd8a'],
        },
        'ronin',
      ),
    },
    sophon: {
      interval: 5,
      reorgPeriod: getReorgPeriod('sophon'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xb84c5d02120ed0b39d0f78bbc0e298d89ebcd10b'],
        },
        'sophon',
      ),
    },
    starknet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('starknet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x61204c987d1121175a74e04d5045ab708aa1489f'],
        },
        'starknet',
      ),
    },
    story: {
      interval: 5,
      reorgPeriod: getReorgPeriod('story'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x501eda013378c60557d763df98d617b6ba55447a'],
        },
        'story',
      ),
    },
    subtensor: {
      interval: 5,
      reorgPeriod: getReorgPeriod('subtensor'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xd5f8196d7060b85bea491f0b52a671e05f3d10a2'],
        },
        'subtensor',
      ),
    },
    hyperevm: {
      interval: 5,
      reorgPeriod: getReorgPeriod('hyperevm'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x01be14a9eceeca36c9c1d46c056ca8c87f77c26f'],
          [Contexts.ReleaseCandidate]: [
            '0x95b460edc770f53981c9aa82aa2a297af619cabf',
          ],
        },
        'hyperevm',
      ),
    },
    plume: {
      interval: 5,
      reorgPeriod: getReorgPeriod('plume'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x63c9b5ea28710d956a51f0f746ee8df81215663f'],
        },
        'plume',
      ),
    },
    coti: {
      interval: 5,
      reorgPeriod: getReorgPeriod('coti'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c89379537f8beafc54e7e8ab4f8a1cf7974b9f0'],
        },
        'coti',
      ),
    },
    nibiru: {
      interval: 5,
      reorgPeriod: getReorgPeriod('nibiru'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xba9779d84a8efba1c6bc66326d875c3611a24b24'],
        },
        'nibiru',
      ),
    },
    opbnb: {
      interval: 5,
      reorgPeriod: getReorgPeriod('opbnb'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x1bdf52749ef2411ab9c28742dea92f209e96c9c4'],
        },
        'opbnb',
      ),
    },
    reactive: {
      interval: 5,
      reorgPeriod: getReorgPeriod('reactive'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x45768525f6c5ca2e4e7cc50d405370eadee2d624'],
        },
        'reactive',
      ),
    },
    milkyway: {
      interval: 5,
      reorgPeriod: getReorgPeriod('milkyway'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x9985e0c6df8e25b655b46a317af422f5e7756875'],
        },
        'milkyway',
      ),
    },
    hashkey: {
      interval: 5,
      reorgPeriod: getReorgPeriod('hashkey'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x55007cab8788cdba22844e7a2499cf43347f487a'],
        },
        'hashkey',
      ),
    },
    ontology: {
      interval: 5,
      reorgPeriod: getReorgPeriod('ontology'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x2578b0a330c492e1a1682684e27e6a93649befd5'],
        },
        'ontology',
      ),
    },
    fluence: {
      interval: 5,
      reorgPeriod: getReorgPeriod('fluence'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xabc8dd7594783c90a3c0fb760943f78c37ea6d75'],
        },
        'fluence',
      ),
    },
    peaq: {
      interval: 5,
      reorgPeriod: getReorgPeriod('peaq'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x7f7fe70b676f65097e2a1e2683d0fc96ea8fea49'],
        },
        'peaq',
      ),
    },
    svmbnb: {
      interval: 5,
      reorgPeriod: getReorgPeriod('svmbnb'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xabcd4dac2d06ae30c011d25b0c2c193873116a14'],
        },
        'svmbnb',
      ),
    },
    miraclechain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('miraclechain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x8fc655174e99194399822ce2d3a0f71d9fc2de7b'],
        },
        'miraclechain',
      ),
    },
    kyve: {
      interval: 5,
      reorgPeriod: getReorgPeriod('kyve'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x8576ddc0cd96325f85528e53f333357afb8bf044'],
        },
        'kyve',
      ),
    },
    botanix: {
      interval: 5,
      reorgPeriod: getReorgPeriod('botanix'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xc944176bc4d4e5c7b0598884478a27a2b1904664'],
        },
        'botanix',
      ),
    },
    katana: {
      interval: 5,
      reorgPeriod: getReorgPeriod('katana'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xf23003ebdc6c53765d52b1fe7a65046eabb0e73b'],
        },
        'katana',
      ),
    },
    solaxy: {
      interval: 5,
      reorgPeriod: getReorgPeriod('solaxy'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4fa10dd6d854cd05f57bacf6f46d1a72eb1396e5'],
        },
        'solaxy',
      ),
    },
    tac: {
      interval: 5,
      reorgPeriod: getReorgPeriod('tac'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x606561d6a45188ba0a486e513e440bfc421dbc36'],
        },
        'tac',
      ),
    },
    galactica: {
      interval: 5,
      reorgPeriod: getReorgPeriod('galactica'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xfc48af3372d621f476c53d79d42a9e96ce11fd7d'],
        },
        'galactica',
      ),
    },
    xrplevm: {
      interval: 5,
      reorgPeriod: getReorgPeriod('xrplevm'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x14d3e2f28d60d54a1659a205cb71e6e440f06510'],
        },
        'xrplevm',
      ),
    },
    noble: {
      interval: 5,
      reorgPeriod: getReorgPeriod('noble'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x28495e5c72a7dafd1658e5d99dfeffaada175c46'],
        },
        'noble',
      ),
    },
    celestia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('celestia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x6dbc192c06907784fb0af0c0c2d8809ea50ba675'],
        },
        'celestia',
      ),
    },
    mitosis: {
      interval: 5,
      reorgPeriod: getReorgPeriod('mitosis'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3b3eb808d90a4e19bb601790a6b6297812d6a61f'],
        },
        'mitosis',
      ),
    },
    radix: {
      interval: 5,
      reorgPeriod: getReorgPeriod('radix'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xa715a7cd97f68caeedb7be64f9e1da10f8ffafb4'],
        },
        'radix',
      ),
    },
    pulsechain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('pulsechain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xa73fc7ebb2149d9c6992ae002cb1849696be895b'],
        },
        'pulsechain',
      ),
    },
    plasma: {
      interval: 5,
      reorgPeriod: getReorgPeriod('plasma'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4ba900a8549fe503bca674114dc98a254637fc2c'],
        },
        'plasma',
      ),
    },
    electroneum: {
      interval: 5,
      reorgPeriod: getReorgPeriod('electroneum'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x32917f0a38c60ff5b1c4968cb40bc88b14ef0d83'],
        },
        'electroneum',
      ),
    },
    zerogravity: {
      interval: 5,
      reorgPeriod: getReorgPeriod('zerogravity'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xc37e7dad064c11d7ecfc75813a4d8d649d797275'],
        },
        'zerogravity',
      ),
    },
    mantra: {
      interval: 5,
      reorgPeriod: getReorgPeriod('mantra'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x89b8064e29f125e896f6081ebb77090c46bca9cd'],
        },
        'mantra',
      ),
    },
    carrchain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('carrchain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x7ed0a7582af75dc38ad82e7125b51e3eaa6ec33b'],
        },
        'carrchain',
      ),
    },
    incentiv: {
      interval: 5,
      reorgPeriod: getReorgPeriod('incentiv'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x72669f47b6f119289f1a42641b02a9656cc8fecd'],
        },
        'incentiv',
      ),
    },
    monad: {
      interval: 5,
      reorgPeriod: getReorgPeriod('monad'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xb4654795b2f1b17513ffde7d85c776e4cade366c'],
        },
        'monad',
      ),
    },
    litchain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('litchain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xde5509be55483aa525e9b5cce6fe64d3e68d068d'],
        },
        'litchain',
      ),
    },
    somnia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('somnia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0xf484907083d32fdc0848bfb998dfdde835e6f9cb'],
        },
        'somnia',
      ),
    },
    lazai: {
      interval: 5,
      reorgPeriod: getReorgPeriod('lazai'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3b00fe3518e739bb978b04d28e1492d8d865d96e'],
        },
        'lazai',
      ),
    },
    megaeth: {
      interval: 5,
      reorgPeriod: getReorgPeriod('megaeth'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x051ddac8ecf4bae2532b8b7caa626b5567dab528'],
        },
        'megaeth',
      ),
    },
    adichain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('adichain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x4b11a6310bc06300b529b0397683ca3376407eca'],
        },
        'adichain',
      ),
    },
    stable: {
      interval: 5,
      reorgPeriod: getReorgPeriod('stable'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x21820baebcd972c769e490415cfee43a894f3c18'],
        },
        'stable',
      ),
    },
  };
};
