import { describe, expect, it } from 'vitest';
import { alertText, carrierCode, credReady, DEFAULT_OPTS, exportFileName, judge, md5, parseTime, parseTrace, queryBody, queryParam, readShipments, signOf, stateFromText, summarize, traceFromRow, QueryError, type Shipment } from './core';
import { sampleGrid } from './samples';
import transit from './fixtures/kd-transit.json';
import fresh from './fixtures/kd-fresh.json';
import signed from './fixtures/kd-signed.json';
import ret from './fixtures/kd-return.json';
import exc from './fixtures/kd-exception.json';
import e503 from './fixtures/kd-error-503.json';
import e500 from './fixtures/kd-error-500.json';

const NOW = new Date(2026, 9, 23, 12, 0).getTime();
const ship = (o: Partial<Shipment> = {}): Shipment => ({ num: 'DEMO0000001', com: 'yuantong', carrier: '圆通', phone: '', ref: '', shipAt: '', latestStatus: '', latestTime: '', latestContext: '', ...o });

describe('MD5 与签名', () => {
  it('标准测试向量', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
    expect(md5('1234567890'.repeat(8))).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });
  it('中文按 UTF-8 计算', () => expect(md5('你好')).toBe('7eca689f0d3389d9dea66ae112e5cfd7'));
  it('签名 = MD5(param + key + customer) 转大写 32 位', () => {
    const s = signOf('{"com":"yuantong","num":"X"}', ' KEY ', ' CUST ');
    expect(s).toMatch(/^[0-9A-F]{32}$/);
    expect(s).toBe(md5('{"com":"yuantong","num":"X"}KEYCUST').toUpperCase());
  });
  it('请求体含 customer、sign、param，带手机号时写入 param', () => {
    const p = JSON.parse(queryParam(ship({ com: 'shunfeng', phone: '13800000000' })));
    expect(p).toEqual({ com: 'shunfeng', num: 'DEMO0000001', phone: '13800000000', resultv2: '4' });
    const body = new URLSearchParams(queryBody(ship(), { customer: 'C', key: 'K' }));
    expect(body.get('customer')).toBe('C');
    expect(body.get('sign')).toBe(signOf(body.get('param')!, 'K', 'C'));
  });
  it('授权码检查', () => { expect(credReady({ customer: '', key: 'k' })).toBe(false); expect(credReady({ customer: 'c', key: 'k' })).toBe(true); });
});

describe('读表', () => {
  it('按表头猜列、去重、识别快递公司', () => {
    const r = readShipments([['运单号', '快递公司', '手机号', '订单编号'], ['A1', '圆通速递', '138', 'O1'], ['A1', '圆通', '', ''], ['A2', 'zhongtong', '', ''], [null, '', '', '']]);
    expect(r.shipments.map((s) => [s.num, s.com])).toEqual([['A1', 'yuantong'], ['A2', 'zhongtong']]);
    expect(r.skipped).toEqual(['A1（重复）']);
    expect(r.hasTrace).toBe(false);
    expect(r.shipments[0]).toMatchObject({ phone: '138', ref: 'O1' });
  });
  it('没有单号列', () => expect(readShipments([['姓名'], ['x']]).missingCols).toEqual(['快递单号']));
  it('示例表带轨迹列', () => {
    const r = readShipments(sampleGrid(NOW));
    expect(r.shipments).toHaveLength(12);
    expect(r.hasTrace).toBe(true);
  });
  it('快递公司编码', () => { expect(carrierCode('顺丰速运')).toBe('shunfeng'); expect(carrierCode('yuantong')).toBe('yuantong'); expect(carrierCode('某某物流')).toBe(''); expect(carrierCode('')).toBe(''); });
});

describe('解析快递100 响应', () => {
  it('正常响应：状态、最新轨迹在前', () => {
    const t = parseTrace(transit, NOW);
    expect(t.state).toBe(0);
    expect(t.points[0]).toMatchObject({ time: '2026-10-20 08:00:00', statusCode: '1002' });
  });
  it('失败响应抛出带说明的错误', () => {
    expect(() => parseTrace(e503, NOW)).toThrow('签名验证失败');
    try { parseTrace(e500, NOW); } catch (e) { expect(e).toBeInstanceOf(QueryError); expect((e as QueryError).code).toBe('500'); }
  });
  it('无法识别的内容', () => expect(() => parseTrace({ foo: 1 }, NOW)).toThrow('无法识别'));
});

describe('判定', () => {
  const j = (json: unknown, s = ship()) => judge(s, parseTrace(json, NOW), null, NOW, DEFAULT_OPTS);
  it('停滞：最近轨迹 76 小时前，阈值 48', () => {
    const v = j(transit);
    expect(v.category).toBe('stagnant');
    expect(v.idleHours).toBe(76);
  });
  it('阈值可调：阈值 100 小时则正常', () => expect(judge(ship(), parseTrace(transit, NOW), null, NOW, { stagnantHours: 100 }).category).toBe('normal'));
  it('派件中且刚更新 = 正常', () => expect(j(fresh).category).toBe('normal'));
  it('签收、退回、疑难', () => {
    expect(j(signed).category).toBe('delivered');
    expect(j(ret).category).toBe('return');
    const v = j(exc);
    expect(v.category).toBe('exception');
    expect(v.reason).toContain('无法联系');
  });
  it('statusCode 202 判停滞，203 判拒收', () => {
    const t = (code: string, state: number) => ({ state, statusCode: code, fetchedAt: NOW, points: [{ time: '2026-10-23 10:00:00', context: '', statusCode: code }] });
    expect(judge(ship(), t('202', 2), null, NOW, DEFAULT_OPTS).category).toBe('stagnant');
    expect(judge(ship(), t('203', 2), null, NOW, DEFAULT_OPTS).category).toBe('refused');
    expect(judge(ship(), t('', 14), null, NOW, DEFAULT_OPTS).category).toBe('refused');
  });
  it('轨迹文字含「退回」也判退回', () => {
    const t = { state: 0, statusCode: '', fetchedAt: NOW, points: [{ time: '2026-10-23 10:00:00', context: '快件退回发件人', statusCode: '' }] };
    expect(judge(ship(), t, null, NOW, DEFAULT_OPTS).category).toBe('return');
  });
  it('无轨迹：发货超过阈值才报', () => {
    expect(judge(ship({ shipAt: '2026-10-20 12:00:00' }), null, null, NOW, DEFAULT_OPTS).category).toBe('notrace');
    expect(judge(ship({ shipAt: '2026-10-23 08:00:00' }), null, null, NOW, DEFAULT_OPTS).category).toBe('normal');
    expect(judge(ship(), null, null, NOW, DEFAULT_OPTS).category).toBe('normal');
  });
  it('查询失败', () => expect(judge(ship(), null, '签名验证失败', NOW, DEFAULT_OPTS).category).toBe('error'));
  it('时间解析与文字推断', () => {
    expect(parseTime('2026-10-23 12:00:00')).toBe(NOW);
    expect(Number.isNaN(parseTime('昨天'))).toBe(true);
    expect([['已签收', ''], ['', '快件退回'], ['拒收', ''], ['疑难', ''], ['', '派件员正在派送'], ['运输中', '到达']].map(([a, b]) => stateFromText(a, b))).toEqual([3, 6, 14, 2, 5, 0]);
    expect(traceFromRow(ship(), NOW)).toBeNull();
  });
});

describe('汇总与清单', () => {
  it('示例表的分类数量固定', () => {
    const rows = readShipments(sampleGrid(NOW)).shipments.map((s) => ({ s, v: judge(s, traceFromRow(s, NOW), null, NOW, DEFAULT_OPTS) }));
    expect(summarize(rows)).toEqual({ total: 12, alerts: 7, return: 2, exception: 1, stagnant: 4, delivered: 2, error: 0 });
    expect(alertText(rows).split('\n')).toHaveLength(7);
    expect(alertText(rows)).toContain('退回件｜申通 SAMPLE000004｜示例订单-004');
  });
  it('导出文件名', () => expect(exportFileName(new Date(2026, 9, 23, 9, 5))).toBe('快递异常件-20261023-0905.xlsx'));
});
