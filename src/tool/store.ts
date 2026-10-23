// 授权码与查询记录保存在本机应用数据目录的 settings.json（kit 的 settingsStore）。不上传、不写日志。
import { settingsStore } from '../kit/platform';
import type { Cache } from './api';
import { DEFAULT_OPTS, type Credentials, type Opts } from './core';

const CRED_KEY = 'cred.e21';
const PREFS_KEY = 'prefs.e21';
const CACHE_KEY = 'cache.e21';
export const EMPTY_CRED: Credentials = { customer: '', key: '' };
export interface Prefs { mode: 'table' | 'api'; stagnantHours: number }
export const DEFAULT_PREFS: Prefs = { mode: 'table', stagnantHours: DEFAULT_OPTS.stagnantHours };
const str = (v: unknown) => (typeof v === 'string' ? v : '');
export const toOpts = (p: Prefs): Opts => ({ stagnantHours: p.stagnantHours });

async function get<T>(k: string): Promise<T | undefined> { try { return await (await settingsStore()).get<T>(k); } catch { return undefined; } }
async function set(k: string, v: unknown, save = false) { try { const st = await settingsStore(); await st.set(k, v); if (save) await st.save(); } catch { /* 忽略 */ } }

export async function loadCred(): Promise<Credentials> { const v = (await get<Partial<Credentials>>(CRED_KEY)) ?? {}; return { customer: str(v.customer), key: str(v.key) }; }
export const saveCred = (c: Credentials) => set(CRED_KEY, c, true);
export async function loadPrefs(): Promise<Prefs> {
  const v = (await get<Partial<Prefs>>(PREFS_KEY)) ?? {};
  const h = Number(v.stagnantHours);
  return { mode: v.mode === 'api' ? 'api' : 'table', stagnantHours: h >= 1 && h <= 720 ? h : DEFAULT_PREFS.stagnantHours };
}
export const savePrefs = (p: Prefs) => set(PREFS_KEY, p);
export async function loadCache(): Promise<Cache> { const v = await get<Cache>(CACHE_KEY); return v && typeof v === 'object' ? v : {}; }
export const saveCache = (c: Cache) => set(CACHE_KEY, c, true);
