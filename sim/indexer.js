// Reads every event the ledger emitted and turns it into a bank-statement style journal.
// This is what a real deployment's indexer / reporting database would do.

const CATEGORIES = [
  "ISSUE",
  "REDEEM",
  "PAYMENT",
  "ESCROW_LOCK",
  "ESCROW_PAYOUT",
  "PBM_FUND",
  "PBM_SPEND",
  "PBM_RECLAIM",
  "DVP_CASH",
  "FORCED",
];

async function indexLedger({ ethers, contracts, names }) {
  const { token, escrow, pbm, dvp, bond } = contracts;
  const addr = {
    escrow: (await escrow.getAddress()).toLowerCase(),
    pbm: (await pbm.getAddress()).toLowerCase(),
    dvp: (await dvp.getAddress()).toLowerCase(),
  };

  const q = (c, ev) => c.queryFilter(c.filters[ev](), 0, "latest");
  const [transfers, payments, issued, redeemed, forced, spent, reclaimed, settled, bondTransfers] = await Promise.all([
    q(token, "Transfer"),
    q(token, "Payment"),
    q(token, "Issued"),
    q(token, "Redeemed"),
    q(token, "ForcedTransfer"),
    q(pbm, "VoucherSpent"),
    q(pbm, "ProgramReclaimed"),
    q(dvp, "TradeSettled"),
    q(bond, "Transfer"),
  ]);

  // tx hash -> reference / flags, so each cash movement can be labelled
  const refByTx = new Map();
  const decode = (b) => {
    try {
      return ethers.decodeBytes32String(b);
    } catch {
      return b;
    }
  };
  for (const e of [...payments, ...issued, ...redeemed]) refByTx.set(e.transactionHash, decode(e.args.ref));
  for (const e of forced) refByTx.set(e.transactionHash, decode(e.args.reason));
  for (const e of spent) refByTx.set(e.transactionHash, decode(e.args.ref));
  const forcedTx = new Set(forced.map((e) => e.transactionHash));
  const spendTx = new Set(spent.map((e) => e.transactionHash));
  const reclaimTx = new Set(reclaimed.map((e) => e.transactionHash));
  const dvpTx = new Set(settled.map((e) => e.transactionHash));

  const blockTime = new Map();
  const timeOf = async (bn) => {
    if (!blockTime.has(bn)) blockTime.set(bn, (await ethers.provider.getBlock(bn)).timestamp);
    return blockTime.get(bn);
  };

  const ZERO = ethers.ZeroAddress.toLowerCase();
  const label = (a) => names[a.toLowerCase()] || a;
  const journal = [];
  for (const e of transfers) {
    const from = e.args.from.toLowerCase();
    const to = e.args.to.toLowerCase();
    const h = e.transactionHash;
    let category = "PAYMENT";
    if (forcedTx.has(h)) category = "FORCED";
    else if (from === ZERO) category = "ISSUE";
    else if (to === ZERO) category = "REDEEM";
    else if (dvpTx.has(h)) category = "DVP_CASH";
    else if (to === addr.escrow) category = "ESCROW_LOCK";
    else if (from === addr.escrow) category = "ESCROW_PAYOUT";
    else if (to === addr.pbm) category = "PBM_FUND";
    else if (from === addr.pbm && spendTx.has(h)) category = "PBM_SPEND";
    else if (from === addr.pbm && reclaimTx.has(h)) category = "PBM_RECLAIM";

    journal.push({
      block: e.blockNumber,
      time: await timeOf(e.blockNumber),
      tx: h,
      category,
      from: from === ZERO ? "(issuer: mint)" : label(from),
      to: to === ZERO ? "(issuer: burn)" : label(to),
      amount: e.args.value,
      ref: refByTx.get(h) || "",
    });
  }

  const assetJournal = [];
  for (const e of bondTransfers) {
    assetJournal.push({
      block: e.blockNumber,
      time: await timeOf(e.blockNumber),
      from: e.args.from === ethers.ZeroAddress ? "(asset issuer)" : label(e.args.from),
      to: label(e.args.to),
      units: Number(e.args.value),
      dvp: dvpTx.has(e.transactionHash),
    });
  }

  return { journal, assetJournal };
}

module.exports = { indexLedger, CATEGORIES };
