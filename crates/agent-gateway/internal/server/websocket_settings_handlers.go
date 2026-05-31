package server

import (
	"strings"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (c *websocketConnection) handleSettingsGet(req websocketRequest) {
	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_SettingsGet{
			SettingsGet: &gatewayv1.SettingsGetRequest{},
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

	settingsResp := response.GetSettingsGetResp()
	if settingsResp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	payload, err := websocketSettingsJSONPayload(settingsResp.GetSettingsJson())
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	c.sm.ApplySettingsJSON(settingsResp.GetSettingsJson())

	_ = c.writeResponse(req.ID, payload)
}

func (c *websocketConnection) handleSettingsUpdate(req websocketRequest) {
	payloadJSON, err := websocketRawPayloadJSON(req.Payload)
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_SettingsUpdate{
			SettingsUpdate: &gatewayv1.SettingsUpdateRequest{
				SettingsJson: payloadJSON,
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

	settingsResp := response.GetSettingsUpdateResp()
	if settingsResp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}
	if settingsResp.GetAccepted() {
		c.sm.ApplySettingsJSONPreservingRemote(payloadJSON)
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"accepted": settingsResp.GetAccepted(),
		"message":  strings.TrimSpace(settingsResp.GetMessage()),
	})
}
