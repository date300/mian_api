const express        = require('express');
const router         = express.Router();
const authMiddleware = require('../middlewares/auth.middleware');
const { getProfile } = require('../controllers/user.controller');

// GET /api/user/profile  → protected route
// Flutter's verifyToken() hits this endpoint with Bearer token
router.get('/profile', authMiddleware, getProfile);

module.exports = router;

