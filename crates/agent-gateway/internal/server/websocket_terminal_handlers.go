package server

import (
	"strings"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func terminalActionFromRequestType(requestType string) string {
	return strings.TrimPrefix(strings.TrimSpace(requestType), "terminal.")
}

func (c *websocketConnection) handleTerminalRequest(req websocketRequest) {
	action := terminalActionFromRequestType(req.Type)
	if !c.sm.WebTerminalEnabled() {
		_ = c.writeError(req.ID, "web terminal is disabled in desktop Remote settings")
		return
	}

	var body websocketTerminalRequestPayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid "+req.Type+" payload")
		return
	}

	cols, err := websocketOptionalUint32(body.Cols, "cols")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	rows, err := websocketOptionalUint32(body.Rows, "rows")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	maxBytes, err := websocketOptionalUint32(body.MaxBytes, "max_bytes")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	projectPathKey := strings.TrimSpace(body.ProjectPathKey)
	if action == "attach" || action == "snapshot" {
		c.rememberTerminalSession(body.SessionID, projectPathKey)
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_TerminalRequest{
			TerminalRequest: &gatewayv1.TerminalRequest{
				Action:         action,
				SessionId:      strings.TrimSpace(body.SessionID),
				ProjectPathKey: projectPathKey,
				Cwd:            strings.TrimSpace(body.Cwd),
				Shell:          strings.TrimSpace(body.Shell),
				Title:          strings.TrimSpace(body.Title),
				Data:           body.Data,
				Cols:           cols,
				Rows:           rows,
				MaxBytes:       maxBytes,
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

	resp := response.GetTerminalResponse()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}
	c.sm.ApplyTerminalResponseSnapshot(action, projectPathKey, resp)
	c.rememberTerminalInterest(action, body, resp)

	_ = c.writeResponse(req.ID, websocketTerminalResponsePayload(resp))
}

func (c *websocketConnection) rememberTerminalInterest(action string, body websocketTerminalRequestPayload, resp *gatewayv1.TerminalResponse) {
	projectPathKey := strings.TrimSpace(body.ProjectPathKey)
	sessionID := strings.TrimSpace(body.SessionID)
	if respSession := resp.GetSession(); respSession != nil {
		if projectPathKey == "" {
			projectPathKey = strings.TrimSpace(respSession.GetProjectPathKey())
		}
		if sessionID == "" {
			sessionID = strings.TrimSpace(respSession.GetId())
		}
	}

	switch action {
	case "list", "create", "close_project":
		c.rememberTerminalProject(projectPathKey)
	case "attach", "snapshot":
		c.rememberTerminalSession(sessionID, projectPathKey)
	}
}

func (c *websocketConnection) handleTerminalDetach(req websocketRequest) {
	if !c.sm.WebTerminalEnabled() {
		_ = c.writeError(req.ID, "web terminal is disabled in desktop Remote settings")
		return
	}
	var body websocketTerminalRequestPayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid terminal.detach payload")
		return
	}
	c.forgetTerminalInterest(body.SessionID, body.ProjectPathKey)
	_ = c.writeResponse(req.ID, map[string]any{"action": "detach"})
}
