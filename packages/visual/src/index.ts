export {
  DEFAULT_ROLE_COMPONENT_MAP,
  FrontendTaskDraftSchema,
  attachDesignTokens,
  buildComponentMap,
  buildFrontendTasks,
  deriveApproval,
  redactDraftText,
  type DesignTokenSummary,
  type FrontendTaskBuildOptions,
  type FrontendTaskDraft,
  type MatchOptions
} from "./converter";
export {
  EvaluationError,
  PASS_DIFF_RATIO_MAX,
  PIXEL_ONLY_BAND_MAX,
  GEOMETRY_AREA_RATIO_MAX,
  GEOMETRY_SHIFT_PX_MAX,
  HOTSPOT_MAX,
  DIFF_CHANNEL_THRESHOLD,
  diffSections,
  evaluateVisuals,
  scoreEvaluation,
  serializeVisualEvaluationReportMd,
  type EvaluationReport,
  type EvaluationScore,
  type EvaluationSide,
  type MismatchKind,
  type PixelDiff,
  type SectionMismatch
} from "./evaluation";
export { encodePng, decodeMinimalPng, type DecodedPng } from "./pngEncoder";
export {
  FIX_LOOP_MAX_ROUNDS,
  FIX_LOOP_STALL_THRESHOLD,
  SCORE_SEVERITY,
  advanceFixLoop,
  buildFixTaskDrafts,
  determineFixOutcome,
  initialFixLoopState,
  serializeFixAuditTrailMd,
  visualIssuesFromReport,
  type FixAuditTrail,
  type FixLoopState,
  type FixOutcome,
  type FixOutcomeResult,
  type FixTaskDraft,
  type IssueKind,
  type LoopOutcome,
  type LoopStatus,
  type VisualIssue
} from "./autoFix";
export {
  RESPONSIVE_VIEWPORTS,
  VALIDATED_UI_STATES,
  buildCrossViewportSummary,
  detectStateRegressions,
  evaluateResponsiveMatrix,
  evaluateStateFlips,
  serializeResponsiveValidationMd,
  type CrossViewportSummary,
  type EverySharedAnnotationStateIsValidated,
  type MatrixEntry,
  type ResponsiveValidationInput,
  type StateFlip,
  type StateFlipExpectation,
  type StateFlipReport,
  type StateRegressionFindings,
  type ValidatedStateName,
  type ValidatedUiState,
  type ViewportName
} from "./validation";
export { VisualAnalyzerError, type VisualAnalyzerErrorCode } from "./errors";
export { analyzeUnifiedInput, type RealAnalyzeOptions } from "./unifiedAnalyzer";
export {
  FigmaVLMProvider,
  type FigmaVLMOptions
} from "./vlm/figmaProvider";
export { OpenAIWireVLMProvider, parseModelJson, type OpenAIWireVLMOptions } from "./vlm/openaiWireProvider";
export {
  UrlFetchVLMProvider,
  parseHtmlToObservation,
  toHttpsUrl,
  type UrlHtmlFetcher
} from "./vlm/urlFetchProvider";
export {
  fromFigmaProvider,
  fromUrlProvider,
  fromVLMProvider,
  type ObserveContext,
  type ObservableSource
} from "./vlm/unifiedSource";
export {
  analyzeSpecification,
  buildSpecification,
  extractDesignTokens,
  DEFAULT_ANALYZE_TIMEOUT_MS,
  VisualAnalyzer,
  type AnalyzeOutcome,
  type AnalyzeOptions,
  type DesignTokenFinding
} from "./analyzer";
export {
  FAKE_LEAKY_SCREENSHOT_ASSET,
  FAKE_SCREENSHOT_ASSET,
  FakeVLMProvider,
  type FakeVLMProviderOptions
} from "./vlm/fakeProvider";
export type {
  VLMElementObservation,
  VLMInvokeOptions,
  VLMPageObservation,
  VLMProvider,
  VLMRecognizeInput,
  VLMSectionObservation,
  VLMStyleObservation
} from "./vlm/types";
export {
  buildAnalysisReport,
  serializeVisualAnalysisReportMd,
  type VisualAnalysisResult
} from "./report";
export { analyzeWithReport, collectWarnings } from "./facade";
