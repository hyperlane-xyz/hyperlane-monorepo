import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ethers } from 'ethers';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  globSync,
} from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const { values } = parseArgs({
  options: {
    'build-results': { type: 'string' },
    output: { type: 'string' },
  },
});
assert(
  values['build-results'],
  'Pass --build-results from benchmark-solar.mjs',
);
const report = JSON.parse(
  readFileSync(resolve(values['build-results']), 'utf8'),
);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const anvilVersion = execFileSync('anvil', ['--version'], {
  encoding: 'utf8',
}).trim();
const dir = values.output
  ? resolve(values.output)
  : mkdtempSync(join(tmpdir(), 'hyperlane-solar-warp-'));
mkdirSync(dir, { recursive: true });
const server = createServer();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve())),
);
const anvil = spawn(
  'anvil',
  [
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--hardfork',
    'cancun',
    '--silent',
  ],
  { stdio: 'ignore' },
);
const provider = new ethers.providers.JsonRpcProvider(
  `http://127.0.0.1:${port}`,
);
provider.pollingInterval = 25;
const zeroAddress = ethers.constants.AddressZero,
  utils = ethers.utils;
const addressToBytes32 = (a) => utils.hexZeroPad(a, 32);
// Public deterministic fixture keys, unrelated to operator wallets.
const validators = Array.from(
  { length: 5 },
  (_, i) =>
    new ethers.Wallet(utils.id(`public-solar-benchmark-validator-${i}`)),
).sort((a, b) =>
  a.address.toLowerCase().localeCompare(b.address.toLowerCase()),
);
// Full test builds can leave nested duplicate artifacts. Use the selected
// top-level artifacts, matching the compiler benchmark's Contract.json choice.
function artifact(variant, name) {
  const base = report.configs[variant].out;
  const matches = [...globSync(`*/${name}.json`, { cwd: base })].map((p) =>
    JSON.parse(readFileSync(`${base}/${p}`, 'utf8')),
  );
  const own = matches.filter((a) =>
    Object.keys(a.metadata?.settings?.compilationTarget ?? {}).some((p) =>
      p.startsWith('contracts/'),
    ),
  );
  const picked = own.length ? own : matches;
  assert.equal(picked.length, 1, `Artifact ${name}`);
  return picked[0];
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (anvil.exitCode !== null) throw Error('anvil exited');
    try {
      await provider.send('web3_clientVersion', []);
      return;
    } catch {
      await delay(50);
    }
  }
  throw Error('anvil not ready');
}
try {
  await ready();
  const cases = [];
  // Keep proxies and the underlying ERC20 on solc in every scenario. Vary only
  // router implementations, then the ISM factory, then the supporting core.
  for (const scenario of [
    'solc',
    'solar-routers',
    'solar-routers-and-ism',
    'solar-core-and-routers',
  ]) {
    await provider.send('anvil_reset', []);
    const signer = provider.getSigner(0),
      owner = await signer.getAddress(),
      recipient = await provider.getSigner(1).getAddress();
    const rows = [],
      addresses = {};
    const core = scenario === 'solar-core-and-routers' ? 'solar' : 'solc',
      routerVariant = scenario === 'solc' ? 'solc' : 'solar';
    const ismCompiler = [
      'solar-routers-and-ism',
      'solar-core-and-routers',
    ].includes(scenario)
      ? 'solar'
      : 'solc';
    async function receipt(label, promise, trace = false) {
      const tx = await promise,
        r = await tx.wait();
      assert.equal(r.status, 1, label);
      const row = {
        label,
        gas: r.gasUsed.toNumber(),
        to: tx.to ?? null,
        data: tx.data,
        value: tx.value.toString(),
      };
      if (trace) {
        const t = await provider.send('debug_traceTransaction', [
          tx.hash,
          { tracer: 'callTracer' },
        ]);
        row.trace = t;
      }
      rows.push(row);
      return r;
    }
    async function deploy(label, name, args, variant) {
      const a = artifact(variant, name),
        factory = new ethers.ContractFactory(a.abi, a.bytecode.object, signer);
      const c = await factory.deploy(...args);
      await receipt(label, c.deployTransaction);
      addresses[label] = c.address;
      return c;
    }
    const admin = await deploy('shared.proxyAdmin', 'ProxyAdmin', [], 'solc');
    async function proxied(label, name, args, initArgs, variant) {
      const impl = await deploy(`${label}.implementation`, name, args, variant);
      await receipt(
        `${label}.initializeImplementation`,
        impl.initialize(...initArgs),
      );
      const data = impl.interface.encodeFunctionData('initialize', initArgs);
      const proxy = await deploy(
        `${label}.proxy`,
        'TransparentUpgradeableProxy',
        [impl.address, admin.address, data],
        'solc',
      );
      addresses[label] = proxy.address;
      return impl.attach(proxy.address);
    }
    const token = await deploy(
      'existing.collateral',
      'ERC20Test',
      ['Collateral', 'COL', utils.parseEther('1000000'), 18],
      'solc',
    );
    const ismFactory = await deploy(
      'core.ismFactory',
      'StaticMessageIdMultisigIsmFactory',
      [],
      ismCompiler,
    );
    const vals = validators.map((v) => v.address);
    const ismAddr = await ismFactory['getAddress(address[],uint8)'](vals, 3);
    await receipt(
      'route.ismClone',
      ismFactory['deploy(address[],uint8)'](vals, 3),
    );
    addresses['core.ismClone'] = ismAddr;
    addresses['core.ismImplementation'] = await ismFactory.implementation();
    // If a matching validator set is already deployed, the SDK skips this tx.
    const origin = await deploy('core.originMailbox', 'Mailbox', [1000], core);
    const destination = await deploy(
      'core.destinationMailbox',
      'Mailbox',
      [2000],
      core,
    );
    const merkle = await deploy(
      'core.merkleHook',
      'MerkleTreeHook',
      [origin.address],
      core,
    );
    const igp = await proxied(
      'core.igp',
      'InterchainGasPaymaster',
      [],
      [owner, owner],
      core,
    );
    const oracle = await deploy('core.gasOracle', 'StorageGasOracle', [], core);
    await receipt(
      'setup.oracle',
      oracle.setRemoteGasData([2000, 10000000000, 1]),
    );
    await receipt(
      'setup.igpOracle',
      igp.setTokenGasOracles([[zeroAddress, 2000, oracle.address]]),
    );
    await receipt(
      'setup.igpOverhead',
      igp.setDestinationGasOverhead(2000, 50000),
    );
    await receipt(
      'setup.originMailbox',
      origin.initialize(owner, ismAddr, igp.address, merkle.address),
    );
    // Destination only processes messages in this fixture; reuse valid local hook addresses.
    await receipt(
      'setup.destinationMailbox',
      destination.initialize(owner, ismAddr, igp.address, merkle.address),
    );
    const collateral = await proxied(
      'route.collateral',
      'HypERC20Collateral',
      [token.address, 1, 1, origin.address],
      [zeroAddress, ismAddr, owner],
      routerVariant,
    );
    const synthetic = await proxied(
      'route.synthetic',
      'HypERC20',
      [18, 1, 1, destination.address],
      [0, 'Synthetic', 'SYN', zeroAddress, ismAddr, owner],
      routerVariant,
    );
    await receipt(
      'setup.collateralRemote',
      collateral.enrollRemoteRouter(2000, addressToBytes32(synthetic.address)),
    );
    await receipt(
      'setup.syntheticRemote',
      synthetic.enrollRemoteRouter(1000, addressToBytes32(collateral.address)),
    );
    await receipt(
      'setup.gas',
      collateral['setDestinationGas(uint32,uint256)'](2000, 300000),
    );
    await receipt(
      'setup.approval',
      token.approve(collateral.address, ethers.constants.MaxUint256),
    );
    const value = await collateral.quoteGasPayment(2000);
    assert.equal(value.toString(), '350000');
    const runtime = [];
    for (let i = 0; i < 2; i++) {
      const amount = utils.parseEther('1');
      const send = await receipt(
        `runtime.dispatch.${i}`,
        collateral.transferRemote(2000, addressToBytes32(recipient), amount, {
          value,
        }),
        true,
      );
      const parsed = send.logs
        .filter((l) => l.address.toLowerCase() === origin.address.toLowerCase())
        .map((l) => {
          try {
            return origin.interface.parseLog(l);
          } catch {
            return null;
          }
        });
      const dispatch = parsed.find((x) => x?.name === 'Dispatch');
      assert(dispatch);
      const message = dispatch.args.message;
      const [root, index] = await merkle.latestCheckpoint();
      const domain = utils.solidityKeccak256(
        ['uint32', 'bytes32', 'string'],
        [1000, addressToBytes32(merkle.address), 'HYPERLANE'],
      );
      const checkpoint = utils.solidityKeccak256(
        ['bytes32', 'bytes32', 'uint32', 'bytes32'],
        [domain, root, index, utils.keccak256(message)],
      );
      const signatures = await Promise.all(
        validators
          .slice(0, 3)
          .map((v) => v.signMessage(utils.arrayify(checkpoint))),
      );
      const metadata = utils.solidityPack(
        ['bytes32', 'bytes32', 'uint32', 'bytes'],
        [
          addressToBytes32(merkle.address),
          root,
          index,
          utils.hexConcat(signatures),
        ],
      );
      await receipt(
        `runtime.process.${i}`,
        destination.process(metadata, message),
        true,
      );
      assert((await destination.delivered(utils.keccak256(message))) === true);
      assert((await synthetic.balanceOf(recipient)).eq(amount.mul(i + 1)));
      runtime.push({
        messageId: utils.keccak256(message),
        value: value.toString(),
        recipientBalance: (await synthetic.balanceOf(recipient)).toString(),
        collateralLocked: (
          await token.balanceOf(collateral.address)
        ).toString(),
      });
    }
    if (scenario === 'solc') {
      // An existing route has already paid its original deployment cost. Price
      // the replacement implementations and two real ProxyAdmin upgrades.
      const collateralUpgrade = await deploy(
        'upgrade.collateralImplementation',
        'HypERC20Collateral',
        [token.address, 1, 1, origin.address],
        'solar',
      );
      const syntheticUpgrade = await deploy(
        'upgrade.syntheticImplementation',
        'HypERC20',
        [18, 1, 1, destination.address],
        'solar',
      );
      await receipt(
        'upgrade.collateralProxy',
        admin.upgrade(collateral.address, collateralUpgrade.address),
      );
      await receipt(
        'upgrade.syntheticProxy',
        admin.upgrade(synthetic.address, syntheticUpgrade.address),
      );
      assert.equal(
        await admin.getProxyImplementation(collateral.address),
        collateralUpgrade.address,
      );
      assert.equal(
        await admin.getProxyImplementation(synthetic.address),
        syntheticUpgrade.address,
      );
      assert((await synthetic.balanceOf(recipient)).eq(utils.parseEther('2')));
      assert(
        (await token.balanceOf(collateral.address)).eq(utils.parseEther('2')),
      );
    }
    // Raw traces stay in the output directory; published evidence is summarized.
    const publicRows = rows.map(({ data, trace, ...r }) => ({
      ...r,
      inputHash: utils.keccak256(data),
      trace,
    }));
    const result = {
      scenario,
      coreCompiler: core,
      routerCompiler: routerVariant,
      ismCompiler,
      addresses,
      rows: publicRows,
      runtime,
    };
    writeFileSync(
      `${dir}/${scenario}.json`,
      JSON.stringify(result, null, 2) + '\n',
    );
    cases.push(result);
    console.log(
      scenario,
      JSON.stringify(
        rows
          .filter(
            (x) =>
              x.label.startsWith('route.') || x.label.startsWith('runtime.'),
          )
          .map(({ label, gas }) => ({ label, gas })),
      ),
    );
  }
  for (const c of cases.slice(1)) {
    assert.deepEqual(
      c.runtime,
      cases[0].runtime,
      'Transfer results/messages changed',
    );
    for (const row of c.rows.filter((x) => x.label.startsWith('runtime.'))) {
      const base = cases[0].rows.find((x) => x.label === row.label);
      assert.equal(row.inputHash, base.inputHash, 'Runtime input changed');
      assert.equal(row.value, base.value);
      assert.equal(row.to, base.to);
    }
  }
  writeFileSync(
    `${dir}/results.json`,
    JSON.stringify(
      {
        method:
          'Cancun Anvil receipt gas, includes intrinsic gas. Two local domains on one node; direct Mailboxes, proxied routers and IGP. Existing collateral token, ProxyAdmin and transparent proxy bytecode held at solc in all scenarios. New 3-of-5 static message-ID ISM clone; required MerkleTreeHook plus default IGP. No live RPC or funds. Two sequential one-token transfers, verifying delivery/balances and identical runtime inputs across compiler scenarios.',
        sourceCommit,
        sourceDirty:
          execFileSync('git', ['status', '--porcelain'], {
            encoding: 'utf8',
          }).trim().length > 0,
        anvilVersion,
        compilerBuild: {
          sourceCommit: report.sourceCommit,
          solar: report.solar,
          forge: report.forge,
        },
        cases,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Matching runtime inputs and outcomes; results:', dir);
} finally {
  anvil.kill('SIGTERM');
  provider.removeAllListeners();
}
