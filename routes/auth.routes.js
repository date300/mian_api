const express        = require('express');
const router         = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const { login, logout } = require('../controllers/auth.controller');

// POST /api/auth/login   → no auth needed (open endpoint)
router.post('/login', login);

// POST /api/auth/logout  → must be logged in
router.post('/logout', authMiddleware, logout);

module.exports = router;

