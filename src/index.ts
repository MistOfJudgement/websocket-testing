import html from "../public/index.html";
import { SignalingRoom } from "./signaling-room";
export { SignalingRoom };

export interface Env {
    SIGNALING_ROOM: DurableObjectNamespace<SignalingRoom>;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        console.log(`\n========================================`);
        console.log(`[Worker] Incoming Request: ${request.method} ${url.pathname}${url.search}`);

        // Match WebSocket signaling route: /room/:roomId
        const match = url.pathname.match(/^\/room\/([^\/]+)/);
        if (match) {
            const roomId = match[1];
            const peerId = url.searchParams.get("peerId");
            const upgradeHeader = request.headers.get("Upgrade");

            console.log(`[Worker] Room Route Hit. RoomID: "${roomId}", PeerID: "${peerId}", Upgrade Header: "${upgradeHeader}"`);

            if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
                console.warn(`[Worker] ⚠️ Request rejected: Missing or invalid Upgrade header.`);
                return new Response("Expected WebSocket connection. Connect using ws:// or wss://", { status: 426 });
            }

            if (!peerId) {
                console.warn(`[Worker] ⚠️ Request rejected: Missing 'peerId' query parameter.`);
                return new Response("Missing 'peerId' query parameter", { status: 400 });
            }

            try {
                console.log(`[Worker] Fetching DO stub for room: "${roomId}"`);
                const id = env.SIGNALING_ROOM.idFromName(roomId);
                const stub = env.SIGNALING_ROOM.get(id);

                console.log(`[Worker] Forwarding request to DO stub...`);
                const response = await stub.fetch(request);

                console.log(`[Worker] DO returned response status: ${response.status}`);
                return response;
            } catch (err: any) {
                console.error(`[Worker] 💥 Unhandled Exception when forwarding to DO:`, err?.stack || err);
                return new Response(`Worker Error: ${err?.message || err}`, { status: 500 });
            }
        }

        console.log(`[Worker] Path "${url.pathname}" did not match /room/* endpoint.`);
        return new Response(html, { headers: { "Content-Type": "text/html" } });
    },
};