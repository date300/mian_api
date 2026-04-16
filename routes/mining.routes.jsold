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

// ================== SOL PRICE CACHE ==================
// Cache SOL/USD price so we don't hammer CoinGecko on every /status call
let _cachedSolPrice   = null;
let _solPriceFetchedAt = 0;
const SOL_CACHE_TTL   = 60 * 1000; // 1 minute

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
          const json = JSON.parse(body);
          const price = json?.solana?.usd;
          if (price && price > 0) {
            _cachedSolPrice    = price;
            _solPriceFetchedAt = Date.now();
            resolve(price);
          } else {
            resolve(_cachedSolPrice || 150); // fallback
          }
        } catch {
          resolve(_cachedSolPrice || 150);
        }
      });
    }).on('error', () => resolve(_cachedSolPrice || 150))
      .on('timeout', () => resolve(_cachedSolPrice || 150));
  });
}

// ================== BOOST LOGIC ==================
function getEffectiveDays(boostUSD) {
  const clamped = Math.min(Math.max(boostUSD || 0, 0), MAX_BOOST_USD);
  const ratio   = clamped / MAX_BOOST_USD;
  return BASE_DAYS - (BASE_DAYS - MIN_DAYS) * ratio;
}

/**
 * Returns how much USD is earned per second.
 * boostUSD  → shortens cycle days (speed boost)
 * ai        → direct multiplier on top
 */
function getRate(boostUSD, ai = 1) {
  const days = getEffectiveDays(boostUSD);
  return (USD_TARGET / (days * 86400)) * (ai || 1);
}

/**
 * boostMultiplier for the Flutter UI (how many times faster vs baseline)
 * baseline = BASE_DAYS, boosted = effectiveDays
 */
function getBoostMultiplier(boostUSD) {
  const days = getEffectiveDays(boostUSD);
  return BASE_DAYS / days; // e.g. 360/80 = 4.5x at max boost
}

// ================== HELPER ==================
function calcCoins(row) {
  if (!row.mining_active || !row.session_start_at) return 0;

  const start = row.last_claim_at
    ? new Date(row.last_claim_at).getTime()
    : new Date(row.session_start_at).getTime();

  const seconds = Math.floor((Date.now() - start) / 1000);
  const usdRate  = getRate(row.boost_usd, row.ai_multiplier);

  // coins = seconds * (coins/usd) * (usd/sec)
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

// ================== STATUS ==================
// GET /api/mining/status
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const m = await getMining(req.userId);

    // Auto-start mining if feature is enabled
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

    // Derived multipliers (so Flutter can display them)
    const boostUSD        = m.boost_usd    || 0;
    const aiMultiplier    = m.ai_multiplier || 1;
    const boostMultiplier = getBoostMultiplier(boostUSD);
    const usdPerSec       = getRate(boostUSD, aiMultiplier);
    // SOL equivalent coins per second
    const solPrice        = await getSolPrice();
    const solPerSec       = usdPerSec / solPrice;

    res.json({
      // Core fields (unchanged)
      miningActive:     !!m.mining_active,
      minedCoins:       Number(liveCoins.toFixed(4)),
      equivalentUSD:    Number(liveUSD.toFixed(6)),
      withdrawableUSD:  Number(m.withdrawable),
      autoMining:       !!m.auto_mining,

      // NEW — multiplier fields Flutter needs
      boostUSD,
      boostMultiplier:  Number(boostMultiplier.toFixed(4)),  // e.g. 4.5
      aiMultiplier:     Number(aiMultiplier.toFixed(4)),

      // NEW — live rate fields for real-time UI counter
      usdPerSec:        Number(usdPerSec.toFixed(8)),        // USD earned/sec
      solPerSec:        Number(solPerSec.toFixed(10)),        // SOL earned/sec
      solPriceUSD:      Number(solPrice.toFixed(2)),          // current SOL price

      // NEW — SOL equivalent of total mined so far
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

    await db.query(`
      UPDATE mining SET
        balance          = balance - ?,
        mining_active    = 1,
        session_start_at = NOW(),
        last_claim_at    = NOW(),
        total_sessions   = total_sessions + 1
      WHERE user_id = ?
    `, [ENTRY_FEE, req.userId]);

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

    let coins      = m.coins + earned;
    let withdrawable = m.withdrawable;
    let active     = m.mining_active;

    // Multiple cycle support
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
        balance  = balance - ?,
        boost_usd = ?
      WHERE user_id = ?
    `, [amount, newBoost, req.userId]);

    const newMultiplier = getBoostMultiplier(newBoost);

    res.json({
      message:        "Boost added",
      boost:          newBoost,
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

    res.json({ message: "Auto mining enabled" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== SOL PRICE (public) ==================
// GET /api/mining/sol-price  — lightweight endpoint for price-only refresh
router.get('/sol-price', async (req, res) => {
  try {
    const price = await getSolPrice();
    res.json({ solPriceUSD: price });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

