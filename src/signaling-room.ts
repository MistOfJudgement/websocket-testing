import { DurableObject } from "cloudflare:workers";

type IncomingMessage =
    | { type: "authenticate"; password: string }
    | { type: "data"; payload: string };

type OutgoingMessage =
    | { type: "authenticated"; role: "host" | "client"; id: string }
    | { type: "joined"; source: string; timestamp: number }
    | { type: "left"; source: string; timestamp: number }
    | { type: "data"; payload: string; from: string; timestamp: number }
    | { type: "error"; message: string };

export class SignalingRoom extends DurableObject {
    private hostSocket: WebSocket | null = null;
    private roomPassword: string | null = null;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
    }

    async fetch(request: Request): Promise<Response> {
        const upgradeHeader = request.headers.get("Upgrade");
        if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
            return new Response("Expected WebSocket connection", { status: 426 });
        }

        try {
            const webSocketPair = new WebSocketPair();
            const [client, server] = Object.values(webSocketPair);

            this.ctx.acceptWebSocket(server);

            // Using Cloudflare's built-in unique id or fallback crypto random for client session tracking
            const clientId = crypto.randomUUID().substring(0, 5);
            server.serializeAttachment({ id: clientId, authenticated: false });

            return new Response(null, { status: 101, webSocket: client });
        } catch (err: any) {
            return new Response(`Internal DO Error: ${err?.message || err}`, { status: 500 });
        }
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        try {
            const rawText = typeof message === "string" ? message : new TextDecoder().decode(message);
            const attachment = ws.deserializeAttachment() as { id: string; authenticated: boolean };
            console.log(`[DO RECV] From ${attachment.id}:`, rawText); // <-- ADD THIS
            let data: IncomingMessage;
            try {
                data = JSON.parse(rawText);
            } catch {
                ws.send(JSON.stringify({ type: "error", message: "Invalid JSON format" } as OutgoingMessage));
                return;
            }

            // --- Authentication Phase ---
            if (!attachment.authenticated) {
                if (data.type === "authenticate") {
                    if (this.hostSocket === null) {
                        // Claim room as Host
                        this.hostSocket = ws;
                        this.roomPassword = data.password;
                        attachment.authenticated = true;
                        ws.serializeAttachment(attachment);

                        ws.send(JSON.stringify({ type: "authenticated", role: "host", id: attachment.id } as OutgoingMessage));
                        this.broadcast({ type: "joined", source: attachment.id, timestamp: Date.now() }, ws);
                    } else {
                        // Authenticate as Client
                        if (data.password === this.roomPassword) {
                            attachment.authenticated = true;
                            ws.serializeAttachment(attachment);
                            console.log("client", attachment.id)
                            ws.send(JSON.stringify({ type: "authenticated", role: "client", id: attachment.id } as OutgoingMessage));
                            this.broadcast({ type: "joined", source: attachment.id, timestamp: Date.now() }, ws);
                        } else {
                            ws.send(JSON.stringify({ type: "error", message: "Invalid password" } as OutgoingMessage));
                            ws.close(4003, "Authentication failed");
                        }
                    }
                } else {
                    ws.send(JSON.stringify({ type: "error", message: "Must authenticate first" } as OutgoingMessage));
                }
                return;
            }

            // --- Game Data Handling ---
            if (data.type === "data") {
                const wrappedData: OutgoingMessage = {
                    type: "data",
                    payload: data.payload,
                    from: attachment.id,
                    timestamp: Date.now()
                };
                if (ws === this.hostSocket) {
                    this.broadcast(wrappedData, ws);
                } else {
                    this.hostSocket?.send(JSON.stringify(wrappedData))
                }
            }

        } catch (err: any) {
            console.error(`[DO] Error:`, err);
        }
    }

    async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
        try {
            const attachment = ws.deserializeAttachment() as { id: string; authenticated: boolean };
            ws.close(code, "Closed");

            if (ws === this.hostSocket) {
                this.hostSocket = null;
                this.roomPassword = null;
                for (const s of this.ctx.getWebSockets()) {
                    s.close(1000, "Host left");
                }
            } else if (attachment?.authenticated) {
                this.broadcast({ type: "left", source: attachment.id, timestamp: Date.now() });
            }
        } catch (err: any) {
            console.error(`[DO] Close Error:`, err);
        }
    }

    async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
        ws.close(1011, "WebSocket error");
    }

    private broadcast(message: OutgoingMessage, excludeSocket?: WebSocket): void {
        const payloadString = JSON.stringify(message);
        for (const socket of this.ctx.getWebSockets()) {
            try {
                if (socket === excludeSocket) continue;
                const att = socket.deserializeAttachment() as { authenticated: boolean };
                if (att && att.authenticated) {
                    socket.send(payloadString);
                }
            } catch (err) {
                console.error("Broadcast failed:", err);
            }
        }
    }
}