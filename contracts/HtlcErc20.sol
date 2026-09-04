// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title HtlcErc20
 * @notice Universal Agent Asset Router — Architecture V4 (Phase 3)
 * Minimal, non-custodial, immutable ERC-20 Hashed Timelock Contract (HTLC).
 *
 * Enforces:
 * - EVM-SEC-1: Immutable deterministic HTLC identity.
 * - EVM-SEC-2: Hashlock cannot change after creation.
 * - EVM-SEC-3: Claim recipient cannot silently change.
 * - EVM-SEC-4: Refund recipient cannot silently change.
 * - EVM-SEC-5: Amount cannot change after funding.
 * - EVM-SEC-6: Correct preimage required for claim (P0 SHA-256 compatibility).
 * - EVM-SEC-7: Incorrect preimage can never claim.
 * - EVM-SEC-8: Refund impossible before timelock expiry.
 * - EVM-SEC-9: Claim and refund are strictly mutually exclusive.
 * - EVM-SEC-10: Double-claim impossible.
 * - EVM-SEC-11: Double-refund impossible.
 * - EVM-SEC-12: Terminal state prevents fund re-use.
 * - EVM-SEC-17: Zero admin keys, zero owner, zero backdoor seizure powers.
 * - EVM-SEC-18: Zero upgrade mechanisms; immutable logic.
 */
contract HtlcErc20 {
    enum Status {
        EMPTY,
        LOCKED,
        CLAIMED,
        REFUNDED
    }

    struct HtlcRecord {
        bytes32 hashLock;
        uint256 amount;
        address token;
        address sender;
        address claimAddress;
        address refundAddress;
        uint256 timelock;
        Status status;
    }

    mapping(bytes32 => HtlcRecord) public htlcs;

    event HtlcFunded(
        bytes32 indexed htlcId,
        bytes32 indexed hashLock,
        uint256 amount,
        address token,
        address sender,
        address claimAddress,
        address refundAddress,
        uint256 timelock
    );

    event HtlcClaimed(
        bytes32 indexed htlcId,
        bytes32 indexed hashLock,
        bytes preimage,
        address claimAddress
    );

    event HtlcRefunded(
        bytes32 indexed htlcId,
        bytes32 indexed hashLock,
        address refundAddress
    );

    /**
     * @notice Funds a new HTLC locking `amount` tokens until claim or refund.
     * @param hashLock The SHA-256 hash of the 32-byte preimage (P0: MUST be SHA-256, NOT keccak256).
     * @param amount Token amount in base units.
     * @param token ERC-20 contract address.
     * @param claimAddress Immutable recipient entitled to claim funds upon preimage presentation.
     * @param refundAddress Immutable recipient entitled to refund funds after timelock.
     * @param timelock Unix timestamp after which refund is permitted.
     * @return htlcId Deterministic unique identifier of the HTLC.
     */
    function fund(
        bytes32 hashLock,
        uint256 amount,
        address token,
        address claimAddress,
        address refundAddress,
        uint256 timelock
    ) external returns (bytes32 htlcId) {
        require(amount > 0, "ZERO_AMOUNT");
        require(hashLock != bytes32(0), "ZERO_HASHLOCK");
        require(token != address(0), "ZERO_TOKEN");
        require(claimAddress != address(0), "ZERO_CLAIM_ADDRESS");
        require(refundAddress != address(0), "ZERO_REFUND_ADDRESS");
        require(timelock > block.timestamp, "TIMELOCK_MUST_BE_FUTURE");

        htlcId = keccak256(
            abi.encode(
                hashLock,
                amount,
                token,
                msg.sender,
                claimAddress,
                refundAddress,
                timelock,
                block.chainid
            )
        );

        require(htlcs[htlcId].status == Status.EMPTY, "HTLC_ALREADY_EXISTS");

        // Checks-Effects-Interactions: state recorded BEFORE external token transfer
        htlcs[htlcId] = HtlcRecord({
            hashLock: hashLock,
            amount: amount,
            token: token,
            sender: msg.sender,
            claimAddress: claimAddress,
            refundAddress: refundAddress,
            timelock: timelock,
            status: Status.LOCKED
        });

        _safeTransferFrom(token, msg.sender, address(this), amount);

        emit HtlcFunded(
            htlcId,
            hashLock,
            amount,
            token,
            msg.sender,
            claimAddress,
            refundAddress,
            timelock
        );
    }

    /**
     * @notice Claims locked tokens by revealing the preimage matching the hashlock.
     * Tokens are unconditionally sent to `claimAddress` regardless of caller.
     * @param htlcId Unique HTLC identifier.
     * @param preimage Secret preimage that hashes to `htlc.hashLock` via SHA-256.
     */
    function claim(bytes32 htlcId, bytes calldata preimage) external {
        HtlcRecord storage htlc = htlcs[htlcId];
        require(htlc.status == Status.LOCKED, "NOT_LOCKED");

        // P0 REQUIREMENT: Must match Lightning SHA-256 hold invoice byte-for-byte
        require(sha256(preimage) == htlc.hashLock, "INVALID_PREIMAGE");

        // Checks-Effects-Interactions: Transition to CLAIMED before token dispatch
        htlc.status = Status.CLAIMED;

        // Payout is strictly and unconditionally delivered to the immutable claimAddress
        _safeTransfer(htlc.token, htlc.claimAddress, htlc.amount);

        emit HtlcClaimed(htlcId, htlc.hashLock, preimage, htlc.claimAddress);
    }

    /**
     * @notice Refunds locked tokens to `refundAddress` once timelock has expired.
     * @param htlcId Unique HTLC identifier.
     */
    function refund(bytes32 htlcId) external {
        HtlcRecord storage htlc = htlcs[htlcId];
        require(htlc.status == Status.LOCKED, "NOT_LOCKED");
        require(block.timestamp >= htlc.timelock, "TIMELOCK_NOT_EXPIRED");

        // Checks-Effects-Interactions: Transition to REFUNDED before token dispatch
        htlc.status = Status.REFUNDED;

        // Payout is strictly and unconditionally delivered to the immutable refundAddress
        _safeTransfer(htlc.token, htlc.refundAddress, htlc.amount);

        emit HtlcRefunded(htlcId, htlc.hashLock, htlc.refundAddress);
    }

    /**
     * @notice Authoritative view to query complete HTLC storage state.
     */
    function getHtlc(bytes32 htlcId) external view returns (HtlcRecord memory) {
        return htlcs[htlcId];
    }

    /**
     * @notice Safe token transfer supporting standard and non-standard ERC-20s.
     */
    function _safeTransfer(address token, address to, uint256 value) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, value)
        );
        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            "TRANSFER_FAILED"
        );
    }

    /**
     * @notice Safe token transferFrom supporting standard and non-standard ERC-20s.
     */
    function _safeTransferFrom(
        address token,
        address from,
        address to,
        uint256 value
    ) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, value)
        );
        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            "TRANSFER_FROM_FAILED"
        );
    }
}
