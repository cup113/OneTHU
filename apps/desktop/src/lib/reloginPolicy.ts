/**
 * 无效重登治理（2026-11-02 会话自愈专项）。
 *
 * 背景：会话死亡后「谁来重登」修好了（探针封闭世界判定 + 有闸门的重登链），
 * 但登录链成功 ≠ 服务可用——学校维护期 id 认证照常、info 域铸不出会话，
 * 此时每个触发源都会再走一次完整登录：20s 一次、无上限，账密重放就变成风暴，
 * 还可能撞进风控。本模块只管这一件事：
 *
 *   连续 2 次无效 → 退避 30s / 60s / … / 10min（与 libSoftRelogin 同曲线）
 *   连续 3 次无效 → 开路，停止自动重放，落回「请重新登录」的诚实终态
 *   一次明确的完整登录（人工登录、启动静默重登）→ reset()，用户意图优先
 *
 * 纯计算、零依赖、clock 可注入——策略本身可以直接在 node 里断言。
 */

/** 闸门结论。冷却（loginGate 的 20s）由调用方另查，不在本策略里重复建模。 */
export type ReloginGate = { allowed: true } | { allowed: false; reason: "breaker" | "backoff" };

export interface ReloginPolicyOptions {
  /** 首次退避阶梯的基准（第 2 次无效时生效） */
  baseMs?: number;
  /** 退避上限 */
  capMs?: number;
  /** 连续无效到这个次数就开路 */
  openAt?: number;
}

export class ReloginPolicy {
  /** 确认无效的登录次数（门户探针判死）——只有它能开熔断 */
  #ineffective = 0;
  /** 结论不明的登录次数（服务错误/陌生页面）——只进退避，永不开熔断 */
  #indeterminate = 0;
  #nextAt = 0;
  #open = false;
  readonly #baseMs: number;
  readonly #capMs: number;
  readonly #openAt: number;

  constructor(options: ReloginPolicyOptions = {}) {
    this.#baseMs = options.baseMs ?? 30_000;
    this.#capMs = options.capMs ?? 10 * 60_000;
    this.#openAt = options.openAt ?? 3;
  }

  get ineffective(): number {
    return this.#ineffective;
  }

  get indeterminate(): number {
    return this.#indeterminate;
  }

  get open(): boolean {
    return this.#open;
  }

  get nextAt(): number {
    return this.#nextAt;
  }

  /** 现在能不能再走一条登录链（调用方还要自己查 loginGate 的 20s 硬冷却）。 */
  gate(now: number = Date.now()): ReloginGate {
    if (this.#open) return { allowed: false, reason: "breaker" };
    if (now < this.#nextAt) return { allowed: false, reason: "backoff" };
    return { allowed: true };
  }

  /** 退避阶梯位置：确认无效与结论不明都算——两种都说明「刚发的凭据没换来可用会话」。 */
  #ladder(now: number): void {
    const position = this.#ineffective + this.#indeterminate;
    if (position >= 2) {
      this.#nextAt = now + Math.min(this.#baseMs * 2 ** (position - 2), this.#capMs);
    }
  }

  /** 登录链成功但门户探针判死：记一次无效，必要时开退避或开路。 */
  noteIneffective(now: number = Date.now()): ReloginGate {
    this.#ineffective += 1;
    this.#ladder(now);
    if (this.#ineffective >= this.#openAt) this.#open = true;
    return this.gate(now);
  }

  /** 登录链成功但结论不明（5xx / 陌生页面 / 断网）：进退避，不开熔断。
   *  不开熔断是刻意的——结论不明不构成「重放凭据没用」的证据，但反复重放同样
   *  没有意义，所以用退避把节奏压下来。 */
  noteIndeterminate(now: number = Date.now()): ReloginGate {
    this.#indeterminate += 1;
    this.#ladder(now);
    return this.gate(now);
  }

  /** 探针证明有效：清零（不进退避，也不动熔断——熔断只由 reset 关）。 */
  noteEffective(): void {
    this.#ineffective = 0;
    this.#indeterminate = 0;
    this.#nextAt = 0;
  }

  /** 一次明确的完整登录成功：用户新意图优先，全部复位。 */
  reset(): void {
    this.#ineffective = 0;
    this.#indeterminate = 0;
    this.#nextAt = 0;
    this.#open = false;
  }
}
