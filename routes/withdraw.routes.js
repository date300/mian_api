const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');

// ── CONFIG ──────────────────────────
const MIN_WITHDRAW = 5;
const MAX_WITHDRAW = 10000;


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



// ── ROUTE: REQUEST WITHDRAW ─────────
router.post('/withdraw', authMiddleware, async (req, res) => {
  const { amount, wallet } = req.body;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ error: "Invalid wallet address" });
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

    // deduct safely (race-condition safe)
    const [update] = await conn.query(
      `UPDATE mining 
       SET withdrawable = withdrawable - ? 
       WHERE user_id = ? AND withdrawable >= ?`,
      [amount, req.userId, amount]
    );

    if (update.affectedRows === 0) {
      throw new Error("Withdraw failed (retry)");
    }

    // insert withdraw request
    const [insert] = await conn.query(
      `INSERT INTO withdraws 
       (user_id, amount, wallet_address, network, status)
       VALUES (?, ?, ?, 'BEP20', 'pending')`,
      [req.userId, amount, wallet]
    );

    await conn.commit();

    return res.json({
      success: true,
      data: {
        withdrawId: insert.insertId,
        amount,
        wallet,
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
      return res.status(404).json({ error: "Withdraw not found" });
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

    // refund withdrawable
    await conn.query(
      `UPDATE mining 
       SET withdrawable = withdrawable + ? 
       WHERE user_id = ?`,
      [w.amount, w.user_id]
    );

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
