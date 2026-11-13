# E1 变异版本（自检用：oracle 必须全部检出，至少一个 Must 检查失败）

| 变异                         | 改动                                   | 期望主要检出点                                        |
| ---------------------------- | -------------------------------------- | ----------------------------------------------------- |
| no-data-isolation            | `tasks.mjs` 去掉全部 userId 作用域     | AC-23（列表混入他人任务）/ AC-27（越权应 404）        |
| plaintext-passwords          | `auth.mjs` 明文存口令（hash=password） | AC-04（数据文件出现明文密码）；其自测 AC-04 也失败    |
| wrong-error-codes            | `server.mjs` 重复用户名返回 500        | AC-03 / AC-05（应为 409 USERNAME_TAKEN）              |
| patch-ignores-unknown-fields | `server.mjs` PATCH 跳过未知字段校验    | AC-19（应为 400 UNKNOWN_FIELD）                       |
| no-persistence               | `store.mjs` persist() 不写盘           | AC-04（DATA_DIR 无数据文件）/ AC-25（容器重启丢数据） |
| title-off-by-one             | `validate.mjs` 允许 101 码点           | AC-15（应为 400 TITLE_INVALID）                       |
