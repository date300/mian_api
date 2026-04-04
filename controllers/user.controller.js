const db = require('../config/db');

async function getProfile(req, res) {
  try {
    const [rows] = await db.query(
      'SELECT id, wallet_address, referral_code, referred_by, balance, main_balance, mining_balance, coins, withdrawable_coins, boost_amount, boost_multiplier, name, email FROM users WHERE id = ?',
      [req.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    return res.status(200).json({
      status: 'success',
      user: rows[0]
    });

  } catch (err) {
    console.error('[PROFILE ERROR]', err);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
}

module.exports = { getProfile };
