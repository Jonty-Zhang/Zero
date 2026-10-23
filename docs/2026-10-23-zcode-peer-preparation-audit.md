# 2026-10-23：ZCode peer 创建进程前的取消检查

## 已确认的问题

peer 启动在入口文件、打包配置、工作目录和隔离 profile 的异步准备完成后直接调用 spawn。取消信号原先由构造函数在创建进程后处理，因此已经取消的请求仍走到创建进程的调用边界。上层 adapter 的准备期检查无法覆盖它自身继续等待文件系统时收到取消的窗口。

新增六项控制通过实际编译后的 peer 和 Node 内置 spawn 调用探针验证：isolated 和 existing-desktop 两种模式分别覆盖进入前取消、等待文件系统时取消和未取消对照。旧版四项取消失败、两个正常对照通过，实际退出 1；各取消控制都记录到了不应发生的 spawn 调用。探针阻止了真实 CLI 创建，不能将此说成真实供应商任务已执行。

## 修复与范围

在参数校验后和所有异步准备结束后的 spawn 前各检查取消信号，使用 signal 的原始 reason 拒绝启动。正常参数验证、目录安全检查、环境构造、诊断和启动后的关闭/进程树流程保持原有逻辑。等待期间仍可能完成本次文件系统准备，但取消后不会创建 child。

## 验证

编译实际退出 0；相同六项控制修复后 6/6 通过，实际退出 0。七个 ZCode 适配器、协议、peer 和进程树测试文件共 83/83 通过，实际退出 0。这是受影响分支回归，不是完整核心套件。

独立编译产物与已测 root dist 的 peer 和新增测试两个模块逐字节一致。独立六项启动控制、正常 stdio/诊断控制及四项补充控制确认了原始取消 reason、诊断隐私和最后文件系统步骤收到取消时不 spawn。

独立复核在默认沙箱运行旧的 RPC timeout/关闭控制及后续两个 late-abort 控制时曾实际退出 1，原日志保留。观察记录只有 taskkill 失败、code 为 null、stderr 为空，不能将其写成明确的 EACCES。随后仅授权同一 repo-owned fixture 的进程终止，在冻结旧版与修复版各运行相同 late-abort 控制，两者均 1/1、实际退出 0；pending request 被取消拒绝，peer.close 完成，taskkill callback 无错误。该对照支持运行权限影响关闭控制，没有据此改动或宣称修复既有进程树机制。Astra high 最终结论 APPROVE，仅适用于这两处启动 guard；报告和完整 hash 清单保存在独立审查目录。

证据在 `data/verification/zcode-peer-preparation-root/`，其中 `baseline-dist` 固定旧版源码编译产物。所有 fixture 和临时目录均在项目内，没有访问真实 CLI、供应商或用户桌面 profile。GitHub 依用户要求暂缓，本地提交不表示远端发布。
