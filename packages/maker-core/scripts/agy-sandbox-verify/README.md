# agy 系统级隔离：诱饵验证脚本

给 QQ 按代码审查用（good-night-oppie/cindy#1，QQ 预审 6908837891 第 3 条）。只在 Linux 上跑，不调模型、不用账号、不跑真实 agy。

| 文件 | 作用 |
|---|---|
| `fake_agy.py` | 假的 agy：读 `probe-plan.json`，做 57 种越界尝试（读/改/删诱饵、`../`、符号链接、硬链接、子进程、`/proc` 绕路、新开命名空间、宿主回环、X11、Cindy 的 MCP 端口、出网对照），每次尝试打印一行 JSON。真实密钥位置只查存不存在，从不打开；不在沙箱里时不碰家目录。 |
| `verify.sh MODE` | 建诱饵（带一次性暗号）、记跑前跑后的哈希/大小/权限/三种时间、跑 `fake_agy.py`、搜暗号、出 `summary.json`。 |
| `run-module.ts` | `module` 模式：用正式实现 `src/agents/agy/system-sandbox.ts` 的 `prepareAgySandboxedLaunch`（pasta + bubblewrap）启动假 agy，和 AgyAgent 启动真 agy 的方式相同。 |
| `agy-sandbox.sh`、`landlock_exec.py` | 早期原型（bubblewrap + Landlock，**共享宿主网络**），只用于 `bwrap`/`full`/`landlock-only` 对照。正式实现不用它们。 |

## 怎么跑

```sh
cd packages/maker-core/scripts/agy-sandbox-verify
./verify.sh baseline   # 不加沙箱：反例应全部「连上」、诱饵被读被改——证明检查有效
./verify.sh module     # 正式实现：诱饵 0 改动、0 暗号；三个网络反例必须失败、出网对照必须成功
```

需要 `bwrap`、`pasta`（passt 项目；系统没有时用 `AGY_SANDBOX_TEST_PASTA=/path/to/pasta`）、`python3`、`node` 和 maker-core 的依赖（`npx tsx`）。结果在 `$AGY_VERIFY_ROOT/runs/<MODE>/`（默认临时目录）：`summary.json`、`task/fake-agy-results.json`、`manifest-before/after.json`。

## 通过标准（module 模式）

- `outside_changes` 为空，`canary_leaks` 四处都为空，`sibling_write_created` 为 false。
- `Q-host-loopback`、`Q-x11`、每个 `Q-cindy-mcp-*` 的 `ok` 为 false；`Q-egress` 的 `ok` 为 true。
- `T-write`、`T-mkdir`、`T-state` 成功（任务文件夹和私有状态目录可写）。
- 同一机器上 `baseline` 模式里这些反例应为 true，说明反例本身有效。
