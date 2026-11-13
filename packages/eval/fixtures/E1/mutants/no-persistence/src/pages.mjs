// 首页 HTML（含约定的 data-testid：home-title / task-list / search-input / new-task-button）。
export const HOME_HTML = `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <title>TaskBoard</title>
  </head>
  <body>
    <h1 data-testid="home-title">TaskBoard</h1>
    <input data-testid="search-input" type="search" placeholder="搜索任务" />
    <ul data-testid="task-list"></ul>
    <button data-testid="new-task-button">新建任务</button>
  </body>
</html>`;
