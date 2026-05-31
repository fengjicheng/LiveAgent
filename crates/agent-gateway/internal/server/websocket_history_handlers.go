package server

import (
	"encoding/json"
	"strings"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (c *websocketConnection) handleHistoryList(req websocketRequest) {
	type payload struct {
		Page     int    `json:"page"`
		PageSize int    `json:"page_size"`
		Cwd      string `json:"cwd"`
		CwdEmpty bool   `json:"cwd_empty"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.list payload")
		return
	}
	page := body.Page
	if page <= 0 {
		page = defaultHistoryListPage
	}
	pageSize := body.PageSize
	if pageSize <= 0 {
		pageSize = defaultHistoryListPageSize
	} else if pageSize > maxHistoryListLimit {
		pageSize = maxHistoryListLimit
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryList{
			HistoryList: &gatewayv1.HistoryListRequest{
				Page:     int32(page),
				PageSize: int32(pageSize),
				Cwd:      strings.TrimSpace(body.Cwd),
				CwdEmpty: body.CwdEmpty,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryListResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	conversations := make([]map[string]any, 0, len(resp.GetConversations()))
	for _, conversation := range resp.GetConversations() {
		conversations = append(conversations, websocketConversationSummaryPayload(conversation))
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"conversations":            conversations,
		"total_count":              resp.GetTotalCount(),
		"running_conversation_ids": c.sm.ActiveChatRunConversationIDs(),
		"running_conversations":    websocketActiveChatRunSummariesPayload(c.sm.ActiveChatRunSummaries()),
	})
}

func (c *websocketConnection) handleHistoryWorkdirs(req websocketRequest) {
	var body struct{}
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.workdirs payload")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryWorkdirs{
			HistoryWorkdirs: &gatewayv1.HistoryWorkdirsRequest{},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryWorkdirsResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	workdirs := make([]map[string]any, 0, len(resp.GetWorkdirs()))
	for _, workdir := range resp.GetWorkdirs() {
		workdirs = append(workdirs, map[string]any{
			"path":               workdir.GetPath(),
			"conversation_count": workdir.GetConversationCount(),
			"updated_at":         workdir.GetUpdatedAt(),
		})
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"workdirs": workdirs,
	})
}

func (c *websocketConnection) handleHistorySharedList(req websocketRequest) {
	type payload struct {
		Page     int `json:"page"`
		PageSize int `json:"page_size"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.shared_list payload")
		return
	}
	page := body.Page
	if page <= 0 {
		page = defaultHistoryListPage
	}
	pageSize := body.PageSize
	if pageSize <= 0 {
		pageSize = defaultHistoryListPageSize
	} else if pageSize > maxHistoryListLimit {
		pageSize = maxHistoryListLimit
	}

	argsJSON, err := json.Marshal(map[string]any{
		"page":      page,
		"page_size": pageSize,
	})
	if err != nil {
		_ = c.writeError(req.ID, "invalid history.shared_list payload")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_MemoryManage{
			MemoryManage: &gatewayv1.MemoryManageRequest{
				Command:  "history_shared_list",
				ArgsJson: string(argsJSON),
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetMemoryManageResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	var result struct {
		Conversations []map[string]any `json:"conversations"`
		TotalCount    int              `json:"total_count"`
	}
	if err := json.Unmarshal([]byte(resp.GetResultJson()), &result); err != nil {
		_ = c.writeError(req.ID, "invalid history.shared_list response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"conversations": result.Conversations,
		"total_count":   result.TotalCount,
	})
}

func (c *websocketConnection) handleHistoryGet(req websocketRequest) {
	type payload struct {
		ConversationID string `json:"conversation_id"`
		MaxMessages    int32  `json:"max_messages"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.get payload")
		return
	}
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryGet{
			HistoryGet: &gatewayv1.HistoryGetRequest{
				ConversationId: body.ConversationID,
				MaxMessages:    body.MaxMessages,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryGetResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"conversation_id":        resp.GetConversationId(),
		"messages_json":          resp.GetMessagesJson(),
		"total_message_count":    resp.GetTotalMessageCount(),
		"returned_message_count": resp.GetReturnedMessageCount(),
		"has_more":               resp.GetHasMore(),
		"conversation":           websocketConversationSummaryPayload(resp.GetConversation()),
	})
}

func (c *websocketConnection) handleHistoryRename(req websocketRequest) {
	type payload struct {
		ConversationID string `json:"conversation_id"`
		Title          string `json:"title"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.rename payload")
		return
	}
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		_ = c.writeError(req.ID, "title is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryRename{
			HistoryRename: &gatewayv1.HistoryRenameRequest{
				ConversationId: body.ConversationID,
				Title:          body.Title,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryRenameResp()
	if resp == nil || resp.GetConversation() == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	conversation := resp.GetConversation()
	_ = c.writeResponse(req.ID, websocketConversationSummaryPayload(conversation))
}

func (c *websocketConnection) handleHistoryPin(req websocketRequest) {
	type payload struct {
		ConversationID string `json:"conversation_id"`
		IsPinned       bool   `json:"is_pinned"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.pin payload")
		return
	}
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryPin{
			HistoryPin: &gatewayv1.HistoryPinRequest{
				ConversationId: body.ConversationID,
				IsPinned:       body.IsPinned,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryPinResp()
	if resp == nil || resp.GetConversation() == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, websocketConversationSummaryPayload(resp.GetConversation()))
}

func (c *websocketConnection) handleHistoryShareGet(req websocketRequest) {
	type payload struct {
		ConversationID string `json:"conversation_id"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.share.get payload")
		return
	}
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryShareGet{
			HistoryShareGet: &gatewayv1.HistoryShareGetRequest{
				ConversationId: body.ConversationID,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryShareGetResp()
	if resp == nil || resp.GetShare() == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, websocketHistoryShareStatusPayload(resp.GetShare()))
}

func (c *websocketConnection) handleHistoryShareSet(req websocketRequest) {
	type payload struct {
		ConversationID    string `json:"conversation_id"`
		Enabled           bool   `json:"enabled"`
		RedactToolContent *bool  `json:"redact_tool_content,omitempty"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.share.set payload")
		return
	}
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryShareSet{
			HistoryShareSet: &gatewayv1.HistoryShareSetRequest{
				ConversationId:    body.ConversationID,
				Enabled:           body.Enabled,
				RedactToolContent: body.RedactToolContent,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryShareSetResp()
	if resp == nil || resp.GetShare() == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, websocketHistoryShareStatusPayload(resp.GetShare()))
}

func (c *websocketConnection) handleHistoryDelete(req websocketRequest) {
	type payload struct {
		ConversationID string `json:"conversation_id"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.delete payload")
		return
	}
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryDelete{
			HistoryDelete: &gatewayv1.HistoryDeleteRequest{
				ConversationId: body.ConversationID,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}
	if response.GetHistoryDeleteResp() == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{"ok": true})
}

func (c *websocketConnection) handleHistoryTruncate(req websocketRequest) {
	type payload struct {
		ConversationID   string `json:"conversation_id"`
		SegmentIndex     int    `json:"segment_index"`
		MessageIndex     int    `json:"message_index"`
		OmitMessagesJSON bool   `json:"omit_messages_json"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.truncate payload")
		return
	}
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}
	if body.SegmentIndex < 0 {
		_ = c.writeError(req.ID, "segment_index must be >= 0")
		return
	}
	if body.MessageIndex < 0 {
		_ = c.writeError(req.ID, "message_index must be >= 0")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryTruncate{
			HistoryTruncate: &gatewayv1.HistoryTruncateRequest{
				ConversationId:   body.ConversationID,
				SegmentIndex:     int32(body.SegmentIndex),
				MessageIndex:     int32(body.MessageIndex),
				OmitMessagesJson: body.OmitMessagesJSON,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryTruncateResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	payloadMap := map[string]any{
		"conversation_id": resp.GetConversationId(),
		"messages_json":   resp.GetMessagesJson(),
	}
	if conversation := resp.GetConversation(); conversation != nil {
		payloadMap["conversation"] = websocketConversationSummaryPayload(conversation)
	}

	_ = c.writeResponse(req.ID, payloadMap)
}
