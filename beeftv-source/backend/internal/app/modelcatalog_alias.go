package app

import "infinite-canvas/backend/internal/modelcatalog"

type ModelCapabilityConfig = modelcatalog.ModelCapabilityConfig
type TextCapabilityConfig = modelcatalog.TextCapabilityConfig
type TextReferenceConfig = modelcatalog.TextReferenceConfig
type ImageCapabilityConfig = modelcatalog.ImageCapabilityConfig
type ImageReferenceConfig = modelcatalog.ImageReferenceConfig
type ImageSizeConfig = modelcatalog.ImageSizeConfig
type ImageSizePreset = modelcatalog.ImageSizePreset
type ImageQualityConfig = modelcatalog.ImageQualityConfig
type ParameterSupport = modelcatalog.ParameterSupport
type VideoCapabilityConfig = modelcatalog.VideoCapabilityConfig
type VideoReferenceConfig = modelcatalog.VideoReferenceConfig
type VideoDurationConfig = modelcatalog.VideoDurationConfig
type VideoBooleanConfig = modelcatalog.VideoBooleanConfig
type CapabilityImageSizePreset = modelcatalog.CapabilityImageSizePreset
type CapabilityImageSize = modelcatalog.CapabilityImageSize
type CapabilitySpec = modelcatalog.CapabilitySpec
type InputConstraint = modelcatalog.InputConstraint
type OptionConstraint = modelcatalog.OptionConstraint
type ModelRequestIntent = modelcatalog.ModelRequestIntent
type CapabilityMatch = modelcatalog.CapabilityMatch
type PublicChannelCatalog = modelcatalog.PublicChannelCatalog
type PublicChannelModel = modelcatalog.PublicChannelModel
type ChannelModelRequest = modelcatalog.ChannelModelRequest
type ChannelModelVariantRequest = modelcatalog.ChannelModelVariantRequest
type ChannelModelCatalogOption = modelcatalog.ChannelModelCatalogOption
type ChannelModelCatalogItem = modelcatalog.ChannelModelCatalogItem
type ChannelModelCatalogDefaultParameters = modelcatalog.ChannelModelCatalogDefaultParameters
type ChannelModelCatalogOptions = modelcatalog.ChannelModelCatalogOptions
type LogicalModelRequest = modelcatalog.LogicalModelRequest
type LogicalRouteRequest = modelcatalog.LogicalRouteRequest
type PublicLogicalModel = modelcatalog.PublicLogicalModel
type AdminLogicalRoute = modelcatalog.AdminLogicalRoute
type AdminLogicalModel = modelcatalog.AdminLogicalModel
type RouteSimulationCandidate = modelcatalog.RouteSimulationCandidate
type RouteSimulationResult = modelcatalog.RouteSimulationResult
type ChannelRequest = modelcatalog.ChannelRequest
type PublicModelChannel = modelcatalog.PublicModelChannel
type PublicChannelModelProfile = modelcatalog.PublicChannelModelProfile
type AdminChannelPage = modelcatalog.AdminChannelPage
type AdminChannelModelFetchResult = modelcatalog.AdminChannelModelFetchResult
type RoutedModel = modelcatalog.RoutedModel
type cachedLogicalModel = modelcatalog.CachedLogicalModel
type cachedLogicalRoute = modelcatalog.CachedLogicalRoute
type routeCatalogSnapshot = modelcatalog.RouteCatalog
type routeDispatchUncertainError = modelcatalog.DispatchUncertainError

const DefaultVideoPromptMaxChars = modelcatalog.DefaultVideoPromptMaxChars

const (
	officialSeedanceImageMinEdge    = modelcatalog.OfficialSeedanceImageMinEdge
	officialSeedanceImageMaxEdge    = modelcatalog.OfficialSeedanceImageMaxEdge
	officialSeedanceImageMinAspect  = modelcatalog.OfficialSeedanceImageMinAspect
	officialSeedanceImageMaxAspect  = modelcatalog.OfficialSeedanceImageMaxAspect
	officialSeedanceVideoMinPixels  = modelcatalog.OfficialSeedanceVideoMinPixels
	officialSeedanceVideoMaxPixels  = modelcatalog.OfficialSeedanceVideoMaxPixels
	officialSeedanceMinAudioSeconds = modelcatalog.OfficialSeedanceMinAudioSeconds
)
