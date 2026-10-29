package app

import "infinite-canvas/backend/internal/generation"

type canvasGenerationInput = generation.Input
type canvasTextOptions = generation.TextOptions
type agentToolRequests = generation.AgentToolRequests
type canonicalAgentRequest = generation.CanonicalAgentRequest
type providerTextMessage = generation.TextMessage
type providerConfig = generation.Config
type providerMedia = generation.Media
type WorkflowField = generation.WorkflowField
type imageResponse = generation.ImageResponse
type providerError = generation.UpstreamError
type providerPayloadError = generation.PayloadError
type providerHTTPError = generation.HTTPError
type providerResponseDecodeError = generation.ResponseDecodeError
type providerCircuitOpenError = generation.CircuitOpenError
type providerStatePendingError = generation.StatePendingError
type providerSubmissionUnknownError = generation.SubmissionUnknownError
type providerMediaHydrationPolicy = generation.MediaHydrationPolicy

const providerHTTPTimeout = generation.HTTPTimeout
const videoPollTimeout = generation.VideoPollTimeout
const maxProviderResponseBytes = generation.MaxResponseBytes
const videoJSONRequestLimitBytes = generation.VideoJSONRequestLimitBytes

var errVideoJSONRequestTooLarge = generation.ErrVideoJSONRequestTooLarge

const defaultVideoPollInterval = generation.DefaultVideoPollInterval
const videoPollEventRetrying = generation.VideoPollEventRetrying
const videoPollEventRecovered = generation.VideoPollEventRecovered

type beefAPISeedanceMediaGroup = generation.BeefAPISeedanceMediaGroup

const beefAPISeedanceImageMaxBytes = generation.BeefAPISeedanceImageMaxBytes
const beefAPISeedanceVideoMaxBytes = generation.BeefAPISeedanceVideoMaxBytes
const beefAPISeedanceUploadTimeout = generation.BeefAPISeedanceUploadTimeout
const jiMengSubmitAction = generation.JiMengSubmitAction
const jiMengResultAction = generation.JiMengResultAction
const volcengineArkImageMinPixels = generation.VolcengineArkImageMinPixels
const volcengineArkImageMaxPixels = generation.VolcengineArkImageMaxPixels

var errBeefAPISeedanceUploadUnavailable = generation.ErrBeefAPISeedanceUploadUnavailable
var errBeefAPISeedanceUploadIncomplete = generation.ErrBeefAPISeedanceUploadIncomplete
