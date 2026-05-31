package session

import (
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func NewAgentSession(auth AuthSnapshot) *AgentSession {
	return &AgentSession{
		AgentID:      auth.AgentID,
		AgentVersion: auth.AgentVersion,
		SessionID:    auth.SessionID,
		ConnectedAt:  time.Now(),
		LastPing:     time.Now(),
		toAgent:      make(chan *gatewayv1.GatewayEnvelope, 64),
		done:         make(chan struct{}),
		streams:      make(map[string]*agentStream),
	}
}

func (s *AgentSession) Outbound() <-chan *gatewayv1.GatewayEnvelope {
	return s.toAgent
}

func (s *AgentSession) Done() <-chan struct{} {
	return s.done
}

func (s *AgentSession) Close() {
	s.closeOnce.Do(func() {
		s.streamsMu.Lock()
		s.closed = true
		close(s.done)
		for requestID, stream := range s.streams {
			delete(s.streams, requestID)
			stream.close()
		}
		s.streamsMu.Unlock()
	})
}

func (s *AgentSession) SendToAgent(env *gatewayv1.GatewayEnvelope) error {
	s.streamsMu.Lock()
	closed := s.closed
	s.streamsMu.Unlock()
	if closed {
		return ErrAgentOffline
	}

	select {
	case <-s.done:
		return ErrAgentOffline
	case s.toAgent <- env:
		return nil
	}
}

func (s *AgentSession) TrySendToAgent(env *gatewayv1.GatewayEnvelope) (bool, error) {
	s.streamsMu.Lock()
	closed := s.closed
	s.streamsMu.Unlock()
	if closed {
		return false, ErrAgentOffline
	}

	select {
	case <-s.done:
		return false, ErrAgentOffline
	default:
	}

	select {
	case <-s.done:
		return false, ErrAgentOffline
	case s.toAgent <- env:
		return true, nil
	default:
		return false, nil
	}
}

func (s *AgentSession) registerStream(requestID string) (*agentStream, error) {
	stream := &agentStream{
		ch:   make(chan *gatewayv1.AgentEnvelope, 64),
		done: make(chan struct{}),
	}

	s.streamsMu.Lock()
	defer s.streamsMu.Unlock()
	if s.closed {
		stream.close()
		return nil, ErrAgentOffline
	}
	if existing, ok := s.streams[requestID]; ok {
		existing.close()
	}
	s.streams[requestID] = stream
	return stream, nil
}

func (s *AgentSession) unregisterStream(requestID string, stream *agentStream) {
	s.streamsMu.Lock()
	if existing, ok := s.streams[requestID]; ok && existing == stream {
		delete(s.streams, requestID)
		existing.close()
	}
	s.streamsMu.Unlock()
}

func (s *AgentSession) dispatch(env *gatewayv1.AgentEnvelope) {
	s.streamsMu.Lock()
	stream := s.streams[env.GetRequestId()]
	s.streamsMu.Unlock()
	if stream == nil {
		return
	}
	stream.send(env)
}

func (s *agentStream) close() {
	s.closeOnce.Do(func() {
		close(s.done)
	})
}

func (s *agentStream) send(env *gatewayv1.AgentEnvelope) bool {
	select {
	case <-s.done:
		return false
	case s.ch <- env:
		return true
	}
}
