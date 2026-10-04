# Tokenized Cash & Programmable Ledger (prototype)

A simulation prototype of a **tokenized cash ledger** with **programmable payments** on top:

- **`CashToken`**: a permissioned, fully-backed ERC-20 with 2 decimals (`tSGD`). Issuance can
  never exceed attested reserves, and every transfer is checked against a participant
  registry, KYC-tier holding limits, account freezes and a ledger-wide pause.
- **`IdentityRegistry`**: a simulated KYC directory of issuer, banks, corporates, merchants,
  individuals and system contracts.
- **`ConditionalPayments`**: multi-milestone escrow with deadlines, an optional arbiter,
  disputes and pull payments.
- **`PurposeBoundMoney`**: vouchers backed 1:1 by cash, spendable only at approved merchants
  before expiry. Unspent value returns to the sponsor.
- **`DvPSettlement`**: atomic delivery-versus-payment of a tokenized bond (`AssetToken`)
  against cash.
- **A scenario simulator** that runs a 50-participant economy over 14 days (issuance,
  payroll, retail, escrows, a dispute, vouchers, bond trades, a compliance incident, a pause
  and a redemption wave). It indexes every event into a journal, reconciles the books and
  writes an HTML report.

> ⚠️ Prototype for learning and demos. Not audited, not production-ready, no real money.

## Quick start

```bash
npm install
npm test        # 43 tests, including a randomized invariant run
npm run sim     # runs the simulation, writes sim/out/report.html
```

Open `sim/out/report.html` in a browser to see supply versus reserves over time, the
scenario log, reconciliation checks, rejections by rule, balances and the full journal.
A pre-generated copy is in [`docs/sample-report.html`](docs/sample-report.html) (download it
and open it locally; GitHub won't render HTML).

Sample console output:

```
day  4  [DvP settlement] Trade BOND-T5 failed atomically when the buyer was frozen mid-flow: no bonds moved, no cash moved.
day  9  [Purpose-bound money] Programme expired; 3,145.00 of unspent vouchers returned to the agency in one call.
day 12  [Redemption wave] 9 individuals and one corporate redeemed 260,127.03 back to fiat. ...
Actions attempted: 568  settled: 525  rejected by ledger rules: 43
Rejections: InsufficientReserves=1, HoldingLimitExceeded=5, MerchantNotApproved=5, AccountIsFrozen=15, EnforcedPause=10, ...
PASS  Sum of all balances equals total supply (14,739,872.97 vs 14,739,872.97)
PASS  Supply fully backed by attested reserves (backing 100.00%)
PASS  Escrow cash equals locked + claimable (0.00)
PASS  PBM cash equals outstanding vouchers (0.00)
PASS  DvP contract never custodies cash (0.00)
PASS  Journal replay reproduces every on-chain balance (490 entries)
```

Runs are reproducible: `SIM_SEED=7 SIM_DAYS=21 npm run sim` gives a different but
repeatable economy.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run compile` | Compile contracts (uses the pinned `solc` npm package, so no compiler download is needed) |
| `npm test` | All unit, integration and invariant tests |
| `npm run test:invariants` | 1,000-step randomized invariant run (`INVARIANT_SEED=n` to vary) |
| `npm run coverage` | Coverage report |
| `npm run sim` | Simulation and report (exits non-zero if any reconciliation check fails) |
| `npm run node` + `npm run deploy:local` | Deploy the stack to a local node; addresses go to `deployments/localhost.json` |

## Repo layout

```
contracts/
  IdentityRegistry.sol      participants, KYC tiers, holding limits
  CashToken.sol             tokenized cash + ledger rules
  ConditionalPayments.sol   multi-milestone escrow
  PurposeBoundMoney.sol     purpose-bound vouchers
  DvPSettlement.sol         atomic asset/cash settlement
  AssetToken.sol            permissioned bond token for DvP
scripts/
  lib/deploy.js             deploys + wires the whole stack (used by tests, sim and deploy)
  lib/prng.js               seeded PRNG
  deploy.js                 deploy to any network
sim/
  run.js                    scenario engine
  indexer.js                events to bank-statement journal
  report.js                 self-contained HTML report
test/                       R-, C-, E-, P-, D-, INV- test suites
docs/ARCHITECTURE.md        design, state machines, invariants, simulation schedule
```

## Tests

| Suite | IDs | Covers |
| --- | --- | --- |
| `CashToken.test.js` | R-01..03, C-01..14 | Registry; reserves-backed issuance, redemption, permissioning, limits, freeze, force-transfer, pause, roles |
| `ConditionalPayments.test.js` | E-01..11 | Creation checks, release/refund, single settlement, pull payments with a frozen payee, disputes, deadline reclaim |
| `PurposeBoundMoney.test.js` | P-01..07 | 1:1 backing, merchant allowlist, overspend, expiry and reclaim, ledger rules flowing through |
| `DvPSettlement.test.js` | D-01..07 | Atomic settlement, either leg failing rolls back both, expiry/cancel, permissioned asset |
| `Invariants.test.js` | INV-01 | Seeded random operations from random actors, with the 7 ledger invariants checked after every step |

Coverage is about 96% of lines. CI (`.github/workflows/ci.yml`) runs tests, a longer
invariant run, the simulation (uploading the report as a build artifact) and coverage on
every push and PR.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

## Background

This repo grew out of
[`smart-contract-project`](https://github.com/perpetualxbeta-ai/smart-contract-project), a
single-milestone ETH escrow POC. `ConditionalPayments` is its successor; the architecture doc
lists which gaps it closes. The programmable-money modules borrow vocabulary from public
central-bank and industry tokenization experiments (purpose-bound money, DvP on shared
ledgers), but this is an independent educational prototype and is not affiliated with any of
them.

## Roadmap

- [ ] **Ledger explorer frontend**: wallet connect, per-participant views, live event feed
- [ ] **Scheduled and streaming payments**: payroll and subscriptions as standing instructions
- [ ] **Multi-currency and PvP**: a second cash token (e.g. tUSD) with atomic FX settlement
- [ ] **Interbank model**: banks issue their own deposit tokens settling in central-bank tokens
- [ ] **Privacy**: commitments or a permissioned chain to hide balances from other participants
- [ ] **Role separation**: multisig or timelock for issuer, compliance and pauser roles
- [ ] **Foundry invariant fuzzing** alongside the JS randomized test; Slither in CI
- [ ] **Stress scenarios**: liquidity crunch, mass freeze, oracle-driven conditional payments

## License

MIT
