// 截图与演示用的示例数据：单号、订单号、轨迹文字都是虚构的「示例」，时间相对「现在」生成。
import type { Cell } from './common';

export const SAMPLE_HEADER = ['快递单号', '快递公司', '订单号/备注', '发货时间', '物流状态', '最后更新时间', '最新轨迹'];
const fmt = (t: number) => { const d = new Date(t); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`; };

export function sampleGrid(now: number): Cell[][] {
  const h = (n: number) => fmt(now - n * 3_600_000);
  const PREFIX: Record<string, string> = { 圆通: 'YT', 中通: 'ZT', 韵达: 'YD', 申通: 'STO', 极兔: 'JT' };
  const row = (i: number, carrier: string, ref: string, shipH: number, st: string, updH: number | null, ctx: string): Cell[] =>
    [`${PREFIX[carrier]}7301240${String(i).padStart(3, '0')}`, carrier, ref, h(shipH), st, updH == null ? '' : h(updH), ctx];
  return [SAMPLE_HEADER,
    row(1, '圆通', '订单-231024001', 30, '运输中', 5, '包裹已到达【杭州转运中心】'),
    row(2, '中通', '订单-231024002', 120, '运输中', 76, '包裹已离开【义乌分拨中心】'),
    row(3, '韵达', '订单-231024003', 96, '运输中', 60, '包裹已到达【广州分拨中心】'),
    row(4, '申通', '订单-231024004', 90, '退回', 12, '快件已退回发件人'),
    row(5, '圆通', '订单-231024005', 70, '疑难', 6, '派件异常，无法联系收件人'),
    row(6, '极兔', '订单-231024006', 50, '拒收', 20, '收件人拒收'),
    row(7, '圆通', '订单-231024007', 60, '已签收', 8, '已签收'),
    row(8, '韵达', '订单-231024008', 80, '已签收', 30, '已签收'),
    row(9, '中通', '订单-231024009', 100, '运输中', 110, '快件已揽收'),
    row(10, '申通', '订单-231024010', 4, '派件', 2, '派件员正在派送'),
    row(11, '圆通', '订单-231024011', 60, '', null, ''),
    row(12, '极兔', '订单-231024012', 40, '运输中', 18, '包裹已到达【成都转运中心】'),
  ];
}
