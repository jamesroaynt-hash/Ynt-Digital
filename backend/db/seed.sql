BEGIN;

INSERT INTO users (username, password, full_name, role)
SELECT 'admin', 'admin123', 'Admin User', 'Administrator'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin')
UNION ALL
SELECT 'staff', 'staff123', 'Staff User', 'Trainee'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'staff');

COMMIT;
