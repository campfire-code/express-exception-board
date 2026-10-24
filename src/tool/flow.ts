// 看板流程：读表 → （接口模式）逐单查询 → 判定 → 汇总 / 导出。文件读写与网络由外部注入。
import { checkReady, guard, isAbort, isFatal, queryOne, realClock, abortError, type Cache, type Clock, type Fetcher } from './api';
import { EXPORT_COLS, credReady, exportFileName, exportRow, judge, sortRows, traceFromRow, QueryError, type BoardRow, type Credentials, type Opts, type Shipment, type Trace } from './core';
import { writeXlsx } from './xlsx';

export type Mode = 'table' | 'api';
export interface Io {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  join(...parts: string[]): Promise<string>;
}
/** 两次请求之间的间隔：本工具的保守取值，官方文档没有给出每秒请求数限制（未核实） */
export const GAP_MS = 300;

export function validate(mode: Mode, shipments: Shipment[], cred: Credentials, demo: boolean): string | null {
  if (!shipments.length) return '请先导入表格（需要有「快递单号」列）';
  if (mode === 'api' && !demo && !credReady(cred)) return '接口模式需要填写快递100 的授权码和授权 Key';
  return null;
}

export interface RunResult { rows: BoardRow[]; cache: Cache; stoppedEarly: string }

export async function runBoard(a: {
  mode: Mode; shipments: Shipment[]; cred: Credentials; fetcher?: Fetcher; cache: Cache; opts: Opts; clock?: Clock;
  progress?: (done: number, total: number) => void; signal?: AbortSignal;
}): Promise<RunResult> {
  const clock = a.clock ?? realClock;
  const rows: BoardRow[] = [];
  const cache: Cache = { ...a.cache };
  let stopped = '';
  for (let i = 0; i < a.shipments.length; i++) {
    if (a.signal?.aborted) throw abortError();
    a.progress?.(i, a.shipments.length);
    const s = a.shipments[i];
    const now = clock.now();
    let trace: Trace | null = null;
    let err: string | null = null;
    if (a.mode === 'table') {
      trace = traceFromRow(s, now);
    } else if (stopped) {
      err = `已中止：${stopped}`;
    } else {
      err = checkReady(s);
      if (!err) {
        const g = guard(cache[s.num], now);
        if (!g.allow) {
          const cached = cache[s.num]?.trace;
          if (cached) trace = { ...cached, cached: true }; else err = g.reason;
        } else {
          try {
            trace = await queryOne(s, a.cred, a.fetcher!, now, a.signal);
            const prev = cache[s.num];
            cache[s.num] = { times: [...(prev?.times ?? []).filter((t) => now - t < 24 * 3_600_000), now], trace };
          } catch (e) {
            if (isAbort(e)) throw e;
            err = e instanceof Error ? e.message : String(e);
            if (isFatal(e)) stopped = err;
          }
          if (i < a.shipments.length - 1) await clock.sleep(GAP_MS, a.signal);
        }
      }
    }
    const v = judge(s, trace, err, now, a.opts);
    if (trace?.cached) v.reason += '（沿用本机缓存的上次结果，未重新查询）';
    rows.push({ s, v });
  }
  a.progress?.(a.shipments.length, a.shipments.length);
  return { rows: sortRows(rows), cache, stoppedEarly: stopped };
}

export async function exportBoard(rows: BoardRow[], io: Io, outDir: string, now: Date, info: [string, string][]): Promise<string> {
  const header = EXPORT_COLS.map((c) => c[0]);
  const alerts = rows.filter((r) => !['normal', 'delivered'].includes(r.v.category));
  const bytes = await writeXlsx([
    { name: '异常件', header, rows: alerts.map(exportRow) },
    { name: '全部', header, rows: rows.map(exportRow) },
    { name: '说明', header: ['项目', '内容'], rows: info },
  ]);
  await io.mkdir(outDir);
  const path = await io.join(outDir, exportFileName(now));
  await io.writeFile(path, bytes);
  return path;
}
export { QueryError };
