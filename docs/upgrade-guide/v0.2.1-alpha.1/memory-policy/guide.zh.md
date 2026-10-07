---
kind: upgrade-guide
description: "`dsh` 的 profile 启动现在默认运行常驻集回收策略，由五个 `DSH_GC_*` 环境变量控制。"
---

# `dsh` profile 启动默认运行常驻集回收策略

[English](guide.md) | 中文

## 变更

在此版本之前，`dsh` 进程只在 V8 自己决定时才回收：启动期间提交的页面会一直保留，空闲的已构建 Web profile 常驻 243–254 MB，而活跃集只有约 57 MB。现在每次 `dsh <profile>` 启动都会在 profile 组装之前启动常驻集策略。它在没有 `--expose-gc` 的构建里也能拿到回收器（查找过程会设置 flag 钩子，并在新的 context 中读取 `gc`），启动 10 s 后回收一次，之后仅在常驻集超过 256 MB 且距上次回收不短于 300 s 时回收；每 60 s 采样一次常驻集，每 300 s 向 stderr 写一行内存指标。两个定时器都是 unref 的，因此该策略不会让正在退出的进程滞留；运行时若拒绝该 flag 钩子，会报告一次且不再采样。在已构建的 Web profile 上实测：20 s 至 40 s 常驻 147–153 MB，未启用时为 243–254 MB。

该策略是 `@deepseek-ai/dsh-memory` 的库依赖，不是 `cordis.yml` 行：没有任何 profile、patch 或设置键引用它，其他命令模式（`--version`、`--dump-config`）也不会启动它。

## 迁移

1. 无需改动：该策略只是让 V8 重新考虑它已占有的页面，所有默认值无需配置即可生效。若要完全恢复旧行为，以 `DSH_GC=0` 启动——此时不启动任何东西，也不输出任何内容。
2. 若要调参，在启动 `dsh` 的环境里设置以下任一变量（取值未设置或格式错误时保留默认值）：

   | 变量 | 默认值 | 作用 |
   | --- | --- | --- |
   | `DSH_GC` | 未设置 | `0` 关闭整个策略 |
   | `DSH_GC_THRESHOLD_MB` | `256` | 常驻集阈值；`0` 关闭阈值采样，但启动时那次回收仍会运行 |
   | `DSH_GC_MIN_INTERVAL_MS` | `300000` | 两次回收之间的最小间隔 |
   | `DSH_GC_SAMPLE_INTERVAL_MS` | `60000` | 常驻集采样间隔 |
   | `DSH_GC_INITIAL_DELAY_MS` | `10000` | 启动那次回收前的延迟 |
   | `DSH_GC_METRICS_INTERVAL_MS` | `300000` | 指标行间隔；`0` 保留回收报告并关闭周期性指标行 |

3. 确认：`dsh` profile 启动会在 stderr 报告各次回收并打印指标行，`ps -o rss= -p <pid>` 的常驻集明显低于启用前的规模。`dsh --dump-config` 不会列出这些变量，因为该策略没有配置行。
