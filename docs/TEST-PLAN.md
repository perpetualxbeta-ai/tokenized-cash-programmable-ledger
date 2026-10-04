# Test Plan: Tokenized Cash & Programmable Ledger

| | |
| --- | --- |
| Version | 1.0 (October 2026) |
| Applies to | `main` at `e0b693c` (contracts v0.1.0) |
| Related | [`README.md`](../README.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), `.github/workflows/ci.yml` |

## 1. Purpose

This plan defines how the ledger prototype is tested: what is in scope, which techniques are
used at each level, the full catalogue of test cases (existing and to be added), the entry
and exit criteria, and how the work plugs into CI. It also records behaviours found while
reviewing the code that need a product decision before a test can assert the "right" answer
(section 8).

## 2. Scope

**In scope**

| Component | Path | Notes |
| --- | --- | --- |
| `IdentityRegistry` | `contracts/IdentityRegistry.sol` | Participant directory, KYC tiers, holding limits |
| `CashToken` | `contracts/CashToken.sol` | Reserves-backed issuance, redemption, ledger rules in `_update`, compliance controls |
| `ConditionalPayments` | `contracts/ConditionalPayments.sol` | Multi-milestone escrow, disputes, deadlines, pull payments |
| `PurposeBoundMoney` | `contracts/PurposeBoundMoney.sol` | Vouchers, merchant allowlists, expiry and reclaim |
| `DvPSettlement` | `contracts/DvPSettlement.sol` | Atomic asset-versus-cash settlement |
| `AssetToken` | `contracts/AssetToken.sol` | Permissioned bond token (DvP delivery leg) |
| Deployment library | `scripts/lib/deploy.js`, `scripts/deploy.js` | Stack wiring, SYSTEM registration, address output |
| Simulator | `sim/run.js`, `sim/indexer.js`, `sim/report.js` | Scenario engine, event journal, reconciliation, HTML report |

**Out of scope**

- Off-chain fiat movements (reserve deposits, redemption payouts). They are modelled only as
  `attestReserves` calls.
- Public-network deployment, key management and upgrade paths. The prototype uses a single
  deployer key for every role.
- Roadmap items not yet built (explorer frontend, streaming payments, PvP, privacy).
- Production-grade security assurance. The plan improves confidence but does not replace an
  external audit.

## 3. Baseline (measured at `e0b693c`)

`npm test`: **43 passing** (about 10 s). `npx hardhat coverage`:

| File | Stmts | Branch | Funcs | Lines | Uncovered lines |
| --- | ---: | ---: | ---: | ---: | --- |
| AssetToken.sol | 85.71 | 66.67 | 75 | 87.50 | 27 (`decimals`) |
| CashToken.sol | 97.44 | 88.64 | 100 | 100 | |
| ConditionalPayments.sol | 100 | 90.91 | 100 | 100 | |
| DvPSettlement.sol | 94.12 | 62.50 | 80 | 95.45 | 100 (`getTrade`) |
| IdentityRegistry.sol | 86.96 | 70.00 | 70 | 88.89 | 95, 103, 107 (`participant`, `participantCount`, `participantAt`) |
| PurposeBoundMoney.sol | 93.94 | 78.95 | 88.89 | 95.74 | 132, 138 (`getProgram`, `spendableBalance`) |
| **All** | **95.18** | **80.68** | **88.24** | **96.71** | |

Line coverage is already high. **Branch coverage (80.7%) is the weak spot**, especially in
`DvPSettlement` (62.5%) and `IdentityRegistry` (70%). Most new cases below target branches and
boundaries rather than lines.

Existing suites: `R-01..03`, `C-01..14`, `E-01..11`, `P-01..07`, `D-01..07`, `INV-01`. The new
IDs below continue those sequences so the README table stays valid.

## 4. Test levels and approach

| Level | Technique | Tooling | Where |
| --- | --- | --- | --- |
| Unit | One contract per suite, shared `ledgerFixture` snapshot, positive and negative paths, custom-error assertions, event assertions | Hardhat, Mocha/Chai, `hardhat-network-helpers` | `test/*.test.js` |
| Boundary | Exact-limit, limit+1 cent, timestamp `==` deadline/expiry, zero amounts | `time.setNextBlockTimestamp` | Same suites |
| Integration | Flows crossing modules (ledger rules applied through escrow, PBM and DvP; pause and freeze mid-lifecycle) | Same | New `test/Integration.test.js` |
| Stateful property | Seeded random sequences with invariants after every step | `test/Invariants.test.js`, later Foundry | Existing, to be extended |
| Adversarial | Mock tokens with callbacks or lying return values, reentrancy and griefing attempts | Small mocks under `contracts/test/` | New |
| End-to-end | 50-participant, 14-day simulation with reconciliation and journal replay | `npm run sim` | `sim/` |
| Static analysis | Slither detectors, compiler warnings | Slither in CI | New CI step |
| Non-functional | Gas per operation, loop-size limits | `REPORT_GAS=true npm test` (gas reporter ships with the toolbox) | CI artifact |

Conventions for every new test:

- Assert the **specific custom error** (`revertedWithCustomError`) and, where it matters, its
  arguments, never a bare `reverted`.
- For every revert, assert that **state did not change** (balances, counters, totals).
- For every success, assert the **event and its fields**, since the indexer and journal depend on
  them.
- Use `loadFixture` so each test starts from the same snapshot.

## 5. Environment

- Node 22 (CI) and Node 18 or newer locally; `npm ci`.
- Hardhat in-process network with 60 accounts; Solidity 0.8.24 from the pinned `solc` npm
  package, optimizer at 200 runs, EVM `cancun`.
- Seeds: `INVARIANT_SEED`, `INVARIANT_STEPS`, `SIM_SEED`, `SIM_DAYS` (the simulator clamps
  `SIM_DAYS` to a minimum of 12).

## 6. Test case catalogue

Priority: **P1** must pass before merge to `main`, **P2** should be in place before any demo or
external sharing, **P3** completes coverage.

### 6.1 IdentityRegistry (R)

| ID | Case | Expected | Pri |
| --- | --- | --- | --- |
| R-01..03 | *Existing:* registration, duplicate/NONE/role checks, limits only for individuals | | |
| R-04 | `update()` on an unregistered address, with `Kind.NONE`, and from a non-registrar | `NotRegistered`, `InvalidKind`, `AccessControlUnauthorizedAccount` | P2 |
| R-05 | Deactivate then reactivate a participant | `isAllowed` goes false then true; `ParticipantUpdated` emitted each time | P1 |
| R-06 | Change an individual's tier, then change their kind to CORPORATE | `holdingLimitOf` follows the new tier; becomes 0 (uncapped) after the kind change | P1 |
| R-07 | `participantCount` / `participantAt` / `participant` | Registration order preserved; out-of-range index reverts (panic 0x32) | P3 |
| R-08 | `register(address(0))`; constructor with `admin = address(0)` | `ZeroAddress` both times | P3 |
| R-09 | `setTierHoldingLimit` by non-registrar; setting a limit to 0 | Access-control revert; 0 means unlimited; `TierLimitSet` emitted | P2 |

### 6.2 CashToken (C)

| ID | Case | Expected | Pri |
| --- | --- | --- | --- |
| C-01..14 | *Existing:* decimals, reserves, roles, redeem, backing ratio, `pay`, permissioning, limits, freeze, force-transfer, pause | | |
| C-15 | Plain ERC-20 `transfer` and `transferFrom` against every ledger rule (unregistered, deactivated, frozen sender/receiver, holding limit, pause) | Same reverts as `pay()`. The rules live in `_update`, but existing tests mostly use `pay` | P1 |
| C-16 | `transferFrom` executed by a frozen or unregistered **spender** between two valid accounts | Succeeds today: only `from`/`to` are checked. See Q-04 | P2 |
| C-17 | Holding limit boundaries: receive to exactly the limit, then 0.01 more; `mint` to an individual above the limit | Exact limit OK; +0.01 reverts `HoldingLimitExceeded(to, limit, newBalance)`; mint reverts with no supply change | P1 |
| C-18 | Tier limit lowered below an existing balance | Holder can still send and redeem; any receipt reverts until the balance is under the limit | P2 |
| C-19 | Individual at their limit transfers to themselves | Succeeds (`from == to` skips the limit check) | P3 |
| C-20 | `redeem` more than balance, zero, and by a deactivated participant | `ERC20InsufficientBalance`, `ZeroAmount`, `NotAllowed`. See Q-05 | P1 |
| C-21 | `mint` of zero; mint landing exactly on `attestedReserves` | `ZeroAmount`; exact boundary succeeds; `Issued(to, amount, ref)` emitted | P2 |
| C-22 | `attestReserves` equal to supply; lowering reserves after a redemption | Allowed; `ReservesAttested(reserves, supply)` carries the right values | P2 |
| C-23 | `backingRatioBps` with zero supply | Returns `type(uint256).max` | P3 |
| C-24 | `forceTransfer` edge cases: to a frozen or unregistered destination; amount above balance; from a deactivated account; normal transfer from the frozen account afterwards | Destination rules still apply; insufficient balance reverts; deactivated source works; `_forcing` is reset, so the next normal transfer from the frozen account reverts `AccountIsFrozen` | P1 |
| C-25 | `forceTransfer` while paused | Reverts `EnforcedPause` today. See Q-06 | P2 |
| C-26 | `freeze`, `unfreeze`, `attestReserves` while paused; `redeem` while paused | Admin actions succeed; redeem reverts `EnforcedPause` | P2 |
| C-27 | Role separation: grant ISSUER/COMPLIANCE/PAUSER to distinct accounts, revoke from deployer | Each control works only for its role holder; revoked deployer is rejected; only `DEFAULT_ADMIN_ROLE` can grant | P2 |
| C-28 | Freeze a SYSTEM contract (escrow or PBM) | Every outflow from that module reverts (withdraw, spend, reclaim); totals unchanged; recover after unfreeze | P2 |
| C-29 | Event completeness for the indexer: `pay` emits `Transfer` then `Payment`; mint/redeem/forceTransfer emit `Transfer` plus their domain event | Order and fields as listed | P2 |

### 6.3 ConditionalPayments (E)

| ID | Case | Expected | Pri |
| --- | --- | --- | --- |
| E-01..11 | *Existing:* creation, release/refund, single settlement, pull payment with frozen payee, disputes, deadline reclaim | | |
| E-12 | `create` matrix: arbiter == payee, arbiter == payer, payee == 0, deadline == `block.timestamp`, insufficient allowance | `InvalidParty` / `DeadlineInPast` / ERC-20 revert; `escrowCount` and `totalLocked` unchanged | P1 |
| E-13 | `release`/`refund` on a non-existent id; milestone index out of range | `Unauthorized`; `InvalidMilestone` | P2 |
| E-14 | Arbiter releases and refunds **without** a dispute; third party acts on an escrow with no arbiter | Arbiter allowed; third party `Unauthorized` | P2 |
| E-15 | Payee refunds while the escrow is disputed | Succeeds today (refund ignores `disputed`). Confirm, see Q-02 | P2 |
| E-16 | Payer releases after the deadline; reclaim after a partial release; reclaim twice | Release still allowed until reclaimed; reclaim takes only PENDING milestones; second reclaim `NotPending` | P1 |
| E-17 | Reclaim at exactly the deadline timestamp, and one second before | At deadline succeeds; before reverts `DeadlineNotReached` | P2 |
| E-18 | Dispute when every milestone is settled; dispute twice; arbiter never acts | No revert, no state change beyond the flag; a disputed escrow with an absent arbiter has **no exit path**. See Q-01 | P1 |
| E-19 | Individual payee whose `claimable` exceeds their remaining holding-limit headroom (and a case where it exceeds the tier limit itself) | `withdraw` reverts `HoldingLimitExceeded`; `claimable` and `totalClaimable` unchanged. Withdraw is all-or-nothing, so funds above the tier limit are stuck. See Q-03 | P1 |
| E-20 | `withdraw` by a deactivated participant, then after reactivation | Reverts `NotAllowed`; succeeds after reactivation; totals consistent throughout | P1 |
| E-21 | Accounting while the ledger is paused | `release`, `refund`, `dispute`, `reclaimAfterDeadline` succeed (no token movement); `create` and `withdraw` revert. Confirm, see Q-06 | P2 |
| E-22 | Several escrows paying the same payee | `claimable` aggregates across escrows; a single `withdraw` drains all | P2 |
| E-23 | Gas for `create` and `reclaimAfterDeadline` with 10, 100 and 500 milestones | Record gas; define a maximum milestone count that stays well under the block gas limit | P3 |
| E-24 | Event fields: `EscrowCreated`, `MilestoneReleased.by`, `MilestoneRefunded.by`, `Reclaimed.amount`, `Withdrawn` | Match inputs and amounts | P3 |
| E-25 | Reentrancy with a mock ERC-20 that calls back into the escrow on transfer | `nonReentrant` blocks `create`/`withdraw` re-entry; no double credit | P3 |

### 6.4 PurposeBoundMoney (P)

| ID | Case | Expected | Pri |
| --- | --- | --- | --- |
| P-01..07 | *Existing:* 1:1 lock, spend at approved merchant, allowlist, overspend, merchant admin, expiry and reclaim, frozen merchant | | |
| P-08 | `issue` with length mismatch, a zero amount, by a non-sponsor, after expiry, with insufficient allowance | `LengthMismatch`, `ZeroAmount`, `Unauthorized`, `Expired`, ERC-20 revert; no voucher balances or totals change | P1 |
| P-09 | Repeated `issue` to overlapping recipients | Balances accumulate; `outstanding` and `totalOutstanding` equal the sum | P2 |
| P-10 | Spend the exact balance; spend at exactly `expiry`; spend zero | Exact balance OK; at expiry `Expired`; zero `ZeroAmount` | P1 |
| P-11 | Sponsor approves a non-MERCHANT address (an individual, or the voucher holder) as a merchant | Spend succeeds today, so a holder approved as "merchant" can convert vouchers to cash. See Q-07 | P1 |
| P-12 | Approved merchant is deactivated, or is an individual at their holding limit | Spend reverts with the ledger error; voucher balance intact | P2 |
| P-13 | `reclaimExpired` before expiry, twice, with zero outstanding, while the sponsor is frozen | `NotExpired`; `AlreadyReclaimed`; zero-amount reclaim succeeds and emits 0; frozen sponsor reverts and can retry after unfreeze (the `reclaimed` flag rolls back) | P1 |
| P-14 | Read holder state after reclaim | `outstanding` is 0 and `spendableBalance` is 0, but the public `balanceOf[id][holder]` still shows the old value. Consumers must use `spendableBalance` | P2 |
| P-15 | Two programs with different merchants | Vouchers from program 1 cannot be spent under program 2; approvals are per program | P1 |
| P-16 | Voucher transferability | ABI exposes no voucher transfer function | P3 |
| P-17 | `getProgram` and `spendableBalance` views before and after expiry | Correct struct; `spendableBalance` drops to 0 at expiry | P3 |
| P-18 | `createProgram` with an empty merchant list; expiry == now | Program created with no merchants; `ExpiryInPast` | P3 |
| P-19 | Vouchers issued to an unregistered address, which then spends | Succeeds today: the cash leg runs PBM to merchant, so the holder is never checked against the registry. See Q-08 | P2 |

### 6.5 DvPSettlement (D)

| ID | Case | Expected | Pri |
| --- | --- | --- | --- |
| D-01..07 | *Existing:* atomic settle, proposer can't self-settle, either leg failing rolls back, expiry/cancel, party checks, permissioned asset | | |
| D-08 | Settle at exactly the deadline; propose with deadline == now | Both `Expired` | P2 |
| D-09 | Propose with seller == buyer, zero asset amount, zero cash amount | `InvalidTrade` | P2 |
| D-10 | **Buyer** proposes, seller settles | Settles with the buyer's pre-approval; balances move both ways | P1 |
| D-11 | Settle or cancel a SETTLED trade; cancel a CANCELLED one; settle a non-existent id | `InvalidStatus` | P2 |
| D-12 | Seller frozen in cash | Whole settlement reverts (cash leg to seller); bonds unmoved; status still PROPOSED | P1 |
| D-13 | Ledger paused at settle time, then unpaused before the deadline | First attempt reverts and leaves PROPOSED; second settles | P1 |
| D-14 | Seller proposes a fake `asset` (mock ERC-20 whose `transferFrom` returns true without moving anything) | Settles today: the buyer pays and gets nothing. Buyer must verify `asset`. See Q-09 | P1 |
| D-15 | Seller proposes with a victim as buyer (victim has max approval for other trades) | No one but the victim can trigger settlement; victim's cash is safe | P1 |
| D-16 | `getTrade` view | Full struct including `proposer` and `status` | P3 |
| D-17 | Two trades drawing on one limited cash allowance | First settles; second reverts cleanly and stays PROPOSED | P3 |

### 6.6 AssetToken (A, new)

| ID | Case | Expected | Pri |
| --- | --- | --- | --- |
| A-01 | `decimals`, `mint` by non-issuer, mint to an unregistered address | 0; access-control revert; `NotAllowed` | P2 |
| A-02 | Transfers between registered holders; from a deactivated holder | OK; `NotAllowed` | P2 |
| A-03 | Holder frozen in `CashToken` transfers bonds directly | Succeeds: the asset has no freeze or pause. See Q-10 | P2 |

### 6.7 Cross-module integration (X, new file `test/Integration.test.js`)

| ID | Case | Expected | Pri |
| --- | --- | --- | --- |
| X-01 | Deactivate a SYSTEM contract in the registry | Every flow that moves cash in or out of it reverts; reactivation restores; totals unchanged | P2 |
| X-02 | Pause in the middle of live escrows, PBM programmes and proposed trades, then resume | Nothing moves while paused; all lifecycles complete afterwards; invariants hold | P1 |
| X-03 | Compact end-to-end lifecycle: reserves, issuance, payroll, escrow, voucher spend, DvP, freeze and force-transfer, redemption | Every step succeeds; invariants checked after each one | P1 |
| X-04 | Amounts at 0.01 granularity across all modules | No rounding loss; sums exact | P3 |

### 6.8 Invariants (INV)

| ID | Case | Pri |
| --- | --- | --- |
| INV-01 | *Existing:* 250 steps per `npm test`, 1,000 in CI, seven invariants after each step | |
| INV-02 | Extend the operation set with the actions the random run never performs today: `forceTransfer`, `pause`/`unpause`, registry `update` (deactivate, tier change, kind change), `dispute` plus arbiter settlement, `setMerchant`, `cancel`, `attestReserves`, plain `transfer`/`transferFrom`. Relax invariant 7 only for force-transfer steps | P1 |
| INV-03 | Add internal-accounting invariants: sum of pending milestone amounts == `totalLocked`; sum of `claimable` over known accounts == `totalClaimable`; sum of programme `outstanding` == `totalOutstanding`; every `TradeSettled` has matching asset and cash `Transfer` events in the same tx | P1 |
| INV-04 | Nightly multi-seed run (for example 10 seeds × 1,000 steps); a failing seed is printed and turned into a regression test | P2 |
| INV-05 | Foundry invariant fuzzing with handler contracts (roadmap item), using the same invariant list | P2 |

### 6.9 Simulation and indexer (S, new)

| ID | Case | Expected | Pri |
| --- | --- | --- | --- |
| S-01 | Default `npm run sim` | Exit 0; all six checks PASS (already in CI) | P1 |
| S-02 | Determinism: two runs with the same seed | Identical `report.json` and `journal.csv` once wall-clock fields are removed (`meta.generatedAt`, absolute timestamps that depend on the chain start time) | P1 |
| S-03 | Seeds 1 to 10; `SIM_DAYS` of 5, 12 and 30 | All checks PASS; `SIM_DAYS < 12` runs as 12 | P2 |
| S-04 | Fault injection: drop one event in the indexer, or skip a mint in replay | The journal-replay check FAILS and the process exits 1, proving the checks are not vacuous | P1 |
| S-05 | Add invariants 6 (holding limits) and 7 (frozen balances) to the end-of-run reconciliation, and reconcile `assetJournal` against bond balances | Both new checks PASS on the default run | P2 |
| S-06 | Indexer unit tests: each event type maps to the right journal category, sign and counterparties | Fixed sample events produce the expected entries | P2 |
| S-07 | Report renders offline: no external requests, required sections present | `report.html` is self-contained | P3 |

### 6.10 Deployment (DEP, new)

| ID | Case | Expected | Pri |
| --- | --- | --- | --- |
| DEP-01 | `npm run node` + `npm run deploy:local` | `deployments/localhost.json` holds network, chainId, admin and all six contract addresses; escrow, PBM and DvP registered as SYSTEM; issuer registered as ISSUER | P2 |
| DEP-02 | Run the deploy script twice | Second run produces a fresh stack and overwrites the file without error | P3 |

### 6.11 Non-functional (NF, new)

| ID | Case | Expected | Pri |
| --- | --- | --- | --- |
| NF-01 | Gas report for `mint`, `pay`, `create`, `release`, `withdraw`, `issue`, `spend`, `settle` | Baseline stored as a CI artifact; regressions over 10% flagged in review | P3 |
| NF-02 | Slither on `contracts/` | No high or medium findings left untriaged; accepted findings documented | P2 |
| NF-03 | Compiler warnings | Zero | P3 |

## 7. Requirements traceability

| Requirement (README / ARCHITECTURE) | Test IDs |
| --- | --- |
| Issuance never exceeds attested reserves | C-02, C-03, C-21, C-22, INV-01, S-01 |
| Every transfer checked against registry, limits, freeze, pause | C-07..C-15, C-17, C-18, R-05, R-06, INV-02 |
| Compliance can force-transfer from frozen accounts | C-12, C-24, C-25 |
| Escrow: deadlines, arbiter, disputes, pull payments | E-04..E-22 |
| Escrow cash == locked + claimable | INV-01, INV-03, S-01 |
| PBM spendable only at approved merchants before expiry; unspent value returns | P-02..P-06, P-10..P-15 |
| PBM cash == outstanding | INV-01, INV-03, S-01 |
| DvP atomic, never custodies cash | D-01, D-03, D-04, D-12, D-13, INV-01 |
| Journal replay reproduces balances | S-01, S-04, S-06 |
| Runs reproducible by seed | S-02, INV-04 |

## 8. Open questions and risk-based cases

Code review surfaced the behaviours below. Each has a test that pins **today's** behaviour, so
any change is deliberate. Until the owner decides, the test asserts current behaviour and
carries a comment linking here.

| ID | Behaviour today | Risk | Decision needed |
| --- | --- | --- | --- |
| Q-01 | A disputed escrow can only be settled by the arbiter. There is no timeout, and `reclaimAfterDeadline` is blocked while disputed | Funds locked indefinitely if the arbiter disappears | Add an arbiter timeout or a fallback? |
| Q-02 | The payee can `refund` while disputed | Low (it favours the payer) | Confirm intended |
| Q-03 | `withdraw` always pulls the full `claimable` | An individual whose claimable exceeds their limit headroom cannot withdraw; above the tier limit it is stuck permanently | Partial withdraw, or withdraw to a nominated bank account? |
| Q-04 | The spender in `transferFrom` is not checked against the registry or freeze list | A frozen or unregistered operator can still move funds it was approved for | Should the spender be checked? |
| Q-05 | A deactivated participant cannot `redeem` | Off-boarded customers cannot cash out without compliance help | Confirm, or route through `forceTransfer` |
| Q-06 | Pause blocks `forceTransfer`; escrow bookkeeping (`release`, `refund`, `dispute`, reclaim) continues while paused | Compliance cannot act during an incident; claims change during a freeze | Confirm both are intended |
| Q-07 | PBM merchant allowlist does not require `Kind.MERCHANT` | A sponsor (or compromised sponsor key) can allow cash-out to arbitrary addresses, defeating the purpose binding | Require MERCHANT kind on `setMerchant`/`createProgram`? |
| Q-08 | Voucher holders are never checked against the registry | Unregistered or deactivated people can direct PBM cash to merchants | Check `isAllowed(msg.sender)` in `spend`? |
| Q-09 | `DvPSettlement` accepts any ERC-20 as the asset | A buyer who doesn't verify the asset address can pay for a worthless token | Asset allowlist? |
| Q-10 | `AssetToken` has no freeze or pause | A party frozen in cash can still move bonds outside DvP | Mirror the cash controls on the asset? |

## 9. Entry and exit criteria

**Entry:** contracts compile with no warnings; `npm ci` succeeds; the fixture deploys.

**Exit, per pull request**

- All P1 tests pass, with no `.skip` or `.only`.
- `npm run test:invariants` (1,000 steps) passes.
- `npm run sim` exits 0.
- Coverage does not drop below: **lines 97%, branches 90%, functions 95%** overall, and branches
  at least 85% for every contract (from today's 80.7% overall and 62.5% minimum).
- Every Q item touched by the change has a recorded decision.

**Exit, before a demo or external sharing:** all P2 tests pass; Slither clean or triaged;
multi-seed nightly green for 7 days.

## 10. CI changes

1. Add a coverage gate (for example with `istanbul check-coverage` on `coverage.json`) using the
   thresholds above.
2. Add a Slither job (`crytic/slither-action`) on pull requests.
3. Add a nightly scheduled workflow: 10 invariant seeds × 1,000 steps and 10 simulation seeds;
   upload any failing seed's report.
4. Upload the gas report as an artifact next to the simulation report.
5. Fail on `.only` in test files (simple grep step).

## 11. Delivery phases

| Phase | Content | Exit |
| --- | --- | --- |
| 1 | All P1 cases (C-15, C-17, C-20, C-24, E-12, E-16, E-18..E-20, P-08, P-10, P-11, P-13, P-15, D-10, D-12..D-15, X-02, X-03, INV-02, INV-03, S-02, S-04); record decisions on Q-01..Q-10 | Branch coverage at least 88% |
| 2 | P2 cases; Slither; coverage gate; nightly workflow | Section 9 thresholds met |
| 3 | P3 cases; gas baseline; Foundry invariant suite | Pre-demo criteria met |

## 12. Defect handling

- Each failing case becomes a GitHub issue labelled `bug` plus the module (`cash`, `escrow`,
  `pbm`, `dvp`, `registry`, `sim`), with the test ID, the seed if randomized, and the failing
  assertion.
- A failing random seed is turned into a fixed regression test before the fix is merged.
- Severity: **Critical**, any invariant break or loss/creation of money; **High**, funds stuck
  or a control bypassed; **Medium**, wrong event or accounting view; **Low**, cosmetic or
  report-only.
