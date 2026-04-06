require('dotenv').config();

const express = require('express');
const cors = require('cors');

// Routes
const authRoutes   = require('./routes/auth.routes');
const userRoutes   = require('./routes/user.routes');
const miningRoutes = require('./routes/mining.routes'); // ✅
const depositRoutes = require('./routes/deposit.routes'); // ✅
// DB (MySQL pool)
const db = require('./config/db'); // ✅

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Routes ─────────────────────────────────────────

// Auth API
app.use('/api/auth', authRoutes);

// User API
app.use('/api/user', userRoutes);

// Mining API
app.use('/api/mining', miningRoutes); 

app.use('/api/deposit', depositRoutes);

// ── Health check ───────────────────────────────────
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

// ── Start ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
