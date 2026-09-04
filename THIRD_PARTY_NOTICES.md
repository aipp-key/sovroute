# THIRD-PARTY SOFTWARE NOTICES AND LICENSES

This project incorporates architectural patterns and interfaces inspired by open-source projects under the permissive MIT license.

---

## 1. Satora / LendaSwap Contracts
- **Original Project**: [satoraHQ/lendaswap-contracts](https://github.com/satoraHQ/lendaswap-contracts)
- **License**: MIT License
- **Copyright**: (c) 2024 LendaSwap / Satora Contributors
- **Usage in this Project**:
  - The minimal mapping-based HTLC state layout and storage structure in `contracts/HtlcErc20.sol` was adapted from the open-source MIT design of `HTLCErc20.sol`.
  - Our implementation strips all external DEX aggregators, Permit2 dependencies, EIP-1153 transient storage, and 1inch calldata hooks, retaining only the minimal immutable atomic primitive.

### MIT License Text
```
MIT License

Copyright (c) 2024 LendaSwap

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. OpenZeppelin Contracts (Minimal Standard Interfaces)
- **Project**: OpenZeppelin Contracts
- **License**: MIT License
- **Copyright**: (c) 2016-2024 OpenZeppelin
- **Usage**: Minimal ERC-20 token interface patterns used in `contracts/MockSettlementToken.sol`.
