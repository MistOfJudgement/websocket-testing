import { DurableObject } from "cloudflare:workers";

interface message {
    timestamp: number
    source: string
    message: string
}
function genId() {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    let counter = 0;
    while (counter < 5) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
        counter += 1;
    }
    return result;
}
export class SignalingRoom extends DurableObject {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        // const room = url.searchParams.get("roomid");
        const upgradeHeader = request.headers.get("Upgrade");



        if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
            console.log("1")
            return new Response("Expected WebSocket connection", { status: 426 });
        }

        try {
            const webSocketPair = new WebSocketPair();
            const [client, server] = Object.values(webSocketPair);

            console.log("2")
            this.ctx.acceptWebSocket(server);
            const id = genId()
            server.serializeAttachment(id)
            // server.serializeAttachment(room);

            this.broadcast({ source: "server", timestamp: Date.now(), message: `User ${id} joined` })

            return new Response(null, { status: 101, webSocket: client });

        } catch (err: any) {
            return new Response(`Internal DO Error: ${err?.message || err}`, { status: 500 });
        }
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        try {

            const rawText = typeof message === "string" ? message : new TextDecoder().decode(message);

            const id = ws.deserializeAttachment();
            let output: message = {
                message: rawText,
                timestamp: Date.now(),
                source: id ?? "UNKNOWN"
            }
            console.log(JSON.stringify(output))
            this.broadcast((output));

        } catch (err: any) {
            console.error(`[DO:SignalingRoom] 💥 Error in webSocketMessage:`, err?.stack || err);
        }
    }

    async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
        try {
            const attachment: string | undefined = ws.deserializeAttachment();
            const peerId = attachment || "UNKNOWN";

            ws.close(code, "Closed");

            if (attachment) {
                this.broadcast(
                    { message: `${peerId} left`, source: "server", timestamp: Date.now() }
                );
            }
        } catch (err: any) {
            console.error(`[DO:SignalingRoom] 💥 Error in webSocketClose:`, err?.stack || err);
        }
    }

    async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
        ws.close(1011, "WebSocket error");
    }

    private broadcast(message: message, excludePeerId?: string): void {
        const sockets = this.ctx.getWebSockets();
        let sentCount = 0;

        for (const socket of sockets) {
            try {
                const attachment: string | null = socket.deserializeAttachment();
                if (attachment && attachment !== excludePeerId) {
                    socket.send(JSON.stringify(message));
                    sentCount++;
                }
            } catch (err) {
                console.error("[DO:SignalingRoom] Failed to broadcast to a socket:", err);
            }
        }
    }
}