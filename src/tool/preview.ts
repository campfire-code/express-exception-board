// 截图与预览用：打开后自动载入虚构的「示例」运单跑一遍看板，不联网。
export const PREVIEW = { autoRun: true } as const;
export const isPreview = () => typeof location !== 'undefined' && location.pathname.endsWith('preview.html');
export const rows = () => [];
export const params = {};
