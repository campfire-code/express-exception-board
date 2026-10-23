// 工具声明：快递异常件看板（自定义界面；数据来自你自己导出的表格，或你自己的快递100 官方接口授权）。
import { PackageX } from 'lucide-react';
import { createElement } from 'react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'e21',
  name: '快递异常件看板',
  tagline: '导入运单表，用表里自带的轨迹或快递100 官方接口，找出停滞件、退回件、疑难件和拒收件，导出清单。',
  icon: PackageX,
  category: '电商运营',
  type: 'data',
  mode: 'custom',
  mainLabel: '异常件看板',
  params: [],
  Main: ({ ctx }) => createElement(Main, { ctx }),
};

export default tool;
