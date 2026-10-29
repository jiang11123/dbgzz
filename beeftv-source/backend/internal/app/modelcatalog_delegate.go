package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/protocol"
)

func normalizeCapability(value string) string {
	return modelcatalog.NormalizeCapability(value)
}

func capabilityFromTaskType(taskType string) string {
	return modelcatalog.CapabilityFromTaskType(taskType)
}

func DefaultModelCapabilityConfig(protocol string) *ModelCapabilityConfig {
	return modelcatalog.DefaultModelCapabilityConfig(protocol)
}

func DefaultImageCapabilityConfig(protocol string, modelName string) *ImageCapabilityConfig {
	return modelcatalog.DefaultImageCapabilityConfig(protocol, modelName)
}

func DefaultModelCapabilityConfigForModel(protocol string, modelName string) *ModelCapabilityConfig {
	return modelcatalog.DefaultModelCapabilityConfigForModel(protocol, modelName)
}

func DecodeModelCapabilityConfig(raw string) (*ModelCapabilityConfig, error) {
	return modelcatalog.DecodeModelCapabilityConfig(raw)
}

func normalizedChannelModelCapability(channelModel *model.ChannelModel) (*ModelCapabilityConfig, error) {
	return modelcatalog.NormalizedChannelModelCapability(channelModel)
}

func NormalizeModelCapabilityConfig(capability string, protocol string, input *ModelCapabilityConfig) (*ModelCapabilityConfig, error) {
	return modelcatalog.NormalizeModelCapabilityConfig(capability, protocol, input)
}

func NormalizeModelCapabilityConfigForModel(capability string, protocol string, modelName string, input *ModelCapabilityConfig) (*ModelCapabilityConfig, error) {
	return modelcatalog.NormalizeModelCapabilityConfigForModel(capability, protocol, modelName, input)
}

func applyModelSpecificVideoCapability(profile *VideoCapabilityConfig, protocol string, modelName string) *VideoCapabilityConfig {
	return modelcatalog.ApplyModelSpecificVideoCapability(profile, protocol, modelName)
}

func CapabilitySpecFromModelCapabilityConfig(config *ModelCapabilityConfig, capability string) (CapabilitySpec, error) {
	return modelcatalog.CapabilitySpecFromModelCapabilityConfig(config, capability)
}

func applyModelSpecificImageCapability(profile *ImageCapabilityConfig, protocol, modelName, apiFormat string) *ImageCapabilityConfig {
	return modelcatalog.ApplyModelSpecificImageCapability(profile, protocol, modelName, apiFormat)
}

func applyFixedVideoResolution(input *canvasGenerationInput, profile *VideoCapabilityConfig) {
	if input == nil {
		return
	}
	task := taskInputFromCanvas(*input)
	modelcatalog.ApplyFixedVideoResolution(&task, profile)
	applyTaskConfigToCanvas(input, task)
}

func validateVideoTask(profile *VideoCapabilityConfig, input canvasGenerationInput) error {
	return modelcatalog.ValidateVideoTask(profile, taskInputFromCanvas(input))
}

func validateVideoTaskParameters(profile *VideoCapabilityConfig, input canvasGenerationInput) error {
	return modelcatalog.ValidateVideoTaskParameters(profile, taskInputFromCanvas(input))
}

func validateImageTask(profile *ImageCapabilityConfig, input canvasGenerationInput) error {
	return modelcatalog.ValidateImageTask(profile, taskInputFromCanvas(input))
}

func validateVideoReferenceMedia(profile *VideoCapabilityConfig, input canvasGenerationInput) error {
	return modelcatalog.ValidateVideoReferenceMedia(profile, taskInputFromCanvas(input))
}

func validateWorkflowProviderPromptLength(input canvasGenerationInput) error {
	return modelcatalog.ValidateWorkflowProviderPromptLength(taskInputFromCanvas(input))
}

func isSeedance2Family(protocol, modelName string) bool {
	return modelcatalog.IsSeedance2Family(protocol, modelName)
}

func isSeedance25Model(modelName string) bool {
	return modelcatalog.IsSeedance25Model(modelName)
}

func overlayOfficialSeedance2References(base VideoReferenceConfig, is25 bool) VideoReferenceConfig {
	return modelcatalog.OverlayOfficialSeedance2References(base, is25)
}

func applySeedanceDocumentedVideoPixelFloor(config providerConfig, refs *VideoReferenceConfig) {
	modelcatalog.ApplySeedanceDocumentedVideoPixelFloor(modelcatalog.TaskConfig{
		InterfaceType: config.InterfaceType,
		Model:         config.Model,
		BaseURL:       config.BaseURL,
	}, refs)
}

func ModelRequestIntentFromTaskInput(input map[string]any, taskType string, operation string) ModelRequestIntent {
	return modelcatalog.ModelRequestIntentFromTaskInput(input, taskType, operation)
}

func DecodeCapabilitySpec(raw string) (CapabilitySpec, error) {
	return modelcatalog.DecodeCapabilitySpec(raw)
}

func ValidateCapabilitySpec(spec CapabilitySpec) error {
	return modelcatalog.ValidateCapabilitySpec(spec)
}

func NormalizeCapabilitySpec(spec CapabilitySpec) (CapabilitySpec, error) {
	return modelcatalog.NormalizeCapabilitySpec(spec)
}

func MatchCapability(spec CapabilitySpec, intent ModelRequestIntent) CapabilityMatch {
	return modelcatalog.MatchCapability(spec, intent)
}

func channelModelVariantForIntent(channelModel model.ChannelModel, intent ModelRequestIntent) *model.ChannelModelVariant {
	return modelcatalog.ChannelModelVariantForIntent(channelModel, intent)
}

func skuSelectorForIntent(intent ModelRequestIntent) map[string]string {
	return modelcatalog.SKUSelectorForIntent(intent)
}

func skuSelectorForTier(tier model.ChannelModelVariant) map[string]string {
	return modelcatalog.SKUSelectorForTier(tier)
}

func matchSKUSelector(tier map[string]string, requested map[string]string) (bool, int) {
	return modelcatalog.MatchSKUSelector(tier, requested)
}

func mergeIntentDefaults(options map[string]any, defaults map[string]any) map[string]any {
	return modelcatalog.MergeIntentDefaults(options, defaults)
}

func normalizeModelRequestOption(name string, value any) any {
	return modelcatalog.NormalizeModelRequestOption(name, value)
}

func canonicalCapabilityOptionName(value string) string {
	return modelcatalog.CanonicalCapabilityOptionName(value)
}

func modelCapabilityConfigToMap(config *ModelCapabilityConfig) (map[string]any, error) {
	return modelcatalog.ModelCapabilityConfigToMap(config)
}

func normalizeChannelModelContract(channel *model.ModelChannel, req ChannelModelRequest) (string, string, string, model.ChannelInterfaceType, error) {
	return normalizeChannelModelContractWithRegistry(protocol.Builtins(), channel, req)
}

func (s *Service) normalizeChannelModelContract(channel *model.ModelChannel, req ChannelModelRequest) (string, string, string, model.ChannelInterfaceType, error) {
	return normalizeChannelModelContractWithRegistry(s.protocolRegistry(), channel, req)
}

func normalizeChannelModelContractWithRegistry(registry *protocol.Registry, channel *model.ModelChannel, req ChannelModelRequest) (string, string, string, model.ChannelInterfaceType, error) {
	return modelcatalog.NormalizeChannelModelContract(modelcatalog.LookupFromRegistry(registry), channel, req)
}

func normalizeChannelModelTierSelector(capability string, input ChannelModelVariantRequest) (map[string]string, string, int, error) {
	return modelcatalog.NormalizeChannelModelTierSelector(capability, input)
}

func normalizeChannelModelTierResolution(raw string) string {
	return modelcatalog.NormalizeChannelModelTierResolution(raw)
}

func validateChannelModelTierCapabilities(tiers []model.ChannelModelVariant, rawCapabilityConfig string, capability string) error {
	return modelcatalog.ValidateChannelModelTierCapabilities(tiers, rawCapabilityConfig, capability)
}

func videoTestDefaults(profile *VideoCapabilityConfig) (string, string) {
	return modelcatalog.VideoTestDefaults(profile)
}

func imageTestDefaults(profile *ImageCapabilityConfig) (string, string) {
	return modelcatalog.ImageTestDefaults(profile)
}

func normalizeAdminChannelModelDeleteIDs(values []string) ([]string, error) {
	return modelcatalog.NormalizeAdminChannelModelDeleteIDs(values)
}

func retiredChannelModelKeys(raw string) map[string]bool {
	return modelcatalog.RetiredChannelModelKeys(raw)
}

func channelModelCatalogKey(value string) string {
	return modelcatalog.ChannelModelCatalogKey(value)
}

func protocolCapabilityFromMetadata(metadata protocol.Metadata) string {
	primary := ""
	if len(metadata.Categories) > 0 {
		primary = string(metadata.Categories[0])
	}
	return modelcatalog.ProtocolCapabilityFromMetadata(modelcatalog.ProtocolMeta{
		ID:                metadata.ID,
		Enabled:           metadata.Enabled,
		UnavailableReason: metadata.UnavailableReason,
		PrimaryCapability: primary,
	})
}

func (s *Service) protocolLookup() modelcatalog.ProtocolLookup {
	return modelcatalog.LookupFromRegistry(s.protocolRegistry())
}

func channelModelCapabilitySpec(channelModel model.ChannelModel) (CapabilitySpec, error) {
	return modelcatalog.ChannelModelCapabilitySpec(channelModel)
}

func capabilitySpecWithVariants(spec CapabilitySpec, channelModel model.ChannelModel) CapabilitySpec {
	return modelcatalog.CapabilitySpecWithVariants(spec, channelModel)
}

func channelModelDefaultOptions(channelModel model.ChannelModel, spec CapabilitySpec) (map[string]any, error) {
	return modelcatalog.ChannelModelDefaultOptions(channelModel, spec)
}

func normalizeLogicalDefaults(spec CapabilitySpec, defaults map[string]any) (map[string]any, error) {
	return modelcatalog.NormalizeLogicalDefaults(spec, defaults)
}

func validateProductSpecWithinRoutes(product CapabilitySpec, routeSpecs []CapabilitySpec) error {
	return modelcatalog.ValidateProductSpecWithinRoutes(product, routeSpecs)
}

func capabilitySpecWithRoutePresets(spec CapabilitySpec, routes []CapabilitySpec) CapabilitySpec {
	return modelcatalog.CapabilitySpecWithRoutePresets(spec, routes)
}

func mergeCapabilityImageSize(specs []CapabilitySpec) *CapabilityImageSize {
	return modelcatalog.MergeCapabilityImageSize(specs)
}

func capabilityFingerprint(spec CapabilitySpec) string {
	return modelcatalog.CapabilityFingerprint(spec)
}

func decodeLegacyModelIDs(raw string) []string {
	return modelcatalog.DecodeLegacyModelIDs(raw)
}

func normalizeLegacyModelIDs(values []string) []string {
	return modelcatalog.NormalizeLegacyModelIDs(values)
}

func normalizeCatalogModelType(value string) string {
	return modelcatalog.NormalizeCatalogModelType(value)
}

func normalizeCatalogOptions(options []ChannelModelCatalogOption) []ChannelModelCatalogOption {
	return modelcatalog.NormalizeCatalogOptions(options)
}

func normalizeCatalogEndpointTypes(values []string) []string {
	return modelcatalog.NormalizeCatalogEndpointTypes(values)
}

func videoResolutionNameRequest(profile *VideoCapabilityConfig, value string) string {
	return modelcatalog.VideoResolutionNameRequest(profile, value)
}

func isAutomaticVideoResolution(value string) bool {
	return modelcatalog.IsAutomaticVideoResolution(value)
}

func splitModelKey(value string) (channelID, modelID string) {
	return modelcatalog.SplitModelKey(value)
}

func validateVideoReferenceImage(refs VideoReferenceConfig, index int, media providerMedia) error {
	return modelcatalog.ValidateVideoReferenceImage(refs, index, taskMediaFromProvider(media))
}

func validateVideoReferenceVideo(refs VideoReferenceConfig, index int, media providerMedia) error {
	return modelcatalog.ValidateVideoReferenceVideo(refs, index, taskMediaFromProvider(media))
}

func videoCapabilityAllowsAudioOnly(profile *VideoCapabilityConfig) bool {
	return modelcatalog.VideoCapabilityAllowsAudioOnly(profile)
}

func isProviderCapabilityOption(name string) bool {
	return modelcatalog.IsProviderCapabilityOption(name)
}

func isCapabilityOptionFor(capability string, name string) bool {
	return modelcatalog.IsCapabilityOptionFor(capability, name)
}

func videoDurationSupported(value *VideoCapabilityConfig) bool {
	return modelcatalog.VideoDurationSupported(value)
}

func validateImageCapabilityConfig(value *ImageCapabilityConfig) error {
	return modelcatalog.ValidateImageCapabilityConfig(value)
}

func validateTextCapabilityConfig(value *TextCapabilityConfig) error {
	return modelcatalog.ValidateTextCapabilityConfig(value)
}

func validateVideoCapabilityConfig(value *VideoCapabilityConfig) error {
	return modelcatalog.ValidateVideoCapabilityConfig(value)
}

func containsCapabilityString(values []string, target string) bool {
	return modelcatalog.ContainsCapabilityString(values, target)
}

func legacyImageSizeValues() []string {
	return modelcatalog.LegacyImageSizeValues()
}

func normalizeResolution(value string) string {
	return modelcatalog.NormalizeResolution(value)
}

func capabilityOptionValuesEqual(name string, candidate any, value any) bool {
	return modelcatalog.CapabilityOptionValuesEqual(name, candidate, value)
}

func validateReferenceDuration(kind string, index int, durationMs int64, minimum, maximum float64) error {
	return modelcatalog.ValidateReferenceDuration(kind, index, durationMs, minimum, maximum)
}

func enabledLogicalRouteSpecs(routes []cachedLogicalRoute) []CapabilitySpec {
	return modelcatalog.EnabledLogicalRouteSpecs(routes)
}

func logicalModelConfigurationError(product CapabilitySpec, routeSpecs []CapabilitySpec) string {
	return modelcatalog.LogicalModelConfigurationError(product, routeSpecs)
}

func isRouteDispatchUncertain(err error) bool {
	return modelcatalog.IsDispatchUncertain(err)
}

func channelModelNames(channel model.ModelChannel) []string {
	return modelcatalog.ChannelModelNames(channel)
}

func mergeChannelRequest(req ChannelRequest, channel model.ModelChannel) ChannelRequest {
	return modelcatalog.MergeChannelRequest(req, channel)
}

func publicChannel(channel model.ModelChannel, admin bool, channelModels []model.ChannelModel) PublicModelChannel {
	return modelcatalog.PublicChannel(channel, admin, channelModels)
}

func duplicateChannelName(name string) string {
	return modelcatalog.DuplicateChannelName(name)
}

func validateChannelSortOrder(value int) error {
	return modelcatalog.ValidateChannelSortOrder(value)
}

func normalizeAdminPage(page int, limit int) (int, int) {
	return modelcatalog.NormalizeAdminPage(page, limit)
}

func applyRoutedProviderSelection(input map[string]any, routed *RoutedModel) map[string]any {
	return modelcatalog.ApplyRoutedProviderSelection(input, routed)
}

func channelFromRequest(req ChannelRequest, channel model.ModelChannel) (model.ModelChannel, error) {
	return modelcatalog.ApplyChannelRequest(req, channel)
}

func (s *Service) channelFromRequest(req ChannelRequest, channel model.ModelChannel) (model.ModelChannel, error) {
	return modelcatalog.ApplyChannelRequest(req, channel)
}
