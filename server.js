require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Routes ─────────────────────────────────────────
// Flutter calls: https://ltcminematrix.com/api/auth/login
app.use('/api/auth', authRoutes);

// Flutter calls: https://web3.ltcminematrix.com/api/user/profile
app.use('/api/user', userRoutes);

// ── Health check ───────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Mine Matrix API running' });
});

// ── Start ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Mine Matrix API running on http://localhost:${PORT}`);
});

