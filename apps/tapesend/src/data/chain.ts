// 链上读取：全部经 TapeKit 内核的多节点一致读取（SPEC §4），不信任任何单个节点。
import { createKernel, statusText, setLocale } from '../../../../kernel/src/index.js';
import { locale } from '../i18n';

setLocale(locale);

let kernel: ReturnType<typeof createKernel> | null = null;
export function getKernel() {
  kernel ??= createKernel({});
  return kernel;
}

export interface SiteSummary {
  status: string;
  statusText: string;
  name?: string;
  container?: string;
  holder?: string | null;
  block?: string;
}

export async function resolveSite(input: string): Promise<SiteSummary> {
  const res = await getKernel().resolve(input);
  return {
    status: res.status,
    statusText: statusText(res.status),
    name: res.name,
    container: res.container,
    holder: res.holder,
    block: res.block,
  };
}
