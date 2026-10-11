import { DurableObject } from "cloudflare:workers";

export class ChatLobbyRoom extends DurableObject {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const upgradeHeader = request.headers.get("Upgrade");

        return new Response("Not Ready", { status: 400 })
    }
}