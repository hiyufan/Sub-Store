# 在同一个 EdgeOne Makers 项目部署 Sub-Store 前后端

本适配使用 **官方前端静态文件 + Node 云函数 + EdgeOne Blob**。打开根域名就是完整 Sub-Store 界面，首次输入秘密路径连接后端。KV 当前仅支持 Edge Functions；Blob 有 Node SDK，并支持强一致读取。

-   Blob 文档：https://pages.edgeone.ai/document/blob-storage
-   KV 文档：https://pages.edgeone.ai/document/kv-storage
-   Express 云函数入口：https://pages.edgeone.ai/document/node-functions

## 部署配置

将本次修改推送到你在 EdgeOne 导入的 Git 分支，再重新部署。项目根目录填写 `backend`（无开头斜杠）。

| 配置项       | 值                               |
| ------------ | -------------------------------- |
| 框架         | Other / 其他                     |
| 根目录       | `backend`                        |
| 安装命令     | `pnpm install --frozen-lockfile` |
| 构建命令     | `pnpm run build:edgeone`         |
| 静态输出目录 | `edgeone-public`                 |

`backend/edgeone.json` 已包含安装、构建、输出目录和构建用 Node 版本设置。不要继续使用 `bundle:esbuild`、`dist` 或 `build` 作为本部署的配置。

构建时自动下载官方前端 **2.34.1** 发布包，校验固定 SHA-256，然后输出到 `edgeone-public`。版本、下载地址、校验值与对应源码地址保存在 `backend/edgeone/frontend-release.json`。构建需要能够访问 GitHub Releases；下载或校验失败会中止，不会发布说明页替代完整界面。无需另建前端项目，也不需要前端源码的第二次依赖安装。

前端默认 API 改为当前域名，首次连接使用官方前端已有的“后端连接配置”弹窗；不会把 `EDGEONE_SUB_STORE_PATH` 编译进 JS 或 HTML。修改后的文件同步更新 PWA 预缓存版本，原发布包的压缩副本不会混入部署。前端 GPL-3.0 许可证和源码说明随静态文件提供。

在 EdgeOne 项目启用 Blob 存储，在环境变量中设置：

| 环境变量                         | 必需 | 含义                                                                                          |
| -------------------------------- | ---- | --------------------------------------------------------------------------------------------- |
| `EDGEONE_SUB_STORE_PATH`         | 是   | 秘密后端路径，16–128 位字母、数字、下划线或短横线，开头的 `/` 可省略。推荐 32 位随机十六进制字符。 |
| `EDGEONE_SUB_STORE_BLOB_NAME`    | 否   | Blob namespace，默认 `sub-store`。正式环境和预览环境应使用不同名称。                          |
| `SUB_STORE_CORS_ALLOWED_ORIGINS` | 否   | 额外跨域前端的完整 origin。同域界面自动处理，无需配置此项；跨域请求仍遵循上游白名单。填写此项会替换默认白名单，多个来源以逗号分隔。 |

生成路径（本机终端运行）：

```sh
node -e "console.log('/' + require('node:crypto').randomBytes(16).toString('hex'))"
```

不要把秘密路径提交进仓库。它授予完整后端访问权限，分享时也需保护。未配置时后端 API 返回 503，路径不匹配时返回 404，不会访问 Blob；公开前端页面仍可打开。

**保存环境变量后必须重新部署。** 修改不会影响旧部署；请确认变量的生效范围包含当前访问域名所属的环境（通常为生产环境）。在“后端连接配置”弹窗输入路径，只会保存浏览器连接地址，不会替你设置云端环境变量。

连接失败时，可检查秘密路径下的 `/api/utils/env` JSON 响应：

- `EDGEONE_CONFIG_REQUIRED`：当前云函数未读取到变量。检查名称是否为 `EDGEONE_SUB_STORE_PATH`、变量生效范围，以及是否在保存后创建了新部署。
- `EDGEONE_CONFIG_INVALID`：变量已读到，但格式无效。填写随机字符串或 `/随机字符串`，不要填写域名、完整 URL、引号或结尾斜杠，再重新部署。变量前后空白会自动去除。
- `EDGEONE_REQUEST_FAILED`：路径校验已通过，后端处理或 Blob 访问失败；检查云函数日志和 Blob 启用状态。
- `404`：浏览器填写的秘密路径与云端变量不一致。

若出现 `403 CORS origin not allowed`：同域识别使用 EdgeOne 传入的 `Eo-Pages-Host` 和 `X-Forwarded-Proto`（平台未传协议时默认 HTTPS），可处理平台将 Host 改为内部地址的情况。请部署包含该修复的版本。旧版本的临时处理方式是在 `SUB_STORE_CORS_ALLOWED_ORIGINS` 中填写前端的完整 origin（例如 `https://example.edgeone.app`，不包含秘密路径），保存后重新部署；不要填 `*`。若还需要官方前端访问，将其 origin 一并加入，使用逗号分隔。

云函数内部通过 `getStore()` 使用平台提供的凭据，无需把 EdgeOne API Token 写进源码或前端。第一次有效请求会自动创建 namespace；控制台无需预建。保持 namespace 名称不变，重新部署会继续使用原数据。

本模式忽略独立服务器用的端口、前后端合并、启动时恢复数据和进程内 Cron 配置。不要设置 `SUB_STORE_BACKEND_PREFIX`、`SUB_STORE_BACKEND_MERGE` 或 `SUB_STORE_FRONTEND_PATH`；秘密路径由本适配器处理。

## 连接前端和迁移数据

假设域名是 `https://example.edgeone.app`、秘密路径是 `/你的随机字符串`：

1. 访问 `https://example.edgeone.app/你的随机字符串/api/utils/env`，应该返回 JSON，`status` 为 `success`。
2. 打开 `https://example.edgeone.app/`，在“后端连接配置”弹窗中输入 `/你的随机字符串`，点击“连接”。浏览器会保存这个配置，以后直接打开域名即可使用。更换浏览器或设备需要重新输入。
3. 从原 Sub-Store 导出备份，在新后端通过前端的数据恢复功能导入。该适配不会自动读取你其他服务器上的 JSON 文件。
4. 新建测试订阅，刷新，再重新部署一次，确认订阅仍然存在。也可在 Blob 控制台看到 `transactions/` 下的对象。

也可以在首次访问时使用 `https://example.edgeone.app/?magicpath=你的随机字符串` 一键配置，但这个地址包含后端访问权限，应按密码保管。建议直接在弹窗输入路径，避免把秘密留在 URL 中。

Vue 页面路径（如 `/subs`、`/settings/api`、`/edit/subs/名称`）可直接打开和刷新。EdgeOne 优先提供静态资源，云函数为页面导航返回同一份 SPA HTML；API、下载和分享接口不会被当作前端页面返回。首页公开展示界面不会授予后端数据访问权限。

## 保存方式和并发语义

-   每次请求使用独立应用和缓存，先强一致读取 Blob，再处理请求。
-   多次 `$.write()` / `$.delete()` 及备份恢复在响应结束前统一保存。Blob 失败返回 503，HTTP 4xx/5xx 的请求不会提交局部修改。
-   每次变更使用随机 UUID 写一个独立记录，避免覆盖共享快照；读请求无变更时不写入。同步日志和远程内容缓存不写进持久化记录，日志在 EdgeOne 控制台查看。
-   读取时按逻辑时钟和 UUID 排序重放变更。对象按字段、订阅等按 `name`、令牌按 `token` 合并，保留独立实例对不同项目或不同字段的修改。
-   对同一字段、普通数组、同名项目的并发修改按确定顺序解决冲突。这不是数据库的串行化事务，也不提供唯一性约束、原子计数或跨外部服务事务。
-   SDK 0.0.18 明确注明 `onlyIfNew` 不受底层存储保证，因此没有用它做分布式锁。按次数限制的分享令牌在此模式下不可创建、不可使用；请改用时间有效期令牌。正常服务器模式保持原行为。

记录不会自动删除，历史中可能保留已删除的订阅和凭据，namespace 应按私密数据管理。首次加载和冷启动成本随历史增长；本方案适用于个人使用，不适合高频写入或严格事务场景。需要清理历史时：暂停所有客户端写入，在前端导出当前备份，将 `EDGEONE_SUB_STORE_BLOB_NAME` 切换为新的名称并部署，导入备份，确认数据后再处理旧 namespace。不要直接删 `transactions/` 中的部分记录。

## 定时任务和功能限制

进程内 Cron 在此模式下不启动。使用外部定时调度服务请求已有的同步 API：

```text
GET https://你的域名/秘密路径/api/sync/artifacts
GET https://你的域名/秘密路径/api/sync/artifact/URL编码后的名称
```

调度服务中的地址包含完整后端权限，需保密；任务应在平台执行时间限制内完成。每条配置中保存的 Cron 表达式不会自动执行。

依赖本机文件、外部二进制或任意 npm 包的用户脚本仍需按云函数环境调整。MMDB 等本机资源需自行提供；本适配不会将现有服务器磁盘一并迁移。

构建机器的 Node 版本不决定云函数版本。构建目标为 Node 20，并单独为本云函数包使用兼容 Node 20.18.1+ 的 Undici 7；原 Node 服务继续使用上游 Undici 8。

## 本地验证

```sh
cd backend
pnpm install --frozen-lockfile
pnpm run test:edgeone
pnpm --package=edgeone dlx edgeone makers build
```

测试使用内存模拟 Blob，涵盖真实 Sub-Store 应用的增删改查、跨实例加载、并发新增、备份恢复、写入失败、秘密路径、前端发布包校验、页面导航和同域 CORS；无需云凭据。浏览器验证流程为：打开首页 → 输入秘密路径 → 创建本地订阅 → 保存 → 刷新确认数据 → 刷新编辑和设置页，并检查桌面/手机布局。只有实际部署后的检查才能验证你的账户权限和线上 Blob 服务。
