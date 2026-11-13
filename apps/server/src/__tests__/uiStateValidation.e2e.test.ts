/**
 * Phase 5.6-6 e2e: Responsive & UI State validation over the REAL stack.
 *
 *   UI state / viewport → BrowserSession (real Chromium, real interactions)
 *   → real screenshot → frozen 5.6-4 evaluateVisuals
 *   → VisualEvaluationReport through the 5.6-6 wrappers (no second system).
 *
 * Everything is real except the model layer: a local node:http fixture page
 * (zero external network) renders the app; states are driven through real
 * controlled interactions (click / type / hover / focus / press-and-hold) and
 * each assertion reads REAL screenshot pixels; the spec sides are derived
 * from the screenshot bytes (decode + center-column band scan), never from
 * hand-built state JSON.
 *
 * Checks:
 *   1. responsive matrix — design-vs-page at desktop/tablet/mobile/custom all
 *      PASS; with the `@media (max-width:600px)` block stripped only the
 *      sub-600px viewports change (desktop/tablet pixel-identical), and the
 *      cross-viewport summary flags the variant viewports.
 *   2. UI state flips — loading / empty / error / disabled / hover / focus /
 *      active / expanded / modal each produce a REAL pixel change vs the
 *      default render; the stable control produces none (diffRatio === 0).
 *   3. state regression detection — a broken hover stylesheet is invisible to
 *      page-level comparison (default render identical) but the state flip
 *      loses its expected change and detectStateRegressions flags it.
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { BrowserSession, createRealPlaywright, type NavigateAllowlist } from "@ai-se/browser";
import {
  buildAnalysisReport,
  buildCrossViewportSummary,
  buildSpecification,
  collectWarnings,
  decodeMinimalPng,
  detectStateRegressions,
  evaluateResponsiveMatrix,
  evaluateStateFlips,
  serializeResponsiveValidationMd,
  type EvaluationReport,
  type EvaluationSide,
  type ValidatedStateName,
  type ViewportName
} from "@ai-se/visual";
import { describe, expect, it } from "vitest";

// ── environment guard ────────────────────────────────────────────────────────

function chromiumAvailable(): boolean {
  const cacheRoot = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(cacheRoot)) return false;
  return (
    existsSync(`${cacheRoot}/chromium_headless_shell-1228`) ||
    existsSync(`${cacheRoot}/chromium-1228`)
  );
}

const BROWSER_AVAILABLE = chromiumAvailable();
const ALLOW_HTTP: NavigateAllowlist = { allowedProtocols: ["http"] };

// ── fixture page (responsive layout + interactive state widgets) ─────────────

const CSS_CORE = `
  * { transition: none !important; animation: none !important; }
  body { margin: 0; background: #ffffff; font-family: sans-serif; }
  header { background: #1f2937; height: 64px; display: block; }
  main { padding: 16px; }
  button { appearance: none; -webkit-appearance: none; background: #e5e7eb; border: 1px solid #9ca3af; padding: 6px 12px; color: #111827; }
  #query { width: 320px; height: 40px; border: 2px solid #111827; outline: none; background: #ffffff; padding: 0 8px; }
  #query:focus { border-color: #16a34a; background: #f0fdf4; }
  #submit { width: 160px; height: 44px; background: #2563eb; color: #ffffff; border: 0; }
  #submit:hover { background: #7c3aed; }
  #submit:active { background: #111827; }
  #submit:disabled { background: #9ca3af; }
  #side { width: 200px; height: 200px; background: #fb923c; }
  #static-label { display: inline-block; padding: 8px; }
  .card { width: 420px; height: 72px; background: #e5e7eb; margin-top: 8px; }
  #spinner { display: none; width: 32px; height: 32px; border: 6px solid #93c5fd; border-top-color: #1d4ed8; border-radius: 50%; margin-top: 8px; }
  #spinner[data-visible="1"] { display: block; }
  #error-banner { display: none; width: 420px; padding: 12px; background: #fee2e2; color: #991b1b; margin-top: 8px; }
  #error-banner[data-visible="1"] { display: block; }
  #empty-state { display: none; width: 420px; padding: 12px; background: #f3f4f6; margin-top: 8px; }
  #empty-state[data-visible="1"] { display: block; }
  #accordion-panel { display: none; width: 420px; height: 96px; background: #dcfce7; }
  #accordion-panel[data-visible="1"] { display: block; }
  #modal { display: none; position: fixed; inset: 0; background: rgba(15, 23, 42, 0.6); }
  #modal[data-visible="1"] { display: block; }
  #modal .dialog { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 480px; height: 220px; background: #ffffff; }`;

const CARD_HOVER_RULE = `.card:hover { background: #fbbf24; }`;

const MEDIA_BLOCK = `@media (max-width: 600px) {
  header { height: 48px; }
  #side { display: none; }
  .card { width: 100%; }
}`;

/** css modes: null = complete, "broken-media" = @media block stripped,
 * "broken-hover" = card :hover rule stripped. */
function pageCss(cssMode: string | null): string {
  const pieces = [CSS_CORE];
  if (cssMode !== "broken-hover") pieces.push(CARD_HOVER_RULE);
  if (cssMode !== "broken-media") pieces.push(MEDIA_BLOCK);
  return pieces.join("\n");
}

function renderPage(cssMode: string | null): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Validation Fixture</title>
<style>${pageCss(cssMode)}</style></head><body>
<header></header>
<main>
  <div>
    <button id="refresh">refresh</button>
    <button id="submit">save</button>
    <input id="query" value="alpha">
    <span id="static-label">Static label</span>
  </div>
  <div id="side"></div>
  <div id="spinner" data-visible="0"></div>
  <div id="error-banner" data-visible="0">Failed to load items</div>
  <div id="empty-state" data-visible="0">No items found</div>
  <div id="list"><div class="card" id="card-1">alpha</div></div>
  <button id="accordion">details</button>
  <div id="accordion-panel" data-visible="0"></div>
  <button id="open-modal">open dialog</button>
  <div id="modal" data-visible="0"><div class="dialog"><button id="close-modal">close</button></div></div>
</main>
<script>
  function $(id) { return document.getElementById(id); }
  $("refresh").addEventListener("click", function () {
    $("spinner").setAttribute("data-visible", "1");
    $("error-banner").setAttribute("data-visible", "0");
    fetch("/api/items?delay=1500").then(function (res) {
      $("spinner").setAttribute("data-visible", "0");
      if (!res.ok) { $("error-banner").setAttribute("data-visible", "1"); }
    }, function () {
      $("spinner").setAttribute("data-visible", "0");
      $("error-banner").setAttribute("data-visible", "1");
    });
  });
  $("query").addEventListener("input", function () {
    var value = $("query").value.replace(/\\s+/g, "");
    $("submit").disabled = value.length === 0;
    $("list").style.display = value === "zzz" ? "none" : "block";
    $("empty-state").setAttribute("data-visible", value === "zzz" ? "1" : "0");
  });
  $("submit").disabled = false;
  $("accordion").addEventListener("click", function () { $("accordion-panel").setAttribute("data-visible", "1"); });
  $("open-modal").addEventListener("click", function () { $("modal").setAttribute("data-visible", "1"); });
  $("close-modal").addEventListener("click", function () { $("modal").setAttribute("data-visible", "0"); });
</script>
</body></html>`;
}

// ── fixture server (in-process, random port, zero external network) ──────────

interface FixtureServer {
  base: string;
  setItemsFail: (value: boolean) => void;
  stop: () => Promise<void>;
}

function startFixtureServer(): Promise<FixtureServer> {
  let itemsFail = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/favicon.ico") {
      res.writeHead(200, { "content-type": "image/x-icon" });
      res.end();
      return;
    }
    if (url.pathname === "/design" || url.pathname === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderPage(url.searchParams.get("css")));
      return;
    }
    if (url.pathname === "/api/items") {
      if (itemsFail) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("boom");
        return;
      }
      const delay = Number(url.searchParams.get("delay") ?? "0");
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [{ id: "alpha" }] }));
      }, delay);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("fixture server has no port"));
        return;
      }
      resolve({
        base: `http://127.0.0.1:${address.port}`,
        setItemsFail: (value) => {
          itemsFail = value;
        },
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          })
      });
    });
  });
}

// ── screenshot-derived spec side (same deterministic pattern as 5.6-5) ───────

const PAGE_BACKGROUND = "#ffffff";
const SECTION_COLOR_NAMES: Record<string, string> = { "#1f2937": "Header" };

function sectionNameFor(hex: string): string {
  return SECTION_COLOR_NAMES[hex] ?? `Color-${hex.replace("#", "")}`;
}

/** Decode the REAL screenshot and report one section per band of constant
 * non-background color along the vertical center column; the 5.6-1
 * normalization (buildSpecification) runs unchanged afterwards. */
function sideFromScreenshot(
  session: BrowserSession,
  shot: { seq: number; fullPage: boolean; base64: string },
  viewport: { width: number; height: number }
): EvaluationSide {
  const decoded = decodeMinimalPng(Buffer.from(shot.base64, "base64"));
  if (decoded.width !== viewport.width || decoded.height !== viewport.height) {
    throw new Error(
      `screenshot size ${decoded.width}x${decoded.height} != viewport ${viewport.width}x${viewport.height}`
    );
  }
  const { width, height } = decoded;
  const centerX = Math.floor(width / 2);
  const bands: Array<{ color: string; start: number; end: number }> = [];
  let current: { color: string; start: number; end: number } | null = null;
  for (let y = 0; y < height; y += 1) {
    const index = (y * width + centerX) * 4;
    const hex = `#${[decoded.rgba[index], decoded.rgba[index + 1], decoded.rgba[index + 2]]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")}`;
    if (hex === PAGE_BACKGROUND) {
      current = null;
      continue;
    }
    if (current && current.color === hex) {
      current.end = y;
      continue;
    }
    current = { color: hex, start: y, end: y };
    bands.push(current);
  }
  const sections = bands
    .filter((band) => band.end - band.start + 1 >= 8)
    .map((band) => {
      const name = sectionNameFor(band.color);
      return {
        name,
        rect: { x: 0, y: band.start, width, height: band.end - band.start + 1 },
        elements: [{ name, role: "other" as const }]
      };
    });
  const record = {
    inputType: "screenshot" as const,
    source: session.assetRefFor(shot),
    viewport
  };
  const specification = buildSpecification(
    { pageName: "Validation Fixture", sections, warnings: [] },
    record
  );
  const analysis = buildAnalysisReport(
    specification,
    [],
    collectWarnings(specification, []),
    new Date().toISOString()
  );
  return { record, base64: shot.base64, analysis, specification, knownGapSections: [] };
}

async function captureSide(
  session: BrowserSession,
  url: string,
  viewport: { width: number; height: number }
): Promise<EvaluationSide> {
  await session.setViewport(viewport.width, viewport.height);
  await session.goto(url);
  await session.waitForRender();
  const shot = await session.screenshot();
  return sideFromScreenshot(session, shot, { width: viewport.width, height: viewport.height });
}

// ── viewports / fixtures ─────────────────────────────────────────────────────

const VIEWPORTS: Array<{ viewportName: ViewportName; width: number; height: number }> = [
  { viewportName: "desktop", width: 1440, height: 900 },
  { viewportName: "tablet", width: 768, height: 1024 },
  { viewportName: "mobile", width: 375, height: 812 },
  { viewportName: "custom", width: 500, height: 800 }
];

const DESKTOP = { width: 1440, height: 900 };

async function withSession<T>(
  work: (session: BrowserSession) => Promise<T>
): Promise<T> {
  const session = new BrowserSession({
    playwright: createRealPlaywright(),
    navigateAllowlist: ALLOW_HTTP
  });
  try {
    await session.launch({ headless: true });
    return await work(session);
  } finally {
    await session.close();
  }
}

describe.skipIf(!BROWSER_AVAILABLE)("5.6-6 REAL responsive & UI state e2e", () => {
  it(
    "responsive matrix: desktop/tablet/mobile/custom; breakpoint scoping; variant viewports flagged",
    async () => {
      const server = await startFixtureServer();
      try {
        await withSession(async (session) => {
          // Round 1: the served page is design-faithful at every viewport.
          const round1 = [];
          for (const viewport of VIEWPORTS) {
            const reference = await captureSide(session, `${server.base}/design`, viewport);
            const candidate = await captureSide(session, `${server.base}/page`, viewport);
            const { reports } = evaluateResponsiveMatrix([
              { viewportName: viewport.viewportName, request: { reference, candidate } }
            ]);
            round1.push({ viewportName: viewport.viewportName, report: reports[0].report });
          }
          expect(round1.map((entry) => entry.report.score)).toEqual([
            "PASS",
            "PASS",
            "PASS",
            "PASS"
          ]);
          expect(round1.every((entry) => entry.report.pixel.diffRatio === 0)).toBe(true);

          // Round 2: the @media (max-width:600px) block is stripped. Only
          // sub-600px viewports may change; desktop/tablet stay pixel-exact.
          const round2 = [];
          for (const viewport of VIEWPORTS) {
            const reference = await captureSide(session, `${server.base}/design`, viewport);
            const candidate = await captureSide(
              session,
              `${server.base}/page?css=broken-media`,
              viewport
            );
            const { reports } = evaluateResponsiveMatrix([
              { viewportName: viewport.viewportName, request: { reference, candidate } }
            ]);
            round2.push({ viewportName: viewport.viewportName, report: reports[0].report });
          }
          const byName = new Map(round2.map((entry) => [entry.viewportName, entry.report]));
          expect(byName.get("desktop")?.pixel.diffRatio).toBe(0);
          expect(byName.get("desktop")?.score).toBe("PASS");
          expect(byName.get("tablet")?.pixel.diffRatio).toBe(0);
          expect(byName.get("tablet")?.score).toBe("PASS");
          for (const name of ["mobile", "custom"] as const) {
            expect(byName.get(name)?.score).not.toBe("PASS");
            expect(byName.get(name)?.pixel.diffRatio ?? 0).toBeGreaterThan(0.02);
          }

          // Cross-viewport summary: inconsistent (frozen wrapper semantics —
          // when scores diverge ALL entries are listed with their scores and
          // the per-viewport diff ratios).
          const summary = buildCrossViewportSummary(
            round2.map((entry) => ({
              viewportName: entry.viewportName,
              report: entry.report
            }))
          );
          expect(summary.consistent).toBe(false);
          expect(summary.variantViewports.map((entry) => entry.viewportName)).toEqual([
            "desktop",
            "tablet",
            "mobile",
            "custom"
          ]);
          expect(summary.variantViewports.map((entry) => entry.score)).toEqual([
            "PASS",
            "PASS",
            byName.get("mobile")?.score,
            byName.get("custom")?.score
          ]);
          expect(summary.variantViewports[2].score).not.toBe("PASS");
          expect(summary.variantViewports[3].score).not.toBe("PASS");

          // The md export carries the summary (existing serializer, no new report type).
          const markdown = serializeResponsiveValidationMd({
            header: { pageName: "Validation Fixture", evaluatedAt: new Date().toISOString() },
            matrixReports: round2,
            stateReports: [],
            crossViewport: summary
          });
          expect(markdown).toContain("## viewport mobile");
          expect(markdown).toContain("- consistent: false");
          expect(markdown).toContain("mobile");
        });
      } finally {
        await server.stop();
      }
    },
    300_000
  );

  it(
    "UI state flips: nine real states each change the pixels; the stable control does not",
    async () => {
      const server = await startFixtureServer();
      try {
        await withSession(async (session) => {
          const baseUrl = `${server.base}/page`;

          interface FlipResult {
            stateName: ValidatedStateName;
            report: EvaluationReport;
          }
          const flips: FlipResult[] = [];

          const runFlip = async (
            stateName: ValidatedStateName,
            trigger: (session: BrowserSession) => Promise<void>,
            drain: (session: BrowserSession) => Promise<void> = async () => {}
          ) => {
            const base = await captureSide(session, baseUrl, DESKTOP);
            await trigger(session);
            const shot = await session.screenshot();
            const stateSide = sideFromScreenshot(session, shot, DESKTOP);
            const { reports } = evaluateStateFlips([
              { stateName, request: { reference: base, candidate: stateSide } }
            ]);
            flips.push({ stateName, report: reports[0].report });
            await drain(session);
          };

          // loading — the refresh click starts a 1500ms fetch; the spinner is
          // captured while the request is still pending (no settle wait).
          await runFlip("loading", async (s) => {
            await s.click("#refresh");
          }, async (s) => {
            await s.waitForRender();
          });

          // empty — typing the filter value hides the list and shows the
          // empty state (real input event).
          await runFlip("empty", async (s) => {
            await s.type("#query", "zzz");
          });

          // error — the refresh fetch fails with a real HTTP 500.
          await runFlip("error", async (s) => {
            server.setItemsFail(true);
            await s.click("#refresh");
            await s.waitForRender();
            server.setItemsFail(false);
          });
          const networkEvidence = session.getErrors().network;
          expect(networkEvidence.some((entry) => entry.kind === "http_5xx")).toBe(true);

          // disabled — clearing the input disables the submit button.
          await runFlip("disabled", async (s) => {
            await s.type("#query", "");
          });

          // hover — real pointer move applies the card :hover style.
          await runFlip("hover", async (s) => {
            await s.hover("#card-1");
          });

          // focus — real DOM focus applies the input :focus style.
          await runFlip("focus", async (s) => {
            await s.focus("#query");
          });

          // active — press-and-hold captures the :active style.
          await runFlip("active", async (s) => {
            await s.mouseDown("#submit");
          }, async (s) => {
            await s.mouseUp();
          });

          // expanded — the accordion click reveals the panel.
          await runFlip("expanded", async (s) => {
            await s.click("#accordion");
          });

          // modal — the dialog click opens the overlay.
          await runFlip("modal", async (s) => {
            await s.click("#open-modal");
          });

          expect(flips).toHaveLength(9);
          const ratios: Record<string, number> = {};
          for (const flip of flips) {
            ratios[flip.stateName] = flip.report.pixel.diffRatio;
          }
          console.log("[5.6-6 state diff ratios]", JSON.stringify(ratios));
          for (const flip of flips) {
            expect(
              flip.report.pixel.diffRatio,
              `state ${flip.stateName} produced no pixel change`
            ).toBeGreaterThan(0);
          }
          const modal = flips.find((flip) => flip.stateName === "modal");
          expect(modal?.report.score).toBe("LAYOUT");

          // Stable control: hovering a non-interactive element changes nothing
          // (diffRatio exactly 0 — the pinned equality from the browser e2e).
          const controlBase = await captureSide(session, baseUrl, DESKTOP);
          await session.hover("#static-label");
          const controlShot = await session.screenshot();
          const controlSide = sideFromScreenshot(session, controlShot, DESKTOP);
          const { reports: controlReports } = evaluateStateFlips([
            {
              stateName: "hover",
              request: { reference: controlBase, candidate: controlSide }
            }
          ]);
          expect(controlReports[0].report.pixel.diffRatio).toBe(0);

          // Regression verdicts on the healthy page: no findings.
          expect(
            detectStateRegressions(
              flips.map((flip) => ({
                stateName: flip.stateName,
                expected: "change" as const,
                report: flip.report
              }))
            )
          ).toEqual({ missingChange: [], unexpectedChange: [] });
        });
      } finally {
        await server.stop();
      }
    },
    300_000
  );

  it(
    "state regression detection: broken hover CSS is invisible page-level but flagged state-level",
    async () => {
      const server = await startFixtureServer();
      try {
        await withSession(async (session) => {
          // Healthy page: hover flip shows the real change.
          const healthyBase = await captureSide(session, `${server.base}/page`, DESKTOP);
          await session.hover("#card-1");
          const healthyHover = sideFromScreenshot(session, await session.screenshot(), DESKTOP);
          const { reports: healthyReports } = evaluateStateFlips([
            { stateName: "hover", request: { reference: healthyBase, candidate: healthyHover } }
          ]);
          expect(healthyReports[0].report.pixel.diffRatio).toBeGreaterThan(0);

          // Broken page: the :hover rule is stripped.
          const brokenBase = await captureSide(
            session,
            `${server.base}/page?css=broken-hover`,
            DESKTOP
          );
          await session.hover("#card-1");
          const brokenHover = sideFromScreenshot(session, await session.screenshot(), DESKTOP);
          const { reports: brokenReports } = evaluateStateFlips([
            { stateName: "hover", request: { reference: brokenBase, candidate: brokenHover } }
          ]);
          expect(brokenReports[0].report.pixel.diffRatio).toBe(0);

          // Page-level comparison is blind to it (default renders identical)…
          const { reports: pageLevel } = evaluateStateFlips([
            {
              stateName: "hover",
              request: { reference: healthyBase, candidate: brokenBase }
            }
          ]);
          expect(pageLevel[0].report.pixel.diffRatio).toBe(0);

          // …while the state flip loses its expected change and is flagged.
          expect(
            detectStateRegressions([
              {
                stateName: "hover",
                expected: "change",
                report: healthyReports[0].report
              }
            ])
          ).toEqual({ missingChange: [], unexpectedChange: [] });
          expect(
            detectStateRegressions([
              {
                stateName: "hover",
                expected: "change",
                report: brokenReports[0].report
              }
            ])
          ).toEqual({ missingChange: ["hover"], unexpectedChange: [] });
        });
      } finally {
        await server.stop();
      }
    },
    300_000
  );
});
