// 在指定链上发交易：身份在哪条链（BNB Chain、Base、X Layer），交易就发到哪条链。
// 钱包当前不在那条链上时先请钱包切换（钱包会弹窗让用户确认）；切换失败就不发，绝不在别的链上发出同一笔调用。
import { useCallback } from 'react';
import { useConfig } from 'wagmi';
import { getAccount, getPublicClient, sendTransaction, switchChain } from '@wagmi/core';
import type { Hex } from '../data/tapesend';

/** 切链阶段失败：交易还没交给钱包，一定没有发出 */
export class ChainSwitchError extends Error {
  constructor(chainId: number, cause?: unknown) {
    super(`wallet could not switch to chain ${chainId}`);
    this.name = 'ChainSwitchError';
    (this as { cause?: unknown }).cause = cause;
  }
}

export type ChainTx = { to: Hex; data?: Hex; value?: bigint; chainId: number; account: Hex };

export function useChainSend() {
  const config = useConfig();
  return useCallback(async (tx: ChainTx): Promise<Hex> => {
    if (getAccount(config).chainId !== tx.chainId) {
      try {
        await switchChain(config, { chainId: tx.chainId as (typeof config)['chains'][number]['id'] });
      } catch (e) {
        throw new ChainSwitchError(tx.chainId, e);
      }
      // 切换是钱包异步完成的：切过去之后再核对一次，没切过去就不发
      if (getAccount(config).chainId !== tx.chainId) throw new ChainSwitchError(tx.chainId);
    }
    try {
      return (await sendTransaction(config, {
        to: tx.to, data: tx.data, value: tx.value, account: tx.account,
        chainId: tx.chainId as (typeof config)['chains'][number]['id'],
      })) as Hex;
    } catch (e) {
      // viem 在交给钱包之前一刻再查一次链号，不对就报 ChainMismatchError、不发：同样是"一定没发出"
      if (e && typeof e === 'object' && /ChainMismatch/.test(String((e as { name?: string }).name) + String((e as { cause?: { name?: string } }).cause?.name ?? ''))) throw new ChainSwitchError(tx.chainId, e);
      throw e;
    }
  }, [config]);
}

/** 某条链的只读客户端（钱包连接库自带的，用来等回执；结果另用多节点严格核对） */
export function useChainClient() {
  const config = useConfig();
  return useCallback((chainId: number) => getPublicClient(config, { chainId: chainId as (typeof config)['chains'][number]['id'] }), [config]);
}
