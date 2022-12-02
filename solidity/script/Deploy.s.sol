// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.6.0;

import "forge-std/Script.sol";
import {ICREATE3Factory} from "../lib/create3-factory/src/ICREATE3Factory.sol";

import {Mailbox} from "../contracts/Mailbox.sol";

contract Deploy is Script {
    function getCreate3Factory(string memory network)
        public
        returns (ICREATE3Factory)
    {
        string memory file = string.concat(
            "lib/create3-factory/deployments/",
            network,
            ".json"
        );
        string memory json = vm.readFile(file);
        return
            ICREATE3Factory(
                address(bytes20(vm.parseJson(json, "CREATE3Factory")))
            );
    }

    function getDomainId(string memory network) public returns (uint32) {
        string memory json = vm.readFile("../chains.json");
        return
            uint32(
                bytes4(vm.parseJson(string(vm.parseJson(json, network)), "id"))
            );
    }

    function run() public {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        string memory network = vm.envString("NETWORK");
        // string memory salt = vm.envString("SALT");
        bytes32 salt = keccak256("SALT");

        uint32 domain = getDomainId(network);
        ICREATE3Factory factory = getCreate3Factory(network);
        Mailbox mailbox = Mailbox(
            factory.deploy(
                salt,
                abi.encodePacked(type(Mailbox).creationCode, domain)
            )
        );
    }
}
