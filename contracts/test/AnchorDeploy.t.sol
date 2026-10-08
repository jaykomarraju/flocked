// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {FlockedAnchor} from "../src/FlockedAnchor.sol";
import {FlockedEscrow} from "../src/FlockedEscrow.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice `script/Deploy.s.sol`: CREATE2 addresses, MockUSDC on anvil only, constructor wiring, and the deployment
///         JSON it writes. `script/dry-run.sh` runs the same script against a live anvil.
contract AnchorDeployTest is Test {
    string internal constant OUT = "deployments/31337.test.json";

    Deploy internal script;

    function setUp() public {
        script = new Deploy();
    }

    function _config() internal returns (Deploy.Config memory c) {
        c.admin = makeAddr("admin");
        c.guardian = makeAddr("guardian");
        c.operator = makeAddr("operator");
        c.pauser = makeAddr("pauser");
        c.ticketSigner = makeAddr("ticketSigner");
        c.treasury = makeAddr("treasury");
        c.anchorer = makeAddr("anchorer");
        c.receiptSigner = makeAddr("receiptSigner");
        c.drandGenesis = 1692803367;
        c.drandPeriod = 3;
    }

    function _path(string memory name) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", name);
    }

    function test_deploy_localWiresBothContractsAtCreate2Addresses() public {
        Deploy.Config memory c = _config();
        assertEq(block.chainid, 31337);
        assertFalse(script.isDeployed(c));
        Deploy.Deployment memory d = script.deploy(c);
        assertTrue(script.isDeployed(c));

        // CREATE2 through the deterministic deployer with the fixed salt.
        assertEq(d.usdc, script.predict(type(MockUSDC).creationCode));
        assertEq(d.escrow, script.predict(script.escrowInitCode(c, d.usdc)));
        assertEq(d.anchor, script.predict(script.anchorInitCode(c)));
        assertEq(d.deployBlock, block.number);

        MockUSDC usdc = MockUSDC(d.usdc);
        assertEq(usdc.decimals(), 6);
        FlockedEscrow escrow = FlockedEscrow(d.escrow);
        assertEq(address(escrow.usdc()), d.usdc);
        assertTrue(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), c.admin));
        assertEq(escrow.guardian(), c.guardian);
        assertTrue(escrow.hasRole(escrow.OPERATOR_ROLE(), c.operator));
        assertTrue(escrow.hasRole(escrow.PAUSER_ROLE(), c.pauser));
        assertEq(escrow.ticketSigner(), c.ticketSigner);
        assertEq(escrow.treasury(), c.treasury);
        assertEq(escrow.GENESIS(), c.drandGenesis);
        assertEq(escrow.PERIOD(), c.drandPeriod);
        FlockedAnchor anchor = FlockedAnchor(d.anchor);
        assertTrue(anchor.hasRole(anchor.DEFAULT_ADMIN_ROLE(), c.admin));
        assertTrue(anchor.hasRole(anchor.ANCHOR_ROLE(), c.anchorer));
        assertEq(anchor.receiptSigner(), c.receiptSigner);
        assertEq(anchor.GENESIS(), c.drandGenesis);
        assertEq(anchor.PERIOD(), c.drandPeriod);
        // Neither contract keeps a role for the deployer or the factory.
        assertFalse(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), CREATE2_FACTORY));
        assertFalse(anchor.hasRole(anchor.DEFAULT_ADMIN_ROLE(), CREATE2_FACTORY));

        // A second run with the same configuration deploys nothing and returns the same addresses.
        Deploy.Deployment memory again = script.deploy(c);
        assertEq(again.escrow, d.escrow);
        assertEq(again.anchor, d.anchor);
        assertEq(again.usdc, d.usdc);
    }

    function test_deploy_writesDeploymentJson() public {
        vm.roll(1234);
        Deploy.Deployment memory d = script.deploy(_config());
        string memory path = _path("31337.test.json");
        script.write(d, path);

        string memory json = vm.readFile(path);
        string[] memory keys = vm.parseJsonKeys(json, "$");
        assertEq(keys.length, 4, "exactly escrow, anchor, usdc, deployBlock");
        assertEq(vm.parseJsonAddress(json, ".escrow"), d.escrow);
        assertEq(vm.parseJsonAddress(json, ".anchor"), d.anchor);
        assertEq(vm.parseJsonAddress(json, ".usdc"), d.usdc);
        assertEq(vm.parseJsonUint(json, ".deployBlock"), 1234);
        Deploy.Deployment memory back = script.read(path);
        assertEq(keccak256(abi.encode(back)), keccak256(abi.encode(d)));
    }

    function test_deploy_usesGivenUsdcAndNeedsOneOffAnvil() public {
        Deploy.Config memory c = _config();
        vm.chainId(84532);
        vm.expectRevert(abi.encodeWithSelector(Deploy.UsdcRequired.selector, 84532));
        script.deploy(c);

        MockUSDC token = new MockUSDC();
        c.usdc = address(token);
        Deploy.Deployment memory d = script.deploy(c);
        assertEq(d.usdc, address(token));
        assertEq(address(FlockedEscrow(d.escrow).usdc()), address(token));
        assertEq(script.predict(type(MockUSDC).creationCode).code.length, 0, "no MockUSDC off anvil");
    }

    function test_deploy_differentConfigDifferentAddresses() public {
        Deploy.Config memory c = _config();
        Deploy.Deployment memory a = script.deploy(c);
        c.drandPeriod = 30; // a local drand network
        Deploy.Deployment memory b = script.deploy(c);
        assertEq(b.usdc, a.usdc);
        assertTrue(b.escrow != a.escrow);
        assertTrue(b.anchor != a.anchor);
    }

    /// @dev The env path end to end: `run()` reads every P2.2 variable and writes the file it names.
    function test_run_fromEnv() public {
        Deploy.Config memory c = _config();
        vm.setEnv("ADMIN", vm.toString(c.admin));
        vm.setEnv("GUARDIAN", vm.toString(c.guardian));
        vm.setEnv("OPERATOR", vm.toString(c.operator));
        vm.setEnv("PAUSER", vm.toString(c.pauser));
        vm.setEnv("TICKET_SIGNER", vm.toString(c.ticketSigner));
        vm.setEnv("TREASURY", vm.toString(c.treasury));
        vm.setEnv("ANCHORER", vm.toString(c.anchorer));
        vm.setEnv("RECEIPT_SIGNER", vm.toString(c.receiptSigner));
        vm.setEnv("DRAND_GENESIS", vm.toString(uint256(c.drandGenesis)));
        vm.setEnv("DRAND_PERIOD", vm.toString(uint256(c.drandPeriod)));
        vm.setEnv("USDC", vm.toString(address(0)));
        string memory path = _path("31337.test-run.json");
        vm.setEnv("DEPLOYMENTS_FILE", path);

        assertEq(keccak256(abi.encode(script.config())), keccak256(abi.encode(c)));
        assertEq(script.outputPath(), path);
        vm.roll(50);
        Deploy.Deployment memory d = script.run();
        assertEq(script.read(path).escrow, d.escrow);
        assertEq(script.read(path).deployBlock, 50);

        // Re-running later deploys nothing and keeps the original block.
        vm.roll(90);
        Deploy.Deployment memory again = script.run();
        assertEq(again.escrow, d.escrow);
        assertEq(script.read(path).deployBlock, 50);
    }
}
