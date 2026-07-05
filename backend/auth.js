/**
 * Auth helpers — JWT sign/verify + role guards + hierarchy scoping.
 */
const jwt = require('jsonwebtoken');
const db = require('./db');

const SECRET = process.env.JWT_SECRET || 'ms-sms-dev-secret-change-in-production';

function sign(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    SECRET,
    { expiresIn: '12h' }
  );
}

// middleware: require valid token
function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// middleware factory: require one of given roles
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden — insufficient permission' });
    next();
  };
}

/**
 * Return the list of user IDs that a given user is allowed to "see"
 * (their whole downstream hierarchy), including self.
 */
function descendantIds(userId) {
  const ids = [userId];
  let frontier = [userId];
  while (frontier.length) {
    const placeholders = frontier.map(() => '?').join(',');
    const kids = db.all(`SELECT id FROM users WHERE parent_id IN (${placeholders})`, frontier);
    const newIds = kids.map(k => k.id);
    ids.push(...newIds);
    frontier = newIds;
  }
  return ids;
}

module.exports = { sign, authRequired, requireRole, descendantIds, SECRET };
