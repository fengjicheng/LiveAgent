package server

import (
	"sync"
	"time"

	"golang.org/x/net/websocket"
)

type websocketConnectionWriter struct {
	conn    *websocket.Conn
	timeout time.Duration
	mu      sync.Mutex
}

func newWebsocketConnectionWriter(conn *websocket.Conn, timeout time.Duration) *websocketConnectionWriter {
	return &websocketConnectionWriter{
		conn:    conn,
		timeout: timeout,
	}
}

func (w *websocketConnectionWriter) write(envelope websocketEnvelope) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timeout > 0 {
		if err := w.conn.SetWriteDeadline(time.Now().Add(w.timeout)); err != nil {
			return err
		}
		defer func() {
			_ = w.conn.SetWriteDeadline(time.Time{})
		}()
	}
	return websocket.JSON.Send(w.conn, envelope)
}
