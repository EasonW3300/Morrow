import type { SqliteDatabase } from "./db.ts";

/**
 * 任务域表结构迁移（票 M1-T4 / Issue #16）——独立于 tasks.ts 的业务逻辑，集中建表 DDL。
 *
 * 与事件账本同库（events.sqlite，WAL）：tasks / task_nodes / task_edges 是**可变投影表**
 * （状态随调度推进更新），与 events 的 append-only 互不影响（触发器只锁 events 表）。
 * 事件账本仍是唯一事实源（task.* 事件族全量落账本）；本组表是调度器的可变工作态，
 * 支撑 DAG 存取与状态推进，投影重建（重启后按账本重放）是后续票的恢复路径。
 *
 * task_version：规划修订（FR-TASK-3 修改未完成节点重算依赖）时递增；初版恒 1。
 *
 * M1-T6（Issue #18）演进：tasks.session_id（创建来源会话，Chat 任务卡片关联）与
 * task_nodes.actor（节点责任方：NULL = 调度器，'owner' = Owner 接管）。列只增不改名；
 * 旧库经 ensureColumn 幂等 ALTER（CREATE IF NOT EXISTS 不会给已存在的表补列）。
 */
export const TASK_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id      TEXT PRIMARY KEY,
  goal         TEXT NOT NULL,
  status       TEXT NOT NULL,
  task_version INTEGER NOT NULL DEFAULT 1,
  session_id   TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_nodes (
  node_id     TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  node_key    TEXT NOT NULL,
  title       TEXT NOT NULL,
  goal        TEXT,
  agent_role  TEXT,
  model       TEXT,
  retriable   INTEGER NOT NULL DEFAULT 1,
  side_effect TEXT NOT NULL DEFAULT 'delivery_unknown',
  status      TEXT NOT NULL DEFAULT 'pending',
  actor       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  result      TEXT,
  error       TEXT,
  node_seq    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_nodes_task_idx ON task_nodes (task_id, node_seq);
CREATE TABLE IF NOT EXISTS task_edges (
  edge_id   TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL,
  from_node TEXT NOT NULL,
  to_node   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_edges_task_idx ON task_edges (task_id);
`;

/**
 * Checkpoint 表（M1-T5 / Issue #17，FR-TASK-5）：JSON 快照 + 元数据，与任务投影同库。
 * checkpoint 是可恢复快照（GLOSSARY: Checkpoint），行可补偿删除（写入中断时不留孤儿，
 * 见 checkpoint.ts）；账本侧以 task.checkpoint_created / task.restored 事件留痕。
 */
export const TASK_CHECKPOINTS_SQL = `
CREATE TABLE IF NOT EXISTS task_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  task_version  INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  snapshot      TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_checkpoints_task_idx ON task_checkpoints (task_id, created_at, checkpoint_id);
`;

/** 幂等建表（CREATE IF NOT EXISTS）+ 旧库补列（M1-T6 的 actor / session_id）；由 tasks.ts 的 TaskStore 调用 */
export function ensureTaskTables(db: SqliteDatabase): void {
  db.exec(TASK_TABLES_SQL);
  ensureColumn(db, "tasks", "session_id", "TEXT");
  ensureColumn(db, "task_nodes", "actor", "TEXT");
}

/** 列存在则跳过（pragma table_info）；演进规则：只加列不改名不删列 */
function ensureColumn(db: SqliteDatabase, table: string, column: string, decl: string): void {
  const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as unknown as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/** 幂等建 checkpoint 表（CREATE IF NOT EXISTS）；由 checkpoint.ts 的 CheckpointStore 调用 */
export function ensureCheckpointTable(db: SqliteDatabase): void {
  db.exec(TASK_CHECKPOINTS_SQL);
}
