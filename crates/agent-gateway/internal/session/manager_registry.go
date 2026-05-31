package session

import (
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (m *Manager) RecordAuthentication(agentID, agentVersion, sessionID string) {
	m.registry.mu.Lock()
	defer m.registry.mu.Unlock()
	m.registry.lastAuth = AuthSnapshot{
		AgentID:      agentID,
		AgentVersion: agentVersion,
		SessionID:    sessionID,
	}
	m.registry.authValid = true
}

func (m *Manager) LatestAuthSnapshot() AuthSnapshot {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	return m.registry.lastAuth
}

func (m *Manager) IsOnline() bool {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	return m.registry.session != nil
}

func (m *Manager) SetSession(s *AgentSession) {
	m.registry.mu.Lock()
	previous := m.registry.session
	previousEpoch := m.registry.sessionEpoch
	if m.registry.authValid {
		s.AgentID = m.registry.lastAuth.AgentID
		s.AgentVersion = m.registry.lastAuth.AgentVersion
		s.SessionID = m.registry.lastAuth.SessionID
	}
	if previous != s {
		m.registry.sessionEpoch += 1
	}
	sessionChanged := previous != s
	m.registry.session = s
	m.registry.mu.Unlock()

	if sessionChanged {
		m.clearTerminalSessionSnapshot()
	}
	if previous != nil && previous != s {
		previous.Close()
		m.failOpenChatRunsForSessionEpoch(previousEpoch, agentDisconnectedChatRunMessage)
	}
}

func (m *Manager) ClearSession(session *AgentSession) {
	m.registry.mu.Lock()
	if m.registry.session != session {
		m.registry.mu.Unlock()
		return
	}
	clearedEpoch := m.registry.sessionEpoch
	m.registry.session = nil
	m.registry.mu.Unlock()

	if session == nil {
		return
	}

	session.Close()
	m.clearTerminalSessionSnapshot()
	m.failOpenChatRunsForSessionEpoch(clearedEpoch, agentDisconnectedChatRunMessage)
}

func (m *Manager) Status() Status {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()

	status := Status{}
	if m.registry.authValid {
		status.AgentID = m.registry.lastAuth.AgentID
		status.AgentVersion = m.registry.lastAuth.AgentVersion
		status.SessionID = m.registry.lastAuth.SessionID
	}
	if m.registry.session == nil {
		return status
	}
	status.Online = true
	status.AgentID = m.registry.session.AgentID
	status.AgentVersion = m.registry.session.AgentVersion
	status.SessionID = m.registry.session.SessionID
	status.ConnectedSince = m.registry.session.ConnectedAt.Unix()
	status.LastHeartbeat = m.registry.session.LastPing.Unix()
	return status
}

func (m *Manager) TouchHeartbeat(session *AgentSession) {
	m.registry.mu.Lock()
	defer m.registry.mu.Unlock()
	if m.registry.session == session {
		m.registry.session.LastPing = time.Now()
	}
}

func (m *Manager) SendToAgent(env *gatewayv1.GatewayEnvelope) error {
	m.registry.mu.RLock()
	session := m.registry.session
	m.registry.mu.RUnlock()
	if session == nil {
		return ErrAgentOffline
	}

	return session.SendToAgent(env)
}

func (m *Manager) currentSessionEpoch() uint64 {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	return m.registry.sessionEpoch
}

func (m *Manager) RegisterStream(requestID string) (<-chan *gatewayv1.AgentEnvelope, <-chan struct{}, func(), error) {
	m.registry.mu.RLock()
	session := m.registry.session
	m.registry.mu.RUnlock()
	if session == nil {
		return nil, nil, nil, ErrAgentOffline
	}

	stream, err := session.registerStream(requestID)
	if err != nil {
		return nil, nil, nil, err
	}

	cleanup := func() {
		session.unregisterStream(requestID, stream)
	}

	return stream.ch, stream.done, cleanup, nil
}
