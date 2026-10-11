import chatPage from "../public/chat.html";
import echoPage from "../public/echo.html";
import landingPage from "../public/index.html";
import { ChatLobbyRoom } from "./chat-lobby-room";
import { SignalingRoom } from "./signaling-room";
export { ChatLobbyRoom, SignalingRoom };
export interface Env {
    SIGNALING_ROOM: DurableObjectNamespace<SignalingRoom>;
    CHAT_LOBBY_ROOM: DurableObjectNamespace<ChatLobbyRoom>;
}

function servePage(htmlContent: string): Response {
    return new Response(htmlContent, { headers: { "Content-Type": "text/html" } })
}
export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        // return new Response("Not Implemented", { status: 400 })
        console.log(url.pathname)
        if (url.pathname.startsWith("/echo")) {
            return new Response(echoPage, { headers: { "Content-Type": "text/html" } })

        }
        if (url.pathname.startsWith("/chat")) {
            return servePage(chatPage)
        }

        if (url.pathname.startsWith("/api/echo")) {
            const upgradeHeader = request.headers.get("Upgrade")
            if (!upgradeHeader || upgradeHeader !== "websocket") {
                return new Response("errrr wrong", { status: 426 })
            }
            const [client, server] = Object.values(new WebSocketPair())
            server.accept()

            server.addEventListener("message", (event) => {
                server.send(event.data)
            })

            return new Response(null, { status: 101, webSocket: client })
        }
        // Match WebSocket signaling route: /room/:roomId
        const match = url.pathname.match(/^\/api\/chat\/([^\/]+)/);
        if (match) {
            const roomId = match[1];
            const upgradeHeader = request.headers.get("Upgrade");

            console.log(`[Worker] Room Route Hit. RoomID: "${roomId}", Upgrade Header: "${upgradeHeader}"`);

            if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
                return new Response("Expected WebSocket connection. Connect using ws:// or wss://", { status: 426 });
            }


            try {
                const id = env.SIGNALING_ROOM.idFromName(roomId);
                const stub = env.SIGNALING_ROOM.get(id);

                const response = await stub.fetch(request);

                return response;
            } catch (err: any) {
                return new Response(`Worker Error: ${err?.message || err}`, { status: 500 });
            }
        } else {
            console.log("?")
        }

        return new Response(landingPage, { headers: { "Content-Type": "text/html" } });
    },
};