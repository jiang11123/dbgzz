package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/conversation"
)

const creationConversationMaxBody = conversation.MaxDocumentBytes + (1 << 20)

func RegisterCreationConversationRoutes(r *gin.RouterGroup, svc *app.Service, conversations *conversation.Service) {
	registerCreationConversationRoutes(r, svc, conversations)
}

func registerCreationConversationRoutes(r *gin.RouterGroup, svc *app.Service, conversations *conversation.Service) {
	r.GET("/creation-conversations", func(c *gin.Context) {
		if !conversationReady(conversations) {
			failConversation(c, conversation.ErrUnavailable())
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		result, listErr := conversations.List(user.ID)
		if listErr != nil {
			failConversation(c, listErr)
			return
		}
		ok(c, result)
	})
	r.POST("/creation-conversations/import", func(c *gin.Context) {
		if !conversationReady(conversations) {
			failConversation(c, conversation.ErrUnavailable())
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		raw, readErr := readCreationConversationBody(c)
		if readErr != nil {
			fail(c, http.StatusBadRequest, readErr)
			return
		}
		var req struct {
			OperationID string          `json:"operationId"`
			Hash        string          `json:"hash"`
			Document    json.RawMessage `json:"document"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			fail(c, http.StatusBadRequest, errInvalidJSON())
			return
		}
		result, importErr := conversations.Import(user.ID, req.OperationID, req.Hash, req.Document)
		if importErr != nil {
			failConversation(c, importErr)
			return
		}
		ok(c, result)
	})
	r.GET("/creation-conversations/:id", func(c *gin.Context) {
		if !conversationReady(conversations) {
			failConversation(c, conversation.ErrUnavailable())
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		result, getErr := conversations.Get(user.ID, c.Param("id"))
		if getErr != nil {
			failConversation(c, getErr)
			return
		}
		ok(c, result)
	})
	r.PUT("/creation-conversations/:id", func(c *gin.Context) {
		if !conversationReady(conversations) {
			failConversation(c, conversation.ErrUnavailable())
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		raw, readErr := readCreationConversationBody(c)
		if readErr != nil {
			fail(c, http.StatusBadRequest, readErr)
			return
		}
		var req struct {
			ExpectedRevision int64           `json:"expectedRevision"`
			Document         json.RawMessage `json:"document"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			fail(c, http.StatusBadRequest, errInvalidJSON())
			return
		}
		result, putErr := conversations.Put(user.ID, c.Param("id"), req.ExpectedRevision, req.Document)
		if putErr != nil {
			failConversation(c, putErr)
			return
		}
		ok(c, result)
	})
	r.DELETE("/creation-conversations/:id", func(c *gin.Context) {
		if !conversationReady(conversations) {
			failConversation(c, conversation.ErrUnavailable())
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		expectedRevision, parseErr := strconv.ParseInt(strings.TrimSpace(c.Query("expectedRevision")), 10, 64)
		if strings.TrimSpace(c.Query("expectedRevision")) == "" {
			expectedRevision = 0
			parseErr = nil
		}
		if parseErr != nil {
			fail(c, http.StatusBadRequest, errors.New("对话版本无效"))
			return
		}
		result, deleteErr := conversations.Delete(user.ID, c.Param("id"), expectedRevision)
		if deleteErr != nil {
			failConversation(c, deleteErr)
			return
		}
		ok(c, result)
	})
}

func conversationReady(conversations *conversation.Service) bool {
	return conversations != nil && conversations.Available()
}

func readCreationConversationBody(c *gin.Context) ([]byte, error) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, creationConversationMaxBody)
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		return nil, errors.New("请求体过大或无法读取")
	}
	return raw, nil
}

func errInvalidJSON() error {
	return errors.New("请求体无效")
}

func failConversation(c *gin.Context, err error) {
	var convErr *conversation.Error
	if errors.As(err, &convErr) {
		appErr := app.NewAppError(convErr.Status, convErr.Message)
		appErr.Reason = app.ErrorReason(convErr.Reason)
		failService(c, appErr)
		return
	}
	failService(c, err)
}
