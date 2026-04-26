const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const db      = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');

// ── CONFIG ──────────────────────────
const BEP20_WALLET = process.env.BEP20_WALLET?.toLowerCase();
const BSCSCAN_KEY  = process.env.BSCSCAN_API_KEY;

const USDT_CONTRACT = "0x55d398326f99059ff775485246999027b3197955";
const REQUIRED_CONFIRMATIONS = 12;
const MIN_DEPOSIT = 1;

// ── SAFE API CALL ─────────────────
async function safeApi(url) {
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    return data;
  } catch (err) {
    throw new Error("Blockchain API error");
  }
}

// ── GET CONFIRMATIONS ─────────────────
async function getConfirmations(blockNumberHex) {
  const url = `https://api.bscscan.com/api?module=proxy&action=eth_blockNumber&apikey=${BSCSCAN_KEY}`;
  const data = await safeApi(url);

  if (!data.result) throw new Error("Failed to fetch block");

  const current = parseInt(data.result, 16);
  const txBlock = parseInt(blockNumberHex, 16);

  return current - txBlock;
}

// ── VERIFY BEP20 ─────────────────
async function verifyBEP20(txHash) {
  const receiptUrl = `https://api.bscscan.com/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${BSCSCAN_KEY}`;
  const data = await safeApi(receiptUrl);

  if (!data.result) {
    throw new Error("Transaction not found");
  }

  // ১. চেক করুন ট্রানজেকশন ফেইল করেছে কিনা
  if (data.result.status !== "0x1") {
    throw new Error("Transaction failed on blockchain");
  }

  if (!data.result.logs || data.result.logs.length === 0) {
    throw new Error("No logs found in transaction");
  }

  const logs = data.result.logs;
  const TRANSFER_SIG = "0xddf252ad00000000000000000000000000000000000000000000000000000000";

  let senderAddress = "";

  const log = logs.find(l => {
    try {
      const isTransfer = l.topics[0].toLowerCase() === TRANSFER_SIG;
      const isUSDT = l.address.toLowerCase() === USDT_CONTRACT;
      const to = ("0x" + l.topics[2].slice(26)).toLowerCase();

      if (isTransfer && isUSDT && to === BEP20_WALLET) {
        // সেন্ডার অ্যাড্রেস সেভ করে রাখছি (ভবিষ্যতের সিকিউরিটির জন্য)
        senderAddress = ("0x" + l.topics[1].slice(26)).toLowerCase();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  });

  if (!log) throw new Error("No valid USDT transfer to our wallet found");

  const value = BigInt(log.data);
  const amount = Number(value) / 1e18;

  const confirmations = await getConfirmations(data.result.blockNumber);
  if (confirmations < REQUIRED_CONFIRMATIONS) {
    throw new Error(`Confirmations: ${confirmations}/${REQUIRED_CONFIRMATIONS}`);
  }

  return { amount, senderAddress };
}

// ── MAIN ROUTE ─────────────────
router.post('/verify', authMiddleware, async (req, res) => {
  const { txHash } = req.body;

  // বেসিক ভ্যালিডেশন এবং txHash এর ফরম্যাট চেক (Length & Hex check)
  if (!txHash || typeof txHash !== "string" || !/^0x([A-Fa-f0-9]{64})$/.test(txHash)) {
    return res.status(400).json({ error: "Invalid txHash format" });
  }

  // API কলগুলো Database Transaction এর বাইরে নিয়ে আসা হয়েছে
  let verifyData;
  try {
    verifyData = await verifyBEP20(txHash);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const { amount, senderAddress } = verifyData;

  if (amount < MIN_DEPOSIT) {
    return res.status(400).json({ error: `Minimum deposit is $${MIN_DEPOSIT}` });
  }

  // ⚠️ সিকিউরিটি রিমাইন্ডার: আপনার উচিত এখানে চেক করা যে senderAddress এই নির্দিষ্ট ইউজারের কিনা।
  // Example: if (user.walletAddress !== senderAddress) throw Error("...");

  const conn = await db.getConnection();

  try {
    // ডাটাবেসে চেক করা হচ্ছে হ্যাশ আগে থেকে আছে কিনা (Transaction শুরু করার আগেই)
    const [exist] = await conn.query(
      "SELECT id FROM deposits WHERE tx_hash = ? LIMIT 1",
      [txHash]
    );

    if (exist.length) {
      throw new Error("Transaction already used");
    }

    // এখন শুধু ডাটাবেস ইনসার্টের জন্য ট্রানজেকশন শুরু হবে (খুব দ্রুত কাজ শেষ হবে)
    await conn.beginTransaction();

    // 💾 Save deposit (Must ensure tx_hash column has UNIQUE index in DB)
    await conn.query(
      `INSERT INTO deposits (user_id, tx_hash, amount, network, status)
       VALUES (?, ?, ?, 'BEP20', 'confirmed')`,
      [req.userId, txHash, amount]
    );

    // 💰 Update balance
    await conn.query(
      `INSERT INTO mining (user_id, balance)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
      [req.userId, amount]
    );

    await conn.commit();

    return res.json({
      success: true,
      amount: Number(amount.toFixed(2)),
      message: `Deposit successful: $${amount.toFixed(2)}`
    });

  } catch (err) {
    if (conn) await conn.rollback();
    
    // Duplicate entry (MySQL Error Code 1062) হ্যান্ডেল করা
    if (err.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ error: "Transaction already used" });
    }

    console.error("Deposit Error:", err.message);
    return res.status(400).json({
      error: err.message || "Deposit failed"
    });

  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;

