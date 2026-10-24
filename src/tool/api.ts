// 快递100 实时查询客户端（官方接口，需用户自己的企业版授权码）与「同一单号查询频率」保护。网络与时钟由外部注入。
import { MIN_INTERVAL_MS, NEEDS_PHONE, QUERY_URL, QueryError, ERROR_TEXT, parseTrace, queryBody, type Credentials, type Shipment, type Trace } from './core';

export interface FetchRes { status: number; text(): Promise<string> }
export type Fetcher = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<FetchRes>;
export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export const abortError = () => Object.assign(new Error('已停止'), { name: 'AbortError' });
export const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';
export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((res, rej) => {
    if (signal?.aborted) return rej(abortError());
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(abortError()); }, { once: true });
  }),
};

/** 本机查询记录：每个单号最近 24 小时的查询时间与最后一次结果，用来遵守官方频率提示 */
export interface CacheEntry { times: number[]; trace?: Trace }
export type Cache = Record<string, CacheEntry>;
/** 官方文档：24 小时内同一单号不超过 48 次 */
export const MAX_PER_DAY = 48;

export type Guard = { allow: true } | { allow: false; reason: string };
export function guard(entry: CacheEntry | undefined, now: number): Guard {
  const recent = (entry?.times ?? []).filter((t) => now - t < 24 * 3_600_000);
  if (recent.length >= MAX_PER_DAY) return { allow: false, reason: `24 小时内已查询 ${recent.length} 次，达到官方提示的上限` };
  const last = Math.max(0, ...recent);
  if (last && now - last < MIN_INTERVAL_MS) return { allow: false, reason: `距上次查询不足 30 分钟（${Math.ceil((now - last) / 60000)} 分钟前）` };
  return { allow: true };
}

export function checkReady(s: Shipment): string | null {
  // check-zh: 忽略（快递公司编码示例，用户在表里需要写成这种编码）
  if (!s.com) return `无法识别快递公司「${s.carrier || '空'}」，请改成快递100 的编码（如 yuantong）`;
  if (NEEDS_PHONE.includes(s.com) && !s.phone) return '顺丰、中通查询必须提供手机号（官方要求），表里没有手机号列';
  return null;
}

export async function queryOne(s: Shipment, cred: Credentials, fetcher: Fetcher, now: number, signal?: AbortSignal): Promise<Trace> {
  const res = await fetcher(QUERY_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: queryBody(s, cred), signal });
  const text = await res.text();
  if (res.status !== 200) throw new QueryError(String(res.status), `请求失败（HTTP ${res.status}）`);
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new QueryError('', '快递100 返回的内容不是 JSON'); }
  return parseTrace(json, now);
}
export const isFatal = (e: unknown) => e instanceof QueryError && ['503', '504', '601'].includes(e.code);
export const errorText = (code: string) => ERROR_TEXT[code];
