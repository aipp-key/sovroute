// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title MockSettlementToken
 * @notice Universal Agent Asset Router — Architecture V4 (Phase 3)
 * Deterministic 6-decimal test ERC-20 token simulating USDC base units for local devnet tests.
 */
contract MockSettlementToken {
    string public name = "Mock Settlement Token";
    string public symbol = "MST";
    uint8 public decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        // Mint initial dev supply to deployer (1,000,000 tokens with 6 decimals)
        _mint(msg.sender, 1_000_000 * 10 ** 6);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "INSUFFICIENT_BALANCE");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(balanceOf[from] >= value, "INSUFFICIENT_BALANCE");
        require(allowance[from][msg.sender] >= value, "INSUFFICIENT_ALLOWANCE");

        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;

        emit Transfer(from, to, value);
        return true;
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
}
