# Pi 内核版本锁定与 PiAdapter

Pi（badlogic/pi-mono）迭代迅速、API 面不稳定，而 Morrow 的业务模块（记忆、任务、渠道、能力工厂）需要稳定的依赖面。决定：锁定 Pi 的具体 release 版本；在业务代码与 Pi API 之间建立一层薄 `PiAdapter` 并冻结其内部接口；业务模块禁止直接 import Pi API；升级 Pi 版本视为显式变更，须通过回归测试后合入。

## Considered Options

- 直接依赖 Pi API：接入最快，但每次上游升级都可能破坏业务模块，单人项目无力持续跟移。
- 并行自研 Agent Loop：决策稿六轮访谈已否决（成本不可接受，Pi 的 Loop/工具调用/流式事件正是选它的理由）。

## Consequences

Pi 的部分能力若 PiAdapter 未暴露，业务侧暂时用不到；为某个上游新特性升级 Pi 时，需要一次显式的适配层变更与回归，而不是"顺手 npm update"。
