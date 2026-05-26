import { Database } from "bun:sqlite";

export interface AppliedAction {
  id: number;
  repo: string;
  type: "merge-pr" | "push-workflow" | "create-issue";
  target: string | null;
  result: "success" | "skipped" | "error";
  message: string | null;
  applied_at: string | null;
}

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_prs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      repo         TEXT NOT NULL,
      pr_number    INTEGER NOT NULL,
      title        TEXT,
      risk         TEXT,
      analyzed_at  TEXT,
      UNIQUE(repo, pr_number)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS applied_actions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      repo         TEXT NOT NULL,
      type         TEXT NOT NULL,
      target       TEXT,
      result       TEXT,
      message      TEXT,
      applied_at   TEXT
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

export function isPRNew(db: Database, repo: string, number: number): boolean {
  const row = db
    .query("SELECT 1 FROM seen_prs WHERE repo = ? AND pr_number = ? LIMIT 1")
    .get(repo, number);

  return row === null;
}

export function markPRSeen(db: Database, repo: string, number: number, title: string, risk: string): void {
  db
    .query(`
      INSERT OR IGNORE INTO seen_prs (repo, pr_number, title, risk, analyzed_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(repo, number, title, risk, new Date().toISOString());
}

export function resetDB(db: Database): void {
  db.exec("DELETE FROM seen_issues");
  db.exec("DELETE FROM seen_prs");
}

export function logAction(
  db: Database,
  repo: string,
  type: AppliedAction["type"],
  target: string,
  result: AppliedAction["result"],
  message: string
): void {
  db
    .query(`
      INSERT INTO applied_actions (repo, type, target, result, message, applied_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(repo, type, target, result, message, new Date().toISOString());
}

export function getAppliedActions(db: Database, repo: string): AppliedAction[] {
  return db
    .query("SELECT id, repo, type, target, result, message, applied_at FROM applied_actions WHERE repo = ?")
    .all(repo) as AppliedAction[];
}

export function closeDB(db: Database): void {
  db.close();
}
