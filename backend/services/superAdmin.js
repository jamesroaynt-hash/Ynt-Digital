// The super admin: one account (users.is_super_admin = 1, the "Admin User")
// above the other Administrators. Only it manages accounts and API access and
// reads the Summary, and no other account may change it. Read from the
// database on every check rather than the token, so granting or revoking it
// takes effect without a fresh login.
async function isSuperAdmin(db, user) {
  const id = Number(user?.id);
  if (!id) return false;
  const row = await db.prepare(
    'SELECT is_super_admin FROM users WHERE id = ? AND is_active = 1'
  ).get(id);
  return Number(row?.is_super_admin) === 1;
}

async function isSuperAdminId(db, userId) {
  const id = Number(userId);
  if (!id) return false;
  const row = await db.prepare('SELECT is_super_admin FROM users WHERE id = ?').get(id);
  return Number(row?.is_super_admin) === 1;
}

function requireSuperAdmin(db) {
  return async function superAdminGate(req, res, next) {
    try {
      if (!(await isSuperAdmin(db, req.user))) {
        return res.status(403).json({ error: 'Super admin access required' });
      }
      return next();
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };
}

// Nobody but the super admin changes the super admin's account.
async function guardSuperAdminTarget(db, req, res, targetId) {
  if (Number(targetId) === Number(req.user?.id)) return true;
  if (!(await isSuperAdminId(db, targetId))) return true;
  if (await isSuperAdmin(db, req.user)) return true;
  res.status(403).json({ error: 'Only the super admin can change this account.' });
  return false;
}

module.exports = { isSuperAdmin, isSuperAdminId, requireSuperAdmin, guardSuperAdminTarget };
