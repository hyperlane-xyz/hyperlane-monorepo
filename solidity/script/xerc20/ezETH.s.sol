// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {IXERC20Lockbox} from "../../contracts/token/interfaces/IXERC20Lockbox.sol";
import {IXERC20} from "../../contracts/token/interfaces/IXERC20.sol";
import {IERC20} from "../../contracts/token/interfaces/IXERC20.sol";
import {HypXERC20Lockbox} from "../../contracts/token/extensions/HypXERC20Lockbox.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {HypXERC20} from "../../contracts/token/extensions/HypXERC20.sol";
import {TransparentUpgradeableProxy} from "../../contracts/upgrade/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "../../contracts/upgrade/ProxyAdmin.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";

contract ezETH is Script {
    using TypeCasts for address;

    string ETHEREUM_RPC_URL = vm.envString("ETHEREUM_RPC_URL");
    string BLAST_RPC_URL = vm.envString("BLAST_RPC_URL");

    uint256 ethereumFork;
    uint32 ethereumDomainId = 1;
    address ethereumMailbox = 0xc005dc82818d67AF737725bD4bf75435d065D239;
    address ethereumLockbox = 0xC8140dA31E6bCa19b287cC35531c2212763C2059;

    uint256 blastFork;
    uint32 blastDomainId = 81457;
    address blastXERC20 = 0x2416092f143378750bb29b79eD961ab195CcEea5;
    address blastMailbox = 0x3a867fCfFeC2B790970eeBDC9023E75B0a172aa7;

    uint256 amount = 100;

    function setUp() public {
        ethereumFork = vm.createFork(ETHEREUM_RPC_URL);
        blastFork = vm.createFork(BLAST_RPC_URL);
    }

    function run() external {
        address deployer = address(this);
        bytes32 recipient = deployer.addressToBytes32();
        bytes memory tokenMessage = TokenMessage.format(recipient, amount, "");
        vm.selectFork(ethereumFork);
        HypXERC20Lockbox hypXERC20Lockbox = new HypXERC20Lockbox(
            ethereumLockbox,
            1,
            ethereumMailbox
        );
        ProxyAdmin ethAdmin = new ProxyAdmin();
        TransparentUpgradeableProxy ethProxy = new TransparentUpgradeableProxy(
            address(hypXERC20Lockbox),
            address(ethAdmin),
            abi.encodeCall(
                HypXERC20Lockbox.initialize,
                (address(0), address(0), deployer)
            )
        );
        hypXERC20Lockbox = HypXERC20Lockbox(address(ethProxy));

        vm.selectFork(blastFork);
        HypXERC20 hypXERC20 = new HypXERC20(blastXERC20, 1, blastMailbox);
        ProxyAdmin blastAdmin = new ProxyAdmin();
        TransparentUpgradeableProxy blastProxy = new TransparentUpgradeableProxy(
                address(hypXERC20),
                address(blastAdmin),
                abi.encodeCall(
                    HypERC20Collateral.initialize,
                    (address(0), address(0), deployer)
                )
            );
        hypXERC20 = HypXERC20(address(blastProxy));
        hypXERC20.enrollRemoteRouter(
            ethereumDomainId,
            address(hypXERC20Lockbox).addressToBytes32()
        );

        // grant `amount` mint and burn limit to warp route
        vm.prank(IXERC20(blastXERC20).owner());
        IXERC20(blastXERC20).setLimits(address(hypXERC20), amount, amount);

        // test sending `amount` on warp route
        vm.prank(0x7BE481D464CAD7ad99500CE8A637599eB8d0FCDB); // ezETH whale
        IXERC20(blastXERC20).transfer(address(this), amount);
        IXERC20(blastXERC20).approve(address(hypXERC20), amount);
        uint256 value = hypXERC20.quoteGasPayment(ethereumDomainId);
        hypXERC20.transferRemote{value: value}(
            ethereumDomainId,
            recipient,
            amount
        );

        // test receiving `amount` on warp route
        vm.prank(blastMailbox);
        hypXERC20.handle(
            ethereumDomainId,
            address(hypXERC20Lockbox).addressToBytes32(),
            tokenMessage
        );

        vm.selectFork(ethereumFork);
        hypXERC20Lockbox.enrollRemoteRouter(
            blastDomainId,
            address(hypXERC20).addressToBytes32()
        );

        // grant `amount` mint and burn limit to warp route
        IXERC20 ethereumXERC20 = hypXERC20Lockbox.xERC20();
        vm.prank(ethereumXERC20.owner());
        ethereumXERC20.setLimits(address(hypXERC20Lockbox), amount, amount);

        // test sending `amount` on warp route
        IERC20 erc20 = IXERC20Lockbox(ethereumLockbox).ERC20();
        vm.prank(ethereumLockbox);
        erc20.transfer(address(this), amount);
        erc20.approve(address(hypXERC20Lockbox), amount);
        hypXERC20Lockbox.transferRemote(blastDomainId, recipient, amount);

        // test receiving `amount` on warp route
        vm.prank(ethereumMailbox);
        hypXERC20Lockbox.handle(
            blastDomainId,
            address(hypXERC20).addressToBytes32(),
            tokenMessage
        );
    }
}
