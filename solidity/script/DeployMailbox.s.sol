// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Mailbox} from "../contracts/Mailbox.sol";
import {MockISM} from "../contracts/mock/MockISM.sol";
import {MockHook} from "../contracts/mock/MockHook.sol";
import {IInterchainSecurityModule} from "../contracts/interfaces/IInterchainSecurityModule.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";

contract DeployMailbox is Script {
    function run() external returns (address mailboxProxyAddress) {
        uint32 hyperlaneDomainId = uint32(vm.envUint("HYPERLANE_DOMAIN_ID"));
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);

        // Use deployer as the initial owner for simplicity
        address owner = deployerAddress;

        vm.startBroadcast(deployerPrivateKey);

        // --- 1. Deploy Mock Dependencies ---
        console.log("Deploying MockISM...");
        MockISM mockIsm = new MockISM();
        console.log("MockISM deployed at:", address(mockIsm));

        console.log("Deploying MockHook (for default)...");
        MockHook mockDefaultHook = new MockHook();
        console.log("Mock Default Hook deployed at:", address(mockDefaultHook));

        console.log("Deploying MockHook (for required)...");
        MockHook mockRequiredHook = new MockHook();
        console.log(
            "Mock Required Hook deployed at:",
            address(mockRequiredHook)
        );

        // --- 2. Deploy Mailbox Implementation ---
        console.log("Deploying Mailbox implementation...");
        Mailbox mailboxImplementation = new Mailbox(hyperlaneDomainId);
        console.log(
            "Mailbox implementation deployed at:",
            address(mailboxImplementation)
        );

        // --- 3. Prepare Initialization Data ---
        // This calls the `initialize` function after deployment
        bytes memory initData = abi.encodeWithSelector(
            Mailbox.initialize.selector,
            owner, // _owner
            address(mockIsm), // _defaultIsm
            address(mockDefaultHook), // _defaultHook
            address(mockRequiredHook) // _requiredHook
        );

        // --- 4. Deploy ERC1967Proxy ---
        console.log("Deploying ERC1967Proxy for Mailbox...");
        ERC1967Proxy mailboxProxy = new ERC1967Proxy(
            address(mailboxImplementation),
            initData
        );
        console.log("Mailbox Proxy deployed at:", address(mailboxProxy));

        vm.stopBroadcast();

        // --- Post-Deployment Info ---
        console.log("-----------------------------------------");
        console.log("Deployment Summary:");
        console.log("  Target Chain Hyperlane Domain ID:", hyperlaneDomainId);
        console.log("  Deployer/Owner:", owner);
        console.log("  MockISM Address:", address(mockIsm));
        console.log("  Mock Default Hook Address:", address(mockDefaultHook));
        console.log("  Mock Required Hook Address:", address(mockRequiredHook));
        console.log(
            "  Mailbox Implementation Address:",
            address(mailboxImplementation)
        );
        console.log("  Mailbox Proxy Address:", address(mailboxProxy));
        console.log("-----------------------------------------");
        console.log(
            "Use the Mailbox Proxy Address:",
            address(mailboxProxy),
            "as the `originMailbox` when deploying PolymerISM on the destination chain."
        );

        mailboxProxyAddress = address(mailboxProxy);
        return mailboxProxyAddress;
    }
}
