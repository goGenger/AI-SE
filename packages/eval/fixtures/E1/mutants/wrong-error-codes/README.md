# TaskBoard（E1 夹具参考实现）

零运行时依赖的 TaskBoard 任务看板（Node 22 标准库 + JSON 文件存储）。

## 命令

- 安装：`pnpm install --frozen-lockfile`
- 启动：`pnpm start`（端口读 `PORT`，默认 3000）
- 测试：`pnpm test`（`node --test`；测试名含对应 AC 编号）
- 自检：`pnpm lint` / `pnpm typecheck` / `pnpm build`
- 镜像：`docker build -t taskboard .`
- 运行：`docker run --rm -p 3000:3000 -e PORT=3000 -v taskboard-data:/data taskboard`
  （非 root 用户运行；数据卷 `/data`；日志输出到 stdout）

## API

| 方法   | 路径                          | 说明                                               |
| ------ | ----------------------------- | -------------------------------------------------- |
| GET    | `/healthz` `/health` `/ready` | 健康检查，200 `{"status":"ok"}`                    |
| GET    | `/`                           | 首页 HTML（含约定 `data-testid`）                  |
| POST   | `/api/register`               | `{username, password}` → 201 `{user}`              |
| POST   | `/api/login`                  | `{username, password}` → 200 `{token, user}`       |
| GET    | `/api/tasks?q=`               | Bearer；`{items}`（仅本人任务；`q` 子串过滤）      |
| POST   | `/api/tasks`                  | Bearer；`{title, dueDate?}` → 201 `{task}`         |
| GET    | `/api/tasks/:id`              | Bearer；`{task}` / 404                             |
| PATCH  | `/api/tasks/:id`              | Bearer；`{title?, dueDate?, done?}` → 200 `{task}` |
| DELETE | `/api/tasks/:id`              | Bearer；204 / 404                                  |

## 错误封套与错误码

`{"error":{"code","message"}}`；错误码：`VALIDATION_ERROR` / `TITLE_INVALID` /
`DATE_INVALID` / `UNKNOWN_FIELD` / `UNAUTHORIZED` / `INVALID_CREDENTIALS` /
`USERNAME_TAKEN` / `NOT_FOUND`。

## 数据与安全

- 数据持久化于 `DATA_DIR`（默认 `./data`；容器内 `/data` 数据卷），重启保留；
- 密码以 scrypt 哈希存储，数据文件不含明文密码；
- 令牌为 HMAC-SHA256 签名，篡改或截断即 401。
