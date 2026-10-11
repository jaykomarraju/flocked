// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin-contracts/access/IAccessControl.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";

import {FlockedAnchor} from "../src/FlockedAnchor.sol";
import {IFlockedAnchor} from "../src/interfaces/IFlockedAnchor.sol";
import {AnchorBase} from "./AnchorBase.t.sol";

/// @notice Drives the anchor with random lock and commit batches and manifest calls over a rotating key pool, so keys
///         collide and time windows open and close, and with the admin's timelocked changes (receipt signer and
///         ANCHOR_ROLE grants) against a model of when each may take effect. It records every write event, checks
///         each event's fields against what was stored, and keeps the first value written.
contract AnchorHandler is Test {
    FlockedAnchor public immutable anchor;
    address internal immutable admin;
    // Cached, so no getter call sits between a prank and the call it is meant for.
    bytes32 internal immutable SIGNER_ACTION;
    bytes32 internal immutable GRANT_ACTION;
    bytes32 internal immutable ROLE;

    uint256 public constant POOL = 6;
    uint256 public constant MAX_KEYS = 36;
    bytes32[] public keys;

    /// @notice ANCHOR_ROLE candidates (the deployment's anchorer first) and receipt signer candidates.
    address[] public anchorers;
    address[] public signers;
    /// @notice The model: who should hold ANCHOR_ROLE, which receipt signer should be current, and when each
    ///         timelocked operation was scheduled (zero when none is pending).
    mapping(address => bool) public expectedAnchorer;
    address public expectedSigner;
    mapping(bytes32 => uint256) public scheduledAt;

    /// @notice Write events seen per key and kind (0 lock, 1 commit, 2 manifest).
    mapping(bytes32 => uint256[3]) internal _writes;
    /// @notice The stored anchor right after the first write of each kind.
    mapping(bytes32 => mapping(uint256 => bytes32)) public firstWrite;
    mapping(bytes32 => uint256) public calls;

    /// @notice Set if a write event's fields differ from what was stored for its key.
    bool public eventMismatch;
    /// @notice Set if a timelocked change took effect before its delay passed.
    bool public earlyExecution;
    /// @notice Set if a `ReceiptSignerSet` is out of order or not stamped with its block's time.
    bool public badSignerHistory;
    uint64 internal _lastValidFrom;
    /// @notice Manifests anchored on keys that were never committed (the spec allows it: lock, no commit).
    uint256 public manifestWithoutCommit;

    constructor(FlockedAnchor anchor_, address admin_, address anchorer_, address receiptSigner_) {
        anchor = anchor_;
        admin = admin_;
        SIGNER_ACTION = anchor_.ACTION_RECEIPT_SIGNER();
        GRANT_ACTION = anchor_.ACTION_ANCHOR_GRANT();
        ROLE = anchor_.ANCHOR_ROLE();
        anchorers.push(anchorer_);
        anchorers.push(makeAddr("anchorer1"));
        anchorers.push(makeAddr("anchorer2"));
        expectedAnchorer[anchorer_] = true;
        signers.push(receiptSigner_);
        signers.push(makeAddr("signer1"));
        signers.push(makeAddr("signer2"));
        expectedSigner = receiptSigner_;
        _lastValidFrom = uint64(block.timestamp);
        _addKeys();
    }

    modifier record(bytes32 name) {
        calls[name]++;
        vm.recordLogs();
        _;
        _tally(vm.getRecordedLogs());
    }

    function writes(bytes32 key, uint256 kind) external view returns (uint256) {
        return _writes[key][kind];
    }

    function keyCount() external view returns (uint256) {
        return keys.length;
    }

    function anchorerCount() external view returns (uint256) {
        return anchorers.length;
    }

    function signerCount() external view returns (uint256) {
        return signers.length;
    }

    // ---------------------------------------------------------------- anchoring

    function lockBatch(uint256 seed, uint256 writerSeed) external record("lock") {
        uint256 n = 1 + seed % 5;
        bytes32[] memory ks = new bytes32[](n);
        uint64[] memory closes = new uint64[](n);
        uint64[] memory beacons = new uint64[](n);
        bytes32[] memory qs = new bytes32[](n);
        bytes32[] memory cs = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            uint256 s = uint256(keccak256(abi.encode(seed, i)));
            ks[i] = _pickKey(s);
            closes[i] = uint64(block.timestamp - 2 minutes + (s >> 8) % 30 minutes);
            // Beacon from 30 s to about 11 min after close: in and out of bounds.
            uint256 bt = uint256(closes[i]) + 30 + (s >> 40) % 640;
            beacons[i] = uint64((bt - anchor.GENESIS() + anchor.PERIOD() - 1) / anchor.PERIOD() + 1);
            qs[i] = keccak256(abi.encode("q", s));
            cs[i] = keccak256(abi.encode("c", s));
        }
        _asWriter(writerSeed);
        anchor.lock(ks, closes, beacons, qs, cs);
    }

    function commitBatch(uint256 seed, uint256 writerSeed) external record("commit") {
        uint256 n = 1 + seed % 5;
        // Half the time, warp into a locked key's commit window first: the window is only 1-10 minutes long.
        bytes32 target = (seed >> 128) % 2 == 0 ? _warpIntoCommitWindow(seed) : bytes32(0);
        bytes32[] memory ks = new bytes32[](n);
        bytes32[] memory roots = new bytes32[](n);
        uint32[] memory counts = new uint32[](n);
        uint64[] memory stakes = new uint64[](n);
        for (uint256 i; i < n; i++) {
            uint256 s = uint256(keccak256(abi.encode(seed, i, "commit")));
            ks[i] = i == 0 && target != bytes32(0) ? target : _pickKey(s);
            roots[i] = s % 7 == 0 ? bytes32(0) : keccak256(abi.encode("root", s));
            counts[i] = uint32(s >> 8);
            stakes[i] = uint64(s >> 40);
        }
        _asWriter(writerSeed);
        anchor.commit(ks, roots, counts, stakes);
    }

    /// @dev Calls `anchorManifest`, expecting a revert exactly when the model says the call is invalid.
    function anchorManifest(uint256 seed, uint256 writerSeed) external record("manifest") {
        bytes32 key = _pickKey(seed);
        bytes32 m = keccak256(abi.encode("manifest", seed));
        IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(key);
        if (a.lockedAt != 0 && (seed >> 128) % 3 == 0) {
            uint256 bt = anchor.beaconTime(a.beaconRound);
            if (block.timestamp < bt) vm.warp(bt); // land exactly on the beacon time sometimes
        }
        bool valid = a.lockedAt != 0 && a.manifestAnchoredAt == 0 && block.timestamp >= anchor.beaconTime(a.beaconRound);
        bool authorized = _asWriter(writerSeed);
        if (authorized && !valid) vm.expectRevert();
        anchor.anchorManifest(key, m);
        if (authorized && valid && a.committedAt == 0) manifestWithoutCommit++;
    }

    /// @dev Adds a fresh set of keys, so writes keep happening after long warps have aged the old ones.
    function addKeys() external record("addKeys") {
        _addKeys();
    }

    function warp(uint256 dt) external record("warp") {
        vm.warp(block.timestamp + bound(dt, 1, 4 minutes)); // short steps, so commit windows get hit
    }

    // ---------------------------------------------------------------- admin and timelocks

    function scheduleSigner(uint256 who) external record("scheduleSigner") {
        _schedule(SIGNER_ACTION, signers[who % signers.length]);
    }

    function executeSigner(uint256 who, uint256 warpSeed) external record("executeSigner") {
        address s = signers[who % signers.length];
        if (!_execute(SIGNER_ACTION, s, warpSeed)) return;
        anchor.executeReceiptSigner(s);
        expectedSigner = s;
    }

    function cancelSigner(uint256 who) external record("cancelSigner") {
        address s = signers[who % signers.length];
        if (!_cancelExpected(SIGNER_ACTION, s)) return;
        anchor.cancelReceiptSigner(s);
    }

    /// @dev Disabling is immediate; setting any other signer directly must revert.
    function disableSigner(uint256 who) external record("disableSigner") {
        vm.startPrank(admin);
        vm.expectRevert(IFlockedAnchor.TimelockRequired.selector);
        anchor.setReceiptSigner(signers[who % signers.length]);
        if (who % 4 == 0) {
            anchor.setReceiptSigner(address(0));
            expectedSigner = address(0);
        }
        vm.stopPrank();
    }

    function scheduleGrant(uint256 who) external record("scheduleGrant") {
        _schedule(GRANT_ACTION, anchorers[who % anchorers.length]);
    }

    function executeGrant(uint256 who, uint256 warpSeed) external record("executeGrant") {
        address a = anchorers[who % anchorers.length];
        if (!_execute(GRANT_ACTION, a, warpSeed)) return;
        anchor.executeAnchorGrant(a);
        expectedAnchorer[a] = true;
    }

    function cancelGrant(uint256 who) external record("cancelGrant") {
        address a = anchorers[who % anchorers.length];
        if (!_cancelExpected(GRANT_ACTION, a)) return;
        anchor.cancelAnchorGrant(a);
    }

    /// @dev Revocation is immediate; a direct grant must revert.
    function revokeOrTryGrant(uint256 who) external record("revokeOrTryGrant") {
        address a = anchorers[who % anchorers.length];
        bytes32 role = ROLE;
        vm.startPrank(admin);
        vm.expectRevert(IFlockedAnchor.TimelockRequired.selector);
        anchor.grantRole(role, a);
        if (who % 3 == 0) {
            anchor.revokeRole(role, a);
            expectedAnchorer[a] = false;
        }
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- internals

    function _addKeys() internal {
        if (keys.length >= MAX_KEYS) return;
        uint256 base = keys.length;
        for (uint256 i; i < POOL; i++) {
            keys.push(anchor.roundKey(bytes16(uint128(base + i + 1)), uint8(i % 2)));
        }
    }

    /// @dev Finds a locked, uncommitted key among the newest whose window hasn't passed, and warps into
    ///      `[closesAt, beaconTime)` (often to an edge). Returns the key, or zero if there is none.
    function _warpIntoCommitWindow(uint256 seed) internal returns (bytes32) {
        uint256 n = keys.length;
        for (uint256 j; j < POOL; j++) {
            bytes32 key = keys[n - POOL + (seed + j) % POOL];
            IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(key);
            if (a.lockedAt == 0 || a.committedAt != 0) continue;
            uint256 bt = anchor.beaconTime(a.beaconRound);
            if (block.timestamp >= bt) continue;
            uint256 from = block.timestamp > a.closesAt ? block.timestamp : a.closesAt;
            uint256 pick = (seed >> 64) % 4;
            vm.warp(pick == 0 ? from : pick == 1 ? bt - 1 : from + (seed >> 96) % (bt - from));
            return key;
        }
        return bytes32(0);
    }

    /// @dev Mostly the newest keys (the ones whose windows are still open), sometimes any key.
    function _pickKey(uint256 s) internal view returns (bytes32) {
        uint256 n = keys.length;
        return (s >> 200) % 4 == 0 ? keys[s % n] : keys[n - POOL + s % POOL];
    }

    /// @dev Pranks as a current holder of ANCHOR_ROLE, or (one call in eight, or when nobody holds it) as a
    ///      non-holder, expecting the access-control revert. Returns whether the writer holds the role.
    function _asWriter(uint256 seed) internal returns (bool authorized) {
        address[3] memory holders;
        uint256 h;
        address outsider = address(0);
        for (uint256 i; i < anchorers.length; i++) {
            if (expectedAnchorer[anchorers[i]]) holders[h++] = anchorers[i];
            else outsider = anchorers[i];
        }
        if (h > 0 && (seed % 8 != 0 || outsider == address(0))) {
            vm.prank(holders[(seed >> 8) % h]);
            return true;
        }
        address writer = outsider == address(0) ? anchorers[0] : outsider;
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, writer, ROLE));
        return false;
    }

    function _schedule(bytes32 action, address target) internal {
        bytes32 id = anchor.operationId(action, abi.encode(target));
        vm.prank(admin);
        if (scheduledAt[id] != 0) {
            vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.AlreadyScheduled.selector, id));
            _callSchedule(action, target);
            return;
        }
        _callSchedule(action, target);
        scheduledAt[id] = block.timestamp;
    }

    function _callSchedule(bytes32 action, address target) internal {
        if (action == SIGNER_ACTION) anchor.scheduleReceiptSigner(target);
        else anchor.scheduleAnchorGrant(target);
    }

    /// @dev Pranks as the admin for an execute. Returns false after making the call revert as the model expects
    ///      (not scheduled, or not ready unless it warps there, one time in eight).
    function _execute(bytes32 action, address target, uint256 warpSeed) internal returns (bool) {
        bytes32 id = anchor.operationId(action, abi.encode(target));
        uint256 at = scheduledAt[id];
        if (at == 0) {
            vm.prank(admin);
            vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.NotScheduled.selector, id));
            _callExecute(action, target);
            return false;
        }
        uint256 readyAt = at + anchor.ADMIN_TIMELOCK();
        if (block.timestamp < readyAt) {
            // A 72-hour jump ages every open key, so take it rarely.
            if (warpSeed % 8 != 0) {
                vm.prank(admin);
                vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.TimelockNotReady.selector, id, readyAt));
                _callExecute(action, target);
                return false;
            }
            vm.warp(readyAt);
        }
        if (block.timestamp < at + anchor.ADMIN_TIMELOCK()) earlyExecution = true;
        scheduledAt[id] = 0;
        vm.prank(admin);
        return true;
    }

    function _callExecute(bytes32 action, address target) internal {
        if (action == SIGNER_ACTION) anchor.executeReceiptSigner(target);
        else anchor.executeAnchorGrant(target);
    }

    /// @dev Pranks as the admin for a cancel; returns false after making an unscheduled cancel revert.
    function _cancelExpected(bytes32 action, address target) internal returns (bool) {
        bytes32 id = anchor.operationId(action, abi.encode(target));
        vm.prank(admin);
        if (scheduledAt[id] == 0) {
            vm.expectRevert(abi.encodeWithSelector(IFlockedAnchor.NotScheduled.selector, id));
            if (action == SIGNER_ACTION) anchor.cancelReceiptSigner(target);
            else anchor.cancelAnchorGrant(target);
            return false;
        }
        scheduledAt[id] = 0;
        return true;
    }

    /// @dev Every call that reverts here reverts before the anchor emits anything, so every recorded log is real.
    function _tally(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(anchor)) continue;
            bytes32 t = logs[i].topics[0];
            if (t == IFlockedAnchor.ReceiptSignerSet.selector) {
                (, uint64 validFrom) = abi.decode(logs[i].data, (address, uint64));
                if (validFrom != block.timestamp || validFrom < _lastValidFrom) badSignerHistory = true;
                _lastValidFrom = validFrom;
                continue;
            }
            uint256 kind;
            if (t == IFlockedAnchor.Locked.selector) kind = 0;
            else if (t == IFlockedAnchor.Committed.selector) kind = 1;
            else if (t == IFlockedAnchor.ManifestAnchored.selector) kind = 2;
            else continue;
            bytes32 key = logs[i].topics[1];
            if (!_eventMatchesStorage(key, kind, logs[i].data)) eventMismatch = true;
            if (++_writes[key][kind] == 1) firstWrite[key][kind] = _snapshot(key, kind);
        }
    }

    function _eventMatchesStorage(bytes32 key, uint256 kind, bytes memory data) internal view returns (bool) {
        IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(key);
        if (kind == 0) {
            return keccak256(data) == keccak256(abi.encode(a.closesAt, a.beaconRound, a.questionHash, a.configHash));
        }
        if (kind == 1) return keccak256(data) == keccak256(abi.encode(a.commitmentRoot, a.entryCount, a.totalStake));
        return keccak256(data) == keccak256(abi.encode(a.manifestHash));
    }

    /// @notice The stored fields of one kind, hashed.
    function _snapshot(bytes32 key, uint256 kind) public view returns (bytes32) {
        IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(key);
        if (kind == 0) {
            return keccak256(abi.encode(a.closesAt, a.beaconRound, a.lockedAt, a.questionHash, a.configHash));
        }
        if (kind == 1) return keccak256(abi.encode(a.committedAt, a.commitmentRoot, a.entryCount, a.totalStake));
        return keccak256(abi.encode(a.manifestAnchoredAt, a.manifestHash));
    }
}

/// @notice CON-9 invariants: each round key is written at most once per kind and the first write is never changed;
///         writes follow the timelock (tlock) order lock < close <= commit < beacon <= manifest; write events match
///         storage; only ANCHOR_ROLE writes; and the admin's timelocked changes take effect only after their delay.
contract AnchorInvariantTest is StdInvariant, AnchorBase {
    AnchorHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new AnchorHandler(anchor, admin, anchorer, receiptSigner);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](20);
        selectors[0] = AnchorHandler.lockBatch.selector;
        selectors[1] = AnchorHandler.commitBatch.selector;
        selectors[2] = AnchorHandler.anchorManifest.selector;
        selectors[3] = AnchorHandler.warp.selector;
        selectors[4] = AnchorHandler.addKeys.selector;
        selectors[5] = AnchorHandler.scheduleSigner.selector;
        selectors[6] = AnchorHandler.executeSigner.selector;
        selectors[7] = AnchorHandler.cancelSigner.selector;
        selectors[8] = AnchorHandler.disableSigner.selector;
        selectors[9] = AnchorHandler.scheduleGrant.selector;
        selectors[10] = AnchorHandler.executeGrant.selector;
        selectors[11] = AnchorHandler.cancelGrant.selector;
        selectors[12] = AnchorHandler.revokeOrTryGrant.selector;
        // Writes are what the anchor is for: weight them so key windows get exercised between admin actions.
        selectors[13] = AnchorHandler.lockBatch.selector;
        selectors[14] = AnchorHandler.commitBatch.selector;
        selectors[15] = AnchorHandler.commitBatch.selector;
        selectors[16] = AnchorHandler.anchorManifest.selector;
        selectors[17] = AnchorHandler.anchorManifest.selector;
        selectors[18] = AnchorHandler.warp.selector;
        selectors[19] = AnchorHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Each round key is written at most once per kind, and what was written first is still stored.
    function invariant_eachKeyWrittenAtMostOncePerKind() public view {
        for (uint256 i; i < handler.keyCount(); i++) {
            bytes32 key = handler.keys(i);
            for (uint256 kind; kind < 3; kind++) {
                uint256 w = handler.writes(key, kind);
                assertLe(w, 1, "written twice");
                if (w == 1) assertEq(handler._snapshot(key, kind), handler.firstWrite(key, kind), "overwritten");
                else assertEq(handler._snapshot(key, kind), _emptySnapshot(kind), "written without an event");
            }
        }
        assertFalse(handler.eventMismatch(), "a write event differs from storage");
    }

    /// @notice Every stored write respects the beacon bounds and the timelock order: lock before close, commitment in
    ///         `[closesAt, beaconTime)`, manifest at or after the beacon; commitments and manifests need a lock.
    function invariant_writesInsideWindows() public view {
        for (uint256 i; i < handler.keyCount(); i++) {
            IFlockedAnchor.RoundAnchor memory a = anchor.getAnchor(handler.keys(i));
            if (a.lockedAt == 0) {
                assertEq(a.committedAt, 0);
                assertEq(a.manifestAnchoredAt, 0);
                continue;
            }
            uint256 bt = anchor.beaconTime(a.beaconRound);
            assertLt(a.lockedAt, a.closesAt);
            assertGe(bt, uint256(a.closesAt) + anchor.MIN_BEACON_DELAY());
            assertLe(bt, uint256(a.closesAt) + anchor.MAX_BEACON_DELAY());
            if (a.committedAt != 0) {
                assertGe(a.committedAt, a.closesAt);
                assertLt(a.committedAt, bt);
            }
            if (a.manifestAnchoredAt != 0) {
                assertGe(a.manifestAnchoredAt, bt);
                // So a commitment, when there is one, always precedes the manifest.
                if (a.committedAt != 0) assertLt(a.committedAt, a.manifestAnchoredAt);
            }
        }
    }

    /// @notice The admin's changes follow the timelock: nothing took effect before its 72 hours, the receipt signer
    ///         and ANCHOR_ROLE holders are exactly what the model's schedule/execute/cancel/revoke history implies,
    ///         every pending operation is ready exactly 72 hours after it was scheduled, and the `ReceiptSignerSet`
    ///         history is in order.
    function invariant_timelockOrdering() public view {
        assertFalse(handler.earlyExecution(), "a change took effect before its delay");
        assertFalse(handler.badSignerHistory(), "ReceiptSignerSet out of order");
        assertEq(anchor.receiptSigner(), handler.expectedSigner(), "receipt signer");
        bytes32 role = anchor.ANCHOR_ROLE();
        uint256 delay = anchor.ADMIN_TIMELOCK();
        for (uint256 i; i < handler.anchorerCount(); i++) {
            address a = handler.anchorers(i);
            assertEq(anchor.hasRole(role, a), handler.expectedAnchorer(a), "ANCHOR_ROLE holder");
            _assertPending(anchor.operationId(anchor.ACTION_ANCHOR_GRANT(), abi.encode(a)), delay);
        }
        for (uint256 i; i < handler.signerCount(); i++) {
            _assertPending(anchor.operationId(anchor.ACTION_RECEIPT_SIGNER(), abi.encode(handler.signers(i))), delay);
        }
    }

    function _assertPending(bytes32 id, uint256 delay) internal view {
        uint256 at = handler.scheduledAt(id);
        assertEq(anchor.timelockReadyAt(id), at == 0 ? 0 : at + delay, "timelockReadyAt");
    }

    function _emptySnapshot(uint256 kind) internal pure returns (bytes32) {
        if (kind == 0) return keccak256(abi.encode(uint64(0), uint64(0), uint64(0), bytes32(0), bytes32(0)));
        if (kind == 1) return keccak256(abi.encode(uint64(0), bytes32(0), uint32(0), uint64(0)));
        return keccak256(abi.encode(uint64(0), bytes32(0)));
    }

    /// @dev Debug aid: `forge test --mc AnchorInvariantTest -vv` prints how many writes a run made.
    function afterInvariant() external view {
        uint256[3] memory total;
        for (uint256 i; i < handler.keyCount(); i++) {
            for (uint256 kind; kind < 3; kind++) {
                total[kind] += handler.writes(handler.keys(i), kind);
            }
        }
        console.log("locks", total[0], "commits", total[1]);
        console.log("manifests", total[2], "without a commit", handler.manifestWithoutCommit());
        console.log("signer executions", handler.calls("executeSigner"), "keys", handler.keyCount());
    }
}
