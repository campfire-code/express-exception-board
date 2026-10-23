// 快递异常件看板：纯函数部分（读表、快递100 请求与签名、轨迹整理、异常判定、汇总、导出列）。
// 数据来源只有两种：用户自己导出的表格（自带最新状态与更新时间），或用户自己的快递100 企业版授权码调用其官方实时查询接口。不使用任何未授权爬虫。
import { cellText, guessColumn, toTable, type Cell } from './common';

// ---------- 快递公司 ----------
/** 常用快递公司名称到快递100 编码。官方文档只在示例里出现了 yuantong，其余编码按常见写法填写，未逐个核实，以快递100「快递公司编码」文档为准；表里直接写编码（小写字母）也可以。 */
export const CARRIERS: [string, string][] = [
  ['顺丰', 'shunfeng'], ['中通', 'zhongtong'], ['圆通', 'yuantong'], ['申通', 'shentong'], ['韵达', 'yunda'],
  ['极兔', 'jtexpress'], ['邮政', 'youzhengguonei'], ['EMS', 'ems'], ['京东', 'jd'], ['德邦', 'debangwuliu'],
];
/** 官方文档：顺丰、顺丰快运、中通 查询必须带收/寄件人手机号。这里只检查 shunfeng 与 zhongtong（顺丰快运的编码未核实） */
export const NEEDS_PHONE = ['shunfeng', 'zhongtong'];

export function carrierCode(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (/^[a-z][a-z0-9]*$/.test(t)) return t;
  return CARRIERS.find(([n]) => t.toUpperCase().includes(n.toUpperCase()))?.[1] ?? '';
}
export const carrierName = (code: string) => CARRIERS.find(([, c]) => c === code)?.[0] ?? code;

// ---------- 读表 ----------
export interface Shipment {
  num: string; com: string; carrier: string; phone: string; ref: string; shipAt: string;
  /** 表格自带的轨迹（表格模式用） */
  latestStatus: string; latestTime: string; latestContext: string;
}
export interface ReadResult { shipments: Shipment[]; skipped: string[]; hasTrace: boolean; missingCols: string[] }

const COLS = {
  num: [/快递单号|运单号|物流单号|单号/, /tracking|waybill/i],
  carrier: [/快递公司|物流公司|承运|快递名称|^快递$|^物流$/, /carrier|courier/i],
  phone: [/手机|电话|联系方式/, /phone|mobile/i],
  ref: [/订单号|订单编号|备注|订单/, /order|ref/i],
  shipAt: [/发货时间|发货日期|揽收时间|发货/],
  status: [/物流状态|最新状态|快递状态|当前状态|状态/],
  time: [/最后更新|最新时间|更新时间|最近更新|最新轨迹时间|轨迹时间/],
  context: [/最新轨迹|最新动态|轨迹|物流信息|最新物流/],
};

export function readShipments(grid: Cell[][]): ReadResult {
  const t = toTable(grid);
  const idx = Object.fromEntries(Object.entries(COLS).map(([k, re]) => [k, guessColumn(t.header, re as RegExp[])])) as Record<keyof typeof COLS, number>;
  if (idx.num < 0) return { shipments: [], skipped: [], hasTrace: false, missingCols: ['快递单号'] };
  const get = (r: Cell[], k: keyof typeof COLS) => (idx[k] >= 0 ? cellText(r[idx[k]]) : '');
  const out: Shipment[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const r of t.rows) {
    const num = get(r, 'num').replace(/\s+/g, '');
    if (!num) continue;
    if (seen.has(num)) { skipped.push(`${num}（重复）`); continue; }
    seen.add(num);
    const carrier = get(r, 'carrier');
    out.push({ num, com: carrierCode(carrier), carrier, phone: get(r, 'phone').replace(/\s+/g, ''), ref: get(r, 'ref'), shipAt: get(r, 'shipAt'), latestStatus: get(r, 'status'), latestTime: get(r, 'time'), latestContext: get(r, 'context') });
  }
  const hasTrace = idx.status >= 0 || idx.context >= 0;
  return { shipments: out, skipped, hasTrace: hasTrace && idx.time >= 0, missingCols: [] };
}

// ---------- 快递100 请求 ----------
export const QUERY_URL = 'https://poll.kuaidi100.com/poll/query.do';
/** 官方提示：同一单号查询间隔至少半小时、24 小时内不超过 48 次，否则可能被锁 */
export const MIN_INTERVAL_MS = 30 * 60 * 1000;
export interface Credentials { customer: string; key: string }
export const credReady = (c: Credentials) => Boolean(c.customer.trim() && c.key.trim());
export const maskSecret = (s: string) => (!s ? '' : s.length <= 8 ? '••••' : `${s.slice(0, 3)}••••${s.slice(-2)}`);

/** 标准 MD5（快递100 默认签名算法），输出 32 位小写十六进制 */
export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const len = bytes.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, (len * 8) >>> 0, true);
  dv.setUint32(total - 4, Math.floor((len * 8) / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < total; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => dv.getUint32(off + i * 4, true));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return [...out].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 官方规则：sign = MD5(param + key + customer) 转 32 位大写，不加「+」号 */
export const signOf = (param: string, key: string, customer: string) => md5(param + key.trim() + customer.trim()).toUpperCase();

/** resultv2=4：官方文档说明会额外返回高级状态（statusCode，如 202 表示超时未更新） */
export function queryParam(s: Shipment): string {
  return JSON.stringify({ com: s.com, num: s.num, ...(s.phone ? { phone: s.phone } : {}), resultv2: '4' });
}
export function queryBody(s: Shipment, c: Credentials): string {
  const param = queryParam(s);
  return new URLSearchParams({ customer: c.customer.trim(), sign: signOf(param, c.key, c.customer), param }).toString();
}

// ---------- 轨迹 ----------
export interface TracePoint { time: string; context: string; statusCode: string }
export interface Trace { state: number; statusCode: string; points: TracePoint[]; fetchedAt: number; cached?: boolean }

/** 官方基础状态码 */
export const STATE_NAMES: Record<number, string> = { 0: '在途', 1: '揽收', 2: '疑难', 3: '签收', 4: '退签', 5: '派件', 6: '退回', 7: '转投', 8: '清关', 10: '待清关', 11: '清关中', 12: '已清关', 13: '清关异常', 14: '拒签' };
/** 官方高级状态码里属于「疑难」的 201～210 */
export const EXCEPTION_CODES: Record<string, string> = { '201': '签收超时', '202': '超时未更新', '203': '拒收', '204': '派件异常', '205': '柜或站超时未取', '206': '无法联系', '207': '超区', '208': '滞留', '209': '破损', '210': '寄件人取消' };

export class QueryError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export const ERROR_TEXT: Record<string, string> = {
  '400': '未找到该快递公司或账号未开通', '401': '不支持该快递公司，请检查编码', '408': '手机号校验失败（顺丰、中通需要手机号）', '500': '暂时没有查到轨迹，稍后再试，并确认快递公司与单号',
  '501': '服务器错误（也可能是请求格式不对）', '502': '服务器繁忙', '503': '签名验证失败，请检查授权码与 Key', '504': '请求太频繁，请等 24 小时', '601': 'Key 已过期或没有可用单量，需要充值',
};

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** 解析快递100 响应。失败响应形如 {result:false, returnCode, message}（官方文档）。 */
export function parseTrace(json: unknown, now: number): Trace {
  const j = rec(json);
  if (j.result === false || (j.state === undefined && j.returnCode !== undefined)) {
    const code = str(j.returnCode);
    throw new QueryError(code, `${ERROR_TEXT[code] ?? str(j.message) ?? '查询失败'}${code ? `（${code}）` : ''}`);
  }
  const data = Array.isArray(j.data) ? j.data : [];
  const points = data.map((d) => ({ time: str(rec(d).ftime) || str(rec(d).time), context: str(rec(d).context), statusCode: str(rec(d).statusCode) }));
  const state = Number(j.state);
  if (Number.isNaN(state)) throw new QueryError('', `查询失败：${str(j.message) || '返回内容无法识别'}`);
  return { state, statusCode: points[0]?.statusCode ?? '', points, fetchedAt: now };
}

// ---------- 表格模式：从文字推断状态 ----------
export function stateFromText(status: string, context: string): number {
  const t = `${status} ${context}`;
  if (/拒收|拒签/.test(t)) return 14;
  if (/退回|退件|退还|退签/.test(t)) return 6;
  if (/疑难|异常|破损|丢失|滞留|无法联系|超区/.test(t)) return 2;
  if (/签收|已取件|已妥投/.test(t)) return 3;
  if (/派件|派送|投递中/.test(t)) return 5;
  if (/揽收|已收件|已发货/.test(t)) return 1;
  return 0;
}
export function traceFromRow(s: Shipment, now: number): Trace | null {
  if (!s.latestStatus && !s.latestContext) return null;
  return { state: stateFromText(s.latestStatus, s.latestContext), statusCode: '', points: [{ time: s.latestTime, context: s.latestContext || s.latestStatus, statusCode: '' }], fetchedAt: now };
}

// ---------- 判定 ----------
export type Category = 'return' | 'refused' | 'exception' | 'stagnant' | 'notrace' | 'normal' | 'delivered' | 'error';
export const CATEGORY_LABEL: Record<Category, string> = { return: '退回件', refused: '拒收', exception: '疑难件', stagnant: '停滞件', notrace: '暂无轨迹', normal: '运输中', delivered: '已签收', error: '查询失败' };
export const ALERT_CATEGORIES: Category[] = ['return', 'refused', 'exception', 'stagnant', 'notrace'];
export interface Opts { stagnantHours: number }
export const DEFAULT_OPTS: Opts = { stagnantHours: 48 };

/** 解析 "2026-10-20 10:00:00"（快递100 返回的本地时间格式）或 ISO；失败返回 NaN */
export function parseTime(s: string): number {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s.trim());
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime();
}

export interface Verdict { category: Category; label: string; reason: string; idleHours: number | null; stateText: string; lastTime: string; lastContext: string }

export function judge(s: Shipment, trace: Trace | null, err: string | null, now: number, o: Opts): Verdict {
  const base = { idleHours: null as number | null, stateText: '', lastTime: '', lastContext: '' };
  const mk = (category: Category, reason: string, extra: Partial<Verdict> = {}): Verdict => ({ ...base, category, label: CATEGORY_LABEL[category], reason, ...extra });
  if (err) return mk('error', err);
  if (!trace || !trace.points.length) {
    const shipped = parseTime(s.shipAt);
    const hours = Number.isNaN(shipped) ? null : (now - shipped) / 3_600_000;
    if (hours !== null && hours > o.stagnantHours) return mk('notrace', `发货 ${Math.floor(hours)} 小时仍没有物流轨迹`, { idleHours: Math.floor(hours) });
    return mk('normal', '暂无轨迹（发货时间未超过阈值，或表里没有发货时间）');
  }
  const last = trace.points[0];
  const t = parseTime(last.time);
  const idle = Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 3_600_000));
  const common = { idleHours: idle, stateText: STATE_NAMES[trace.state] ?? `状态${trace.state}`, lastTime: last.time, lastContext: last.context };
  const code = trace.statusCode;
  if (trace.state === 3) return mk('delivered', '已签收', common);
  if (trace.state === 14 || code === '203') return mk('refused', '收件人拒收', common);
  if (trace.state === 4 || trace.state === 6 || /退回|退件|退还发件/.test(last.context)) return mk('return', trace.state === 4 ? '退件已签收' : '包裹被退回', common);
  if (trace.state === 2 || trace.state === 13) {
    if (code === '202') return mk('stagnant', '快递100 判定超时未更新', common);
    return mk('exception', EXCEPTION_CODES[code] ? `疑难：${EXCEPTION_CODES[code]}` : trace.state === 13 ? '清关异常' : '快递公司标记为疑难件', common);
  }
  if (code === '202') return mk('stagnant', '快递100 判定超时未更新', common);
  if (idle !== null && idle >= o.stagnantHours) return mk('stagnant', `已 ${idle} 小时没有新轨迹（阈值 ${o.stagnantHours} 小时）`, common);
  if (idle === null) return mk('normal', '轨迹时间无法识别，未判断停滞', common);
  return mk('normal', `最近 ${idle} 小时内有更新`, common);
}

export interface BoardRow { s: Shipment; v: Verdict }
export function summarize(rows: BoardRow[]) {
  const count = (c: Category) => rows.filter((r) => r.v.category === c).length;
  return { total: rows.length, alerts: rows.filter((r) => ALERT_CATEGORIES.includes(r.v.category)).length, return: count('return') + count('refused'), exception: count('exception'), stagnant: count('stagnant') + count('notrace'), delivered: count('delivered'), error: count('error') };
}
const RANK: Record<Category, number> = { return: 0, refused: 1, exception: 2, stagnant: 3, notrace: 4, error: 5, normal: 6, delivered: 7 };
export const sortRows = (rows: BoardRow[]) => [...rows].sort((a, b) => RANK[a.v.category] - RANK[b.v.category] || (b.v.idleHours ?? -1) - (a.v.idleHours ?? -1));

/** 复制给同事的异常清单文本 */
export function alertText(rows: BoardRow[]): string {
  return rows.filter((r) => ALERT_CATEGORIES.includes(r.v.category)).map((r) => `${r.v.label}｜${r.s.carrier || r.s.com} ${r.s.num}${r.s.ref ? `｜${r.s.ref}` : ''}｜${r.v.reason}`).join('\n');
}

export const EXPORT_COLS: [string, number][] = [['单号', 18], ['快递公司', 10], ['订单号/备注', 18], ['异常类型', 10], ['原因', 34], ['最新状态', 10], ['最近更新时间', 18], ['已停滞小时', 10], ['最新轨迹', 50]];
export const exportRow = (r: BoardRow): Cell[] => [r.s.num, r.s.carrier || r.s.com, r.s.ref, r.v.label, r.v.reason, r.v.stateText, r.v.lastTime, r.v.idleHours, r.v.lastContext];

export function exportFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `快递异常件-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.xlsx`;
}
