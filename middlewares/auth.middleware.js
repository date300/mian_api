const jwt = require('jsonwebtoken');
const db  = require('../config/db');

async function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: No token provided' });
  }

  const token = header.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [rows] = await db.query(
      'SELECT id FROM auth_tokens WHERE token = ? AND expires_at > NOW()',
      [token]
    );

    if (rows.length === 0) {
      return res.status(401).json({ status: 'error', message: 'Token expired or revoked' });
    }

    req.userId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ status: 'error', message: 'Invalid token' });
  }
}

module.exports = authMiddleware;
