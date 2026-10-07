// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin-contracts/utils/math/SafeCast.sol";

import {FlockedAnchor} from "../src/FlockedAnchor.sol";
import {FlockedEscrow} from "../src/FlockedEscrow.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @title Deploy
/// @notice Deploys `FlockedEscrow` and `FlockedAnchor` through the deterministic CREATE2 factory with a fixed salt, so
///         the same configuration always lands at the same addresses. On anvil (chain 31337) with no `USDC` set it
///         also deploys `MockUSDC`. Writes `deployments/<chainId>.json` as `{ escrow, anchor, usdc, deployBlock }`.
/// @dev Env: `ADMIN`, `GUARDIAN`, `OPERATOR`, `PAUSER`, `TICKET_SIGNER`, `TREASURY`, `ANCHORER`, `RECEIPT_SIGNER`,
///      `DRAND_GENESIS`, `DRAND_PERIOD` (required); `USDC` (required except on anvil); `DEPLOYMENTS_FILE` (optional
///      output path). A contract whose address already has code is left as is, so a re-run is a no-op.
///
///      forge script script/Deploy.s.sol --rpc-url <url> --broadcast [--sender <addr> --account <name>]
contract Deploy is Script {
    /// @notice CREATE2 salt for every Flocked contract.
    bytes32 public constant SALT = keccak256("flocked.deploy.v1");
    uint256 public constant LOCAL_CHAIN_ID = 31337;

    struct Config {
        address usdc;
        address admin;
        address guardian;
        address operator;
        address pauser;
        address ticketSigner;
        address treasury;
        address anchorer;
        address receiptSigner;
        uint64 drandGenesis;
        uint64 drandPeriod;
    }

    struct Deployment {
        address escrow;
        address anchor;
        address usdc;
        /// First block to scan for events: at or before the deployment transactions.
        uint256 deployBlock;
    }

    error UsdcRequired(uint256 chainId);
    error Create2Failed(address expected);

    /// @notice Deploys from env and writes the deployment file.
    /// @return d The deployment.
    function run() external returns (Deployment memory d) {
        Config memory c = config();
        bool existed = isDeployed(c);
        d = deploy(c);
        string memory path = outputPath();
        // Nothing new was deployed: keep the block of the original deployment if the file describes it.
        if (existed && vm.isFile(path)) {
            Deployment memory prev = read(path);
            if (prev.escrow == d.escrow && prev.anchor == d.anchor && prev.usdc == d.usdc) {
                d.deployBlock = prev.deployBlock;
            }
        }
        write(d, path);
    }

    /// @notice The configuration from env.
    /// @return c The configuration.
    function config() public view returns (Config memory c) {
        c.usdc = vm.envOr("USDC", address(0));
        c.admin = vm.envAddress("ADMIN");
        c.guardian = vm.envAddress("GUARDIAN");
        c.operator = vm.envAddress("OPERATOR");
        c.pauser = vm.envAddress("PAUSER");
        c.ticketSigner = vm.envAddress("TICKET_SIGNER");
        c.treasury = vm.envAddress("TREASURY");
        c.anchorer = vm.envAddress("ANCHORER");
        c.receiptSigner = vm.envAddress("RECEIPT_SIGNER");
        c.drandGenesis = SafeCast.toUint64(vm.envUint("DRAND_GENESIS"));
        c.drandPeriod = SafeCast.toUint64(vm.envUint("DRAND_PERIOD"));
    }

    /// @notice Deploys whatever is missing (MockUSDC on anvil without `USDC`, the escrow, the anchor).
    /// @param c The configuration.
    /// @return d The deployment; `deployBlock` is the current block.
    function deploy(Config memory c) public returns (Deployment memory d) {
        d.deployBlock = block.number;
        d.usdc = c.usdc;
        if (d.usdc == address(0)) {
            if (block.chainid != LOCAL_CHAIN_ID) revert UsdcRequired(block.chainid);
            d.usdc = _create2(type(MockUSDC).creationCode);
        }
        d.escrow = _create2(escrowInitCode(c, d.usdc));
        d.anchor = _create2(anchorInitCode(c));
    }

    /// @notice Whether every contract for `c` already has code at its CREATE2 address.
    /// @param c The configuration.
    /// @return True if nothing would be deployed.
    function isDeployed(Config memory c) public view returns (bool) {
        address usdc = c.usdc == address(0) ? predict(type(MockUSDC).creationCode) : c.usdc;
        return usdc.code.length > 0 && predict(escrowInitCode(c, usdc)).code.length > 0
            && predict(anchorInitCode(c)).code.length > 0;
    }

    /// @notice The escrow's creation code with its constructor arguments.
    /// @param c The configuration.
    /// @param usdc The USDC token.
    /// @return The init code.
    function escrowInitCode(Config memory c, address usdc) public pure returns (bytes memory) {
        return abi.encodePacked(
            type(FlockedEscrow).creationCode,
            abi.encode(
                IERC20(usdc),
                c.admin,
                c.guardian,
                c.operator,
                c.pauser,
                c.ticketSigner,
                c.treasury,
                c.drandGenesis,
                c.drandPeriod
            )
        );
    }

    /// @notice The anchor's creation code with its constructor arguments.
    /// @param c The configuration.
    /// @return The init code.
    function anchorInitCode(Config memory c) public pure returns (bytes memory) {
        return abi.encodePacked(
            type(FlockedAnchor).creationCode,
            abi.encode(c.admin, c.anchorer, c.receiptSigner, c.drandGenesis, c.drandPeriod)
        );
    }

    /// @notice The CREATE2 address of `initCode` with `SALT` through the deterministic deployer.
    /// @param initCode The init code.
    /// @return The address.
    function predict(bytes memory initCode) public pure returns (address) {
        return vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_FACTORY);
    }

    /// @notice `DEPLOYMENTS_FILE`, or `deployments/<chainId>.json` in the Foundry project.
    /// @return The path.
    function outputPath() public view returns (string memory) {
        string memory fallbackPath =
            string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        return vm.envOr("DEPLOYMENTS_FILE", fallbackPath);
    }

    /// @notice Writes `{ escrow, anchor, usdc, deployBlock }` to `path`.
    /// @param d The deployment.
    /// @param path The output file.
    function write(Deployment memory d, string memory path) public {
        string memory obj = "deployment";
        vm.serializeAddress(obj, "escrow", d.escrow);
        vm.serializeAddress(obj, "anchor", d.anchor);
        vm.serializeAddress(obj, "usdc", d.usdc);
        vm.writeJson(vm.serializeUint(obj, "deployBlock", d.deployBlock), path);
    }

    /// @notice Reads a deployment file.
    /// @param path The file.
    /// @return d The deployment.
    function read(string memory path) public view returns (Deployment memory d) {
        string memory json = vm.readFile(path);
        d.escrow = vm.parseJsonAddress(json, ".escrow");
        d.anchor = vm.parseJsonAddress(json, ".anchor");
        d.usdc = vm.parseJsonAddress(json, ".usdc");
        d.deployBlock = vm.parseJsonUint(json, ".deployBlock");
    }

    function _create2(bytes memory initCode) internal returns (address addr) {
        addr = predict(initCode);
        if (addr.code.length > 0) return addr;
        vm.broadcast();
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(SALT, initCode));
        if (!ok || addr.code.length == 0) revert Create2Failed(addr);
    }
}
