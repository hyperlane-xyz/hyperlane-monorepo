/// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";
import {TokenBridgeOft} from "../contracts/token/TokenBridgeOft.sol";
import {TransparentUpgradeableProxy} from "../contracts/upgrade/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "../contracts/upgrade/ProxyAdmin.sol";

contract TokenBridgeOftScript is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address erc20 = vm.envAddress("ERC20");
        uint256 scale = vm.envUint("SCALE");
        address mailbox = vm.envAddress("MAILBOX");
        address hook = vm.envAddress("HOOK");
        address ism = vm.envAddress("ISM");
        address owner = vm.envAddress("OWNER");

        vm.startBroadcast(pk);
        // Deploy implementation (initializer disabled in constructor as intended for proxies)
        TokenBridgeOft impl = new TokenBridgeOft(erc20, scale, mailbox);

        // Deploy ProxyAdmin and proxy; initialize via constructor data
        ProxyAdmin admin = new ProxyAdmin();
        bytes memory initData = abi.encodeWithSignature(
            "initialize(address,address,address)",
            hook,
            ism,
            owner
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(impl),
            address(admin),
            initData
        );
        TokenBridgeOft oft = TokenBridgeOft(address(proxy));

        bool hasRemote = vm.envBool("ENROLL_REMOTE");
        if (hasRemote) {
            uint32 remoteDomain = uint32(vm.envUint("REMOTE_DOMAIN"));
            bytes32 remoteRouter = vm.envBytes32("REMOTE_ROUTER");
            oft.enrollRemoteRouter(remoteDomain, remoteRouter);
        }

        bool hasDomainMap = vm.envBool("SET_LZ_EID");
        if (hasDomainMap) {
            uint32 hypDomain = uint32(vm.envUint("DST_HYP_DOMAIN"));
            uint16 lzEid = uint16(vm.envUint("DST_LZ_EID"));
            bytes memory dstVault = vm.envBytes("DST_VAULT");
            bytes memory adapterParams = vm.envBytes("ADAPTER_PARAMS");
            oft.addDomain(hypDomain, lzEid, dstVault, adapterParams);
        }

        vm.stopBroadcast();
    }
}
