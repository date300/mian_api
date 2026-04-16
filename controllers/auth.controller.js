const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { uniqueReferralCode } = require('../helpers/referral.helper');

async function login(req, res) {
  const { wallet_address, referred_by } = req.body;

  // Validate wallet address
  if (!wallet_address || wallet_address.trim() === '') {
    return res.status(400).json({
      status: 'error',
      message: 'wallet_address is required'
    });
  }

  const identifier = wallet_address.trim();

  try {
    // Check if user exists
    const [rows] = await db.query(
      'SELECT * FROM users WHERE wallet_address = ?',
      [identifier]
    );

    let user;

    // If user does not exist → Create new user
    if (rows.length === 0) {
      const referralCode = await uniqueReferralCode();
      let validReferral = null;

      // Validate referral code (optional)
      if (referred_by && referred_by.trim() !== '') {
        const code = referred_by.trim().toUpperCase();

        const [refRows] = await db.query(
          'SELECT id FROM users WHERE referral_code = ?',
          [code]
        );

        if (refRows.length > 0) {
          validReferral = code;
        }
      }

      // Insert new user (✅ FIXED)
      const [result] = await db.query(
        `INSERT INTO users (wallet_address, referral_code, referred_by)
         VALUES (?, ?, ?)`,
        [identifier, referralCode, validReferral]
      );

      // Get created user
      const [newRows] = await db.query(
        'SELECT * FROM users WHERE id = ?',
        [result.insertId]
      );

      user = newRows[0];
    } else {
      user = rows[0];
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || '7d' }
    );

    // Save token in database (✅ FIXED)
    await db.query(
      `INSERT INTO auth_tokens (user_id, token, expires_at)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
      [user.id, token]
    );

    // Final response
    return res.status(200).json({
      status: 'success',
      token: token,
      user: {
        id: user.id,
        wallet_address: user.wallet_address,
        referral_code: user.referral_code,
        referred_by: user.referred_by,
        created_at: user.created_at
      }
    });

  } catch (err) {
    console.error('[LOGIN ERROR]', err);
    return res.status(500).json({
      status: 'error',
      message: 'Server error'
    });
  }
}

async function logout(req, res) {
  try {
    const token = req.headers['authorization']?.split(' ')[1];

    if (!token) {
      return res.status(400).json({
        status: 'error',
        message: 'Token missing'
      });
    }

    await db.query(
      'DELETE FROM auth_tokens WHERE token = ?',
      [token]
    );

    return res.json({
      status: 'success',
      message: 'Logged out successfully'
    });

  } catch (err) {
    console.error('[LOGOUT ERROR]', err);
    return res.status(500).json({
      status: 'error',
      message: 'Server error'
    });
  }
}

module.exports = { login, logout };
