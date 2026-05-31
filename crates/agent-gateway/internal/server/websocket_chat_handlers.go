package server

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (c *websocketConnection) handleChatStart(req websocketRequest) {
	var body handler.ChatRequestBody
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid chat.start payload")
		return
	}
	body.Message = strings.TrimSpace(body.Message)
	body.ConversationID = strings.TrimSpace(body.ConversationID)
	body.ClientRequestID = strings.TrimSpace(body.ClientRequestID)
	body.ExecutionMode = handler.NormalizeExecutionMode(body.ExecutionMode)
	body.Workdir = handler.NormalizeWorkdir(body.Workdir)
	body.SelectedSystemTools = handler.NormalizeSelectedSystemTools(body.SelectedSystemTools)
	body.UploadedFiles = handler.NormalizeChatUploadedFiles(body.UploadedFiles)
	body.RuntimeControls = handler.NormalizeChatRuntimeControls(body.RuntimeControls)
	selectedModel, err := handler.NormalizeChatSelectedModel(body.SelectedModel)
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	body.SelectedModel = selectedModel
	if body.Message == "" && len(body.UploadedFiles) == 0 {
		_ = c.writeError(req.ID, "message is required")
		return
	}
	if !c.sm.IsOnline() {
		_ = c.writeError(req.ID, "agent offline")
		return
	}

	snapshot, created, err := c.sm.StartChatRunWithClientRequest(
		req.ID,
		body.ConversationID,
		body.ClientRequestID,
		body.Workdir,
	)
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	sourceRequestID := snapshot.RequestID
	if sourceRequestID == "" {
		sourceRequestID = req.ID
	}
	eventCh, eventDone, cleanup, snapshot, err := c.sm.SubscribeChatRun(
		sourceRequestID,
		snapshot.ConversationID,
		0,
	)
	if err != nil {
		if created {
			c.sm.RemoveChatRun(sourceRequestID)
		}
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	defer cleanup()

	// Register before sending so the broadcast forwarder can skip the copy that
	// this same connection already receives through the recoverable chat stream.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	responseID := req.ID
	c.registerActiveChat(responseID, sourceRequestID, snapshot.ConversationID, cancel)
	defer c.releaseActiveChat(responseID)

	if created {
		if err := c.sm.SendToAgent(&gatewayv1.GatewayEnvelope{
			RequestId: sourceRequestID,
			Timestamp: time.Now().Unix(),
			Payload: &gatewayv1.GatewayEnvelope_ChatRequest{
				ChatRequest: &gatewayv1.ChatRequest{
					ConversationId:      body.ConversationID,
					ClientRequestId:     body.ClientRequestID,
					Message:             body.Message,
					SelectedModel:       handler.ToProtoChatSelectedModel(body.SelectedModel),
					RuntimeControls:     handler.ToProtoChatRuntimeControls(body.RuntimeControls),
					ExecutionMode:       body.ExecutionMode,
					Workdir:             body.Workdir,
					SelectedSystemTools: body.SelectedSystemTools,
					UploadedFiles:       handler.ToProtoChatUploadedFiles(body.UploadedFiles),
				},
			},
		}); err != nil {
			c.sm.RemoveChatRun(sourceRequestID)
			_ = c.writeError(req.ID, websocketErrorMessage(err))
			return
		}
	}

	// Do not enforce a hard timeout for streaming chat requests. The GUI path can run
	// multiple compaction rounds stably; WebUI should behave the same and only stop
	// when the user cancels, the connection closes, or the agent returns done/error.
	for {
		select {
		case <-c.done:
			return
		case <-ctx.Done():
			_ = c.writeError(responseID, websocketErrorMessage(ctx.Err()))
			return
		case <-eventDone:
			return
		case event, ok := <-eventCh:
			if !ok {
				return
			}
			chatEvent := event.Event
			if chatEvent == nil {
				continue
			}
			if chatEvent.GetConversationId() != "" {
				body.ConversationID = strings.TrimSpace(chatEvent.GetConversationId())
				c.updateActiveChatConversationID(responseID, body.ConversationID)
			}
			if err := c.writeChatEvent(responseID, websocketChatEventPayload(chatEvent, event.Seq, event.Workdir)); err != nil {
				c.close()
				return
			}
			if chatEvent.GetType() == gatewayv1.ChatEvent_DONE || chatEvent.GetType() == gatewayv1.ChatEvent_ERROR {
				return
			}
		}
	}
}

func (c *websocketConnection) handleChatResume(req websocketRequest) {
	var body websocketChatResumePayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid chat.resume payload")
		return
	}
	body.RequestID = strings.TrimSpace(body.RequestID)
	body.ConversationID = strings.TrimSpace(body.ConversationID)
	if body.RequestID == "" && body.ConversationID == "" {
		_ = c.writeError(req.ID, "request_id or conversation_id is required")
		return
	}
	if body.AfterSeq < 0 {
		body.AfterSeq = 0
	}

	eventCh, eventDone, cleanup, snapshot, err := c.sm.SubscribeChatRun(
		body.RequestID,
		body.ConversationID,
		body.AfterSeq,
	)
	if err != nil {
		responseID := body.RequestID
		if responseID == "" {
			responseID = req.ID
		}
		_ = c.writeError(responseID, websocketErrorMessage(err))
		return
	}
	defer cleanup()

	responseID := snapshot.RequestID
	if responseID == "" {
		responseID = body.RequestID
	}
	if responseID == "" {
		responseID = req.ID
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.registerActiveChat(responseID, snapshot.RequestID, snapshot.ConversationID, cancel)
	defer c.releaseActiveChat(responseID)

	if snapshot.Done && snapshot.LatestSeq <= body.AfterSeq {
		payload := map[string]any{
			"type": "done",
			"seq":  snapshot.LatestSeq,
		}
		if snapshot.ConversationID != "" {
			payload["conversation_id"] = snapshot.ConversationID
		}
		if err := c.writeChatEvent(responseID, payload); err != nil {
			c.close()
		}
		return
	}

	for {
		select {
		case <-c.done:
			return
		case <-ctx.Done():
			_ = c.writeError(responseID, websocketErrorMessage(ctx.Err()))
			return
		case <-eventDone:
			return
		case event, ok := <-eventCh:
			if !ok {
				return
			}
			chatEvent := event.Event
			if chatEvent == nil {
				continue
			}
			if chatEvent.GetConversationId() != "" {
				c.updateActiveChatConversationID(responseID, strings.TrimSpace(chatEvent.GetConversationId()))
			}
			if err := c.writeChatEvent(responseID, websocketChatEventPayload(chatEvent, event.Seq, event.Workdir)); err != nil {
				c.close()
				return
			}
			if chatEvent.GetType() == gatewayv1.ChatEvent_DONE || chatEvent.GetType() == gatewayv1.ChatEvent_ERROR {
				return
			}
		}
	}
}

func (c *websocketConnection) handleChatAttach(req websocketRequest) {
	var body websocketChatAttachPayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid chat.attach payload")
		return
	}
	body.ConversationID = strings.TrimSpace(body.ConversationID)
	if body.ConversationID == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}
	if body.AfterSeq < 0 {
		body.AfterSeq = 0
	}

	eventCh, eventDone, cleanup, snapshot, err := c.sm.SubscribeChatRun(
		"",
		body.ConversationID,
		body.AfterSeq,
	)
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	defer cleanup()

	ctx, cancel := context.WithCancel(context.Background())
	c.registerActiveChatAttachment(req.ID, cancel)
	defer c.releaseActiveChatAttachment(req.ID)

	if snapshot.Done && snapshot.LatestSeq <= body.AfterSeq {
		payload := map[string]any{
			"type": "done",
			"seq":  snapshot.LatestSeq,
		}
		if snapshot.ConversationID != "" {
			payload["conversation_id"] = snapshot.ConversationID
		}
		if err := c.writeChatEvent(req.ID, payload); err != nil {
			c.close()
		}
		return
	}

	for {
		select {
		case <-c.done:
			return
		case <-ctx.Done():
			return
		case <-eventDone:
			return
		case event, ok := <-eventCh:
			if !ok {
				return
			}
			chatEvent := event.Event
			if chatEvent == nil {
				continue
			}
			if err := c.writeChatEvent(req.ID, websocketChatEventPayload(chatEvent, event.Seq, event.Workdir)); err != nil {
				c.close()
				return
			}
			if chatEvent.GetType() == gatewayv1.ChatEvent_DONE || chatEvent.GetType() == gatewayv1.ChatEvent_ERROR {
				return
			}
		}
	}
}

func (c *websocketConnection) handleChatDetach(req websocketRequest) {
	var body websocketChatDetachPayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid chat.detach payload")
		return
	}
	targetRequestID := strings.TrimSpace(body.RequestID)
	if targetRequestID == "" {
		targetRequestID = req.ID
	}
	if targetRequestID == "" {
		_ = c.writeError(req.ID, "request_id is required")
		return
	}
	c.cancelActiveChatAttachment(targetRequestID)
	_ = c.writeResponse(req.ID, map[string]any{"ok": true})
}

func (c *websocketConnection) handleChatCancel(req websocketRequest) {
	var body handler.CancelChatRequestBody
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid chat.cancel payload")
		return
	}
	body.ConversationID = strings.TrimSpace(body.ConversationID)
	if body.ConversationID == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}
	if !c.sm.IsOnline() {
		_ = c.writeError(req.ID, "agent offline")
		return
	}

	if err := c.sm.SendToAgent(&gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_CancelChat{
			CancelChat: &gatewayv1.CancelChatRequest{
				ConversationId: body.ConversationID,
			},
		},
	}); err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}

	c.cancelActiveChatsByConversation(body.ConversationID)
	c.sm.RemoveChatRunByConversation(body.ConversationID)
	_ = c.writeResponse(req.ID, map[string]any{"ok": true})
}

func (c *websocketConnection) registerActiveChat(
	requestID string,
	sourceRequestID string,
	conversationID string,
	cancel context.CancelFunc,
) {
	c.chatTracker.registerActive(requestID, sourceRequestID, conversationID, cancel)
}

func (c *websocketConnection) registerActiveChatAttachment(requestID string, cancel context.CancelFunc) {
	c.chatTracker.registerAttachment(requestID, cancel)
}

func (c *websocketConnection) releaseActiveChatAttachment(requestID string) {
	c.chatTracker.releaseAttachment(requestID)
}

func (c *websocketConnection) releaseAllActiveChatAttachments() []context.CancelFunc {
	return c.chatTracker.releaseAllAttachments()
}

func (c *websocketConnection) cancelActiveChatAttachment(requestID string) {
	c.chatTracker.cancelAttachment(requestID)
}

func (c *websocketConnection) hasActiveChatRequest(requestID string) bool {
	return c.chatTracker.hasActiveRequest(requestID)
}

func (c *websocketConnection) updateActiveChatConversationID(requestID string, conversationID string) {
	c.chatTracker.updateConversationID(requestID, conversationID)
}

func (c *websocketConnection) releaseActiveChat(requestID string) *websocketChatState {
	return c.chatTracker.releaseActive(requestID)
}

func (c *websocketConnection) releaseAllActiveChats() []*websocketChatState {
	return c.chatTracker.releaseAllActive()
}

func (c *websocketConnection) cancelActiveChatsByConversation(conversationID string) {
	for _, chat := range c.chatTracker.cancelByConversation(conversationID) {
		chat.cancel()
	}
}

func websocketChatEventPayload(event *gatewayv1.ChatEvent, seq int64, workdirInput ...string) map[string]any {
	payload := map[string]any{
		"type": websocketChatEventType(event.GetType()),
	}
	if seq > 0 {
		payload["seq"] = seq
	}
	if len(workdirInput) > 0 {
		if workdir := strings.TrimSpace(workdirInput[0]); workdir != "" {
			payload["workdir"] = workdir
		}
	}

	raw := strings.TrimSpace(event.GetData())
	if raw == "" {
		raw = "{}"
	}

	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err == nil {
		for key, value := range decoded {
			payload[key] = value
		}
	}

	if conversationID := strings.TrimSpace(event.GetConversationId()); conversationID != "" {
		payload["conversation_id"] = conversationID
	}

	return payload
}

func websocketChatEventType(eventType gatewayv1.ChatEvent_ChatEventType) string {
	switch eventType {
	case gatewayv1.ChatEvent_TOKEN:
		return "token"
	case gatewayv1.ChatEvent_THINKING:
		return "thinking"
	case gatewayv1.ChatEvent_TOOL_CALL:
		return "tool_call"
	case gatewayv1.ChatEvent_TOOL_RESULT:
		return "tool_result"
	case gatewayv1.ChatEvent_DONE:
		return "done"
	case gatewayv1.ChatEvent_ERROR:
		return "error"
	case gatewayv1.ChatEvent_TOOL_STATUS:
		return "tool_status"
	case gatewayv1.ChatEvent_HOSTED_SEARCH:
		return "hosted_search"
	default:
		return "message"
	}
}
