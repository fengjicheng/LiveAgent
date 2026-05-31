package session

import (
	"errors"
	"sync"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

var ErrAgentOffline = errors.New("agent offline")
var ErrChatRunNotFound = errors.New("chat run not found")

const (
	maxBufferedChatRunEvents = 50000
	chatRunDoneRetention     = time.Hour
	chatRunStaleRetention    = 12 * time.Hour

	agentDisconnectedChatRunMessage = "Desktop agent disconnected. Please retry."
)

type AuthSnapshot struct {
	AgentID      string
	AgentVersion string
	SessionID    string
}

type Manager struct {
	registry  *sessionRegistry
	syncHub   *syncHub
	chatStore *chatRunStore
}

type AgentSession struct {
	AgentID      string
	AgentVersion string
	SessionID    string
	ConnectedAt  time.Time
	LastPing     time.Time

	toAgent chan *gatewayv1.GatewayEnvelope
	done    chan struct{}

	closeOnce sync.Once
	closed    bool

	streamsMu sync.Mutex
	streams   map[string]*agentStream
}

type agentStream struct {
	ch        chan *gatewayv1.AgentEnvelope
	done      chan struct{}
	closeOnce sync.Once
}

type ChatBroadcastEvent struct {
	RequestID string
	Event     *gatewayv1.ChatEvent
	Seq       int64
	Workdir   string
}

type ChatRunSnapshot struct {
	RequestID       string
	ConversationID  string
	ClientRequestID string
	Workdir         string
	FirstSeq        int64
	LatestSeq       int64
	Done            bool
}

type ActiveChatRunSummary struct {
	ConversationID string
	Workdir        string
	UpdatedAt      int64
}

type chatRun struct {
	requestID       string
	conversationID  string
	clientRequestID string
	workdir         string
	sessionEpoch    uint64
	events          []*ChatBroadcastEvent
	nextSeq         int64
	done            bool
	updatedAt       time.Time
	expiresAt       time.Time
	subscribers     map[int]*chatRunSubscriber
}

type activeHistoryRun struct {
	conversationID string
	workdir        string
	updatedAt      time.Time
}

type chatRunSubscriber struct {
	ch        chan *ChatBroadcastEvent
	done      chan struct{}
	closeOnce sync.Once
}

type Status struct {
	Online         bool   `json:"online"`
	AgentID        string `json:"agent_id"`
	AgentVersion   string `json:"agent_version"`
	SessionID      string `json:"session_id,omitempty"`
	ConnectedSince int64  `json:"connected_since"`
	LastHeartbeat  int64  `json:"last_heartbeat"`
}

func NewManager() *Manager {
	return &Manager{
		registry:  newSessionRegistry(),
		syncHub:   newSyncHub(),
		chatStore: newChatRunStore(),
	}
}
