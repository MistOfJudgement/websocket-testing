import { DurableObject } from "cloudflare:workers";

interface PeerAttachment {
    peerId: string;
}

export class SignalingRoom extends DurableObject {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        console.log("[DO:SignalingRoom] Instance initialized/awakened from hibernation.");
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const peerId = url.searchParams.get("peerId");
        const upgradeHeader = request.headers.get("Upgrade");

        console.log(`[DO:SignalingRoom] fetch() received request:`, {
            url: request.url,
            method: request.method,
            upgradeHeader,
            peerId,
            headers: Object.fromEntries(request.headers.entries())
        });

        if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
            console.error("[DO:SignalingRoom] ❌ Rejected: Upgrade header is not 'websocket'");
            return new Response("Expected WebSocket connection", { status: 426 });
        }

        if (!peerId) {
            console.error("[DO:SignalingRoom] ❌ Rejected: Missing 'peerId' query parameter");
            return new Response("Missing 'peerId' parameter", { status: 400 });
        }

        try {
            console.log(`[DO:SignalingRoom] Creating WebSocketPair for peer: [${peerId}]`);
            const webSocketPair = new WebSocketPair();
            const [client, server] = Object.values(webSocketPair);

            console.log(`[DO:SignalingRoom] Calling ctx.acceptWebSocket() for peer: [${peerId}]`);
            // Hand over to DO Hibernation state (DO NOT call server.accept())
            this.ctx.acceptWebSocket(server, [peerId]);

            console.log(`[DO:SignalingRoom] Serializing attachment for peer: [${peerId}]`);
            const attachment: PeerAttachment = { peerId };
            server.serializeAttachment(attachment);

            const activeSockets = this.ctx.getWebSockets();
            console.log(`[DO:SignalingRoom] Current total connected WebSockets in room: ${activeSockets.length}`);

            console.log(`[DO:SignalingRoom] Broadcasting 'peer-joined' event for: [${peerId}]`);
            this.broadcast(
                JSON.stringify({ type: "peer-joined", peerId }),
                peerId
            );

            console.log(`[DO:SignalingRoom] ✅ Upgrade successful. Returning 101 Switching Protocols for peer: [${peerId}]`);
            return new Response(null, { status: 101, webSocket: client });

        } catch (err: any) {
            console.error(`[DO:SignalingRoom] 💥 CRITICAL ERROR during WebSocket upgrade for peer [${peerId}]:`, err?.stack || err);
            return new Response(`Internal DO Error: ${err?.message || err}`, { status: 500 });
        }
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        try {
            const attachment: PeerAttachment | null = ws.deserializeAttachment();
            const senderId = attachment?.peerId || "UNKNOWN_PEER";

            const rawText = typeof message === "string" ? message : new TextDecoder().decode(message);
            console.log(`[DO:SignalingRoom] 📩 Message received from [${senderId}]:`, rawText);

            let data: any;
            try {
                data = JSON.parse(rawText);
            } catch (jsonErr) {
                console.warn(`[DO:SignalingRoom] ⚠️ Failed to parse message JSON from [${senderId}]:`, rawText);
                return;
            }

            data.from = senderId;

            if (data.targetPeerId) {
                console.log(`[DO:SignalingRoom] 🎯 Routing targeted message type '${data.type}' from [${senderId}] to [${data.targetPeerId}]`);
                this.sendToPeer(data.targetPeerId, JSON.stringify(data));
            } else {
                console.log(`[DO:SignalingRoom] 📢 Broadcasting message type '${data.type}' from [${senderId}] to room`);
                this.broadcast(JSON.stringify(data), senderId);
            }
        } catch (err: any) {
            console.error(`[DO:SignalingRoom] 💥 Error in webSocketMessage:`, err?.stack || err);
        }
    }

    async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
        try {
            const attachment: PeerAttachment | null = ws.deserializeAttachment();
            const peerId = attachment?.peerId || "UNKNOWN_PEER";

            console.log(`[DO:SignalingRoom] 🔌 WebSocket closed for peer [${peerId}]. Code: ${code}, Reason: "${reason}"`);
            ws.close(code, "Closed");

            if (attachment) {
                console.log(`[DO:SignalingRoom] Broadcasting 'peer-left' event for: [${peerId}]`);
                this.broadcast(
                    JSON.stringify({ type: "peer-left", peerId: attachment.peerId })
                );
            }

            const remainingSockets = this.ctx.getWebSockets();
            console.log(`[DO:SignalingRoom] Remaining connected WebSockets: ${remainingSockets.length}`);
        } catch (err: any) {
            console.error(`[DO:SignalingRoom] 💥 Error in webSocketClose:`, err?.stack || err);
        }
    }

    async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
        const attachment: PeerAttachment | null = ws.deserializeAttachment();
        const peerId = attachment?.peerId || "UNKNOWN_PEER";
        console.error(`[DO:SignalingRoom] ⚠️ WebSocket error for peer [${peerId}]:`, error);
        ws.close(1011, "WebSocket error");
    }

    private broadcast(message: string, excludePeerId?: string): void {
        const sockets = this.ctx.getWebSockets();
        let sentCount = 0;

        for (const socket of sockets) {
            try {
                const attachment: PeerAttachment | null = socket.deserializeAttachment();
                if (attachment && attachment.peerId !== excludePeerId) {
                    socket.send(message);
                    sentCount++;
                }
            } catch (err) {
                console.error("[DO:SignalingRoom] Failed to broadcast to a socket:", err);
            }
        }
        console.log(`[DO:SignalingRoom] Broadcast complete. Delivered to ${sentCount} socket(s) (excluded: [${excludePeerId || "none"}]).`);
    }

    private sendToPeer(targetPeerId: string, message: string): void {
        const sockets = this.ctx.getWebSockets(targetPeerId);
        console.log(`[DO:SignalingRoom] Found ${sockets.length} socket(s) tagged with peerId [${targetPeerId}]`);

        if (sockets.length === 0) {
            console.warn(`[DO:SignalingRoom] ⚠️ Target peer [${targetPeerId}] not found in room! Message dropped.`);
            return;
        }

        for (const socket of sockets) {
            try {
                socket.send(message);
            } catch (err) {
                console.error(`[DO:SignalingRoom] Failed sending to peer [${targetPeerId}]:`, err);
            }
        }
    }
}