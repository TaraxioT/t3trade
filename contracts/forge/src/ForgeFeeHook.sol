// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";

/**
 * @title ForgeFeeHook
 * @notice Fixed Uniswap v4 dynamic-fee hook for the single T3 Forge pool.
 *
 * Fee policy (fail-closed):
 *  - The one bound pool charges BASELINE_FEE (3000, 0.30%) whenever no policy is
 *    active, and POLICY_FEE (500, 0.05%) while a published, unexpired policy is in
 *    force and the hook is not paused.
 *  - Every other pool receives no fee override (returns 0); this hook never
 *    governs pools other than the bound one.
 *
 * v4.0.0 mechanics (verified against pinned v4-core):
 *  - Only pools initialized with fee == LPFeeLibrary.DYNAMIC_FEE_FLAG honor the
 *    third beforeSwap return value. The override must carry the
 *    LPFeeLibrary.OVERRIDE_FEE_FLAG bit; PoolManager then applies
 *    fee.removeOverrideFlagAndValidate() for that swap.
 *  - The ONLY hook permission this contract uses is BEFORE_SWAP (address bit 7).
 *    The constructor enforces this by calling Hooks.validateHookPermissions on
 *    its own address (the v4.0.0 equivalent of BaseHook constructor validation),
 *    so a deployment to an address without exactly the required bits reverts.
 *
 * Pool binding:
 *  - The constructor takes `PoolId _boundPoolId`, the id of the single governed
 *    pool. A full v4 pool id is keccak256(abi.encode(currency0, currency1, fee,
 *    tickSpacing, hooks)) and therefore embeds THIS hook's own address, which
 *    makes binding a constructor argument to a not-yet-deployed pool
 *    mathematically impossible (the id and the CREATE2 address are mutually
 *    dependent). The binding id used here is therefore the pool identity minus
 *    the hook address, keccak256(abi.encode(currency0, currency1, fee,
 *    tickSpacing)) — see `bindingIdForPool`. It uniquely identifies the pool F3
 *    creates (one pool per pair/fee/tickSpacing/hook combination); a pool that
 *    does not match it exactly is unbound and receives no override.
 */
contract ForgeFeeHook is IHooks {
    using LPFeeLibrary for uint24;

    // ---------------------------------------------------------------- fees
    uint24 public constant BASELINE_FEE = 3000; // 0.30%, hundredths of a bip
    uint24 public constant POLICY_FEE = 500; // 0.05%, hundredths of a bip

    // ------------------------------------------------------------- binding
    /// @notice The binding id of the single pool governed by this hook.
    PoolId public immutable boundPoolId;

    // --------------------------------------------------------------- roles
    /// @notice Deployer; sole caller of pause/unpause/setOperator.
    address public immutable owner;
    /// @notice Sole caller of publishPolicy/revokePolicy. Initially the deployer;
    /// rotated with setOperator (F3 authorizes the server operator this way).
    address public operator;

    // -------------------------------------------------------------- state
    /// @notice Global kill switch: while paused every pool (including the bound
    /// pool) pays BASELINE_FEE; policies and the operator are left untouched.
    bool public paused;

    /// @notice The current policy record for the bound pool.
    struct Policy {
        uint256 revision; // strictly increasing high-water mark, never reset
        uint256 expiry; // unix seconds; policy is active while expiry > block.timestamp
        bytes32 evidenceDigest; // detector evidence digest the policy was derived from
    }

    Policy internal policy;

    // -------------------------------------------------------------- errors
    error NotOwner();
    error NotOperator();
    error WrongPool(PoolId poolId);
    error RevisionNotIncreasing(uint256 provided, uint256 current);
    error ExpiryNotFuture(uint256 expiry, uint256 currentTime);
    error NoPolicyStored();
    error AlreadyPaused();
    error NotPaused();
    error HookNotImplemented();

    // -------------------------------------------------------------- events
    event PolicyPublished(PoolId indexed poolId, uint256 revision, uint256 expiry, bytes32 evidenceDigest);
    event PolicyRevoked(PoolId indexed poolId, uint256 revision);
    event Paused();
    event Unpaused();
    event OperatorSet(address indexed newOperator);

    /**
     * @param _boundPoolId Binding id of the governed pool (see bindingIdForPool).
     * Deploying at an address whose low 14 bits are not exactly BEFORE_SWAP_FLAG
     * reverts (Hooks.HookAddressNotValid) — this validation must never be
     * removed or bypassed.
     */
    constructor(PoolId _boundPoolId) {
        // v4.0.0 address-bit self-validation (see Hooks.validateHookPermissions
        // docstring: intended to be used in hook constructors).
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: false,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );

        boundPoolId = _boundPoolId;
        owner = msg.sender;
        operator = msg.sender;
    }

    // ================================================================ roles
    /// @notice Owner-only operator rotation. F3 uses this to authorize the
    /// server operator after deployment. address(0) disables policy writes.
    function setOperator(address newOperator) external {
        if (msg.sender != owner) revert NotOwner();
        operator = newOperator;
        emit OperatorSet(newOperator);
    }

    // ============================================================== policy
    /**
     * @notice Publish (or supersede) the fee policy of the bound pool.
     * @dev `revision` must strictly exceed the stored high-water revision, and
     * `expiry` must be strictly in the future. Publishing while paused is
     * allowed: the pause freezes fee effects, not policy administration.
     */
    function publishPolicy(PoolId poolId, uint256 revision, uint256 expiry, bytes32 evidenceDigest) external {
        if (msg.sender != operator) revert NotOperator();
        if (PoolId.unwrap(poolId) != PoolId.unwrap(boundPoolId)) revert WrongPool(poolId);
        if (revision <= policy.revision) revert RevisionNotIncreasing(revision, policy.revision);
        if (expiry <= block.timestamp) revert ExpiryNotFuture(expiry, block.timestamp);

        policy = Policy({revision: revision, expiry: expiry, evidenceDigest: evidenceDigest});

        emit PolicyPublished(poolId, revision, expiry, evidenceDigest);
    }

    /**
     * @notice Revoke the stored policy. The revision high-water mark is kept,
     * so a later publish must still use a strictly higher revision.
     */
    function revokePolicy(PoolId poolId) external {
        if (msg.sender != operator) revert NotOperator();
        if (PoolId.unwrap(poolId) != PoolId.unwrap(boundPoolId)) revert WrongPool(poolId);
        if (policy.revision == 0) revert NoPolicyStored();

        uint256 revokedRevision = policy.revision;
        policy.expiry = 0;
        policy.evidenceDigest = 0;

        emit PolicyRevoked(poolId, revokedRevision);
    }

    // ================================================================ pause
    /// @notice Owner-only global stop: the bound pool returns to BASELINE_FEE.
    /// Does not touch the operator or stored policies.
    function pause() external {
        if (msg.sender != owner) revert NotOwner();
        if (paused) revert AlreadyPaused();
        paused = true;
        emit Paused();
    }

    function unpause() external {
        if (msg.sender != owner) revert NotOwner();
        if (!paused) revert NotPaused();
        paused = false;
        emit Unpaused();
    }

    // ================================================================ views
    /// @notice True while a published policy is unexpired and the hook is not
    /// paused. This is the only condition that yields POLICY_FEE.
    function policyActive() public view returns (bool) {
        return !paused && policy.expiry > block.timestamp;
    }

    /**
     * @notice Clean effective LP fee the hook applies to `poolId` right now:
     * POLICY_FEE / BASELINE_FEE for the bound pool, or 0 for any other pool,
     * where 0 means "no override" (the hook does not govern that pool), not a
     * 0% fee.
     */
    function effectiveFee(PoolId poolId) public view returns (uint24) {
        if (PoolId.unwrap(poolId) != PoolId.unwrap(boundPoolId)) return 0;
        return policyActive() ? POLICY_FEE : BASELINE_FEE;
    }

    /// @notice The exact raw uint24 the beforeSwap hook returns for `poolId`:
    /// OVERRIDE_FEE_FLAG | effectiveFee for the bound pool, 0 (no override)
    /// otherwise. This is the value F3 should expect on the wire.
    function beforeSwapFeeOverride(PoolId poolId) external view returns (uint24) {
        uint24 fee = effectiveFee(poolId);
        return fee == 0 ? 0 : fee | LPFeeLibrary.OVERRIDE_FEE_FLAG;
    }

    /// @notice Stored policy record (revision high-water, expiry, digest).
    function getPolicy() external view returns (Policy memory) {
        return policy;
    }

    /// @notice Binding id of a pool identity: everything in the v4 PoolKey
    /// except the hook address. Compute this for the F3 pool and pass it to the
    /// constructor.
    function bindingIdForPool(Currency currency0, Currency currency1, uint24 fee, int24 tickSpacing)
        public
        pure
        returns (PoolId)
    {
        return PoolId.wrap(keccak256(abi.encode(currency0, currency1, fee, tickSpacing)));
    }

    // ================================================================ hooks
    /**
     * @notice The single hook this contract implements. For the bound pool it
     * always returns an explicit fee override (baseline or policy fee); for any
     * other pool it returns 0 so the pool's own stored fee applies.
     */
    function beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata, bytes calldata)
        external
        view
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        uint24 fee = effectiveFee(
            bindingIdForPool(key.currency0, key.currency1, key.fee, key.tickSpacing)
        );
        return (
            IHooks.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            fee == 0 ? 0 : fee | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }

    // ------------------------------------------------- unimplemented hooks
    // v4 only calls hooks whose permission bit is set in the hook address; this
    // contract sets ONLY BEFORE_SWAP. Any other call is a misuse and reverts,
    // matching the pinned dependency's own BaseTestHooks pattern.
    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
