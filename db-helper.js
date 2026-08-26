'use strict';

/**
 * 天地图矢量瓦片下载进度库（SQLite / better-sqlite3）
 *
 * 表结构：
 *   - completed_batches(z, x)：整列（同一 z、x 下所有 y）已完成，续传时整列跳过
 *   - error_tiles(z, x, y)：下载失败的瓦片，下次运行优先重试
 *   - meta(key, value)：元信息（如 configFingerprint，配置变化时自动重建进度）
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class ProgressDB {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._init();
    this._prepare();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS completed_batches (
        z INTEGER NOT NULL,
        x INTEGER NOT NULL,
        PRIMARY KEY (z, x)
      );
      CREATE TABLE IF NOT EXISTS error_tiles (
        z INTEGER NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        PRIMARY KEY (z, x, y)
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  _prepare() {
    this.stmtGetMeta = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    this.stmtSetMeta = this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)');

    this.stmtIsBatchDone = this.db.prepare('SELECT 1 FROM completed_batches WHERE z = ? AND x = ?');
    this.stmtMarkBatchDone = this.db.prepare('INSERT OR IGNORE INTO completed_batches(z, x) VALUES(?, ?)');
    this.stmtCountBatches = this.db.prepare('SELECT COUNT(*) AS cnt FROM completed_batches');

    this.stmtGetErrors = this.db.prepare('SELECT z, x, y FROM error_tiles');
    this.stmtCountErrors = this.db.prepare('SELECT COUNT(*) AS cnt FROM error_tiles');
    this.stmtAddError = this.db.prepare('INSERT OR IGNORE INTO error_tiles(z, x, y) VALUES(?, ?, ?)');
    this.stmtRemoveError = this.db.prepare('DELETE FROM error_tiles WHERE z = ? AND x = ? AND y = ?');

    this.stmtClearBatches = this.db.prepare('DELETE FROM completed_batches');
    this.stmtClearErrors = this.db.prepare('DELETE FROM error_tiles');
  }

  getMeta(key) {
    const row = this.stmtGetMeta.get(key);
    return row ? row.value : undefined;
  }

  setMeta(key, value) {
    this.stmtSetMeta.run(key, value);
  }

  isBatchDone(z, x) {
    return !!this.stmtIsBatchDone.get(z, x);
  }

  markBatchDone(z, x) {
    this.stmtMarkBatchDone.run(z, x);
  }

  completedBatchCount() {
    return this.stmtCountBatches.get().cnt;
  }

  getErrorTiles() {
    return this.stmtGetErrors.all();
  }

  errorCount() {
    return this.stmtCountErrors.get().cnt;
  }

  addError(z, x, y) {
    this.stmtAddError.run(z, x, y);
  }

  removeError(z, x, y) {
    this.stmtRemoveError.run(z, x, y);
  }

  // 配置变化（范围/级别/输出目录）后清空进度重建
  resetProgress() {
    this.stmtClearBatches.run();
    this.stmtClearErrors.run();
  }

  close() {
    try { this.db.close(); } catch (_) {}
  }
}

module.exports = ProgressDB;
