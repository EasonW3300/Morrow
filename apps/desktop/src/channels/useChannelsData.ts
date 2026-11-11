/**
 * 渠道清单 + 健康快照的共享读取（原 ChannelsView 顶层的状态与轮询）。
 *
 * 为什么用 hook：清单与 health 被适配器清单、白名单、通知规则三个区块共享，
 * 刷新动作也由风险确认/凭据保存后触发。用一个 hook 收拢「base → 数据 + refetch」
 * 的取数逻辑，其余区块通过显式 props 接收，不引入任何状态库。
 */
import { useCallback, useEffect, useState } from "react";
import { api, type ChannelHealth, type ChannelSummary } from "../api.ts";
import { readableError } from "./shared.ts";

export interface ChannelsData {
  channels: ChannelSummary[];
  healths: Record<string, ChannelHealth>;
  /** 清单加载失败的错误（页面级横幅）；区块自身的操作错误各自持有 */
  error: string | null;
  reload: () => Promise<void>;
}

export function useChannelsData(base: string): ChannelsData {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [healths, setHealths] = useState<Record<string, ChannelHealth>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await api.listChannels(base);
      setChannels(list);
      const pairs = await Promise.all(
        list.map(async (channel) => {
          try {
            return [channel.channel_id, await api.channelHealth(base, channel.channel_id)] as const;
          } catch {
            return [channel.channel_id, null] as const;
          }
        }),
      );
      setHealths(
        Object.fromEntries(
          pairs.filter((pair): pair is readonly [string, ChannelHealth] => pair[1] !== null),
        ),
      );
      setError(null);
    } catch (err) {
      setError(readableError(err, "加载渠道清单失败"));
    }
  }, [base]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 健康数据每 20 秒刷新（原 ChannelsView 行为）
  useEffect(() => {
    const timer = setInterval(() => void reload(), 20_000);
    return () => clearInterval(timer);
  }, [reload]);

  return { channels, healths, error, reload };
}

/** 每秒推进的 now（token 倒计时 / 相对时间）；页面关闭即停 */
export function useNowMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}
