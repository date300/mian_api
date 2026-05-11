const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');

// ── CONFIGURATION ────────────────
const BEP20_WALLET = (process.env.BEP20_WALLET || '').toLowerCase();
const DEPOSIT_MODE = process.env.DEPOSIT_MODE || 'auto'; // 'auto' or 'manual'

// Official Binance Public RPC (No API Key Required)
const BSC_RPC = "https://bsc-dataseed.binance.org/";
const USDT_CONTRACT = "0x55d398326f99059ff775485246999027b3197955"; // BSC-USD
const REQUIRED_CONFIRMATIONS = 12;
const MIN_DEPOSIT = 1.0; 
const DECIMALS = BigInt(1e18);

if (!BEP20_WALLET) {
  console.error("CRITICAL ERROR: Missing BEP20_WALLET in .env file");
}

// ── ADMIN MIDDLEWARE ────────────────
const adminMiddleware = async (req, res, next) => {
  try {
    const [rows] = await db.query("SELECT is_admin FROM users WHERE id = ? LIMIT 1", [req.userId]);
    if (!rows.length || !rows[0].is_admin) {
      return res.status(403).json({ error: "Access denied. Admin privileges required." });
    }
    next();
  } catch (err) {
    return res.status(500).json({ error: "Authorization check failed." });
  }
};

// ── BLOCKCHAIN HELPERS (Direct RPC) ───────────────

async function getConfirmations(blockNumberHex) {
  try {
    const { data } = await axios.post(BSC_RPC, {
      jsonrpc: "2.0",
      method: "eth_blockNumber",
      params: [],
      id: 1
    });
    const currentBlock = parseInt(data.result, 16);
    const txBlock = parseInt(blockNumberHex, 16);
    return currentBlock - txBlock;
  } catch (error) {
    console.error("RPC Error (Block):", error.message);
    throw new Error("Blockchain network is busy. Could not verify confirmations.");
  }
}

async function verifyBEP20(txHash) {
  console.log(`Verifying TxHash via Public RPC...`);
  try {
    const { data } = await axios.post(BSC_RPC, {
      jsonrpc: "2.0",
      method: "eth_getTransactionReceipt",
      params: [txHash],
      id: 1
    });

    const receipt = data.result;
    if (!receipt) throw new Error("Transaction not found. Please wait and try again.");
    if (receipt.status !== "0x1") throw new Error("Blockchain transaction failed.");

    const logs = receipt.logs || [];
    const TRANSFER_SIG = "0xddf252ad00000000000000000000000000000000000000000000000000000000";

    let foundLog = null;
    for (const log of logs) {
      const isTransfer = log.topics[0].toLowerCase() === TRANSFER_SIG;
      const isUSDT = log.address.toLowerCase() === USDT_CONTRACT;
      const toAddress = ("0x" + log.topics[2].slice(26)).toLowerCase();

      if (isTransfer && isUSDT && toAddress === BEP20_WALLET) {
        foundLog = log;
        break;
      }
    }

    if (!foundLog) throw new Error("No valid USDT transfer found to the designated platform wallet.");

    const senderAddress = ("0x" + foundLog.topics[1].slice(26)).toLowerCase();
    const rawAmount = BigInt(foundLog.data);
    const amount = Number(rawAmount) / Number(DECIMALS);
    const confirmations = await getConfirmations(receipt.blockNumber);

    return { amount, senderAddress, confirmations };

  } catch (error) {
    throw new Error(error.message || "RPC connection failed.");
  }
}

// ── ROUTES ──────────────────────────

router.post('/verify', authMiddleware, async (req, res) => {
  const { txHash } = req.body;

  if (!txHash || !/^0x([A-Fa-f0-9]{64})$/.test(txHash)) {
    return res.status(400).json({ error: "Invalid transaction hash format." });
  }

  const conn = await db.getConnection();
  try {
    const [exist] = await conn.query("SELECT id FROM deposits WHERE tx_hash = ?", [txHash]);
    if (exist.length) return res.status(400).json({ error: "This transaction has already been processed." });

    const { amount, senderAddress, confirmations } = await verifyBEP20(txHash);

    if (amount < MIN_DEPOSIT) return res.status(400).json({ error: `Minimum deposit allowed is $${MIN_DEPOSIT}` });

    const [user] = await conn.query("SELECT wallet_address FROM users WHERE id = ?", [req.userId]);
    if (!user.length || user[0].wallet_address?.toLowerCase() !== senderAddress) {
      return res.status(400).json({ error: "Sender wallet address does not match your account profile." });
    }

    if (confirmations < REQUIRED_CONFIRMATIONS) {
      return res.status(202).json({ 
        pending: true, 
        confirmations, 
        required: REQUIRED_CONFIRMATIONS,
        message: "Transaction is pending network confirmations."
      });
    }

    await conn.beginTransaction();

    const status = DEPOSIT_MODE === 'auto' ? 'confirmed' : 'pending';
    
    await conn.query(
      `INSERT INTO deposits (user_id, tx_hash, amount, status, sender, confirmations, approval_mode) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.userId, txHash, amount, status, senderAddress, confirmations, DEPOSIT_MODE]
    );

    if (DEPOSIT_MODE === 'auto') {
      await conn.query(
        `INSERT INTO mining (user_id, balance) VALUES (?, ?) 
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [req.userId, amount]
      );
    }

    await conn.commit();
    res.json({ 
      success: true, 
      mode: DEPOSIT_MODE, 
      amount: amount.toFixed(2), 
      message: DEPOSIT_MODE === 'auto' ? "Deposit successful and balance updated." : "Deposit submitted for admin approval." 
    });

  } catch (err) {
    await conn.rollback();
    console.error("Deposit Error:", err.message);
    res.status(400).json({ error: err.message || "Deposit verification failed." });
  } finally {
    conn.release();
  }
});

router.get('/admin/pending', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT d.*, u.username FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = 'pending' ORDER BY d.id DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch pending list." });
  }
});

router.post('/admin/approve', authMiddleware, adminMiddleware, async (req, res) => {
  const { depositId } = req.body;
  const conn = await db.getConnection();
  try {
    const [deposit] = await conn.query("SELECT * FROM deposits WHERE id = ? AND status = 'pending'", [depositId]);
    if (!deposit.length) throw new Error("Pending deposit not found.");

    await conn.beginTransaction();
    await conn.query("UPDATE deposits SET status = 'confirmed', approved_at = NOW() WHERE id = ?", [depositId]);
    await conn.query(
      "INSERT INTO mining (user_id, balance) VALUES (?, ?) ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)",
      [deposit[0].user_id, deposit[0].amount]
    );
    await conn.commit();
    res.json({ success: true, message: "Deposit approved successfully." });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;

