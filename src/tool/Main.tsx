// 主界面：上方选数据来源与阈值，下方汇总、筛选和异常件列表。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileUp, FolderOpen, Play, ShieldCheck, Square, TriangleAlert } from 'lucide-react';
import type { CustomTool } from '../kit/types';
import { defaultOutputDir, httpFetch, openLink, pickFiles, reveal } from '../kit/platform';
import { CopyButton, useDroppedFiles } from '../kit/parts';
import { ALERT_CATEGORIES, CATEGORY_LABEL, alertText, maskSecret, readShipments, summarize, type BoardRow, type Category, type Credentials, type Shipment } from './core';
import { exportBoard, runBoard, validate, type Mode } from './flow';
import { isAbort, type Cache, type Fetcher } from './api';
import { sampleGrid } from './samples';
import { DEFAULT_PREFS, EMPTY_CRED, loadCache, loadCred, loadPrefs, saveCache, saveCred, savePrefs, toOpts, type Prefs } from './store';
import { PREVIEW, isPreview } from './preview';
import { readSheets } from './xlsx';
import './tool.css';

type Ctx = Parameters<CustomTool['Main']>[0]['ctx'];
const DOCS = 'https://api.kuaidi100.com/document/5f0ffb5ebc8da837cbd8aefc';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const realFetcher: Fetcher = (url, init) => httpFetch(url, init) as ReturnType<Fetcher>;
const sev = (c: Category) => (['return', 'refused', 'exception'].includes(c) ? 'hi' : ['stagnant', 'notrace', 'error'].includes(c) ? 'mid' : 'ok');
type Filter = 'alerts' | 'all' | Category;

export function Main({ ctx }: { ctx?: Ctx }) {
  const preview = isPreview();
  const [cred, setCred] = useState<Credentials>(EMPTY_CRED);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [cache, setCache] = useState<Cache>({});
  const [ships, setShips] = useState<Shipment[]>([]);
  const [hasTrace, setHasTrace] = useState(false);
  const [source, setSource] = useState('');
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [filter, setFilter] = useState<Filter>('alerts');
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => { if (!preview) void Promise.all([loadCred(), loadPrefs(), loadCache()]).then(([c, p, k]) => { setCred(c); setPrefs(p); setCache(k); }); }, [preview]);
  const setP = (patch: Partial<Prefs>) => setPrefs((p) => { const n = { ...p, ...patch }; void savePrefs(n); return n; });
  const demo = source === '示例数据';

  async function importFiles(paths: string[]) {
    if (!ctx) return;
    setError(''); setNotice(''); setRows([]); setSaved('');
    try {
      const all: Shipment[] = [];
      let trace = false;
      const skipped: string[] = [];
      for (const p of paths) {
        const sheets = await readSheets(await ctx.readFile(p), p);
        const r = readShipments(sheets[0]?.grid ?? []);
        if (r.missingCols.length) throw new Error(`「${p.split(/[\\/]/).pop()}」里找不到「${r.missingCols[0]}」列，请确认表头`);
        all.push(...r.shipments); skipped.push(...r.skipped); trace ||= r.hasTrace;
      }
      setShips(all); setHasTrace(trace); setSource(paths.map((p) => p.split(/[\\/]/).pop()).join('、'));
      setNotice(`读到 ${all.length} 个运单${skipped.length ? `，跳过 ${skipped.length} 个重复` : ''}。${trace ? '表里带有最新状态和更新时间，可直接用「表格模式」。' : '表里没有最新状态 / 更新时间列，请用「快递100 接口」模式查询。'}`);
      if (!trace && prefs.mode === 'table') setP({ mode: 'api' });
    } catch (e) { setError(errText(e)); }
  }
  const hover = useDroppedFiles((p) => void importFiles(p));

  function loadDemo() {
    const r = readShipments(sampleGrid(Date.now()));
    setShips(r.shipments); setHasTrace(true); setSource('示例数据'); setRows([]); setError(''); setSaved('');
    setNotice('已载入 12 条虚构的示例运单，不联网。');
  }

  async function start() {
    const mode: Mode = demo ? 'table' : prefs.mode;
    const bad = validate(mode, ships, cred, demo);
    if (bad) { setError(bad); return; }
    if (mode === 'table' && !hasTrace) { setError('表里没有「物流状态 / 最后更新时间」列，表格模式无法判断，请切到快递100 接口模式'); return; }
    setError(''); setSaved(''); setBusy(true); setProg({ done: 0, total: ships.length });
    abort.current = new AbortController();
    try {
      if (mode === 'api') await saveCred(cred);
      const r = await runBoard({ mode, shipments: ships, cred, fetcher: realFetcher, cache, opts: toOpts(prefs), progress: (done, total) => setProg({ done, total }), signal: abort.current.signal });
      setRows(r.rows);
      if (mode === 'api') { setCache(r.cache); await saveCache(r.cache); }
      if (r.stoppedEarly) setError(`查询中止：${r.stoppedEarly}`);
      setFilter('alerts');
    } catch (e) { setError(isAbort(e) ? '已停止' : errText(e)); } finally { setBusy(false); }
  }

  async function exportXlsx() {
    try {
      const outDir = preview ? '/示例/下载/快递异常件看板' : await defaultOutputDir('快递异常件看板');
      const io = ctx ?? { mkdir: async () => {}, writeFile: async () => {}, join: async (...p: string[]) => p.join('/') };
      const info: [string, string][] = [
        ['导出时间', new Date().toLocaleString('zh-CN')],
        ['数据来源', demo ? '示例数据（虚构）' : prefs.mode === 'api' ? '快递100 官方实时查询接口（用户自己的授权码）' : `用户导入的表格：${source}`],
        ['停滞阈值', `${prefs.stagnantHours} 小时没有新轨迹（可调）`],
      ];
      setSaved(await exportBoard(rows, io, outDir, new Date(), info));
    } catch (e) { setError(errText(e)); }
  }

  useEffect(() => {
    if (preview && PREVIEW.autoRun) {
      const r = readShipments(sampleGrid(Date.now()));
      setShips(r.shipments); setHasTrace(true); setSource('示例数据');
      void runBoard({ mode: 'table', shipments: r.shipments, cred: EMPTY_CRED, cache: {}, opts: toOpts(DEFAULT_PREFS) }).then((x) => { setRows(x.rows); setNotice('示例：12 条虚构运单，不联网，单号和轨迹都不是真实的。'); });
    }
  }, [preview]);

  const sum = useMemo(() => summarize(rows), [rows]);
  const shown = rows.filter((r) => (filter === 'all' ? true : filter === 'alerts' ? ALERT_CATEGORIES.includes(r.v.category) : r.v.category === filter));
  const cnt = (c: Category) => rows.filter((r) => r.v.category === c).length;
  const apiMode = !demo && prefs.mode === 'api';
  const thr = prefs.stagnantHours;
  const peak = Math.max(0, ...shown.map((r) => r.v.idleHours ?? 0));
  const axis = Math.max(Math.ceil(Math.max(thr * 1.5, peak) / 24) * 24, 24);
  const tiles: { k: Filter; label: string; n: number; tone: string }[] = [
    { k: 'alerts', label: '需要处理', n: sum.alerts, tone: 'hi' },
    ...(['return', 'refused', 'exception', 'stagnant', 'notrace'] as Category[]).filter(cnt).map((c) => ({ k: c as Filter, label: CATEGORY_LABEL[c], n: cnt(c), tone: sev(c) })),
    ...(['normal', 'delivered', 'error'] as Category[]).filter(cnt).map((c) => ({ k: c as Filter, label: CATEGORY_LABEL[c], n: cnt(c), tone: c === 'error' ? 'mid' : 'ok' })),
  ];

  return (
    <div className="ex-root">
      <section className="ex-bar">
        <div className="ex-grp"><span className="k-label">数据来源</span>
          <span className="ex-seg" role="group" aria-label="数据来源">
            <button className="ex-chip" aria-pressed={prefs.mode === 'table'} disabled={busy} onClick={() => setP({ mode: 'table' })}>表格自带轨迹</button>
            <button className="ex-chip" aria-pressed={prefs.mode === 'api'} disabled={busy || demo} onClick={() => setP({ mode: 'api' })}>快递100 接口</button>
          </span>
        </div>
        <div className="ex-grp"><label className="k-label" htmlFor="ex-hours">停滞阈值</label>
          <span className="ex-hours"><input id="ex-hours" className="k-input" type="number" min={1} max={720} value={prefs.stagnantHours} disabled={busy} onChange={(e) => setP({ stagnantHours: Math.max(1, Math.min(720, Number(e.target.value) || 48)) })} />小时</span>
        </div>
        {apiMode && (
          <>
            <div className="ex-grp"><label className="k-label" htmlFor="ex-cu">授权码</label>
              <input id="ex-cu" className="k-input" autoComplete="off" spellCheck={false} disabled={busy} value={cred.customer} placeholder={cred.customer ? maskSecret(cred.customer) : ''} onChange={(e) => setCred({ ...cred, customer: e.target.value })} />
            </div>
            <div className="ex-grp"><label className="k-label" htmlFor="ex-key">授权 Key</label>
              <input id="ex-key" className="k-input" type="password" autoComplete="off" spellCheck={false} disabled={busy} value={cred.key} placeholder={cred.key ? maskSecret(cred.key) : ''} onChange={(e) => setCred({ ...cred, key: e.target.value })} />
            </div>
          </>
        )}
        <span className="ex-sp" />
        <div className="ex-actions">
          <button className="k-btn" disabled={busy || !ctx} onClick={() => void pickFiles(['xlsx', 'csv'], '运单表').then((p) => { if (p.length) void importFiles(p); })}><FileUp size={14} />导入运单表</button>
          <button className="k-btn" disabled={busy} onClick={loadDemo}>载入示例</button>
          {busy
            ? <button className="k-btn" onClick={() => abort.current?.abort()}><Square size={14} />停止</button>
            : <button className="k-btn primary" onClick={() => void start()}><Play size={14} />开始检查</button>}
        </div>
      </section>

      {error && <div className="k-notice err" role="alert">{error}</div>}
      {notice && !error && <div className="k-notice ok">{notice}{hover ? ' 松开即可导入。' : ''}</div>}
      {busy && <div className="ex-file"><span className="k-spin" /> 正在检查：{prog.done} / {prog.total}</div>}

      {!rows.length && !busy && (
        <section className="ex-empty">
          <svg viewBox="0 0 440 110" aria-hidden="true">
            <line className="ex-s-rail" x1="12" y1="62" x2="428" y2="62" />
            <line className="ex-s-thr" x1="290" y1="24" x2="290" y2="98" />
            {[40, 110, 170, 230].map((x) => <circle key={x} className="ex-s-ok" cx={x} cy="62" r="7" />)}
            <rect className="ex-s-bad" x="278" y="48" width="26" height="28" rx="6" />
            <path className="ex-s-mark" d="M291 55v10m0 5v1" />
            <rect className="ex-s-bad2" x="340" y="52" width="70" height="20" rx="6" />
          </svg>
          <div>
            <b>把运单表，变成一条条停滞时间线</b>
            <p className="k-muted">导入运单表（需要「快递单号」列，可带快递公司、手机号、订单号、发货时间），或先点「载入示例」。表里带「物流状态、最后更新时间」时可直接判断，否则用快递100 接口逐单查询。</p>
          </div>
        </section>
      )}

      {rows.length > 0 && (
        <>
          <div className="ex-head">
            <div className="ex-big"><b className="k-num">{sum.alerts}</b><span>单需要处理<small>共 {sum.total} 单</small></span></div>
            <div className="ex-tiles" role="group" aria-label="按类型筛选">
              {tiles.map((t) => <button key={t.k} className={`ex-tile ${t.tone}`} aria-pressed={filter === t.k} onClick={() => setFilter(t.k)}><b className="k-num">{t.n}</b>{t.label}</button>)}
              {filter !== 'all' && <button className="ex-tile all" onClick={() => setFilter('all')}>显示全部</button>}
            </div>
            <div className="ex-actions">
              <button className="k-btn primary" onClick={() => void exportXlsx()}><Download size={14} />导出 Excel</button>
              <CopyButton text={alertText(rows)} label="复制异常清单" />
            </div>
          </div>
          {saved && <div className="ex-file"><Download size={14} /><span className="k-ellipsis" title={saved}>{saved}</span>{!preview && <button className="k-link" onClick={() => void reveal(saved)}><FolderOpen size={14} />在文件夹中显示</button>}</div>}
          <div className="ex-tl" style={{ ['--t' as string]: thr / axis }}>
            <div className="ex-axis"><span>已停滞时长</span><div className="ex-ruler"><i style={{ left: 0 }}>0</i><i className="thr" style={{ left: `${(thr / axis) * 100}%` }}>阈值 {thr} 小时</i><i style={{ right: 0 }}>{axis} 小时</i></div><span /></div>
            <ol className="ex-list">
              {shown.map((r) => {
                const h = r.v.idleHours;
                return (
                  <li key={r.s.num} className={`ex-row ${sev(r.v.category)}`}>
                    <div className="ex-who">
                      <div className="ex-l1"><span className={`ex-tag ${sev(r.v.category)}`}>{r.v.label}</span><span className="ex-num k-num">{r.s.num}</span><span className="ex-sub">{r.s.carrier || r.s.com}{r.s.ref ? ` · ${r.s.ref}` : ''}</span></div>
                      <p className="ex-ctx" title={r.v.lastContext}><b>{r.v.reason}</b>{r.v.lastContext ? <span className="k-muted">　{r.v.lastContext}</span> : null}</p>
                    </div>
                    <div className="ex-track" role="img" aria-label={h == null ? '没有停滞时长' : `已停滞 ${h} 小时`}>{h != null && <i style={{ width: `${Math.min(100, (h / axis) * 100)}%` }} />}</div>
                    <div className="ex-h k-num">{h == null ? '—' : <>{h}<small>小时</small></>}</div>
                  </li>
                );
              })}
              {!shown.length && <li className="ex-none k-muted">这一类没有运单</li>}
            </ol>
          </div>
          {demo && <p className="k-muted ex-note">当前是示例数据（虚构），不是真实运单。</p>}
        </>
      )}

      <details className="ex-risk">
        <summary><TriangleAlert size={13} />数据来源与合规说明</summary>
        <p>数据来源只有两种：你自己导出的运单表（表里自带最新状态与更新时间），或用你自己的快递100 企业版授权码调用其<b>官方</b>实时查询接口。本工具不爬取任何快递网站。接口模式会消耗你账号的查询单量，同一单号官方建议间隔至少 30 分钟、24 小时内不超过 48 次，工具会自动遵守并沿用缓存。</p>
        {apiMode && <p className="ex-note"><ShieldCheck size={13} /> 授权码只保存在本机，只发给快递100 官方接口。<button className="k-link" onClick={() => void openLink(DOCS)}>接口文档</button></p>}
      </details>
    </div>
  );
}
