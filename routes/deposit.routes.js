// routes/deposit.routes.js
const express = require('express');
const router  = express.Router();
const https   = require('https');
const db      = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');

// ── Constants ────────────────────────────────────────────────────────────────
const PLATFORM_WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const SOLANA_RPC      = 'https://api.mainnet-beta.solana.com';
const COINS_PER_USD   = 1000;

// ── SOL Price Cache ──────────────────────────────────────────────────────────
let _cachedSolPrice    = null;
let _solPriceFetchedAt = 0;
const SOL_CACHE_TTL    = 60 * 1000;

async function getSolPrice() {
  const now = Date.now();
  if (_cachedSolPrice && now - _solPriceFetchedAt < SOL_CACHE_TTL) {
    return _cachedSolPrice;
  }
  return new Promise((resolve) => {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
    https.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const price = JSON.parse(body)?.solana?.usd;
          if (price > 0) {
            _cachedSolPrice    = price;
            _solPriceFetchedAt = Date.now();
            resolve(price);
          } else resolve(_cachedSolPrice || 150);
        } catch { resolve(_cachedSolPrice || 150); }
      });
    }).on('error', () => resolve(_cachedSolPrice || 150));
  });
}

// ── RPC Helper ───────────────────────────────────────────────────────────────
function rpcPost(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method, params,
    });
    const url  = new URL(SOLANA_RPC);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout:  10000,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('RPC timeout')); });
    req.write(body);
    req.end();
  });
}

// ── GET /api/deposit/info ─────────────────────────────────────────────────────
router.get('/info', authMiddleware, async (req, res) => {
  try {
    const solPrice = await getSolPrice();
    res.json({
      platformWallet: PLATFORM_WALLET,
      solPriceUSD:    solPrice,
      minDepositSOL:  0.01,
      network:        'mainnet-beta',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/deposit/verify ──────────────────────────────────────────────────
router.post('/verify', authMiddleware, async (req, res) => {
  const { signature } = req.body;

  if (!signature || signature.length < 80) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    const [existing] = await db.query(
      'SELECT id, status FROM deposits WHERE tx_signature = ?',
      [signature]
    );
    if (existing.length > 0) {
      if (existing[0].status === 'confirmed') {
        return res.status(400).json({ error: 'Transaction already credited' });
      }
      if (existing[0].status === 'pending') {
        return res.status(400).json({ error: 'Transaction already submitted, wait for confirmation' });
      }
    }

    const txData = await rpcPost('getTransaction', [
      signature,
      { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);

    const tx = txData?.result;
    if (!tx) {
      return res.status(400).json({ error: 'Transaction not found on blockchain. Wait a moment and retry.' });
    }

    if (tx.meta?.err) {
      return res.status(400).json({ error: 'Transaction failed on blockchain' });
    }

    const accountKeys = tx.transaction?.message?.accountKeys || [];
    const platformIdx = accountKeys.findIndex(k => k === PLATFORM_WALLET);
    if (platformIdx === -1) {
      return res.status(400).json({ error: 'Transaction not sent to platform wallet' });
    }

    const preBalances  = tx.meta?.preBalances  || [];
    const postBalances = tx.meta?.postBalances || [];
    const lamportsDiff = (postBalances[platformIdx] || 0) - (preBalances[platformIdx] || 0);

    if (lamportsDiff <= 0) {
      return res.status(400).json({ error: 'No SOL received in platform wallet' });
    }

    const solAmount = lamportsDiff / 1000000000;

    const solPrice  = await getSolPrice();
    const usdAmount = solAmount * solPrice;

    if (solAmount < 0.001) {
      return res.status(400).json({ error: 'Minimum deposit is 0.001 SOL' });
    }

    await db.query(
      'INSERT INTO deposits (user_id, tx_signature, sol_amount, usd_amount, sol_price, status) VALUES (?, ?, ?, ?, ?, ?)',
      [req.userId, signature, solAmount, usdAmount, solPrice, 'confirmed']
    );

    await db.query(
      'UPDATE mining SET balance = balance + ? WHERE user_id = ?',
      [usdAmount, req.userId]
    );

    await db.query(
      'UPDATE deposits SET confirmed_at = NOW() WHERE tx_signature = ?',
      [signature]
    );

    res.json({
      success:   true,
      solAmount,
      usdAmount: Number(usdAmount.toFixed(4)),
      solPrice,
      message:   'Deposit confirmed! $' + usdAmount.toFixed(2) + ' added to your balance.',
    });

  } catch (err) {
    console.error('Deposit verify error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ── GET /api/deposit/history ──────────────────────────────────────────────────
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT tx_signature, sol_amount, usd_amount, sol_price, status, created_at, confirmed_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      [req.userId]
    );
    res.json({ deposits: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

