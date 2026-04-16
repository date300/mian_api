const express = require('express');
const router = express.Router();
const https = require('https');

const db = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');

// ================== CONSTANTS ==================
const COINS_PER_USD   = 1000;
const USD_TARGET      = 100;
const COIN_TARGET     = COINS_PER_USD * USD_TARGET;

const ENTRY_FEE       = 18;
const MIN_CLAIM       = 60 * 1000;

// Boost system
const MAX_BOOST_USD   = 50;
const BASE_DAYS       = 360;
const MIN_DAYS        = 80;

// ================== REFERRAL COMMISSION CONFIG ==================
// Active = user has done at least one mining_start ($18 entry)
const REFERRAL_LEVELS = [
  { level: 1, minReferrals: 10, reward: 2.00 },
  { level: 2, minReferrals: 5,  reward: 1.50 },
  { level: 3, minReferrals: 1,  reward: 1.50 },
];

// ================== SOL PRICE CACHE ==================
let _cachedSolPrice    = null;
let _solPriceFetchedAt = 0;
const SOL_CACHE_TTL    = 60 * 1000;

async function getSolPrice() {
  const now = Date.now();
  if (_cachedSolPrice !== null && now - _solPriceFetchedAt < SOL_CACHE_TTL) {
    return _cachedSolPrice;
  }

  return new Promise((resolve) => {
    const url =
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

    https.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const json  = JSON.parse(body);
          const price = json?.solana?.usd;
          if (price && price > 0) {
            _cachedSolPrice    = price;
            _solPriceFetchedAt = Date.now();
            resolve(price);
          } else {
            resolve(_cachedSolPrice || 150);
          }
        } catch {
          resolve(_cachedSolPrice || 150);
        }
      });
    }).on('error',   () => resolve(_cachedSolPrice || 150))
      .on('timeout', () => resolve(_cachedSolPrice || 150));
  });
}

// ================== BOOST LOGIC ==================
function getEffectiveDays(boostUSD) {
  const clamped = Math.min(Math.max(boostUSD || 0, 0), MAX_BOOST_USD);
  const ratio   = clamped / MAX_BOOST_USD;
  return BASE_DAYS - (BASE_DAYS - MIN_DAYS) * ratio;
}

function getRate(boostUSD, ai = 1) {
  const days = getEffectiveDays(boostUSD);
  return (USD_TARGET / (days * 86400)) * (ai || 1);
}

function getBoostMultiplier(boostUSD) {
  const days = getEffectiveDays(boostUSD);
  return BASE_DAYS / days;
}

// ================== HELPER ==================
function calcCoins(row) {
  if (!row.mining_active || !row.session_start_at) return 0;

  const start = row.last_claim_at
    ? new Date(row.last_claim_at).getTime()
    : new Date(row.session_start_at).getTime();

  const seconds = Math.floor((Date.now() - start) / 1000);
  const usdRate = getRate(row.boost_usd, row.ai_multiplier);

  return seconds * COINS_PER_USD * usdRate;
}

// ================== GET OR CREATE ==================
async function getMining(userId) {
  const [rows] = await db.query(
    `SELECT * FROM mining WHERE user_id = ?`,
    [userId]
  );

  if (rows.length === 0) {
    await db.query(`INSERT INTO mining (user_id) VALUES (?)`, [userId]);
    const [newRow] = await db.query(
      `SELECT * FROM mining WHERE user_id = ?`,
      [userId]
    );
    return newRow[0];
  }

  return rows[0];
}

// ================== REFERRAL COMMISSION LOGIC ==================
/**
 * যখন একজন user mining start করে ($18 entry দেয়),
 * তার upline (যে তাকে রেফার করেছে) থেকে শুরু করে ৩ লেভেল পর্যন্ত
 * commission চেক করে withdrawable-এ যোগ করে।
 *
 * Active referral = যে user অন্তত একবার mining_start করেছে।
 */
async function processReferralCommission(newUserId) {
  try {
    // নতুন user-এর referral_code ও referred_by বের করো
    const [userRows] = await db.query(
      `SELECT referral_code, referred_by FROM users WHERE id = ?`,
      [newUserId]
    );
    if (!userRows.length || !userRows[0].referred_by) return;

    let currentReferredBy = userRows[0].referred_by; // level 1 upline-এর referral_code

    for (let i = 0; i < REFERRAL_LEVELS.length; i++) {
      if (!currentReferredBy) break;

      const { level, minReferrals, reward } = REFERRAL_LEVELS[i];

      // upline user বের করো (referred_by = তার referral_code)
      const [uplineRows] = await db.query(
        `SELECT id, referred_by FROM users WHERE referral_code = ?`,
        [currentReferredBy]
      );
      if (!uplineRows.length) break;

      const upline = uplineRows[0];

      // upline-এর কতজন active referral আছে গণনা করো
      // active = তারা purchase_logs-এ mining_start আছে
      const [countRows] = await db.query(
        `SELECT COUNT(DISTINCT pl.user_id) AS active_count
         FROM users u
         JOIN purchase_logs pl
           ON pl.user_id = u.id AND pl.purchase_type = 'mining_start'
         WHERE u.referred_by = (
           SELECT referral_code FROM users WHERE id = ?
         )`,
        [upline.id]
      );

      const activeCount = countRows[0]?.active_count || 0;

      if (activeCount >= minReferrals) {
        // Mining row নিশ্চিত করো (না থাকলে create হবে)
        await getMining(upline.id);

        // withdrawable-এ reward যোগ করো
        await db.query(
          `UPDATE mining SET withdrawable = withdrawable + ? WHERE user_id = ?`,
          [reward, upline.id]
        );

        // commission_logs টেবিলে রেকর্ড রাখো
        await db.query(
          `INSERT INTO commission_logs
             (beneficiary_user_id, triggered_by_user_id, level, reward_usd)
           VALUES (?, ?, ?, ?)`,
          [upline.id, newUserId, level, reward]
        );
      }

      // পরের লেভেলের জন্য upline-এর referred_by নাও
      currentReferredBy = upline.referred_by;
    }
  } catch (err) {
    // Commission error হলে main flow আটকাবে না, শুধু log করবো
    console.error('[Referral Commission Error]', err.message);
  }
}

// ================== STATUS ==================
// GET /api/mining/status
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const m = await getMining(req.userId);

    if (!m.mining_active && m.auto_mining) {
      await db.query(`
        UPDATE mining SET
          mining_active    = 1,
          session_start_at = NOW(),
          last_claim_at    = NOW()
        WHERE user_id = ?
      `, [req.userId]);

      m.mining_active    = 1;
      m.session_start_at = new Date();
      m.last_claim_at    = new Date();
    }

    const liveCoins = m.coins + calcCoins(m);
    const liveUSD   = liveCoins / COINS_PER_USD;

    const boostUSD        = m.boost_usd     || 0;
    const aiMultiplier    = m.ai_multiplier || 1;
    const boostMultiplier = getBoostMultiplier(boostUSD);
    const usdPerSec       = getRate(boostUSD, aiMultiplier);
    const solPrice        = await getSolPrice();
    const solPerSec       = usdPerSec / solPrice;

    res.json({
      miningActive:     !!m.mining_active,
      minedCoins:       Number(liveCoins.toFixed(4)),
      equivalentUSD:    Number(liveUSD.toFixed(6)),
      withdrawableUSD:  Number(m.withdrawable),
      autoMining:       !!m.auto_mining,
      boostUSD,
      boostMultiplier:  Number(boostMultiplier.toFixed(4)),
      aiMultiplier:     Number(aiMultiplier.toFixed(4)),
      usdPerSec:        Number(usdPerSec.toFixed(8)),
      solPerSec:        Number(solPerSec.toFixed(10)),
      solPriceUSD:      Number(solPrice.toFixed(2)),
      minedSOL:         Number((liveUSD / solPrice).toFixed(8)),
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== START ==================
// POST /api/mining/start-day
router.post('/start-day', authMiddleware, async (req, res) => {
  try {
    const m = await getMining(req.userId);

    if (m.mining_active) {
      return res.status(400).json({ error: "Already active" });
    }

    if (m.balance < ENTRY_FEE) {
      return res.status(400).json({ error: "Need $18 balance" });
    }

    // Mining start করো
    await db.query(`
      UPDATE mining SET
        balance          = balance - ?,
        mining_active    = 1,
        session_start_at = NOW(),
        last_claim_at    = NOW(),
        total_sessions   = total_sessions + 1
      WHERE user_id = ?
    `, [ENTRY_FEE, req.userId]);

    // Purchase log করো
    await db.query(
      `INSERT INTO purchase_logs (user_id, purchase_type, amount_usd)
       VALUES (?, 'mining_start', ?)`,
      [req.userId, ENTRY_FEE]
    );

    // Referral commission process করো (async, main flow block করবে না)
    processReferralCommission(req.userId);

    res.json({ message: "Mining started" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== CLAIM ==================
// POST /api/mining/claim
router.post('/claim', authMiddleware, async (req, res) => {
  try {
    const m = await getMining(req.userId);

    if (!m.mining_active) {
      return res.status(400).json({ error: "No active session" });
    }

    if (
      m.last_claim_at &&
      Date.now() - new Date(m.last_claim_at).getTime() < MIN_CLAIM
    ) {
      return res.status(400).json({ error: "Wait before claim" });
    }

    const earned = calcCoins(m);

    let coins        = m.coins + earned;
    let withdrawable = m.withdrawable;
    let active       = m.mining_active;

    while (coins >= COIN_TARGET) {
      withdrawable += USD_TARGET;
      coins        -= COIN_TARGET;
      active        = 0;
    }

    await db.query(`
      UPDATE mining SET
        coins         = ?,
        withdrawable  = ?,
        mining_active = ?,
        last_claim_at = NOW()
      WHERE user_id = ?
    `, [coins, withdrawable, active, req.userId]);

    res.json({
      message:     active ? "Claim success" : "Cycle complete $100 added",
      coins:       Number(coins.toFixed(4)),
      usd:         Number((coins / COINS_PER_USD).toFixed(6)),
      withdrawable,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== BUY BOOST ==================
// POST /api/mining/buy-boost
router.post('/buy-boost', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount < 1 || amount > 50) {
      return res.status(400).json({ error: "Boost must be $1–$50" });
    }

    const m = await getMining(req.userId);

    if (m.balance < amount) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const newBoost = Math.min((m.boost_usd || 0) + amount, 50);

    await db.query(`
      UPDATE mining SET
        balance   = balance - ?,
        boost_usd = ?
      WHERE user_id = ?
    `, [amount, newBoost, req.userId]);

    // Purchase log (commission ভবিষ্যতে)
    await db.query(
      `INSERT INTO purchase_logs (user_id, purchase_type, amount_usd)
       VALUES (?, 'boost', ?)`,
      [req.userId, amount]
    );

    const newMultiplier = getBoostMultiplier(newBoost);

    res.json({
      message:         "Boost added",
      boost:           newBoost,
      boostMultiplier: Number(newMultiplier.toFixed(4)),
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== BUY AUTO MINING ==================
// POST /api/mining/buy-auto
router.post('/buy-auto', authMiddleware, async (req, res) => {
  try {
    const m = await getMining(req.userId);

    if (m.auto_mining) {
      return res.json({ message: "Already active" });
    }

    if (m.balance < 10) {
      return res.status(400).json({ error: "Need $10" });
    }

    await db.query(`
      UPDATE mining SET
        balance     = balance - 10,
        auto_mining = 1
      WHERE user_id = ?
    `, [req.userId]);

    // Purchase log (commission ভবিষ্যতে)
    await db.query(
      `INSERT INTO purchase_logs (user_id, purchase_type, amount_usd)
       VALUES (?, 'auto_mining', 10)`,
      [req.userId]
    );

    res.json({ message: "Auto mining enabled" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== SOL PRICE (public) ==================
// GET /api/mining/sol-price
router.get('/sol-price', async (req, res) => {
  try {
    const price = await getSolPrice();
    res.json({ solPriceUSD: price });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

