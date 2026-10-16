CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO posts (title, content) VALUES
  ('Hello World', 'This is your first post. Welcome to your new D1-backed API!'),
  ('Getting Started', 'Try creating, updating, and deleting posts via the REST endpoints.');
