"""Pure prerequisite plan/pin controls. No installers, SDKs or chain execution."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace
import sys

spec=importlib.util.spec_from_file_location('native_case_setup',Path(__file__).with_name('native_case_setup.py'))
api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ziggy-setup-control-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.tools={name:Path('/public/'+name) for name in api.TOOL_NAMES}

    def test_exact_install_and_direct_build_graph_excludes_hooks_and_mains(self):
        rows=api.build_commands(self.root,self.tools,self.root/'stage')
        install=rows[0]['argv']
        for flag in ['--frozen-lockfile','--ignore-scripts','--config.ignore-pnpmfile=true','--config.verify-store-integrity=true','--config.package-import-method=copy']:self.assertIn(flag,install)
        self.assertEqual(install[:5],['/public/pnpm','--filter','@hyperlane-xyz/infra...','install','--frozen-lockfile'])
        self.assertIn('--config.cache-dir='+str(self.root/'stage/cache'),install)
        self.assertNotIn('--cache-dir',install)
        forbidden={'turbo','prebuild','fetch-contracts','generate-artifacts','deploy-core','deploy-ism','kathy','version:update','cargo','zig'}
        self.assertFalse(any(argument in forbidden for row in rows for argument in row['argv']))
        names=[row['name'] for row in rows]
        self.assertLess(names.index('typescript-utils-tsc'),names.index('core-hardhat'))
        self.assertLess(names.index('tron-typechain-fix'),names.index('typescript-tron-sdk-tsc'))
        self.assertNotIn('typescript-infra-tsc',names)
        self.assertEqual([row['extra_environment']['TRON_BUILD_TARGET'] for row in rows if 'TRON_BUILD_TARGET' in row['extra_environment']],['core','warp'])
        for row in rows:
            if 'compile' in row['argv']:self.assertEqual(row['argv'][-2:],['--concurrency','1'])

    def test_version_constants_are_checked_not_rewritten(self):
        solidity=self.root/'solidity';(solidity/'contracts').mkdir(parents=True);(solidity/'core-utils').mkdir()
        (solidity/'package.json').write_text(json.dumps({'version':'12.2.0'}))
        version=solidity/'contracts/PackageVersioned.sol';version.write_text('string public constant PACKAGE_VERSION = "12.2.0";')
        types=solidity/'core-utils/index.ts';types.write_text("export const CONTRACTS_PACKAGE_VERSION = '12.2.0';")
        api.version_constants(self.root);version.write_text('old source')
        with self.assertRaises(ValueError):api.version_constants(self.root)
        self.assertEqual(version.read_text(),'old source')

    def test_clean_environment_never_propagates_auth_or_ambient_proxy(self):
        env=api.clean_environment(self.root,self.tools)
        self.assertEqual(env['HOME'],str(self.root/'home'))
        self.assertEqual(env['PATH'].split(':')[0],str(self.root/'bin'))
        self.assertFalse(set(env)&{'GH_TOKEN','GITHUB_TOKEN','AWS_SECRET_ACCESS_KEY','HTTP_PROXY','HTTPS_PROXY','DOCKER_CONTEXT','SSH_AUTH_SOCK'})
        self.assertEqual(env['npm_config_ignore_scripts'],'true')

    def test_owned_native_tool_symlinks_do_not_introduce_interpreter_wrappers(self):
        target=self.root/'pnpm-native';target.write_bytes(b'public native fixture');target.chmod(0o700)
        out=self.root/'stage';out.mkdir();api.create_tool_aliases(out,{'pnpm':target})
        alias=out/'bin/pnpm';self.assertTrue(alias.is_symlink());self.assertEqual(alias.resolve(),target)
        self.assertEqual(alias.read_bytes(),target.read_bytes());self.assertFalse(alias.read_bytes().startswith(b'#!'))
        with self.assertRaises(FileExistsError):api.create_tool_aliases(out,{'pnpm':target})

    def test_owned_alias_mutation_rejects_before_passing_receipt(self):
        out=self.root/'stage';out.mkdir();target=self.root/'tool';target.write_bytes(b'public')
        api.create_tool_aliases(out,{'node':target});api.verify_tool_aliases(out,{'node':target})
        alias=out/'bin/node';alias.unlink();alias.symlink_to(self.root/'absent')
        with self.assertRaises((ValueError,FileNotFoundError)):api.verify_tool_aliases(out,{'node':target})
        alias.unlink();alias.write_bytes(b'public')
        with self.assertRaises(ValueError):api.verify_tool_aliases(out,{'node':target})

    def test_isolated_sibling_import_restores_module_search_path(self):
        directory=self.root/'zig/bench';directory.mkdir(parents=True)
        (directory/'unique_setup_control_dep.py').write_text('value=19\n')
        (directory/'control.py').write_text('import unique_setup_control_dep\nvalue=unique_setup_control_dep.value\n')
        before=list(sys.path)
        try:
            with mock.patch.object(api,'ROOT',self.root):self.assertEqual(api.module('control','zig/bench/control.py').value,19)
            self.assertEqual(sys.path,before)
        finally:sys.modules.pop('unique_setup_control_dep',None)

    def test_contract_outputs_require_both_compilers_and_real_deployment_artifact(self):
        for path in ['solidity/artifacts','solidity/artifacts-tron',*[str(Path(package)/'dist') for package in api.PACKAGES if package not in {'typescript/tsconfig','solhint-plugin','typescript/infra'}]]:(self.root/path).mkdir(parents=True)
        (self.root/'solidity/artifacts/Mailbox.json').write_text('{}')
        with self.assertRaises(ValueError):api.output_files(self.root)
        (self.root/'solidity/artifacts-tron/Mailbox.json').write_text('{}');(self.root/'solidity/dist/buildArtifact.json').write_text('{}')
        rows=api.output_files(self.root);self.assertEqual(len(rows),3)
        (self.root/'solidity/dist/link').symlink_to(self.root/'solidity/dist/buildArtifact.json')
        with self.assertRaises(ValueError):api.output_files(self.root)

    def test_pg_exact_id_digest_and_architecture_are_independent(self):
        policy={'image_id':'sha256:'+'a'*64,'canonical_digest':'postgres@sha256:'+'b'*64,'architecture':'amd64'}
        row={'Id':policy['image_id'],'RepoDigests':[policy['canonical_digest']],'Os':'linux','Architecture':'amd64'}
        api.validate_pg_image(row,policy)
        for key,value in [('Id','sha256:'+'c'*64),('RepoDigests',['postgres@sha256:'+'d'*64]),('Os','darwin'),('Architecture','arm64')]:
            changed=copy.deepcopy(row);changed[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):api.validate_pg_image(changed,policy)
        row['RepoDigests']=['docker.io/library/'+policy['canonical_digest']];api.validate_pg_image(row,policy)

    def test_hypd_asset_never_falls_back_to_foreign_repo_transport_or_platform(self):
        policy={'name':'hypd','architecture':'amd64','source_url':'https://github.com/bcp-innovations/hyperlane-cosmos/releases/download/v5.0.0/hypd_linux_amd64'}
        self.assertEqual(api.validate_hypd_policy(policy,'amd64'),policy['source_url'])
        for key,value in [('name','osmosisd'),('architecture','arm64'),('source_url','http://github.com/bcp-innovations/hyperlane-cosmos/releases/download/v5/hypd'),('source_url','https://github.com/foreign/repo/releases/download/v5/hypd'),('source_url','https://github.com/bcp-innovations/hyperlane-cosmos/releases/download/../hypd'),('source_url',policy['source_url']+'?credential=not-a-real-token')]:
            changed=dict(policy);changed[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):api.validate_hypd_policy(changed,'amd64')

    def test_snapshot_records_compiler_consumed_source_mutation_and_rejects_escape(self):
        path=self.root/'typescript/utils/src/index.ts';path.parent.mkdir(parents=True);path.write_text('first')
        listing=b'100644 '+b'0'*40+b' 0\ttypescript/utils/src/index.ts\0'
        with mock.patch.object(api.subprocess,'run',return_value=SimpleNamespace(stdout=listing)):
            before=api.snapshot(self.root,Path('/public/git'));path.write_text('changed')
            self.assertNotEqual(before,api.snapshot(self.root,Path('/public/git')))
        path.unlink();other=tempfile.TemporaryDirectory(prefix='ziggy-outside-control-');self.addCleanup(other.cleanup);outside=Path(other.name)/'public';outside.write_text('public')
        path.symlink_to(outside)
        listing=b'120000 '+b'0'*40+b' 0\ttypescript/utils/src/index.ts\0'
        with mock.patch.object(api.subprocess,'run',return_value=SimpleNamespace(stdout=listing)),self.assertRaises(ValueError):api.snapshot(self.root,Path('/public/git'))

    def test_mutated_or_symlink_prerequisite_pin_rejects(self):
        path=self.root/'tool';path.write_bytes(b'original');first=api.pin(path);path.write_bytes(b'changed')
        self.assertNotEqual(api.pin(path)['sha256'],first['sha256'])
        link=self.root/'link';link.symlink_to(path)
        with self.assertRaises(ValueError):api.pin(link)


    def evm_manager_fixture(self,machine=62):
        launcher=self.root/'launcher';launcher.write_bytes(b'#!/usr/bin/env node\n// public launcher fixture\n');launcher.chmod(0o700)
        native=self.root/'pnpm-native';raw=bytearray(64);raw[:8]=b'\x7fELF\x02\x01\x01\x00';raw[18:20]=machine.to_bytes(2,'little');native.write_bytes(raw);native.chmod(0o700)
        log=self.root/'resolution.json';log.write_text(json.dumps({'path':str(native)}));identity=api.pin(native);recipe=SimpleNamespace(PNPM_RELEASE={arch:{'bytes':identity['bytes'],'sha256':identity['sha256']}for arch in ('amd64','arm64')});tools={**self.tools,'pnpm':launcher};return launcher,native,log,recipe,tools

    def test_EVM_resolves_and_pins_actual_native_without_relabelling_launcher(self):
        launcher,native,log,recipe,tools=self.evm_manager_fixture();original=api.pin(launcher);run=mock.Mock(return_value=log)
        with mock.patch.object(api,'module',return_value=recipe):value=api.inspect_evm_native_pnpm(run,tools,'amd64')
        self.assertEqual(value,api.pin(native));self.assertNotEqual(value,original);self.assertEqual(api.pin(launcher),original);self.assertEqual(tools['pnpm'],launcher)
        args=run.call_args.args;self.assertEqual(args[0],'resolve-original-launcher-native-pnpm');self.assertEqual(args[1][:2],['/public/node','-e']);self.assertEqual(args[1][-2:],[str(launcher),'x64']);self.assertIn('r.resolve(',args[1][2]);self.assertNotIn('spawn',args[1][2]);self.assertNotIn('import(',args[1][2]);self.assertNotIn('writeFile',args[1][2])

    def test_EVM_wrong_native_identity_or_wrapper_as_native_never_passes(self):
        launcher,native,log,recipe,tools=self.evm_manager_fixture()
        with mock.patch.object(api,'module',return_value=recipe):
            log.write_text(json.dumps({'path':str(launcher)}))
            with self.assertRaisesRegex(ValueError,'Separate canonical'):api.inspect_evm_native_pnpm(mock.Mock(return_value=log),tools,'amd64')
            log.write_text(json.dumps({'path':str(native)}));native.write_bytes(native.read_bytes()+b'changed')
            with self.assertRaisesRegex(ValueError,'official12.3.0'):api.inspect_evm_native_pnpm(mock.Mock(return_value=log),tools,'amd64')

    def test_EVM_exact_native_bytes_still_need_matching_ELF_platform(self):
        launcher,native,log,recipe,tools=self.evm_manager_fixture(machine=62)
        with mock.patch.object(api,'module',return_value=recipe),self.assertRaisesRegex(ValueError,'ELF/platform'):api.inspect_evm_native_pnpm(mock.Mock(return_value=log),tools,'arm64')
        native.write_bytes(b'not ELF'+b'0'*57);identity=api.pin(native);recipe.PNPM_RELEASE['amd64']={'bytes':identity['bytes'],'sha256':identity['sha256']}
        with mock.patch.object(api,'module',return_value=recipe),self.assertRaisesRegex(ValueError,'ELF/platform'):api.inspect_evm_native_pnpm(mock.Mock(return_value=log),tools,'amd64')

    def test_EVM_native_resolution_is_closed_bounded_and_no_path_alias(self):
        launcher,native,log,recipe,tools=self.evm_manager_fixture();alias=self.root/'alias';alias.symlink_to(native)
        with mock.patch.object(api,'module',return_value=recipe):
            for value in [{'path':str(alias)},{'path':'relative'},{'path':str(native),'extra':'foreign'},['wrong'],{'path':'/'+'p'*8192}]:
                log.write_text(json.dumps(value))
                with self.subTest(value=type(value).__name__),self.assertRaises(ValueError):api.inspect_evm_native_pnpm(mock.Mock(return_value=log),tools,'amd64')
            with self.assertRaises(ValueError):api.inspect_evm_native_pnpm(mock.Mock(side_effect=AssertionError('no resolver')) ,tools,'darwin')

    def test_EVM_original_native_launcher_retains_existing_native_path_semantics(self):
        launcher,native,log,recipe,tools=self.evm_manager_fixture();tools['pnpm']=native;run=mock.Mock(side_effect=AssertionError('native ELF needs no module resolution'))
        with mock.patch.object(api,'module',return_value=recipe):self.assertEqual(api.inspect_evm_native_pnpm(run,tools,'amd64'),api.pin(native))
        run.assert_not_called()

if __name__=='__main__':unittest.main()
