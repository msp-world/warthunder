/**
 * 《战争雷霆》War Thunder 8111 遥测与本地百科 MSP World（移植自 cortico-world-warthunder）：
 * - 工具：wt_status, wt_hud, wt_search, wt_vehicle
 * - 信号：wt.battle_start, wt.battle_end, wt.hud_event, wt.telemetry
 */
import type { MSPNode } from "../shared/msp.ts";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface WtVehicleEntry {
  name: string;
  aliases: string[];
  nation: string;
  category: string;
  br: string;
  tips: string;
}

const DEFAULT_KB: WtVehicleEntry[] = [
  {
    name: "P-51D-5 Mustang",
    aliases: ["野马", "P-51", "P51", "Mustang"],
    nation: "USA",
    category: "Fighter",
    br: "4.3",
    tips: "高空高速能量战（BnZ），保持速度优势，避免低速与零战/喷火狗斗。",
  },
  {
    name: "T-34-85",
    aliases: ["T34-85", "T-34", "3485"],
    nation: "USSR",
    category: "Medium Tank",
    br: "5.7",
    tips: "机动良好、85mm 装药弹毁伤优秀；首上倾斜装甲注意摆角度，避免正对虎豹远距离对炮。",
  },
  {
    name: "Tiger II (H)",
    aliases: ["虎王", "虎王H", "Tiger II", "King Tiger"],
    nation: "Germany",
    category: "Heavy Tank",
    br: "6.7",
    tips: "长 88 炮穿深与弹道极佳；摆角度时注意炮塔脸颊垂直弱点。",
  },
  {
    name: "Bf 109 G-6",
    aliases: ["109", "Bf109", "G6"],
    nation: "Germany",
    category: "Fighter",
    br: "4.7",
    tips: "优秀爬升率，适合能量压制与垂直机动。",
  },
];

export interface WarThunderConfig {
  baseUrl?: string;
  pollIntervalMs?: number;
}

export class WarThunderWorld {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: FetchImpl;
  private readonly kb: WtVehicleEntry[];
  private node: MSPNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private online = false;
  private inBattle = false;
  private lastEvtId = 0;
  private lastDmgId = 0;
  private lastIndicators: Record<string, unknown> = {};
  private lastState: Record<string, unknown> = {};
  private recentHud: Array<{ id: number; msg: string; kind: "event" | "damage" }> = [];

  constructor(config: WarThunderConfig = {}, fetchImpl?: FetchImpl, kb: WtVehicleEntry[] = DEFAULT_KB) {
    this.baseUrl = (config.baseUrl ?? "http://127.0.0.1:8111").replace(/\/+$/, "");
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
    this.kb = kb;
  }

  attach(node: MSPNode): void {
    this.node = node;
    node.declareSignal("wt.battle_start", "进入战局");
    node.declareSignal("wt.battle_end", "退出战局");
    node.declareSignal("wt.hud_event", "战局击杀/受损/战果消息");
    node.declareSignal("wt.telemetry", "载具遥测快照");

    node.tool(
      "wt_status",
      "读取战争雷霆 8111 遥测连接状态、是否在战局及当前载具/飞行参数",
      async () => {
        await this.pollOnce();
        return {
          online: this.online,
          inBattle: this.inBattle,
          indicators: this.lastIndicators,
          state: this.lastState,
        };
      },
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "wt_hud",
      "读取最近的战争雷霆战局击杀/受损/系统消息",
      (args) => {
        const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 50) : 15;
        return { count: this.recentHud.length, events: this.recentHud.slice(-limit) };
      },
      { type: "object", properties: { limit: { type: "integer", default: 15 } } },
    );

    node.tool(
      "wt_search",
      "在战争雷霆本地百科检索载具或概念",
      (args) => {
        const q = String(args.query ?? "").trim().toLowerCase();
        const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 10) : 5;
        const hits = this.kb
          .filter(
            (v) =>
              v.name.toLowerCase().includes(q) ||
              v.tips.toLowerCase().includes(q) ||
              v.aliases.some((a) => a.toLowerCase().includes(q)),
          )
          .slice(0, limit);
        return { query: q, count: hits.length, results: hits };
      },
      {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" }, limit: { type: "integer", default: 5 } },
      },
    );

    node.tool(
      "wt_vehicle",
      "按名称或别名查询载具完整词条",
      (args) => {
        const name = String(args.name ?? "").trim().toLowerCase();
        const found = this.kb.find(
          (v) => v.name.toLowerCase() === name || v.aliases.some((a) => a.toLowerCase() === name),
        );
        if (!found) throw new Error(`未找到载具: ${args.name}`);
        return { vehicle: found };
      },
      { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    );
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<void> {
    try {
      const [indRes, stateRes, hudRes] = await Promise.all([
        this.fetchImpl(`${this.baseUrl}/indicators`, { signal: AbortSignal.timeout(1500) }),
        this.fetchImpl(`${this.baseUrl}/state`, { signal: AbortSignal.timeout(1500) }),
        this.fetchImpl(`${this.baseUrl}/hudmsg?lastEvt=${this.lastEvtId}&lastDmg=${this.lastDmgId}`, {
          signal: AbortSignal.timeout(1500),
        }),
      ]);
      if (!indRes.ok || !stateRes.ok) throw new Error("8111 not ready");
      const ind = (await indRes.json()) as Record<string, unknown>;
      const st = (await stateRes.json()) as Record<string, unknown>;
      this.online = true;
      this.lastIndicators = ind;
      this.lastState = st;

      const valid = Boolean(ind.valid || st.valid);
      if (valid && !this.inBattle) {
        this.inBattle = true;
        this.node?.publish("wt.battle_start", { type: ind.type ?? null, army: ind.army ?? null });
      } else if (!valid && this.inBattle) {
        this.inBattle = false;
        this.node?.publish("wt.battle_end", {});
      }

      if (valid) {
        this.node?.publish("wt.telemetry", {
          vehicle: ind.type ?? null,
          speedKmh: st["IAS, km/h"] ?? st["TAS, km/h"] ?? null,
          altitudeM: st["H, m"] ?? null,
          throttlePct: st["throttle 1, %"] ?? null,
        });
      }

      if (hudRes.ok) {
        const hud = (await hudRes.json()) as { events?: any[]; damage?: any[] };
        for (const ev of hud.events ?? []) {
          if (typeof ev.id === "number" && ev.id > this.lastEvtId) this.lastEvtId = ev.id;
          const item = { id: Number(ev.id ?? 0), msg: String(ev.msg ?? ""), kind: "event" as const };
          if (item.msg) {
            this.recentHud.push(item);
            this.node?.publish("wt.hud_event", item);
          }
        }
        for (const dmg of hud.damage ?? []) {
          if (typeof dmg.id === "number" && dmg.id > this.lastDmgId) this.lastDmgId = dmg.id;
          const item = { id: Number(dmg.id ?? 0), msg: String(dmg.msg ?? ""), kind: "damage" as const };
          if (item.msg) {
            this.recentHud.push(item);
            this.node?.publish("wt.hud_event", item);
          }
        }
        if (this.recentHud.length > 100) this.recentHud = this.recentHud.slice(-100);
      }
    } catch {
      this.online = false;
      if (this.inBattle) {
        this.inBattle = false;
        this.node?.publish("wt.battle_end", { reason: "telemetry offline" });
      }
    }
  }
}
