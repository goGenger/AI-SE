/**
 * Page module under fix (initial state: only the Header band is rendered —
 * the Body band required by reference/design.body.html is missing). Bands use
 * the fixture's section palette so the visual analysis can identify sections
 * from the rendered screenshot.
 */
export function renderFixturePage() {
  return `
<div style="width:100%;height:60px;background:#112233"></div>
`;
}
