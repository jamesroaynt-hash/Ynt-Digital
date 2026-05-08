BEGIN;

INSERT INTO users (username, password, full_name, role)
VALUES
  ('admin', 'admin123', 'Admin User', 'Administrator'),
  ('staff', 'staff123', 'Staff User', 'Trainee')
ON CONFLICT(username) DO NOTHING;

COMMIT;
