const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');

// ================== CONFIG ==================
const BASE_URL = process.env.APP_BASE_URL || 'https://yourdomain.com';

const REFERRAL_LEVELS = [
  { level: 1, minReferrals: 10, reward: 2.00,  label: 'Level 1' },
  { level: 2, minReferrals: 5,  reward: 1.50,  label: 'Level 2' },
  { level: 3, minReferrals: 1,  reward: 1.50,  label: 'Level 3' },
];

// ================== HELPER ==================
// একজন user-এর কতজন active referral আছে (active = mining_start করেছে)
async function getActiveReferralCount(userId) {
  const [rows] = await db.query(
    `SELECT COUNT(DISTINCT pl.user_id) AS cnt
     FROM users u
     JOIN purchase_logs pl
       ON pl.user_id = u.id AND pl.purchase_type = 'mining_start'
     WHERE u.referred_by = (SELECT referral_code FROM users WHERE id = ?)`,
    [userId]
  );
  return rows[0]?.cnt || 0;
}

// একজন user-এর সব direct referral (level 1 children)
async function getDirectReferrals(userId) {
  const [rows] = await db.query(
    `SELECT u.id, u.wallet_address, u.referral_code, u.created_at,
            CASE WHEN pl.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_active
     FROM users u
     LEFT JOIN (
       SELECT DISTINCT user_id FROM purchase_logs WHERE purchase_type = 'mining_start'
     ) pl ON pl.user_id = u.id
     WHERE u.referred_by = (SELECT referral_code FROM users WHERE id = ?)
     ORDER BY u.created_at DESC`,
    [userId]
  );
  return rows;
}

// Level 2 children (direct referral-দের referral)
async function getLevel2Referrals(userId) {
  const [rows] = await db.query(
    `SELECT u.id, u.wallet_address, u.referral_code, u.created_at,
            CASE WHEN pl.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_active,
            parent.id AS referred_by_user_id,
            parent.wallet_address AS referred_by_wallet
     FROM users u
     LEFT JOIN (
       SELECT DISTINCT user_id FROM purchase_logs WHERE purchase_type = 'mining_start'
     ) pl ON pl.user_id = u.id
     JOIN users parent ON parent.referral_code = u.referred_by
     WHERE parent.referred_by = (SELECT referral_code FROM users WHERE id = ?)
     ORDER BY u.created_at DESC`,
    [userId]
  );
  return rows;
}

// Level 3 children (level 2-এর referral)
async function getLevel3Referrals(userId) {
  const [rows] = await db.query(
    `SELECT u.id, u.wallet_address, u.referral_code, u.created_at,
            CASE WHEN pl.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_active,
            parent.id AS referred_by_user_id,
            parent.wallet_address AS referred_by_wallet
     FROM users u
     LEFT JOIN (
       SELECT DISTINCT user_id FROM purchase_logs WHERE purchase_type = 'mining_start'
     ) pl ON pl.user_id = u.id
     JOIN users parent ON parent.referral_code = u.referred_by
     JOIN users grandparent ON grandparent.referral_code = parent.referred_by
     WHERE grandparent.referred_by = (SELECT referral_code FROM users WHERE id = ?)
     ORDER BY u.created_at DESC`,
    [userId]
  );
  return rows;
}

// wallet address শর্ট করে দেখানো
function shortWallet(addr) {
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 4) + '...' + addr.slice(-4);
}

// ================== GET /api/referral/stats ==================
// সব তথ্য একসাথে — referral link, tree, commission, progress
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    // নিজের user info
    const [userRows] = await db.query(
      `SELECT id, wallet_address, referral_code, referred_by, created_at
       FROM users WHERE id = ?`,
      [req.userId]
    );
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });
    const me = userRows[0];

    // Referral link
    const referralLink = `${BASE_URL}/register?ref=${me.referral_code}`;

    // ---- Level 1 ----
    const l1List   = await getDirectReferrals(req.userId);
    const l1Total  = l1List.length;
    const l1Active = l1List.filter(u => u.is_active).length;

    // ---- Level 2 ----
    const l2List   = await getLevel2Referrals(req.userId);
    const l2Total  = l2List.length;
    const l2Active = l2List.filter(u => u.is_active).length;

    // ---- Level 3 ----
    const l3List   = await getLevel3Referrals(req.userId);
    const l3Total  = l3List.length;
    const l3Active = l3List.filter(u => u.is_active).length;

    // ---- Commission earned ----
    const [commRows] = await db.query(
      `SELECT 
         SUM(reward_usd) AS total_earned,
         SUM(CASE WHEN level = 1 THEN reward_usd ELSE 0 END) AS l1_earned,
         SUM(CASE WHEN level = 2 THEN reward_usd ELSE 0 END) AS l2_earned,
         SUM(CASE WHEN level = 3 THEN reward_usd ELSE 0 END) AS l3_earned,
         COUNT(*) AS total_payouts
       FROM commission_logs
       WHERE beneficiary_user_id = ?`,
      [req.userId]
    );
    const comm = commRows[0];

    // ---- Commission history (last 20) ----
    const [histRows] = await db.query(
      `SELECT cl.level, cl.reward_usd, cl.created_at,
              u.wallet_address AS triggered_by_wallet
       FROM commission_logs cl
       JOIN users u ON u.id = cl.triggered_by_user_id
       WHERE cl.beneficiary_user_id = ?
       ORDER BY cl.created_at DESC
       LIMIT 20`,
      [req.userId]
    );

    // ---- Referred by (আমাকে কে রেফার করেছে) ----
    let referredByInfo = null;
    if (me.referred_by) {
      const [refByRows] = await db.query(
        `SELECT id, wallet_address, referral_code FROM users WHERE referral_code = ?`,
        [me.referred_by]
      );
      if (refByRows.length) {
        referredByInfo = {
          wallet: shortWallet(refByRows[0].wallet_address),
          referralCode: refByRows[0].referral_code,
        };
      }
    }

    // ---- Level progress & status ----
    const levelProgress = REFERRAL_LEVELS.map(cfg => {
      let activeCount, totalCount;
      if (cfg.level === 1) { activeCount = l1Active; totalCount = l1Total; }
      if (cfg.level === 2) { activeCount = l2Active; totalCount = l2Total; }
      if (cfg.level === 3) { activeCount = l3Active; totalCount = l3Total; }

      const unlocked   = activeCount >= cfg.minReferrals;
      const remaining  = Math.max(cfg.minReferrals - activeCount, 0);
      const progressPct = Math.min(Math.round((activeCount / cfg.minReferrals) * 100), 100);

      return {
        level:        cfg.level,
        label:        cfg.label,
        reward:       cfg.reward,
        minReferrals: cfg.minReferrals,
        totalReferred: totalCount,
        activeReferred: activeCount,
        remaining,
        progressPct,
        unlocked,
        status:       unlocked ? '✅ Unlocked' : `🔒 Need ${remaining} more active referral${remaining !== 1 ? 's' : ''}`,
        hint: unlocked
          ? `You earn $${cfg.reward} every time someone under you starts mining`
          : `Get ${remaining} more person${remaining !== 1 ? 's' : ''} to join & pay $18 entry to unlock $${cfg.reward} reward`,
      };
    });

    // ---- Tree (level 1 → 2 → 3 nested) ----
    const tree = l1List.map(l1 => {
      const children = l2List
        .filter(l2 => l2.referred_by_user_id === l1.id)
        .map(l2 => {
          const grandchildren = l3List
            .filter(l3 => l3.referred_by_user_id === l2.id)
            .map(l3 => ({
              wallet:    shortWallet(l3.wallet_address),
              active:    !!l3.is_active,
              joinedAt:  l3.created_at,
              level:     3,
            }));
          return {
            wallet:    shortWallet(l2.wallet_address),
            active:    !!l2.is_active,
            joinedAt:  l2.created_at,
            level:     2,
            children:  grandchildren,
          };
        });
      return {
        wallet:    shortWallet(l1.wallet_address),
        active:    !!l1.is_active,
        joinedAt:  l1.created_at,
        level:     1,
        children,
      };
    });

    // ---- Summary ----
    const totalNetwork = l1Total + l2Total + l3Total;
    const totalActive  = l1Active + l2Active + l3Active;

    res.json({
      // নিজের info
      myReferralCode: me.referral_code,
      referralLink,
      referredBy:     referredByInfo,
      memberSince:    me.created_at,

      // Network summary
      network: {
        totalReferred: totalNetwork,
        totalActive,
        totalInactive: totalNetwork - totalActive,
      },

      // Level-by-level progress
      levelProgress,

      // Commission summary
      commission: {
        totalEarned:  Number((comm.total_earned  || 0).toFixed(2)),
        level1Earned: Number((comm.l1_earned     || 0).toFixed(2)),
        level2Earned: Number((comm.l2_earned     || 0).toFixed(2)),
        level3Earned: Number((comm.l3_earned     || 0).toFixed(2)),
        totalPayouts: comm.total_payouts || 0,
      },

      // Commission history
      commissionHistory: histRows.map(h => ({
        level:     h.level,
        reward:    Number(h.reward_usd),
        from:      shortWallet(h.triggered_by_wallet),
        earnedAt:  h.created_at,
      })),

      // Tree view
      referralTree: tree,

      // Guide — ইউজার কী করবে
      guide: {
        step1: 'Share your referral link with friends',
        step2: 'They must register using your link',
        step3: 'They must deposit $18 to start mining (this makes them "active")',
        step4: 'Once you reach the required active referrals per level, you earn commission automatically',
        rewards: REFERRAL_LEVELS.map(l =>
          `Level ${l.level}: ${l.minReferrals} active referral${l.minReferrals > 1 ? 's' : ''} needed → earn $${l.reward} per mining 
start`
        ),
      },
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== GET /api/referral/leaderboard ==================
// টপ referrer-দের লিস্ট (optional, motivational)
router.get('/leaderboard', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.wallet_address,
              COUNT(DISTINCT ref.id) AS total_referred,
              SUM(COALESCE(cl.reward_usd, 0)) AS total_earned
       FROM users u
       LEFT JOIN users ref ON ref.referred_by = u.referral_code
       LEFT JOIN commission_logs cl ON cl.beneficiary_user_id = u.id
       GROUP BY u.id
       ORDER BY total_earned DESC, total_referred DESC
       LIMIT 10`
    );

    res.json({
      leaderboard: rows.map((r, i) => ({
        rank:          i + 1,
        wallet:        shortWallet(r.wallet_address),
        totalReferred: r.total_referred,
        totalEarned:   Number((r.total_earned || 0).toFixed(2)),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

