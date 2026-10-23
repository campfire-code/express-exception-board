// Excel / CSV 读写：基于 exceljs（MIT）。读出来统一成二维数组；写出时加粗表头、冻结首行、按内容估算列宽、按列设置数字格式。
import ExcelJS from 'exceljs';
import { decodeText, numeric, parseCsv, type Cell } from './common';

export interface Sheet {
  name: string;
  grid: Cell[][];
}

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v == null) return null;
  if (v instanceof Date || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    if ('error' in v) return null;
  }
  return String(v);
}

export async function readSheets(bytes: Uint8Array, fileName: string): Promise<Sheet[]> {
  if (/\.(csv|txt)$/i.test(fileName)) return [{ name: 'Sheet1', grid: parseCsv(decodeText(bytes)).map((r, i) => (i === 0 ? r : r.map(numeric))) }];
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch {
    throw new Error('无法读取这个 Excel 文件，可能已损坏或不是 .xlsx 格式');
  }
  const out: Sheet[] = [];
  wb.eachSheet((ws) => {
    if (ws.state !== 'visible') return;
    const grid: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals = row.values as ExcelJS.CellValue[];
      grid[n - 1] = vals.slice(1).map(cellValue);
    });
    for (let i = 0; i < grid.length; i++) grid[i] ??= [];
    out.push({ name: ws.name, grid });
  });
  return out;
}

/** 列格式：money 两位小数，pct 百分比，int 整数，text 文本 */
export type ColFmt = 'money' | 'pct' | 'int' | 'text';
export interface OutSheet {
  name: string;
  header: string[];
  rows: Cell[][];
  formats?: ColFmt[];
  /** 按行设置数字格式（用于「项目 / 数值」这种竖排表） */
  rowFormats?: (ColFmt | undefined)[];
  /** 最后一行加粗（合计行） */
  boldLast?: boolean;
}

const NUMFMT: Record<ColFmt, string | undefined> = { money: '#,##0.00', pct: '0.0%', int: '0', text: '@' };
const width = (v: Cell) => (v == null ? 0 : v instanceof Date ? 18 : [...String(v)].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0));

export async function writeXlsx(sheets: OutSheet[], creator = '篝火'): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = creator;
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.replace(/[[\]:*?/\\]/g, '_').slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(s.header).font = { bold: true };
    for (const r of s.rows) ws.addRow(r);
    s.rowFormats?.forEach((f, ri) => {
      if (f && NUMFMT[f]) ws.getRow(ri + 2).eachCell((c) => { if (typeof c.value === 'number') c.numFmt = NUMFMT[f]!; });
    });
    if (s.boldLast && s.rows.length) ws.getRow(s.rows.length + 1).font = { bold: true };
    ws.columns.forEach((col, ci) => {
      const w = Math.max(width(s.header[ci]), ...s.rows.slice(0, 500).map((r) => width(r[ci] ?? null) + (s.formats?.[ci] === 'money' ? 2 : 0)));
      col.width = Math.min(50, Math.max(8, w + 2));
      const f = s.formats?.[ci];
      if (f && NUMFMT[f]) col.numFmt = NUMFMT[f]!;
    });
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
