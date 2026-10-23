import { describe, expect, it } from 'vitest';
import { exportBoard, runBoard, validate, GAP_MS, type Io } from './flow';
import { guard, MAX_PER_DAY, type Cache, type Clock, type Fetcher, type FetchRes } from './api';
import { parseTrace, readShipments, signOf, type Shipment } from './core';
import { sampleGrid } from './samples';
import { readSheets } from './xlsx';
import { readFileSync } from 'node:fs';
import { parseCsv } from './common';
import transit from './fixtures/kd-transit.json';
import signed from './fixtures/kd-signed.json';
import ret from './fixtures/kd-return.json';
import e503 from './fixtures/kd-error-503.json';
import e500 from './fixtures/kd-error-500.json';

const NOW = new Date(2026, 9, 23, 12, 0).getTime();
const cred = { customer: 'TEST-CUSTOMER', key: 'TEST-KEY' };
const opts = { stagnantHours: 48 };
const ship = (num: string, o: Partial<Shipment> = {}): Shipment => ({ num, com: 'yuantong', carrier: '圆通', phone: '', ref: '', shipAt: '', latestStatus: '', latestTime: '', latestContext: '', ...o });
const res = (body: unknown, status = 200): FetchRes => ({ status, text: async () => JSON.stringify(body) });
const clock = () => { let t = NOW; const sleeps: number[] = []; const c: Clock = { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } }; return { c, sleeps }; };
type Call = { url: string; body: URLSearchParams };
function fake(map: Record<string, unknown>) {
  const calls: Call[] = [];
  const f: Fetcher = async (url, init) => {
    const body = new URLSearchParams(init.body);
    calls.push({ url, body });
    const num = JSON.parse(body.get('param')!).num as string;
    return res(map[num] ?? e500);
  };
  return { f, calls };
}
const memIo = () => { const files = new Map<string, Uint8Array>(); const io: Io = { mkdir: async () => {}, join: async (...p) => p.join('/'), writeFile: async (p, d) => { files.set(p, d); } }; return { io, files }; };

describe('接口模式', () => {
  it('逐单查询：请求地址、签名正确，结果按严重程度排序', async () => {
    const { f, calls } = fake({ A: transit, B: signed, C: ret });
    const { c, sleeps } = clock();
    const r = await runBoard({ mode: 'api', shipments: [ship('A'), ship('B'), ship('C')], cred, fetcher: f, cache: {}, opts, clock: c });
    expect(calls[0].url).toBe('https://poll.kuaidi100.com/poll/query.do');
    expect(calls[0].body.get('sign')).toBe(signOf(calls[0].body.get('param')!, 'TEST-KEY', 'TEST-CUSTOMER'));
    expect(r.rows.map((x) => [x.s.num, x.v.category])).toEqual([['C', 'return'], ['A', 'stagnant'], ['B', 'delivered']]);
    expect(sleeps).toEqual([GAP_MS, GAP_MS]);
    expect(Object.keys(r.cache)).toEqual(['A', 'B', 'C']);
  });
  it('频率保护：30 分钟内再查，沿用缓存不发请求', async () => {
    const { f, calls } = fake({ A: transit });
    const { c } = clock();
    const first = await runBoard({ mode: 'api', shipments: [ship('A')], cred, fetcher: f, cache: {}, opts, clock: c });
    const second = await runBoard({ mode: 'api', shipments: [ship('A')], cred, fetcher: f, cache: first.cache, opts, clock: c });
    expect(calls).toHaveLength(1);
    expect(second.rows[0].v.reason).toContain('沿用本机缓存');
  });
  it('频率保护：没有缓存时给出原因，不发请求', async () => {
    const { f, calls } = fake({});
    const cache: Cache = { A: { times: [NOW - 10 * 60000] } };
    const r = await runBoard({ mode: 'api', shipments: [ship('A')], cred, fetcher: f, cache, opts, clock: clock().c });
    expect(calls).toHaveLength(0);
    expect(r.rows[0].v.category).toBe('error');
    expect(r.rows[0].v.reason).toContain('30 分钟');
  });
  it('guard：满 48 次或超过 24 小时的记录', () => {
    expect(guard({ times: Array.from({ length: MAX_PER_DAY }, (_, i) => NOW - (40 + i) * 60000) }, NOW).allow).toBe(false);
    expect(guard({ times: [NOW - 25 * 3_600_000] }, NOW).allow).toBe(true);
    expect(guard(undefined, NOW).allow).toBe(true);
  });
  it('顺丰缺手机号、无法识别快递公司：不发请求', async () => {
    const { f, calls } = fake({});
    const r = await runBoard({ mode: 'api', shipments: [ship('S', { com: 'shunfeng', carrier: '顺丰' }), ship('U', { com: '', carrier: '某物流' })], cred, fetcher: f, cache: {}, opts, clock: clock().c });
    expect(calls).toHaveLength(0);
    expect(r.rows.map((x) => x.v.reason).join('|')).toContain('手机号');
    expect(r.rows.map((x) => x.v.reason).join('|')).toContain('无法识别快递公司');
  });
  it('单号查不到只标记该单；签名错误 503 中止后续', async () => {
    const { f, calls } = fake({ A: e500, B: e503, C: transit });
    const r = await runBoard({ mode: 'api', shipments: [ship('A'), ship('B'), ship('C')], cred, fetcher: f, cache: {}, opts, clock: clock().c });
    expect(calls).toHaveLength(2);
    expect(r.stoppedEarly).toContain('签名验证失败');
    expect(r.rows.filter((x) => x.v.category === 'error')).toHaveLength(3);
    expect(r.rows.find((x) => x.s.num === 'C')!.v.reason).toContain('已中止');
  });
  it('HTTP 非 200 记为失败', async () => {
    const f: Fetcher = async () => res({}, 502);
    const r = await runBoard({ mode: 'api', shipments: [ship('A')], cred, fetcher: f, cache: {}, opts, clock: clock().c });
    expect(r.rows[0].v.reason).toContain('HTTP 502');
  });
  it('停止', async () => {
    const ac = new AbortController(); ac.abort();
    await expect(runBoard({ mode: 'api', shipments: [ship('A')], cred, fetcher: fake({}).f, cache: {}, opts, clock: clock().c, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('校验', () => {
    expect(validate('table', [], cred, false)).toContain('导入表格');
    expect(validate('api', [ship('A')], { customer: '', key: '' }, false)).toContain('授权码');
    expect(validate('api', [ship('A')], { customer: '', key: '' }, true)).toBeNull();
    expect(validate('table', [ship('A')], { customer: '', key: '' }, false)).toBeNull();
  });
});

describe('表格模式与导出', () => {
  it('示例表：不联网，分类固定，并导出三个工作表', async () => {
    const shipments = readShipments(sampleGrid(NOW)).shipments;
    const r = await runBoard({ mode: 'table', shipments, cred, cache: {}, opts, clock: clock().c });
    expect(r.rows.map((x) => x.v.category).slice(0, 7)).toEqual(['return', 'refused', 'exception', 'stagnant', 'stagnant', 'stagnant', 'notrace']);
    const { io, files } = memIo();
    const path = await exportBoard(r.rows, io, '/out', new Date(2026, 9, 23, 9, 5), [['数据来源', '示例']]);
    expect(path).toBe('/out/快递异常件-20261023-0905.xlsx');
    const sheets = await readSheets(files.get(path)!, 'x.xlsx');
    expect(sheets.map((s) => s.name)).toEqual(['异常件', '全部', '说明']);
    expect(sheets[0].grid).toHaveLength(8);
    expect(sheets[1].grid).toHaveLength(13);
    expect(sheets[0].grid[0][3]).toBe('异常类型');
  });
  it('解析函数与流程用同一份轨迹', () => expect(parseTrace(transit, NOW).points).toHaveLength(2));
  it('samples 里的验收文件：带轨迹表的分类与 README 一致，无轨迹表识别为需要接口', async () => {
    const grid = (f: string) => parseCsv(readFileSync(new URL(`../../samples/${f}`, import.meta.url), 'utf8'));
    const a = readShipments(grid('运单表-带轨迹.csv'));
    expect(a.hasTrace).toBe(true);
    const r = await runBoard({ mode: 'table', shipments: a.shipments, cred, cache: {}, opts, clock: clock().c });
    expect(r.rows.map((x) => `${x.s.num}:${x.v.category}`)).toEqual(['SAMPLE000003:return', 'SAMPLE000005:refused', 'SAMPLE000004:exception', 'SAMPLE000002:stagnant', 'SAMPLE000007:notrace', 'SAMPLE000001:normal', 'SAMPLE000006:delivered']);
    const b = readShipments(grid('运单表-无轨迹.csv'));
    expect(b.hasTrace).toBe(false);
    expect(b.shipments).toHaveLength(4);
  });
});
