import type { ExecutionReconcileEvidence } from "@morrow/protocol";
import type { EventLedger } from "../ledger.ts";
import type { SyncEngine } from "../sync/engine.ts";
import { detectDualLeaseHold, findRemoteActiveLease, replayLeaseView, type ReplayedLease } from "./view.ts";

/**
 * 执行权协调器（M3 同步接线修复 / Issue #34，FR-DEP-4 的事前半边）。
 *
 * 调度器在 `leases.acquire` 之前调用 `beforeAcquire`：向**全部已配对 peer 做一次增量
 * 拉取（只 pull 不 push，避免同步风暴）**，随后按账本事件重放远端租约视图：
 *   - 远端有未过期租约 → 拒绝本机 acquire（调用方记 `task.lease_denied`，payload 带
 *     持有者与来源事件），任务保持 planned / waiting_input；
 *   - 拉取失败（不可达/缺 token）只记录，不阻断本地执行——离线优先语义下无法把
 *     网络可用性当作执行前提；该 peer 的状态在 `/v1/sync/status` 以 unreachable_reason
 *     暴露。
 *
 * acquire 成功后调用 `afterAcquire`：强制再拉一轮（不复用节流结果），若发现双方都
 * 持有未过期租约（近同时 acquire）→ 返回双持有证据，调用方立即释放租约并把任务冻结
 * 为 needs_reconcile，不执行任何节点。
 *
 * 节流：同一任务在 `pullThrottleMs`（默认 500ms）内的重复 beforeAcquire 复用上一次
 * 拉取结果，避免调度循环/重试造成每 acquire 一次全网拉取。afterAcquire 永远强制刷新
 * （它是竞态检测的第二次采样，不能被节流吞掉）。
 *
 * 残余窗口（诚实边界）：拉取与 acquire 之间没有共识协议，仍可能两端都认为「对方没有
 * 租约」而各自 acquire；afterAcquire 的第二采样只能缩小窗口，不能消除。最终护栏是
 * fencing token（副作用提交前校验）与 needs_reconcile（Owner 显式裁决）。
 */

export interface LeasePullError {
  peer_replica_id: string;
  error: string;
}

export interface LeasePullSummary {
  peers: string[];
  pulled: number;
  errors: LeasePullError[];
}

export interface LeaseGateDecision {
  /** true = 可以继续 acquire / 执行；false = 不得 acquire 或已检测到双持有 */
  ok: boolean;
  /** beforeAcquire：远端持有者；afterAcquire：冲突的另一持有者 */
  holder: ReplayedLease | null;
  /** afterAcquire 专用：双方都持有未过期租约 */
  dual_hold: boolean;
  /** afterAcquire 双持有时的 needs_reconcile 证据（协议类型） */
  evidence: ExecutionReconcileEvidence | null;
  pull: LeasePullSummary;
  /**
   * 本次重放观察到的跨副本最大 token（M3 修复批 / #33）。调用方应在 acquire 前
   * 交给 LeaseStore.observeGrantedToken / observeReservedToken——取号越过它、
   * validate 拒绝低于它的旧 token。
   */
  observed: { granted: number; reserved: number };
}

export interface LeaseCoordinatorOptions {
  ledger: EventLedger;
  replicaId: string;
  /** 同步引擎；缺省 = 不做跨设备协调（纯本地部署/单测） */
  sync?: SyncEngine;
  /** 注入时钟（节流与租约过期判定；测试零 sleep） */
  now?: () => Date;
  /** 同任务拉取结果复用窗口（毫秒，默认 500；0 = 不节流） */
  pullThrottleMs?: number;
}

const DEFAULT_PULL_THROTTLE_MS = 500;
/** 单 peer 排空上限（防御对端异常导致无限翻页） */
const MAX_PULL_PAGES = 254;

interface ThrottledPull {
  at: number;
  promise: Promise<LeasePullSummary>;
}

export class LeaseCoordinator {
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #sync: SyncEngine | undefined;
  readonly #now: () => Date;
  readonly #pullThrottleMs: number;
  readonly #pulls = new Map<string, ThrottledPull>();

  constructor(options: LeaseCoordinatorOptions) {
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#sync = options.sync;
    this.#now = options.now ?? (() => new Date());
    this.#pullThrottleMs = Math.max(0, options.pullThrottleMs ?? DEFAULT_PULL_THROTTLE_MS);
  }

  async beforeAcquire(taskId: string): Promise<LeaseGateDecision> {
    const pull = await this.#pullFromPeers(taskId, false);
    const view = replayLeaseView(this.#ledger, taskId);
    const remote = findRemoteActiveLease(view.leases, this.#replicaId, this.#now());
    return {
      ok: remote === null,
      holder: remote,
      dual_hold: false,
      evidence: null,
      pull,
      observed: observedOf(view),
    };
  }

  async afterAcquire(taskId: string): Promise<LeaseGateDecision> {
    const pull = await this.#pullFromPeers(taskId, true);
    const evidence = detectDualLeaseHold(this.#ledger, taskId, this.#now());
    const view = replayLeaseView(this.#ledger, taskId);
    const observed = observedOf(view);
    if (evidence === null) {
      return { ok: true, holder: null, dual_hold: false, evidence: null, pull, observed };
    }
    const other = findRemoteActiveLease(view.leases, this.#replicaId, this.#now());
    return { ok: false, holder: other, dual_hold: true, evidence, pull, observed };
  }

  async #pullFromPeers(taskId: string, force: boolean): Promise<LeasePullSummary> {
    const sync = this.#sync;
    if (sync === undefined) return { peers: [], pulled: 0, errors: [] };
    const peers = sync.peerIds();
    if (peers.length === 0) return { peers: [], pulled: 0, errors: [] };

    if (!force && this.#pullThrottleMs > 0) {
      const cached = this.#pulls.get(taskId);
      if (cached !== undefined && this.#now().getTime() - cached.at < this.#pullThrottleMs) {
        return cached.promise;
      }
    }
    const promise = this.#pullAll(sync, peers);
    this.#pulls.set(taskId, { at: this.#now().getTime(), promise });
    return promise;
  }

  async #pullAll(sync: SyncEngine, peers: string[]): Promise<LeasePullSummary> {
    let pulled = 0;
    const errors: LeasePullError[] = [];
    // 串行拉取：同一 SyncEngine 的游标/导入不是为并发 peer 设计的（也会放大审计噪声）。
    for (const peer of peers) {
      try {
        for (let page = 0; page < MAX_PULL_PAGES; page++) {
          const batch = await sync.pullFromPeer(peer);
          pulled += batch.accepted;
          if (!batch.has_more) break;
        }
      } catch (err) {
        errors.push({ peer_replica_id: peer, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { peers, pulled, errors };
  }
}

function observedOf(view: { max_granted_token: number; max_reserved_token: number }): {
  granted: number;
  reserved: number;
} {
  return { granted: view.max_granted_token, reserved: view.max_reserved_token };
}
