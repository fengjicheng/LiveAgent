package session

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (m *Manager) SubscribeChatEvents() (<-chan *ChatBroadcastEvent, func()) {
	ch := make(chan *ChatBroadcastEvent, 128)

	m.chatStore.chatMu.Lock()
	subID := m.chatStore.nextChatSubID
	m.chatStore.nextChatSubID += 1
	m.chatStore.chatSubscribers[subID] = ch
	m.chatStore.chatMu.Unlock()

	cleanup := func() {
		m.chatStore.chatMu.Lock()
		existing, ok := m.chatStore.chatSubscribers[subID]
		if ok {
			delete(m.chatStore.chatSubscribers, subID)
			close(existing)
		}
		m.chatStore.chatMu.Unlock()
	}

	return ch, cleanup
}

func (m *Manager) StartChatRun(requestID string, conversationID string) (ChatRunSnapshot, error) {
	snapshot, _, err := m.StartChatRunWithClientRequest(requestID, conversationID, "", "")
	return snapshot, err
}

func (m *Manager) StartChatRunWithClientRequest(
	requestID string,
	conversationID string,
	clientRequestID string,
	workdirInput ...string,
) (ChatRunSnapshot, bool, error) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return ChatRunSnapshot{}, false, ErrChatRunNotFound
	}

	now := time.Now()
	conversationID = strings.TrimSpace(conversationID)
	clientRequestID = strings.TrimSpace(clientRequestID)
	workdir := ""
	if len(workdirInput) > 0 {
		workdir = strings.TrimSpace(workdirInput[0])
	}
	sessionEpoch := m.currentSessionEpoch()

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	m.pruneExpiredChatRunsLocked(now)

	if clientRequestID != "" {
		if existingRequestID := m.chatStore.chatRunByClientRequest[clientRequestID]; existingRequestID != "" {
			if existing := m.chatStore.chatRuns[existingRequestID]; existing != nil {
				if !existing.done {
					if workdir != "" && existing.workdir == "" {
						existing.workdir = workdir
					}
					return existing.snapshot(), false, nil
				}
				m.releaseCompletedChatRunLocked(existingRequestID, existing)
			}
			delete(m.chatStore.chatRunByClientRequest, clientRequestID)
		}
	}

	if existing := m.chatStore.chatRuns[requestID]; existing != nil {
		m.removeChatRunLocked(requestID, existing)
	}

	run := &chatRun{
		requestID:       requestID,
		conversationID:  conversationID,
		clientRequestID: clientRequestID,
		workdir:         workdir,
		sessionEpoch:    sessionEpoch,
		updatedAt:       now,
		subscribers:     make(map[int]*chatRunSubscriber),
	}
	m.chatStore.chatRuns[requestID] = run
	if conversationID != "" {
		m.chatStore.chatRunByConversation[conversationID] = requestID
	}
	if clientRequestID != "" {
		m.chatStore.chatRunByClientRequest[clientRequestID] = requestID
	}

	return run.snapshot(), true, nil
}

func (m *Manager) RemoveChatRun(requestID string) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		return
	}
	m.removeChatRunLocked(requestID, run)
}

func (m *Manager) RemoveChatRunByConversation(conversationID string) {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return
	}

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	requestID := m.chatStore.chatRunByConversation[conversationID]
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		for candidateRequestID, candidateRun := range m.chatStore.chatRuns {
			if strings.TrimSpace(candidateRun.conversationID) == conversationID {
				requestID = candidateRequestID
				run = candidateRun
				break
			}
		}
	}
	if run == nil {
		return
	}
	m.removeChatRunLocked(requestID, run)
}

func (m *Manager) ActiveChatRunSummaries() []ActiveChatRunSummary {
	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	now := time.Now()
	m.pruneExpiredChatRunsLocked(now)

	seen := make(map[string]int, len(m.chatStore.chatRuns)+len(m.chatStore.historyActiveRuns))
	summaries := make([]ActiveChatRunSummary, 0, len(m.chatStore.chatRuns)+len(m.chatStore.historyActiveRuns))
	for _, run := range m.chatStore.chatRuns {
		if run == nil || run.done {
			continue
		}
		conversationID := strings.TrimSpace(run.conversationID)
		if conversationID == "" {
			continue
		}
		summary := ActiveChatRunSummary{
			ConversationID: conversationID,
			Workdir:        strings.TrimSpace(run.workdir),
			UpdatedAt:      run.updatedAt.UnixMilli(),
		}
		if index, ok := seen[conversationID]; ok {
			if summaries[index].Workdir == "" {
				summaries[index].Workdir = summary.Workdir
			}
			if summary.UpdatedAt > summaries[index].UpdatedAt {
				summaries[index].UpdatedAt = summary.UpdatedAt
			}
			continue
		}
		seen[conversationID] = len(summaries)
		summaries = append(summaries, summary)
	}

	for conversationID, run := range m.chatStore.historyActiveRuns {
		conversationID = strings.TrimSpace(conversationID)
		if conversationID == "" {
			continue
		}
		if now.Sub(run.updatedAt) > chatRunStaleRetention {
			delete(m.chatStore.historyActiveRuns, conversationID)
			continue
		}
		workdir := strings.TrimSpace(run.workdir)
		updatedAt := run.updatedAt.UnixMilli()
		if index, ok := seen[conversationID]; ok {
			if summaries[index].Workdir == "" {
				summaries[index].Workdir = workdir
			}
			if updatedAt > summaries[index].UpdatedAt {
				summaries[index].UpdatedAt = updatedAt
			}
			continue
		}
		seen[conversationID] = len(summaries)
		summaries = append(summaries, ActiveChatRunSummary{
			ConversationID: conversationID,
			Workdir:        workdir,
			UpdatedAt:      updatedAt,
		})
	}

	sort.Slice(summaries, func(i, j int) bool {
		return summaries[i].ConversationID < summaries[j].ConversationID
	})
	return summaries
}

func (m *Manager) ActiveChatRunConversationIDs() []string {
	summaries := m.ActiveChatRunSummaries()
	ids := make([]string, 0, len(summaries))
	for _, summary := range summaries {
		if conversationID := strings.TrimSpace(summary.ConversationID); conversationID != "" {
			ids = append(ids, conversationID)
		}
	}
	return ids
}

func (m *Manager) failOpenChatRunsForSessionEpoch(sessionEpoch uint64, message string) {
	message = strings.TrimSpace(message)
	if message == "" {
		message = agentDisconnectedChatRunMessage
	}

	data, err := json.Marshal(map[string]string{"message": message})
	if err != nil {
		data = []byte(`{"message":"Desktop agent disconnected. Please retry."}`)
	}
	now := time.Now()

	type broadcastTarget struct {
		event       *ChatBroadcastEvent
		subscribers []*chatRunSubscriber
	}
	targets := make([]broadcastTarget, 0)
	globalSubscribers := make([]chan *ChatBroadcastEvent, 0)

	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	for requestID, run := range m.chatStore.chatRuns {
		if run == nil || run.done || run.sessionEpoch != sessionEpoch {
			continue
		}

		run.nextSeq += 1
		run.updatedAt = now
		run.done = true
		run.expiresAt = now.Add(chatRunDoneRetention)

		chatEvent := &gatewayv1.ChatEvent{
			Type:           gatewayv1.ChatEvent_ERROR,
			ConversationId: strings.TrimSpace(run.conversationID),
			Data:           string(data),
		}
		broadcast := &ChatBroadcastEvent{
			RequestID: requestID,
			Event:     chatEvent,
			Seq:       run.nextSeq,
			Workdir:   strings.TrimSpace(run.workdir),
		}
		run.events = append(run.events, cloneChatBroadcastEvent(broadcast))
		if len(run.events) > maxBufferedChatRunEvents {
			copy(run.events, run.events[len(run.events)-maxBufferedChatRunEvents:])
			run.events = run.events[:maxBufferedChatRunEvents]
		}

		subscribers := make([]*chatRunSubscriber, 0, len(run.subscribers))
		for _, subscriber := range run.subscribers {
			subscribers = append(subscribers, subscriber)
		}
		targets = append(targets, broadcastTarget{
			event:       broadcast,
			subscribers: subscribers,
		})
	}
	for _, ch := range m.chatStore.chatSubscribers {
		globalSubscribers = append(globalSubscribers, ch)
	}
	m.chatStore.chatMu.Unlock()

	for _, target := range targets {
		for _, subscriber := range target.subscribers {
			select {
			case <-subscriber.done:
			case subscriber.ch <- cloneChatBroadcastEvent(target.event):
			}
		}
		for _, ch := range globalSubscribers {
			select {
			case ch <- cloneChatBroadcastEvent(target.event):
			default:
			}
		}
	}
}

func (m *Manager) SubscribeChatRun(
	requestID string,
	conversationID string,
	afterSeq int64,
) (<-chan *ChatBroadcastEvent, <-chan struct{}, func(), ChatRunSnapshot, error) {
	requestID = strings.TrimSpace(requestID)
	conversationID = strings.TrimSpace(conversationID)
	if afterSeq < 0 {
		afterSeq = 0
	}

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	m.pruneExpiredChatRunsLocked(time.Now())

	if requestID == "" && conversationID != "" {
		requestID = m.chatStore.chatRunByConversation[conversationID]
	}
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		done := make(chan struct{})
		close(done)
		return nil, done, func() {}, ChatRunSnapshot{}, ErrChatRunNotFound
	}

	replay := make([]*ChatBroadcastEvent, 0)
	for _, event := range run.events {
		if event.Seq > afterSeq {
			replay = append(replay, cloneChatBroadcastEvent(event))
		}
	}

	bufferSize := len(replay) + 128
	if bufferSize < 128 {
		bufferSize = 128
	}
	ch := make(chan *ChatBroadcastEvent, bufferSize)
	done := make(chan struct{})
	for _, event := range replay {
		ch <- event
	}

	subID := -1
	var subscriber *chatRunSubscriber
	if !run.done {
		subID = m.chatStore.nextChatRunSubID
		m.chatStore.nextChatRunSubID += 1
		subscriber = &chatRunSubscriber{
			ch:   ch,
			done: done,
		}
		run.subscribers[subID] = subscriber
	}

	var cleanupOnce sync.Once
	cleanup := func() {
		cleanupOnce.Do(func() {
			m.chatStore.chatMu.Lock()
			if subID >= 0 {
				if current := m.chatStore.chatRuns[requestID]; current != nil {
					delete(current.subscribers, subID)
				}
			}
			m.chatStore.chatMu.Unlock()
			if subscriber != nil {
				subscriber.close()
			} else {
				close(done)
			}
		})
	}

	return ch, done, cleanup, run.snapshot(), nil
}

func (m *Manager) broadcastChatEvent(requestID string, event *gatewayv1.ChatEvent) {
	if event == nil {
		return
	}

	requestID = strings.TrimSpace(requestID)
	conversationID := strings.TrimSpace(event.GetConversationId())
	now := time.Now()
	sessionEpoch := m.currentSessionEpoch()

	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	broadcast := &ChatBroadcastEvent{
		RequestID: requestID,
		Event:     event,
	}
	var runSubscribers []*chatRunSubscriber
	run := m.chatStore.chatRuns[requestID]
	if run == nil && requestID != "" {
		run = &chatRun{
			requestID:      requestID,
			conversationID: conversationID,
			sessionEpoch:   sessionEpoch,
			updatedAt:      now,
			subscribers:    make(map[int]*chatRunSubscriber),
		}
		m.chatStore.chatRuns[requestID] = run
		if conversationID != "" {
			m.chatStore.chatRunByConversation[conversationID] = requestID
		}
	}
	if run != nil {
		run.nextSeq += 1
		run.updatedAt = now
		if conversationID != "" {
			if run.conversationID != "" && run.conversationID != conversationID {
				if m.chatStore.chatRunByConversation[run.conversationID] == requestID {
					delete(m.chatStore.chatRunByConversation, run.conversationID)
				}
			}
			run.conversationID = conversationID
			m.chatStore.chatRunByConversation[conversationID] = requestID
			if run.workdir == "" {
				if activeRun, ok := m.chatStore.historyActiveRuns[conversationID]; ok {
					run.workdir = strings.TrimSpace(activeRun.workdir)
				}
			}
		}
		broadcast.Seq = run.nextSeq
		broadcast.Workdir = strings.TrimSpace(run.workdir)
		run.events = append(run.events, cloneChatBroadcastEvent(broadcast))
		if len(run.events) > maxBufferedChatRunEvents {
			copy(run.events, run.events[len(run.events)-maxBufferedChatRunEvents:])
			run.events = run.events[:maxBufferedChatRunEvents]
		}
		if isTerminalChatEvent(event) {
			run.done = true
			run.expiresAt = now.Add(chatRunDoneRetention)
		}
		runSubscribers = make([]*chatRunSubscriber, 0, len(run.subscribers))
		for _, subscriber := range run.subscribers {
			runSubscribers = append(runSubscribers, subscriber)
		}
	}
	subscribers := make([]chan *ChatBroadcastEvent, 0, len(m.chatStore.chatSubscribers))
	for _, ch := range m.chatStore.chatSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.chatStore.chatMu.Unlock()

	for _, subscriber := range runSubscribers {
		select {
		case <-subscriber.done:
		case subscriber.ch <- cloneChatBroadcastEvent(broadcast):
		}
	}
	for _, ch := range subscribers {
		select {
		case ch <- broadcast:
		default:
		}
	}
}

func (m *Manager) DispatchFromAgent(env *gatewayv1.AgentEnvelope) {
	m.dispatchFromAgent(nil, env)
}

func (m *Manager) DispatchFromAgentForSession(session *AgentSession, env *gatewayv1.AgentEnvelope) {
	m.dispatchFromAgent(session, env)
}

func (m *Manager) dispatchFromAgent(expected *AgentSession, env *gatewayv1.AgentEnvelope) {
	m.registry.mu.RLock()
	session := m.registry.session
	m.registry.mu.RUnlock()
	if session == nil || (expected != nil && session != expected) {
		return
	}

	if chatEvent := env.GetChatEvent(); chatEvent != nil {
		m.broadcastChatEvent(env.GetRequestId(), chatEvent)
	}

	if historySync := env.GetHistorySync(); historySync != nil {
		m.broadcastHistorySync(historySync)
		return
	}

	if settingsSync := env.GetSettingsSync(); settingsSync != nil {
		m.broadcastSettingsSync(settingsSync)
		return
	}

	if terminalEvent := env.GetTerminalEvent(); terminalEvent != nil {
		m.broadcastTerminalEvent(terminalEvent)
		return
	}

	session.dispatch(env)
}

func (r *chatRun) snapshot() ChatRunSnapshot {
	firstSeq := int64(0)
	if len(r.events) > 0 {
		firstSeq = r.events[0].Seq
	}
	return ChatRunSnapshot{
		RequestID:       r.requestID,
		ConversationID:  r.conversationID,
		ClientRequestID: r.clientRequestID,
		Workdir:         r.workdir,
		FirstSeq:        firstSeq,
		LatestSeq:       r.nextSeq,
		Done:            r.done,
	}
}

func (s *chatRunSubscriber) close() {
	s.closeOnce.Do(func() {
		close(s.done)
	})
}

func (m *Manager) pruneExpiredChatRunsLocked(now time.Time) {
	for requestID, run := range m.chatStore.chatRuns {
		if run == nil {
			delete(m.chatStore.chatRuns, requestID)
			continue
		}
		if run.done {
			if !run.expiresAt.IsZero() && now.After(run.expiresAt) {
				m.removeChatRunLocked(requestID, run)
			}
			continue
		}
		if !run.updatedAt.IsZero() && now.Sub(run.updatedAt) > chatRunStaleRetention {
			m.removeChatRunLocked(requestID, run)
		}
	}
}

func (m *Manager) removeChatRunLocked(requestID string, run *chatRun) {
	if run.conversationID != "" && m.chatStore.chatRunByConversation[run.conversationID] == requestID {
		delete(m.chatStore.chatRunByConversation, run.conversationID)
	}
	if run.clientRequestID != "" && m.chatStore.chatRunByClientRequest[run.clientRequestID] == requestID {
		delete(m.chatStore.chatRunByClientRequest, run.clientRequestID)
	}
	delete(m.chatStore.chatRuns, requestID)
	for _, subscriber := range run.subscribers {
		subscriber.close()
	}
}

func (m *Manager) releaseCompletedChatRunLocked(requestID string, run *chatRun) {
	if run.conversationID != "" && m.chatStore.chatRunByConversation[run.conversationID] == requestID {
		delete(m.chatStore.chatRunByConversation, run.conversationID)
	}
	if run.clientRequestID != "" && m.chatStore.chatRunByClientRequest[run.clientRequestID] == requestID {
		delete(m.chatStore.chatRunByClientRequest, run.clientRequestID)
	}
	delete(m.chatStore.chatRuns, requestID)
}

func cloneChatBroadcastEvent(event *ChatBroadcastEvent) *ChatBroadcastEvent {
	if event == nil {
		return nil
	}
	return &ChatBroadcastEvent{
		RequestID: event.RequestID,
		Event:     event.Event,
		Seq:       event.Seq,
		Workdir:   event.Workdir,
	}
}

func isTerminalChatEvent(event *gatewayv1.ChatEvent) bool {
	if event == nil {
		return false
	}
	return event.GetType() == gatewayv1.ChatEvent_DONE || event.GetType() == gatewayv1.ChatEvent_ERROR
}
