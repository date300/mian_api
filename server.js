require('dotenv').config();

const express = require('express');
const cors = require('cors');

// Routes
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const miningRoutes = require('./routes/mining.routes');
const depositRoutes = require('./routes/deposit.crypto.routes');
const referralRouter = require('./routes/refer.routes');
// DB
const db = require('./config/db');

const app = express();

// ── PORT (IMPORTANT: ONLY ONE) ──
const PORT = process.env.PORT || 3001;

// ── Middleware ──
app.use(cors());
app.use(express.json());

// ── Routes ──
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/mining', miningRoutes);
app.use('/api/deposit', depositRoutes);
app.use('/api/referral', referralRouter);
// ── Health Check ──
app.get('/', async (req, res) => {
  try {
    await db.query('SELECT 1');

    res.json({
      status: 'ok',
      message: 'Mine Matrix API running',
      database: 'connected'
    });
  } catch (err) {
    res.json({
      status: 'error',
      message: 'API running but DB failed',
      error: err.message
    });
  }
});

// ── Start Server ──
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
