package app

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func runImageTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunImageTask(ctx, input)
}

func runGeminiImageTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunGeminiImageTask(ctx, input)
}

func geminiImageConfigFor(config providerConfig) *geminiImageConfig {
	return generation.GeminiImageConfigFor(config)
}

func geminiImageBytes(media providerMedia) ([]byte, string, error) {
	return generation.GeminiImageBytes(media)
}

func geminiImageDataURLs(payload map[string]interface{}) ([]map[string]string, error) {
	return generation.GeminiImageDataURLs(payload)
}

func runGrokImageTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunGrokImageTask(ctx, input)
}

func grokImageRequestBody(input canvasGenerationInput) (grokImageRequest, string, error) {
	return generation.GrokImageRequestBody(input)
}

func normalizeGrokImageResolution(quality string) string {
	return generation.NormalizeGrokImageResolution(quality)
}

func normalizeGrokImageAspectRatio(size string) string {
	return generation.NormalizeGrokImageAspectRatio(size)
}

func grokImageInputURL(media providerMedia) (string, error) {
	return generation.GrokImageInputURL(media)
}

func runVolcengineArkImageTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunVolcengineArkImageTask(ctx, input)
}

func volcengineArkImageDataURLs(ctx context.Context, config providerConfig, payload imageResponse) ([]map[string]string, error) {
	return generation.MaterializeImageDataURLs(ctx, config, payload)
}

func volcengineArkImageBody(input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.VolcengineArkImageBody(input)
}

func normalizeVolcengineArkImageSize(value string) string {
	return generation.NormalizeVolcengineArkImageSize(value)
}

func imageDataURLs(payload imageResponse) ([]map[string]string, error) {
	return generation.ImageDataURLs(payload)
}

func runAgentToolTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunAgentToolTask(ctx, input)
}

func postAgentRequest(ctx context.Context, input canvasGenerationInput, path string, body map[string]interface{}, protocol string) (map[string]interface{}, error) {
	return generation.PostAgentRequest(ctx, input, path, body, protocol)
}

func runDeclarativeAgentTask(ctx context.Context, input canvasGenerationInput, adapter protocol.AgentAdapter) (map[string]interface{}, error) {
	return generation.RunDeclarativeAgentTask(ctx, input, adapter)
}

func claudeAgentBody(request map[string]interface{}) map[string]interface{} {
	return generation.ClaudeAgentBody(request)
}

func mapClaudeMessageRole(role string) string {
	return generation.MapClaudeMessageRole(role)
}

func claudeToolInput(value interface{}) interface{} {
	return generation.ClaudeToolInput(value)
}

func claudeToolChoice(value interface{}) interface{} {
	return generation.ClaudeToolChoice(value)
}

func isAgentToolChoiceCompatibilityError(err error) bool {
	return generation.IsAgentToolChoiceCompatibilityError(err)
}

func isAutoAgentToolChoice(value interface{}) bool {
	return generation.IsAutoAgentToolChoice(value)
}

func parseAgentToolPayload(payload map[string]interface{}, protocol string) (map[string]interface{}, error) {
	return generation.ParseAgentToolPayload(payload, protocol)
}

func postStreamingAgent(ctx context.Context, config providerConfig, path string, body map[string]interface{}, protocol string, onDelta func(string), onReasoning ...func(string)) (map[string]interface{}, error) {
	return generation.PostStreamingAgent(ctx, config, path, body, protocol, onDelta, onReasoning...)
}

func newStreamingAgentParser(protocol string, emit func(string)) *streamingAgentParser {
	return generation.NewStreamingAgentParser(protocol, emit)
}

func resultString(value map[string]interface{}, key string) string {
	return generation.ResultString(value, key)
}

func intField(value map[string]interface{}, key string, fallback int) int {
	return generation.IntField(value, key, fallback)
}

func extractResponseReasoning(payload map[string]interface{}) string {
	return generation.ExtractResponseReasoning(payload)
}

func interfaceSlice(value interface{}) []interface{} {
	return generation.InterfaceSlice(value)
}

func cloneStringAnyMap(value map[string]interface{}) map[string]interface{} {
	return generation.CloneStringAnyMap(value)
}

func runTextTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunTextTask(ctx, input)
}

func runLegacyTextTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunLegacyTextTask(ctx, input)
}

func runResponsesTextTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunResponsesTextTask(ctx, input)
}

func runChatCompletionsTextTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunChatCompletionsTextTask(ctx, input)
}

func runClaudeTextTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunClaudeTextTask(ctx, input)
}

func applyTextThinking(body map[string]interface{}, input canvasGenerationInput, protocol string) {
	generation.ApplyTextThinking(body, input, protocol)
}

func normalizeAgentToolChoice(body map[string]interface{}, input canvasGenerationInput, protocol string) {
	generation.NormalizeAgentToolChoice(body, input, protocol)
}

func providerTextTaskResult(result providerTextResult) map[string]interface{} {
	return generation.ProviderTextTaskResult(result)
}

func applyTextOutputLimit(body map[string]interface{}, limit int, field string) {
	generation.ApplyTextOutputLimit(body, limit, field)
}

func claudeTextContent(input canvasGenerationInput) (interface{}, error) {
	return generation.ClaudeTextContent(input)
}

func splitDataURL(value string) (string, string, bool) {
	return generation.SplitDataURL(value)
}

func textResponseInput(input canvasGenerationInput) (interface{}, error) {
	return generation.TextResponseInput(input)
}

func validatedTextHistory(history []providerTextMessage) []map[string]interface{} {
	return generation.ValidatedTextHistory(history)
}

func textResponseContent(input canvasGenerationInput) ([]map[string]interface{}, error) {
	return generation.TextResponseContent(input)
}

func textChatContent(input canvasGenerationInput) (interface{}, error) {
	return generation.TextChatContent(input)
}

func shouldFallbackTextToChat(err error) bool {
	return generation.ShouldFallbackTextToChat(err)
}

func requestTextProvider(ctx context.Context, config providerConfig, path string, body map[string]interface{}, protocol string, stream bool, onDelta func(string)) (providerTextResult, error) {
	return generation.RequestTextProvider(ctx, config, path, body, protocol, stream, onDelta)
}

func postStreamingText(ctx context.Context, config providerConfig, path string, body map[string]interface{}, protocol string, onDelta func(string)) (string, error) {
	return generation.PostStreamingText(ctx, config, path, body, protocol, onDelta)
}

func postStreamingTextResult(ctx context.Context, config providerConfig, path string, body map[string]interface{}, protocol string, onDelta func(string)) (providerTextResult, error) {
	return generation.PostStreamingTextResult(ctx, config, path, body, protocol, onDelta)
}

func extractTextPayload(payload map[string]interface{}, protocol string) string {
	return generation.ExtractTextPayload(payload, protocol)
}

func validateTextPayload(payload map[string]interface{}) error {
	return generation.ValidateTextPayload(payload)
}

func parseTextEventStream(data []byte, protocol string) (string, error) {
	return generation.ParseTextEventStream(data, protocol)
}

func streamContentText(value interface{}) string {
	return generation.StreamContentText(value)
}

func newStreamingTextDeltaParser(protocol string, emit func(string)) *streamingTextDeltaParser {
	return generation.NewStreamingTextDeltaParser(protocol, emit)
}

func streamingTextDelta(protocol string, eventName string, payload map[string]interface{}) string {
	return generation.StreamingTextDelta(protocol, eventName, payload)
}

func extractResponseText(payload map[string]interface{}) string {
	return generation.ExtractResponseText(payload)
}

func extractChatCompletionText(payload map[string]interface{}) string {
	return generation.ExtractChatCompletionText(payload)
}

type streamingAgentToolCall = generation.StreamingAgentToolCall
type streamingAgentParser = generation.StreamingAgentParser
type providerTextResult = generation.ProviderTextResult
type streamingTextDeltaParser = generation.StreamingTextDeltaParser

func restoreBeefAPISeedanceAudioControl(ctx context.Context, config providerConfig, video *VideoCapabilityConfig) {
	generation.RestoreBeefAPISeedanceAudioControl(ctx, config, video)
}

func runVideoTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunVideoTask(ctx, input)
}

func runVideoTaskWithPolicy(ctx context.Context, input canvasGenerationInput, pollPolicy videoPollPolicy) (map[string]interface{}, error) {
	return generation.RunVideoTaskWithPolicy(ctx, input, pollPolicy)
}

func newAPIVideoResultURL(state map[string]interface{}) string {
	return generation.NewAPIVideoResultURL(state)
}

func nestedNewAPIVideoResultURL(payload map[string]interface{}, allowResultURL bool, depth int) string {
	return generation.NestedNewAPIVideoResultURL(payload, allowResultURL, depth)
}

func grokVideoBody(input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.GrokVideoBody(input)
}

func runSeedanceVideosTask(ctx context.Context, input canvasGenerationInput, pollPolicy videoPollPolicy) (map[string]interface{}, error) {
	return generation.RunSeedanceVideosTask(ctx, input, pollPolicy)
}

func seedancePollStatusAndURL(state map[string]interface{}) (string, string) {
	return generation.SeedancePollStatusAndURL(state)
}

func beefAPIVideoRequestBody(input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.BeefAPIVideoRequestBody(input)
}

func runSeedanceAgentPlanVideoTask(ctx context.Context, input canvasGenerationInput, pollPolicy videoPollPolicy) (map[string]interface{}, error) {
	return generation.RunSeedanceAgentPlanVideoTask(ctx, input, pollPolicy)
}

func seedanceContent(input canvasGenerationInput) ([]map[string]interface{}, error) {
	return generation.SeedanceContent(input)
}

func shouldSendNewAPIVideoImages(input canvasGenerationInput) bool {
	return generation.ShouldSendNewAPIVideoImages(input)
}

func videoCapabilitySupportsAudio(input canvasGenerationInput) bool {
	return generation.VideoCapabilitySupportsAudio(input)
}

func videoCapabilitySupportsWatermark(input canvasGenerationInput) bool {
	return generation.VideoCapabilitySupportsWatermark(input)
}

func newAPIVideoPromptText(input canvasGenerationInput) string {
	return generation.NewAPIVideoPromptText(input)
}

func seedanceVideosRequestBody(input canvasGenerationInput) (seedanceVideosRequest, error) {
	return generation.SeedanceVideosRequestBody(input)
}

func seedanceVideosBody(input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.SeedanceVideosBody(input)
}

func seedancePromptText(input canvasGenerationInput) string {
	return generation.SeedancePromptText(input)
}

func seedanceVideosPromptText(input canvasGenerationInput) string {
	return generation.SeedanceVideosPromptText(input)
}

func videoImageRole(input canvasGenerationInput, image providerMedia) string {
	return generation.VideoImageRole(input, image)
}

func seedanceTaskImageRole(input canvasGenerationInput, image providerMedia) string {
	return generation.SeedanceTaskImageRole(input, image)
}

func seedanceTaskOptions(input canvasGenerationInput) protocol.GenerationRequest {
	return generation.SeedanceTaskOptions(input)
}

func videoImageRoleOrDefault(input canvasGenerationInput, image providerMedia, fallback string) string {
	return generation.VideoImageRoleOrDefault(input, image, fallback)
}

func videoFrameImageURLs(input canvasGenerationInput, imageURLs []string) ([]string, error) {
	return generation.VideoFrameImageURLs(input, imageURLs)
}

func mediaReferenceURL(media providerMedia) (string, error) {
	return generation.MediaReferenceURL(media)
}

func seedanceVideosMediaURL(media providerMedia) (string, error) {
	return generation.SeedanceVideosMediaURL(media)
}

func beefAPIAudioURL(media providerMedia) (string, error) {
	return generation.BeefAPIAudioURL(media)
}

func seedanceErrorMessage(state map[string]interface{}) string {
	return generation.SeedanceErrorMessage(state)
}

func runAudioTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunAudioTask(ctx, input)
}

func runAsyncAudioTask(ctx context.Context, input canvasGenerationInput, body map[string]interface{}, format string) (map[string]interface{}, error) {
	return generation.RunAsyncAudioTask(ctx, input, body, format)
}

func asyncAudioPayload(payload map[string]interface{}) map[string]interface{} {
	return generation.AsyncAudioPayload(payload)
}

func asyncAudioSucceeded(state map[string]interface{}) bool {
	return generation.AsyncAudioSucceeded(state)
}

func asyncAudioResult(ctx context.Context, config providerConfig, id string, state map[string]interface{}, format string) (map[string]interface{}, error) {
	return generation.AsyncAudioResult(ctx, config, id, state, format)
}

func asyncAudioResultURL(state map[string]interface{}) string {
	return generation.AsyncAudioResultURL(state)
}

func asyncAudioErrorMessage(state map[string]interface{}) string {
	return generation.AsyncAudioErrorMessage(state)
}

func decodeProviderDataURL(value string) (string, []byte, error) {
	return generation.DecodeProviderDataURL(value)
}

func providerGeneratedFileLimit(ctx context.Context) (int64, error) {
	return generation.GeneratedFileLimit(ctx)
}

func validateGeneratedAudio(declared string, data []byte, format string) (string, error) {
	return generation.ValidateGeneratedAudio(declared, data, format)
}

func audioSignatureMatches(mimeType string, data []byte) bool {
	return generation.AudioSignatureMatches(mimeType, data)
}

func resolvedAudioSpeechVoice(model, voice string) string {
	return generation.ResolvedAudioSpeechVoice(model, voice)
}

func isOpenAISpeechVoice(voice string) bool {
	return generation.IsOpenAISpeechVoice(voice)
}

func audioFormatMimeType(format string) string {
	return generation.AudioFormatMimeType(format)
}

func runDeclarativeProtocolTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunDeclarativeProtocolTask(ctx, input)
}

func runProtocolAdapterTask(ctx context.Context, input canvasGenerationInput, adapter protocol.Adapter) (map[string]interface{}, error) {
	return generation.RunProtocolAdapterTask(ctx, input, adapter)
}

func declarativeProtocolPollPolicy(mode string) videoPollPolicy {
	return generation.DeclarativeProtocolPollPolicy(mode)
}

func runProtocolAdapterTaskWithPolicy(ctx context.Context, input canvasGenerationInput, adapter protocol.Adapter, policy videoPollPolicy) (map[string]interface{}, error) {
	return generation.RunProtocolAdapterTaskWithPolicy(ctx, input, adapter, policy)
}

func extractProviderTaskID(body []byte) (string, error) {
	return generation.ExtractProviderTaskID(body)
}

func queryProtocolAdapterVideoTask(ctx context.Context, input canvasGenerationInput, adapter protocol.Adapter, taskID string) (map[string]interface{}, string, error) {
	return generation.QueryProtocolAdapterVideoTask(ctx, input, adapter, taskID)
}

func protocolRequestFromInput(input canvasGenerationInput) protocol.GenerationRequest {
	return generation.ProtocolRequestFromInput(input)
}

func protocolImageAspectRatio(input canvasGenerationInput) string {
	return generation.ProtocolImageAspectRatio(input)
}

func protocolImageReferences(input canvasGenerationInput) []protocol.MediaReference {
	return generation.ProtocolImageReferences(input)
}

func protocolVideoImageReferences(input canvasGenerationInput) []protocol.MediaReference {
	return generation.ProtocolVideoImageReferences(input)
}

func protocolMediaReferences(values []providerMedia, kind string) []protocol.MediaReference {
	return generation.ProtocolMediaReferences(values, kind)
}

func protocolMediaReference(value providerMedia, kind string, order int) protocol.MediaReference {
	return generation.ProtocolMediaReference(value, kind, order)
}

func executeProtocolRequest(ctx context.Context, config providerConfig, spec protocol.RequestSpec) ([]byte, error) {
	return generation.ExecuteProtocolRequest(ctx, config, spec)
}

func executeProtocolBinaryRequest(ctx context.Context, config providerConfig, spec protocol.RequestSpec) ([]byte, string, error) {
	return generation.ExecuteProtocolBinaryRequest(ctx, config, spec)
}

func executeProtocolBinaryRequestWithConsumer(ctx context.Context, config providerConfig, spec protocol.RequestSpec, consume func(string, []byte)) ([]byte, string, error) {
	return generation.ExecuteProtocolBinaryRequestWithConsumer(ctx, config, spec, consume)
}

func protocolRequestBody(ctx context.Context, config providerConfig, spec protocol.RequestSpec) (io.Reader, string, error) {
	return generation.ProtocolRequestBody(ctx, config, spec)
}

func protocolBodyObject(value any) map[string]any {
	return generation.ProtocolBodyObject(value)
}

func protocolFormValues(value any) []string {
	return generation.ProtocolFormValues(value)
}

func safeProtocolFilename(value string) string {
	return generation.SafeProtocolFilename(value)
}

func applyProtocolAuth(req *http.Request, config providerConfig, auth protocol.ManifestAuth) error {
	return generation.ApplyProtocolAuth(req, config, auth)
}

func signProtocolAWSV4(req *http.Request, accessKey, secretKey string, auth protocol.ManifestAuth) error {
	return generation.SignProtocolAWSV4(req, accessKey, secretKey, auth)
}

func signProtocolTC3(req *http.Request, secretID, secretKey string, auth protocol.ManifestAuth) error {
	return generation.SignProtocolTC3(req, secretID, secretKey, auth)
}

func protocolRequestPayload(req *http.Request) ([]byte, error) {
	return generation.ProtocolRequestPayload(req)
}

func protocolCanonicalHeaders(req *http.Request) (string, string) {
	return generation.ProtocolCanonicalHeaders(req)
}

func protocolHMAC(key []byte, value string) []byte {
	return generation.ProtocolHMAC(key, value)
}

func sha256Hex(value []byte) string {
	return generation.Sha256Hex(value)
}

func protocolCredentialField(config providerConfig, field string) string {
	return generation.ProtocolCredentialField(config, field)
}

func protocolRequestURL(baseURL string, spec protocol.RequestSpec) (string, error) {
	return generation.ProtocolRequestURL(baseURL, spec)
}

func appendProtocolQuery(rawURL string, values map[string][]string) (string, error) {
	return generation.AppendProtocolQuery(rawURL, values)
}

func finishProtocolResult(ctx context.Context, config providerConfig, mode string, taskID string, result *protocol.Result, pollPolicy videoPollPolicy) (map[string]interface{}, error) {
	return generation.FinishProtocolResult(ctx, config, mode, taskID, result, pollPolicy)
}

func finishProtocolAdapterResult(ctx context.Context, input canvasGenerationInput, adapter protocol.Adapter, request protocol.GenerationRequest, taskID string, result *protocol.Result, pollPolicy videoPollPolicy) (map[string]interface{}, error) {
	return generation.FinishProtocolAdapterResult(ctx, input, adapter, request, taskID, result, pollPolicy)
}

func protocolResultHasOutput(mode string, result *protocol.Result) bool {
	return generation.ProtocolResultHasOutput(mode, result)
}

func protocolMediaBytes(ctx context.Context, config providerConfig, reference protocol.MediaReference) ([]byte, string, error) {
	return generation.ProtocolMediaBytes(ctx, config, reference)
}

func protocolMediaBytesOnce(ctx context.Context, config providerConfig, reference protocol.MediaReference) ([]byte, string, error) {
	return generation.ProtocolMediaBytesOnce(ctx, config, reference)
}

func retryableProtocolMediaDownload(err error) bool {
	return generation.RetryableProtocolMediaDownload(err)
}

func protocolResultError(message, taskID string, bodies ...[]byte) error {
	return generation.ProtocolResultError(message, taskID, bodies...)
}

func validateGenerationInterface(mode string, interfaceType string) error {
	return generation.ValidateGenerationInterface(mode, interfaceType)
}

func validateGenerationInterfaceWithRegistry(registry *protocol.Registry, mode string, interfaceType string) error {
	return generation.ValidateGenerationInterfaceWithRegistry(registry, mode, interfaceType)
}

func protocolCapabilityMatches(metadata protocol.Metadata, capability protocol.Capability) bool {
	return generation.ProtocolCapabilityMatches(metadata, capability)
}

func isVolcengineJiMengProtocol(protocol string) bool {
	return generation.IsVolcengineJiMengProtocol(protocol)
}

func runVolcengineJiMengImageTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return generation.RunVolcengineJiMengImageTask(ctx, input)
}

func submitJiMengTask(ctx context.Context, config providerConfig, body map[string]interface{}) (string, error) {
	return generation.SubmitJiMengTask(ctx, config, body)
}

func pollJiMengTask(ctx context.Context, config providerConfig, taskID string, reqJSON string) (jiMengResponse, error) {
	return generation.PollJiMengTask(ctx, config, taskID, reqJSON)
}

func postJiMengJSON(ctx context.Context, config providerConfig, action string, body interface{}, target interface{}) error {
	return generation.PostJiMengJSON(ctx, config, action, body, target)
}

func validateJiMengResponse(payload jiMengResponse) error {
	return generation.ValidateJiMengResponse(payload)
}

func jiMengImageDataURLs(ctx context.Context, payload jiMengResponse) ([]string, error) {
	return generation.JiMengImageDataURLs(ctx, payload)
}

func jiMengImageDimensions(value string) (int, int) {
	return generation.JiMengImageDimensions(value)
}

type jiMengResponse = generation.JiMengResponse

func expandCanonicalAgentRequest(source *canonicalAgentRequest, config providerConfig, declarative bool) (*agentToolRequests, error) {
	return generation.ExpandCanonicalAgentRequest(source, config, declarative)
}

func canonicalAgentChatBody(source *canonicalAgentRequest, claude bool) map[string]interface{} {
	return generation.CanonicalAgentChatBody(source, claude)
}

func canonicalAgentResponsesBody(source *canonicalAgentRequest) map[string]interface{} {
	return generation.CanonicalAgentResponsesBody(source)
}

func canonicalAgentGeminiBody(source *canonicalAgentRequest) map[string]interface{} {
	return generation.CanonicalAgentGeminiBody(source)
}

func canonicalAgentContent(content interface{}, format string) interface{} {
	return generation.CanonicalAgentContent(content, format)
}

func canonicalAgentDataURL(value string) (string, string, bool) {
	return generation.CanonicalAgentDataURL(value)
}

func validateCanonicalAgentContent(content interface{}) error {
	return generation.ValidateCanonicalAgentContent(content)
}

func canonicalAgentJSONValue(value interface{}) interface{} {
	return generation.CanonicalAgentJSONValue(value)
}

func canonicalAgentToolCalls(value interface{}) []map[string]interface{} {
	return generation.CanonicalAgentToolCalls(value)
}

func canonicalAgentJSONObject(value interface{}) map[string]interface{} {
	return generation.CanonicalAgentJSONObject(value)
}

func canonicalAgentText(content interface{}) string {
	return generation.CanonicalAgentText(content)
}

func defaultVideoPollPolicy() videoPollPolicy {
	return generation.DefaultVideoPollPolicy()
}

func runVideoPollLoop(ctx context.Context, taskID string, policy videoPollPolicy, query func(context.Context) (videoPollOutcome, error)) (map[string]interface{}, error) {
	return generation.RunVideoPollLoop(ctx, taskID, policy, query)
}

func normalizeVideoPollPolicy(policy videoPollPolicy) videoPollPolicy {
	return generation.NormalizeVideoPollPolicy(policy)
}

func runVideoDownload(ctx context.Context, taskID string, policy videoPollPolicy, download func(context.Context) ([]byte, string, error)) ([]byte, string, error) {
	return generation.RunVideoDownload(ctx, taskID, policy, download)
}

func retryableVideoPollError(ctx context.Context, err error) (retry bool, notFound bool) {
	return generation.RetryableVideoPollError(ctx, err)
}

func isTransientResponseDecodeError(err error) bool {
	return generation.IsTransientResponseDecodeError(err)
}

func notifyTaskVideoPollEvent(ctx context.Context, taskID string, event videoPollEvent, eventErr error) {
	generation.NotifyPollEvent(ctx, taskID, event, eventErr)
}

func isProviderTaskNotReadyError(httpErr providerHTTPError) bool {
	return generation.IsProviderTaskNotReadyError(httpErr)
}

func providerRetryAfter(err error) time.Duration {
	return generation.ProviderRetryAfter(err)
}

type videoPollPolicy = generation.VideoPollPolicy
type videoPollEvent = generation.VideoPollEvent
type videoPollOutcome = generation.VideoPollOutcome
type videoDownloadError = generation.VideoDownloadError

func isPublicMediaURL(value string) bool {
	return generation.IsPublicMediaURL(value)
}

func isSeedanceVideoConfig(config providerConfig) bool {
	return generation.IsSeedanceVideoConfig(config)
}

func isBeefAPIVideoConfig(ctx context.Context, config providerConfig) bool {
	return generation.IsBeefAPIVideoConfig(ctx, config)
}

func isBeefAPISeedancePreuploadConfig(ctx context.Context, config providerConfig) bool {
	return generation.IsBeefAPISeedancePreuploadConfig(ctx, config)
}

func isGrokVideoConfig(config providerConfig) bool {
	return generation.IsGrokVideoConfig(config)
}

func isArkPlanVideoConfig(config providerConfig) bool {
	return generation.IsArkPlanVideoConfig(config)
}

func normalizeImageQuality(value string) string {
	return generation.NormalizeImageQuality(value)
}

func imageParameterSupported(profile *ImageCapabilityConfig, parameter string) bool {
	return generation.ImageParameterSupported(profile, parameter)
}

func imageQualitySupported(profile *ImageCapabilityConfig) bool {
	return generation.ImageQualitySupported(profile)
}

func imageTransparentBackgroundSupported(profile *ImageCapabilityConfig) bool {
	return generation.ImageTransparentBackgroundSupported(profile)
}

func imageSizeParameter(profile *ImageCapabilityConfig, value string) (string, string) {
	return generation.ImageSizeParameter(profile, value)
}

func normalizeImageAspectRatio(value string) string {
	return generation.NormalizeImageAspectRatio(value)
}

func imageDimensionGCD(left int, right int) int {
	return generation.ImageDimensionGCD(left, right)
}

func normalizePixelSize(value string) string {
	return generation.NormalizePixelSize(value)
}

func normalizeVideoSize(value string) string {
	return generation.NormalizeVideoSize(value)
}

func normalizeVideoResolution(value string) string {
	return generation.NormalizeVideoResolution(value)
}

func normalizeSeedanceDuration(value string) int {
	return generation.NormalizeSeedanceDuration(value)
}

func normalizeSeedanceVideosDuration(value string) int {
	return generation.NormalizeSeedanceVideosDuration(value)
}

func normalizeSeedanceRatio(value string) string {
	return generation.NormalizeSeedanceRatio(value)
}

func normalizeSeedanceVideosRatio(value string) string {
	return generation.NormalizeSeedanceVideosRatio(value)
}

func normalizeSeedanceResolution(value string, interfaceType string) string {
	return generation.NormalizeSeedanceResolution(value, interfaceType)
}

func parseBool(value string, fallback bool) bool {
	return generation.ParseBool(value, fallback)
}

func parseFloat(value string, fallback float64) float64 {
	return generation.ParseFloat(value, fallback)
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	return generation.SleepContext(ctx, duration)
}

func prepareBeefAPISeedanceReferences(ctx context.Context, config providerConfig, input *canvasGenerationInput, read beefAPISeedanceMediaReader) error {
	return generation.PrepareBeefAPIVideoReferences(ctx, config, input, read)
}

func beefAPISeedanceMediaGroups(input *canvasGenerationInput) []beefAPISeedanceMediaGroup {
	return generation.BeefAPISeedanceMediaGroups(input)
}

func skipBeefAPISeedanceMedia(media providerMedia) bool {
	return generation.SkipBeefAPISeedanceMedia(media)
}

func readBeefAPISeedanceInlineMedia(kind string, media providerMedia) ([]byte, string, bool, error) {
	return generation.ReadBeefAPISeedanceInlineMedia(kind, media)
}

func fallbackBeefAPISeedanceInline(ctx context.Context, input *canvasGenerationInput, read beefAPISeedanceMediaReader) error {
	return generation.FallbackBeefAPISeedanceInline(ctx, input, read)
}

func createBeefAPISeedanceUpload(ctx context.Context, config providerConfig, request beefAPISeedanceUploadRequest) (beefAPISeedanceUploadSession, error) {
	return generation.CreateBeefAPISeedanceUpload(ctx, config, request)
}

func completeBeefAPISeedanceUpload(ctx context.Context, config providerConfig, session beefAPISeedanceUploadSession, data []byte) (beefAPISeedanceUploadComplete, error) {
	return generation.CompleteBeefAPISeedanceUpload(ctx, config, session, data)
}

func beefAPISeedancePutTimeout(ctx context.Context) time.Duration {
	return generation.BeefAPISeedancePutTimeout(ctx)
}

func putBeefAPISeedanceBytes(ctx context.Context, session beefAPISeedanceUploadSession, data []byte) error {
	return generation.PutBeefAPISeedanceBytes(ctx, session, data)
}

func validateBeefAPISeedanceSession(ctx context.Context, session beefAPISeedanceUploadSession) error {
	return generation.ValidateBeefAPISeedanceSession(ctx, session)
}

func validateBeefAPISeedanceSecureURL(ctx context.Context, raw string) error {
	return generation.ValidateBeefAPISeedanceSecureURL(ctx, raw)
}

func beefAPISeedanceAllowInsecureTestURL(ctx context.Context, parsed *url.URL) bool {
	return generation.BeefAPISeedanceAllowInsecureTestURL(ctx, parsed)
}

func skipBeefAPISeedancePutHeader(name string) bool {
	return generation.SkipBeefAPISeedancePutHeader(name)
}

func beefAPISeedancePreuploadUnavailable(err error) bool {
	return generation.BeefAPISeedancePreuploadUnavailable(err)
}

func mapBeefAPISeedanceUploadError(err error, completing bool) error {
	return generation.MapBeefAPISeedanceUploadError(err, completing)
}

func beefAPISeedanceUserErrorMessage(body string) string {
	return generation.BeefAPISeedanceUserErrorMessage(body)
}

func beefAPISeedanceKindMaxBytes(kind string) int64 {
	return generation.BeefAPISeedanceKindMaxBytes(kind)
}

func validateBeefAPISeedanceMediaSize(kind string, size int64) error {
	return generation.ValidateBeefAPISeedanceMediaSize(kind, size)
}

func canonicalBeefAPISeedanceMime(kind string, declared string, data []byte) (string, error) {
	return generation.CanonicalBeefAPISeedanceMime(kind, declared, data)
}

func canonicalBeefAPISeedanceDeclaredMime(kind, raw string) (string, bool) {
	return generation.CanonicalBeefAPISeedanceDeclaredMime(kind, raw)
}

type beefAPISeedanceMediaReader = generation.BeefAPISeedanceMediaReader
type beefAPISeedanceUploadSession = generation.BeefAPISeedanceUploadSession
type beefAPISeedanceUploadComplete = generation.BeefAPISeedanceUploadComplete
type beefAPISeedanceUploadRequest = generation.BeefAPISeedanceUploadRequest

func withTaskExecutionID(ctx context.Context, taskID string) context.Context {
	return generation.WithTaskExecutionID(ctx, taskID)
}

func taskExecutionID(ctx context.Context) string {
	return generation.TaskExecutionID(ctx)
}

func withoutProviderAnalytics(ctx context.Context) context.Context {
	ctx = context.WithValue(ctx, providerAnalyticsKey{}, providerAnalyticsContext{})
	return generation.WithoutCallAccounting(ctx)
}

func isArkPrivateAssetVideoConfig(config providerConfig) bool {
	return generation.IsArkPrivateAssetVideoConfig(config)
}

func arkPrivateAssetAutomaticSyncEnabled(setting arkPrivateAssetSettingValue) (bool, error) {
	return generation.ArkPrivateAssetAutomaticSyncEnabled(setting)
}

func arkPrivateAssetResourceID(reference providerMedia) string {
	return generation.ArkPrivateAssetResourceID(reference)
}

func shouldRetryArkPrivateAssetBinding(binding *model.ArkPrivateAssetBinding) bool {
	return generation.ShouldRetryArkPrivateAssetBinding(binding)
}

func shouldResumeArkPrivateAssetPolling(binding *model.ArkPrivateAssetBinding) bool {
	return generation.ShouldResumeArkPrivateAssetPolling(binding)
}

func callArkPrivateAssetAPI(ctx context.Context, setting arkPrivateAssetSettingValue, action string, payload map[string]interface{}) (map[string]interface{}, error) {
	return generation.CallArkPrivateAssetAPI(ctx, setting, action, payload)
}

func arkPrivateAssetUpstreamDetail(response map[string]interface{}) string {
	return generation.ArkPrivateAssetUpstreamDetail(response)
}

func arkPrivateAssetControlPlaneURL(ctx context.Context, region string) (string, error) {
	return generation.ArkPrivateAssetControlPlaneURL(ctx, region)
}

func arkPrivateAssetResponseField(response map[string]interface{}, keys ...string) string {
	return generation.ArkPrivateAssetResponseField(response, keys...)
}

func arkPrivateAssetResponseMaps(response map[string]interface{}) []map[string]interface{} {
	return generation.ArkPrivateAssetResponseMaps(response)
}

type ArkPrivateAssetSyncResult = generation.ArkPrivateAssetSyncResult

func requestAsMap(value interface{}) (map[string]interface{}, error) {
	return generation.RequestAsMap(value)
}

type seedanceVideosRequest = generation.SeedanceVideosRequest
type grokImageRequest = generation.GrokImageRequest
type grokImageInput = generation.GrokImageInput
type geminiImageRequest = generation.GeminiImageRequest
type geminiImageContent = generation.GeminiImageContent
type geminiImageContentPart = generation.GeminiImageContentPart
type geminiImageInlineData = generation.GeminiImageInlineData
type geminiImageGenerationConfig = generation.GeminiImageGenerationConfig
type geminiImageConfig = generation.GeminiImageConfig
type seedanceAgentPlanRequest = generation.SeedanceAgentPlanRequest
