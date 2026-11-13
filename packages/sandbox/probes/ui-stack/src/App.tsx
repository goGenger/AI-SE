/**
 * 探针靶子（`docs/234` §3）：断言**计算样式**，不是类名——类名出现在 HTML 里不代表 CSS 生成并生效。
 *
 * - `text-[#123456]` → computed color `rgb(18, 52, 86)`
 * - `p-4`           → computed paddingTop `16px`
 */
export default function App() {
  return (
    <main className="p-4">
      <h1 data-testid="probe-title" className="p-4 text-[#123456]">
        AI-SE UI stack probe
      </h1>
    </main>
  );
}
