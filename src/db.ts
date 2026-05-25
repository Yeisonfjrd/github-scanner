import { Database } from "bun:sqlite";

export function initDB(path: string): Database {
  const db = new Database(path);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_issues (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      repo         TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      title        TEXT,
      type         TEXT,
      risk         TEXT,
      analyzed_at  TEXT,
      UNIQUE(repo, issue_number)
    )
  `);

  return db;
}

export function isNew(db: Database, repo: string, number: number): boolean {
  const row = db
    .query("SELECT 1 FROM seen_issues WHERE repo = ? AND issue_number = ? LIMIT 1")
    .get(repo, number);

  return row === null;
}

export function markSeen(
  db: Database,
  repo: string,
  number: number,
  title: string,
  type: string,
  risk: string
): void {
  db
    .query(`
      INSERT OR IGNORE INTO seen_issues (repo, issue_number, title, type, risk, analyzed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(repo, number, title, type, risk, new Date().toISOString());
}

export function closeDB(db: Database): void {
  db.close();
}
