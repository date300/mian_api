const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const db      = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');

// ── CONFIG ──────────────────────────
const BEP20_WALLET = process.env.BEP20_WALLET?.toLowerCase();
const BSCSCAN_KEY  = process.env.BSCSCAN_API_KEY;
const DEPOSIT_MODE = process.env.DEPOSIT_MODE || 'auto'; // 'auto' or 'manual'

const USDT_CONTRACT = "0x55d398326f99059ff775485246999027b3197955";
const REQUIRED_CONFIRMATIONS = 12;
const MIN_DEPOSIT = 1;
const DECIMALS = BigInt(1e18);

// ── ADMIN MIDDLEWARE ────────────────
const adminMiddleware = async (req, res, next) => {
  try {
    const [rows] = await db.query(
      "SELECT is_admin FROM users WHERE id = ? LIMIT 1",
      [req.userId]
    );
    if (!rows.length || !rows[0].is_admin) {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  } catch {
    return res.status(500).json({ error: "Auth check failed" });
  }
};

// ── SAFE API (retry) ────────────────
async function safeApi(url, retries = 3) {
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    return data;
  } catch (err) {
    if (retries > 0) return safeApi(url, retries - 1);
    throw new Error("Blockchain API error");
  }
}

// ── GET CONFIRMATIONS ───────────────
async function getConfirmations(blockNumberHex) {
  const url = `https://api.bscscan.com/api?module=proxy&action=eth_blockNumber&apikey=${BSCSCAN_KEY}`;
  const data = await safeApi(url);

  if (!data.result) throw new Error("Failed to fetch block");

  const current = parseInt(data.result, 16);
  const txBlock = parseInt(blockNumberHex, 16);

  return current - txBlock;
}

// ── VERIFY BEP20 TX ─────────────────
async function verifyBEP20(txHash) {
  const receiptUrl = `https://api.bscscan.com/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${BSCSCAN_KEY}`;
  const data = await safeApi(receiptUrl);

  if (!data.result) throw new Error("Transaction not found");

  if (data.result.status !== "0x1") {
    throw new Error("Transaction failed on blockchain");
  }

  const logs = data.result.logs || [];
  const TRANSFER_SIG = "0xddf252ad00000000000000000000000000000000000000000000000000000000";

  let senderAddress = null;
  let amount = 0;

  const log = logs.find(l => {
    try {
      const isTransfer = l.topics[0].toLowerCase() === TRANSFER_SIG;
      const isUSDT = l.address.toLowerCase() === USDT_CONTRACT;

      const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
      const from = ("0x" + l.topics[1].slice(26)).toLowerCase();

      if (isTransfer && isUSDT && to === BEP20_WALLET) {
        senderAddress = from;

        const value = BigInt(l.data);
        amount = Number(value) / Number(DECIMALS);

        return true;
      }
      return false;
    } catch {
      return false;
    }
  });

  if (!log) throw new Error("No valid USDT transfer found");

  const confirmations = await getConfirmations(data.result.blockNumber);

  return { amount, senderAddress, confirmations };
}

// ── ROUTE: VERIFY DEPOSIT ───────────
router.post('/verify', authMiddleware, async (req, res) => {
  const { txHash } = req.body;

  if (!txHash || typeof txHash !== "string" || !/^0x([A-Fa-f0-9]{64})$/.test(txHash)) {
    return res.status(400).json({ error: "Invalid txHash format" });
  }

  let verifyData;

  try {
    verifyData = await verifyBEP20(txHash);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const { amount, senderAddress, confirmations } = verifyData;

  // ⏳ Pending confirmations
  if (confirmations < REQUIRED_CONFIRMATIONS) {
    return res.status(202).json({
      pending: true,
      confirmations,
      required: REQUIRED_CONFIRMATIONS
    });
  }

  if (amount < MIN_DEPOSIT) {
    return res.status(400).json({ error: `Minimum deposit is $${MIN_DEPOSIT}` });
  }

  const conn = await db.getConnection();

  try {
    // duplicate check
    const [exist] = await conn.query(
      "SELECT id, status FROM deposits WHERE tx_hash = ? LIMIT 1",
      [txHash]
    );

    if (exist.length) throw new Error("Transaction already used");

    // get user wallet (আপনার users table এ wallet_address আছে)
    const [user] = await conn.query(
      "SELECT wallet_address FROM users WHERE id = ? LIMIT 1",
      [req.userId]
    );

    if (!user.length) throw new Error("User not found");

    if (!user[0].wallet_address || user[0].wallet_address.toLowerCase() !== senderAddress) {
      throw new Error("Sender wallet mismatch");
    }

    await conn.beginTransaction();

    const mode = DEPOSIT_MODE;

    if (mode === 'auto') {
      // ✅ AUTO MODE
      await conn.query(
        `INSERT INTO deposits 
         (user_id, tx_hash, amount, network, status, sender, confirmations, approval_mode)
         VALUES (?, ?, ?, 'BEP20', 'confirmed', ?, ?, 'auto')`,
        [req.userId, txHash, amount, senderAddress, confirmations]
      );

      // update mining balance (ON DUPLICATE KEY UPDATE কাজ করবে কারণ user_id unique)
      await conn.query(
        `INSERT INTO mining (user_id, balance) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [req.userId, amount]
      );

      await conn.commit();

      return res.json({
        success: true,
        mode: 'auto',
        amount: Number(amount.toFixed(2)),
        message: `Deposit successful: $${amount.toFixed(2)}`
      });

    } else {
      // ⏳ MANUAL MODE - Admin approve করবে
      await conn.query(
        `INSERT INTO deposits 
         (user_id, tx_hash, amount, network, status, sender, confirmations, approval_mode)
         VALUES (?, ?, ?, 'BEP20', 'pending', ?, ?, 'manual')`,
        [req.userId, txHash, amount, senderAddress, confirmations]
      );

      await conn.commit();

      return res.json({
        success: true,
        mode: 'manual',
        pending: true,
        amount: Number(amount.toFixed(2)),
        message: `Deposit submitted for admin approval: $${amount.toFixed(2)}`
      });
    }

  } catch (err) {
    await conn.rollback();

    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: "Transaction already used" });
    }

    return res.status(400).json({
      error: err.message || "Deposit failed"
    });

  } finally {
    conn.release();
  }
});

// ── ROUTE: ADMIN APPROVE DEPOSIT ────
router.post('/admin/approve', authMiddleware, adminMiddleware, async (req, res) => {
  const { depositId } = req.body;

  if (!depositId) {
    return res.status(400).json({ error: "depositId required" });
  }

  const conn = await db.getConnection();

  try {
    const [deposit] = await conn.query(
      `SELECT * FROM deposits WHERE id = ? AND status = 'pending' AND approval_mode = 'manual' LIMIT 1`,
      [depositId]
    );

    if (!deposit.length) {
      return res.status(404).json({ error: "Pending deposit not found" });
    }

    const dep = deposit[0];

    await conn.beginTransaction();

    // status update
    await conn.query(
      `UPDATE deposits 
       SET status = 'confirmed', approved_by = ?, approved_at = NOW() 
       WHERE id = ?`,
      [req.userId, depositId]
    );

    // update mining balance
    await conn.query(
      `INSERT INTO mining (user_id, balance) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
      [dep.user_id, dep.amount]
    );

    await conn.commit();

    return res.json({
      success: true,
      message: `Deposit #${dep.id} approved. $${dep.amount} added to user balance.`
    });

  } catch (err) {
    await conn.rollback();
    return res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ── ROUTE: ADMIN REJECT DEPOSIT ─────
router.post('/admin/reject', authMiddleware, adminMiddleware, async (req, res) => {
  const { depositId, reason } = req.body;

  if (!depositId) {
    return res.status(400).json({ error: "depositId required" });
  }

  try {
    const [result] = await db.query(
      `UPDATE deposits 
       SET status = 'rejected', approved_by = ?, approved_at = NOW(), rejected_reason = ? 
       WHERE id = ? AND status = 'pending' AND approval_mode = 'manual'`,
      [req.userId, reason || null, depositId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Pending deposit not found" });
    }

    return res.json({
      success: true,
      message: `Deposit #${depositId} rejected.`
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── ROUTE: ADMIN LIST PENDING DEPOSITS ─
router.get('/admin/pending', authMiddleware, adminMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  try {
    const conn = await db.getConnection();

    const [countResult] = await conn.query(
      "SELECT COUNT(*) as total FROM deposits WHERE status = 'pending' AND approval_mode = 'manual'"
    );

    const total = countResult[0].total;

    const [rows] = await conn.query(
      `SELECT d.*, u.wallet_address 
       FROM deposits d
       JOIN users u ON d.user_id = u.id
       WHERE d.status = 'pending' AND d.approval_mode = 'manual'
       ORDER BY d.id DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    conn.release();

    return res.json({
      success: true,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      },
      data: rows
    });

  } catch {
    return res.status(500).json({ error: "Failed to fetch pending deposits" });
  }
});

// ── ROUTE: TRANSACTION HISTORY ──────
router.get('/history', authMiddleware, async (req, res) => {
  const userId = req.userId;

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    const conn = await db.getConnection();

    const [countResult] = await conn.query(
      "SELECT COUNT(*) as total FROM deposits WHERE user_id = ?",
      [userId]
    );

    const total = countResult[0].total;

    const [rows] = await conn.query(
      `SELECT tx_hash, amount, network, status, sender, confirmations, approval_mode, created_at, approved_at, rejected_reason
       FROM deposits
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    conn.release();

    return res.json({
      success: true,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      },
      data: rows.map(tx => ({
        txHash: tx.tx_hash,
        amount: Number(tx.amount),
        network: tx.network,
        status: tx.status,
        sender: tx.sender,
        confirmations: tx.confirmations,
        mode: tx.approval_mode,
        date: tx.created_at,
        approvedAt: tx.approved_at,
        rejectedReason: tx.rejected_reason
      }))
    });

  } catch {
    return res.status(500).json({
      error: "Failed to fetch transaction history"
    });
  }
});

// ── ROUTE: SINGLE TX ────────────────
router.get('/tx/:hash', authMiddleware, async (req, res) => {
  const { hash } = req.params;

  try {
    const [rows] = await db.query(
      `SELECT * FROM deposits 
       WHERE tx_hash = ? AND user_id = ? LIMIT 1`,
      [hash, req.userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    return res.json({
      success: true,
      data: rows[0]
    });

  } catch {
    return res.status(500).json({ error: "Error fetching transaction" });
  }
});

module.exports = router;



