const db = require('../config/db');

function generateReferralCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function uniqueReferralCode() {
  let code, exists;
  do {
    code = generateReferralCode();
    const [rows] = await db.query(
      'SELECT id FROM users WHERE referral_code = ?',
      [code]
    );
    exists = rows.length > 0;
  } while (exists);
  return code;
}

module.exports = { generateReferralCode, uniqueReferralCode };
