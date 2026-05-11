const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');

// ── CONFIG ──────────────────────────
const MIN_WITHDRAW = 5;
const MAX_WITHDRAW = 10000;
const ALLOWED_NETWORKS = ['BEP20', 'TRC20'];

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

// ── HELPER: wallet validation ───────
function isValidWallet(wallet, network) {
  if (network === 'BEP20') {
    // Ethereum style: 0x + 40 hex chars (case-insensitive)
    return /^0x[a-fA-F0-9]{40}$/.test(wallet);
  }
  if (network === 'TRC20') {
    // Tron base58check starting with T, 34 chars
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(wallet);
  }
  return false;
}

// ── ROUTE: GET WITHDRAWABLE BALANCE (no coins) ─
router.get('/withdraw/balance', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT balance, withdrawable FROM mining WHERE user_id = ? LIMIT 1",
      [req.userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Mining account not found" });
    }

    return res.json({
      success: true,
      data: {
        balance: Number(rows[0].balance),
        withdrawable: Number(rows[0].withdrawable)
      }
    });
  } catch (err) {
    console.error("Balance fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch balance" });
  }
});

// ── ROUTE: REQUEST WITHDRAW ─────────
router.post('/withdraw', authMiddleware, async (req, res) => {
  const { amount, wallet, network = 'BEP20' } = req.body;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  if (!wallet || !isValidWallet(wallet, network)) {
    return res.status(400).json({ error: `Invalid wallet address for ${network}` });
  }

  if (!ALLOWED_NETWORKS.includes(network)) {
    return res.status(400).json({ error: "Unsupported network" });
  }

  if (amount < MIN_WITHDRAW) {
    return res.status(400).json({ error: `Minimum withdraw is $${MIN_WITHDRAW}` });
  }

  if (amount > MAX_WITHDRAW) {
    return res.status(400).json({ error: "Maximum withdraw limit exceeded" });
  }

  const conn = await db.getConnection();

  try {
    const [rows] = await conn.query(
      "SELECT withdrawable FROM mining WHERE user_id = ? LIMIT 1",
      [req.userId]
    );

    if (!rows.length) throw new Error("Mining account not found");

    const withdrawable = Number(rows[0].withdrawable);

    if (withdrawable < amount) {
      throw new Error("Insufficient withdrawable balance");
    }

    await conn.beginTransaction();

    // Deduct (race‑condition safe)
    const [update] = await conn.query(
      `UPDATE mining 
       SET withdrawable = withdrawable - ? 
       WHERE user_id = ? AND withdrawable >= ?`,
      [amount, req.userId, amount]
    );

    if (update.affectedRows === 0) {
      throw new Error("Withdraw failed (retry)");
    }

    // Insert withdrawal request
    const [insert] = await conn.query(
      `INSERT INTO withdraws 
       (user_id, amount, wallet_address, network, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [req.userId, amount, wallet, network]
    );

    await conn.commit();

    return res.json({
      success: true,
      data: {
        withdrawId: insert.insertId,
        amount,
        wallet,
        network,
        status: "pending"
      },
      message: "Withdraw request submitted"
    });

  } catch (err) {
    await conn.rollback();
    return res.status(400).json({
      success: false,
      error: err.message
    });
  } finally {
    conn.release();
  }
});

// ── ROUTE: ADMIN APPROVE ────────────
router.post('/admin/withdraw/approve', authMiddleware, adminMiddleware, async (req, res) => {
  const { withdrawId } = req.body;

  if (!withdrawId) {
    return res.status(400).json({ error: "withdrawId required" });
  }

  const conn = await db.getConnection();

  try {
    const [rows] = await conn.query(
      `SELECT * FROM withdraws 
       WHERE id = ? AND status = 'pending' LIMIT 1`,
      [withdrawId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Withdraw not found or not pending" });
    }

    await conn.beginTransaction();

    await conn.query(
      `UPDATE withdraws 
       SET status = 'approved', approved_at = NOW() 
       WHERE id = ?`,
      [withdrawId]
    );

    await conn.commit();

    return res.json({
      success: true,
      message: "Withdraw approved"
    });

  } catch (err) {
    await conn.rollback();
    return res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ── ROUTE: ADMIN REJECT ─────────────
router.post('/admin/withdraw/reject', authMiddleware, adminMiddleware, async (req, res) => {
  const { withdrawId, reason } = req.body;

  if (!withdrawId) {
    return res.status(400).json({ error: "withdrawId required" });
  }

  const conn = await db.getConnection();

  try {
    const [rows] = await conn.query(
      `SELECT * FROM withdraws 
       WHERE id = ? AND status = 'pending' LIMIT 1`,
      [withdrawId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Withdraw not found" });
    }

    const w = rows[0];

    await conn.beginTransaction();

    // Refund withdrawable
    await conn.query(
      `UPDATE mining 
       SET withdrawable = withdrawable + ? 
       WHERE user_id = ?`,
      [w.amount, w.user_id]
    );

    // Mark rejected (approved_at reused for status change time – later you can rename)
    await conn.query(
      `UPDATE withdraws 
       SET status = 'rejected', rejected_reason = ?, approved_at = NOW() 
       WHERE id = ?`,
      [reason || null, withdrawId]
    );

    await conn.commit();

    return res.json({
      success: true,
      message: "Withdraw rejected & refunded"
    });

  } catch (err) {
    await conn.rollback();
    return res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ── ROUTE: USER HISTORY ─────────────
router.get('/withdraw/history', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    const [rows] = await db.query(
      `SELECT id, amount, wallet_address, network, status, created_at, approved_at
       FROM withdraws
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    return res.json({
      success: true,
      data: rows
    });

  } catch {
    return res.status(500).json({
      error: "Failed to fetch history"
    });
  }
});

// ── ROUTE: SINGLE WITHDRAW ──────────
router.get('/withdraw/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.query(
      `SELECT * FROM withdraws 
       WHERE id = ? AND user_id = ? LIMIT 1`,
      [id, req.userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Withdraw not found" });
    }

    return res.json({
      success: true,
      data: rows[0]
    });

  } catch {
    return res.status(500).json({
      error: "Error fetching withdraw"
    });
  }
});

module.exports = router;
