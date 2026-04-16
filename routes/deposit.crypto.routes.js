const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const db      = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');

// ── CONFIG ─────────────────────────────
const BEP20_WALLET = "0xYourBEP20Wallet";
const TRC20_WALLET = "YourTRC20Wallet";

// USDT Contract
const BEP20_USDT = "0x55d398326f99059ff775485246999027b3197955";
const TRC20_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const MIN_DEPOSIT = 1;

// ── BEP20 VERIFY (REAL) ─────────────────
async function verifyBEP20(txHash) {
  const url = `https://api.bscscan.com/api?module=account&action=tokentx&txhash=${txHash}&apikey=${process.env.BSCSCAN_API_KEY}`;

  const { data } = await axios.get(url);

  if (!data.result || data.result.length === 0) {
    throw new Error("Transaction not found");
  }

  const tx = data.result[0];

  if (tx.to.toLowerCase() !== BEP20_WALLET.toLowerCase()) {
    throw new Error("Wrong receiver wallet");
  }

  if (tx.contractAddress.toLowerCase() !== BEP20_USDT.toLowerCase()) {
    throw new Error("Not USDT token");
  }

  const amount = Number(tx.value) / 1e18;

  return amount;
}

// ── TRC20 VERIFY (REAL) ─────────────────
async function verifyTRC20(txHash) {
  const url = `https://api.trongrid.io/v1/transactions/${txHash}/events`;

  const { data } = await axios.get(url, {
    headers: {
      "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY
    }
  });

  if (!data.data || data.data.length === 0) {
    throw new Error("Transaction not found");
  }

  const event = data.data.find(e => e.contract_address === TRC20_USDT);

  if (!event) {
    throw new Error("Not USDT TRC20 transaction");
  }

  if (event.result.to !== TRC20_WALLET) {
    throw new Error("Wrong receiver wallet");
  }

  const amount = Number(event.result.value) / 1e6;

  return amount;
}

// ── MAIN VERIFY API ────────────────────
router.post('/verify', authMiddleware, async (req, res) => {
  const { txHash, network } = req.body;

  if (!txHash || !network) {
    return res.status(400).json({ error: "txHash & network required" });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    // 🔒 Duplicate check
    const [exist] = await conn.query(
      "SELECT id FROM deposits WHERE tx_hash = ?",
      [txHash]
    );

    if (exist.length > 0) {
      await conn.rollback();
      return res.status(400).json({ error: "Transaction already used" });
    }

    let amount = 0;

    // ── BEP20 ──
    if (network === "BEP20") {
      amount = await verifyBEP20(txHash);
    }

    // ── TRC20 ──
    else if (network === "TRC20") {
      amount = await verifyTRC20(txHash);
    }

    else {
      await conn.rollback();
      return res.status(400).json({ error: "Invalid network" });
    }

    if (amount < MIN_DEPOSIT) {
      await conn.rollback();
      return res.status(400).json({ error: "Minimum deposit is $1" });
    }

    // ── SAVE DEPOSIT ───────────────────
    await conn.query(
      `INSERT INTO deposits 
      (user_id, tx_hash, amount, network, status, created_at) 
      VALUES (?, ?, ?, ?, 'confirmed', NOW())`,
      [req.userId, txHash, amount, network]
    );

    // ── UPDATE BALANCE ─────────────────
    await conn.query(
      `INSERT INTO mining (user_id, balance)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
      [req.userId, amount]
    );

    await conn.commit();

    res.json({
      success: true,
      amount: Number(amount.toFixed(2)),
      network,
      message: `Deposit successful! $${amount.toFixed(2)} added`
    });

  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
