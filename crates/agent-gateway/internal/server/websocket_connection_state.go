package server

import (
	"context"
	"strings"
	"sync"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

type websocketChatTracker struct {
	activeMu sync.RWMutex
	active   map[string]*websocketChatState
	recent   map[string]time.Time

	attachmentsMu sync.Mutex
	attachments   map[string]context.CancelFunc
}

func newWebsocketChatTracker() *websocketChatTracker {
	return &websocketChatTracker{
		active:      make(map[string]*websocketChatState),
		recent:      make(map[string]time.Time),
		attachments: make(map[string]context.CancelFunc),
	}
}

func (t *websocketChatTracker) registerActive(
	requestID string,
	sourceRequestID string,
	conversationID string,
	cancel context.CancelFunc,
) {
	requestID = strings.TrimSpace(requestID)
	sourceRequestID = strings.TrimSpace(sourceRequestID)
	t.activeMu.Lock()
	defer t.activeMu.Unlock()
	t.active[requestID] = &websocketChatState{
		cancel:          cancel,
		conversationID:  strings.TrimSpace(conversationID),
		sourceRequestID: sourceRequestID,
	}
	delete(t.recent, requestID)
	delete(t.recent, sourceRequestID)
}

func (t *websocketChatTracker) registerAttachment(requestID string, cancel context.CancelFunc) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}
	t.attachmentsMu.Lock()
	defer t.attachmentsMu.Unlock()
	if existing := t.attachments[requestID]; existing != nil {
		existing()
	}
	t.attachments[requestID] = cancel
}

func (t *websocketChatTracker) releaseAttachment(requestID string) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}
	t.attachmentsMu.Lock()
	delete(t.attachments, requestID)
	t.attachmentsMu.Unlock()
}

func (t *websocketChatTracker) releaseAllAttachments() []context.CancelFunc {
	t.attachmentsMu.Lock()
	defer t.attachmentsMu.Unlock()

	cancels := make([]context.CancelFunc, 0, len(t.attachments))
	for requestID, cancel := range t.attachments {
		delete(t.attachments, requestID)
		cancels = append(cancels, cancel)
	}
	return cancels
}

func (t *websocketChatTracker) cancelAttachment(requestID string) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}
	t.attachmentsMu.Lock()
	cancel := t.attachments[requestID]
	delete(t.attachments, requestID)
	t.attachmentsMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (t *websocketChatTracker) hasActiveRequest(requestID string) bool {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return false
	}
	t.activeMu.Lock()
	defer t.activeMu.Unlock()
	if _, ok := t.active[requestID]; ok {
		return true
	}
	for _, chat := range t.active {
		if chat.sourceRequestID == requestID {
			return true
		}
	}
	now := time.Now()
	for recentRequestID, expiresAt := range t.recent {
		if now.After(expiresAt) {
			delete(t.recent, recentRequestID)
		}
	}
	if expiresAt, ok := t.recent[requestID]; ok && now.Before(expiresAt) {
		return true
	}
	return false
}

func (t *websocketChatTracker) updateConversationID(requestID string, conversationID string) {
	t.activeMu.Lock()
	defer t.activeMu.Unlock()
	if chat, ok := t.active[requestID]; ok {
		chat.conversationID = strings.TrimSpace(conversationID)
	}
}

func (t *websocketChatTracker) releaseActive(requestID string) *websocketChatState {
	t.activeMu.Lock()
	defer t.activeMu.Unlock()
	chat := t.active[requestID]
	delete(t.active, requestID)
	expiresAt := time.Now().Add(recentActiveChatRetention)
	if strings.TrimSpace(requestID) != "" {
		t.recent[strings.TrimSpace(requestID)] = expiresAt
	}
	if chat != nil && chat.sourceRequestID != "" {
		t.recent[chat.sourceRequestID] = expiresAt
	}
	return chat
}

func (t *websocketChatTracker) releaseAllActive() []*websocketChatState {
	t.activeMu.Lock()
	defer t.activeMu.Unlock()

	chats := make([]*websocketChatState, 0, len(t.active))
	expiresAt := time.Now().Add(recentActiveChatRetention)
	for requestID, chat := range t.active {
		delete(t.active, requestID)
		if strings.TrimSpace(requestID) != "" {
			t.recent[strings.TrimSpace(requestID)] = expiresAt
		}
		if chat != nil && chat.sourceRequestID != "" {
			t.recent[chat.sourceRequestID] = expiresAt
		}
		chats = append(chats, chat)
	}
	return chats
}

func (t *websocketChatTracker) cancelByConversation(conversationID string) []*websocketChatState {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return nil
	}

	t.activeMu.Lock()
	chats := make([]*websocketChatState, 0, len(t.active))
	expiresAt := time.Now().Add(recentActiveChatRetention)
	for requestID, chat := range t.active {
		if chat.conversationID == conversationID {
			delete(t.active, requestID)
			if strings.TrimSpace(requestID) != "" {
				t.recent[strings.TrimSpace(requestID)] = expiresAt
			}
			if chat.sourceRequestID != "" {
				t.recent[chat.sourceRequestID] = expiresAt
			}
			chats = append(chats, chat)
		}
	}
	t.activeMu.Unlock()

	return chats
}

type websocketTerminalInterestTracker struct {
	mu       sync.RWMutex
	projects map[string]struct{}
	sessions map[string]struct{}
}

func newWebsocketTerminalInterestTracker() *websocketTerminalInterestTracker {
	return &websocketTerminalInterestTracker{
		projects: make(map[string]struct{}),
		sessions: make(map[string]struct{}),
	}
}

func (t *websocketTerminalInterestTracker) rememberProject(projectPathKey string) {
	projectPathKey = strings.TrimSpace(projectPathKey)
	if projectPathKey == "" {
		return
	}
	t.mu.Lock()
	t.projects[projectPathKey] = struct{}{}
	t.mu.Unlock()
}

func (t *websocketTerminalInterestTracker) rememberSession(sessionID string, projectPathKey string) {
	sessionID = strings.TrimSpace(sessionID)
	projectPathKey = strings.TrimSpace(projectPathKey)
	if sessionID == "" && projectPathKey == "" {
		return
	}
	t.mu.Lock()
	if sessionID != "" {
		t.sessions[sessionID] = struct{}{}
	}
	if projectPathKey != "" {
		t.projects[projectPathKey] = struct{}{}
	}
	t.mu.Unlock()
}

func (t *websocketTerminalInterestTracker) forget(sessionID string, projectPathKey string) {
	sessionID = strings.TrimSpace(sessionID)
	projectPathKey = strings.TrimSpace(projectPathKey)
	t.mu.Lock()
	if sessionID != "" {
		delete(t.sessions, sessionID)
	}
	if sessionID == "" && projectPathKey != "" {
		delete(t.projects, projectPathKey)
	}
	t.mu.Unlock()
}

func (t *websocketTerminalInterestTracker) shouldForward(event *gatewayv1.TerminalEvent) bool {
	if event == nil {
		return false
	}
	sessionID := strings.TrimSpace(event.GetSessionId())
	projectPathKey := strings.TrimSpace(event.GetProjectPathKey())
	kind := strings.TrimSpace(event.GetKind())

	// Terminal metadata changes are broadcast so each browser tab can keep its
	// project list fresh; raw output remains gated behind explicit attachment.
	if kind != "output" {
		return sessionID != "" || projectPathKey != ""
	}

	t.mu.RLock()
	_, sessionSubscribed := t.sessions[sessionID]
	t.mu.RUnlock()

	return sessionID != "" && sessionSubscribed
}
