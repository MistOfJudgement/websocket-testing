import { DurableObject } from "cloudflare:workers";

export interface Env {
	TIC_TAC_TOE: DurableObjectNamespace;
}

interface GameRow {
	id: number;
	board: string;
	turn: string;
	winner: string | null;
}

interface MoveMessage {
	action: "move";
	index: number;
	player: string;
}

interface ResetMessage {
	action: "reset";
}

type ClientMessage = MoveMessage | ResetMessage;

interface GameState {
	board: string;
	turn: string;
	winner: string | null;
}

export class TicTacToeRoom extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		// FIXED: Use this.ctx.storage.sql instead of this.ctx.sql
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS game (
				id INTEGER PRIMARY KEY,
				board TEXT,
				turn TEXT,
				winner TEXT
			)
		`);

		// Seed default state if empty
		const row = this.ctx.storage.sql.exec("SELECT * FROM game WHERE id = 1").toArray() as unknown as GameRow[];
		if (row.length === 0) {
			const emptyBoard = JSON.stringify(Array(9).fill(null));
			this.ctx.storage.sql.exec("INSERT INTO game (id, board, turn, winner) VALUES (1, ?, 'X', NULL)", emptyBoard);
		}
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		this.ctx.acceptWebSocket(server);
		server.send(JSON.stringify(this.getState()));

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(conn: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const data: ClientMessage = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));

		if (data.action === "move") {
			const state = this.getState();

			if (state.winner || state.turn !== data.player) return;
			const board: (string | null)[] = JSON.parse(state.board);
			if (board[data.index] !== null) return;

			board[data.index] = data.player;
			const nextTurn = data.player === "X" ? "O" : "X";
			const winner = this.checkWinner(board);

			// FIXED: Use this.ctx.storage.sql
			this.ctx.storage.sql.exec(
				"UPDATE game SET board = ?, turn = ?, winner = ? WHERE id = 1",
				JSON.stringify(board),
				nextTurn,
				winner
			);

			this.broadcastState();
		} else if (data.action === "reset") {
			const emptyBoard = JSON.stringify(Array(9).fill(null));
			
			// FIXED: Use this.ctx.storage.sql
			this.ctx.storage.sql.exec("UPDATE game SET board = ?, turn = 'X', winner = NULL WHERE id = 1", emptyBoard);
			this.broadcastState();
		}
	}

	getState(): GameState {
		// FIXED: Use this.ctx.storage.sql
		const rows = this.ctx.storage.sql.exec("SELECT * FROM game WHERE id = 1").toArray() as unknown as GameRow[];
		const row = rows[0];
		return {
			board: row.board,
			turn: row.turn,
			winner: row.winner,
		};
	}

	broadcastState(): void {
		const stateString = JSON.stringify(this.getState());
		for (const socket of this.ctx.getWebSockets()) {
			socket.send(stateString);
		}
	}

	checkWinner(b: (string | null)[]): string | null {
		const lines = [
			[0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
			[0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
			[0, 4, 8], [2, 4, 6]          // Diagonals
		];
		for (const [x, y, z] of lines) {
			if (b[x] && b[x] === b[y] && b[x] === b[z]) return b[x];
		}
		return b.includes(null) ? null : "Draw";
	}
}

// 1. Put your HTML frontend code right here as a string
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Cloudflare Tic-Tac-Toe</title>
    <style>
        body { background: #121212; color: #fff; font-family: sans-serif; text-align: center; margin-top: 40px; }
        #board { display: grid; grid-template-columns: repeat(3, 100px); gap: 8px; justify-content: center; margin: 20px auto; }
        .cell { width: 100px; height: 100px; background: #1e1e1e; font-size: 48px; display: flex; align-items: center; justify-content: center; cursor: pointer; border-radius: 8px; color: #00ffd5; }
        .cell:hover { background: #2a2a2a; }
        #status { font-size: 20px; margin-bottom: 15px; }
        button { padding: 10px 20px; font-size: 16px; cursor: pointer; background: #00ffd5; border: none; border-radius: 5px; font-weight: bold; }
    </style>
</head>
<body>
    <h1>Cloudflare Durable Object Tic-Tac-Toe</h1>
    <div id="status">Connecting...</div>
    <div id="board">
        <div class="cell" onclick="makeMove(0)"></div>
        <div class="cell" onclick="makeMove(1)"></div>
        <div class="cell" onclick="makeMove(2)"></div>
        <div class="cell" onclick="makeMove(3)"></div>
        <div class="cell" onclick="makeMove(4)"></div>
        <div class="cell" onclick="makeMove(5)"></div>
        <div class="cell" onclick="makeMove(6)"></div>
        <div class="cell" onclick="makeMove(7)"></div>
        <div class="cell" onclick="makeMove(8)"></div>
    </div>
    <br>
    <button onclick="resetGame()">Restart Game</button>
    <script>
        const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(\`\${wsProtocol}//\${window.location.host}/?room=match-1\`);
        let currentState = { board: Array(9).fill(null), turn: "X", winner: null };
        const myPlayerSymbol = prompt("Play as which symbol? Type 'X' or 'O':")?.toUpperCase() || "X";

        ws.onmessage = (event) => {
            let data = JSON.parse(event.data);
            currentState.board = JSON.parse(data.board);
            currentState.turn = data.turn;
            currentState.winner = data.winner;
            render();
        };

        function makeMove(index) {
            if (currentState.winner) return;
            if (currentState.turn !== myPlayerSymbol) {
                alert("Not your turn!");
                return;
            }
            ws.send(JSON.stringify({ action: "move", index: index, player: myPlayerSymbol }));
        }

        function resetGame() {
            ws.send(JSON.stringify({ action: "reset" }));
        }

        function render() {
            const cells = document.querySelectorAll(".cell");
            cells.forEach((cell, i) => {
                cell.textContent = currentState.board[i] || "";
            });
            const status = document.getElementById("status");
            if (currentState.winner) {
                status.textContent = currentState.winner === "Draw" ? "It's a Draw!" : \`Player \${currentState.winner} Wins! 🎉\`;
            } else {
                status.textContent = \`You are: \${myPlayerSymbol} | Turn: Player \${currentState.turn}\`;
            }
        }
    </script>
</body>
</html>`;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// If it's a standard browser request, serve the game UI directly!
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response(HTML_CONTENT, {
				headers: { "Content-Type": "text/html" },
			});
		}

		// Otherwise, handle the WebSocket connection via the Durable Object
		const url = new URL(request.url);
		const roomId = url.searchParams.get("room") || "room-1";
		const id = env.TIC_TAC_TOE.idFromName(roomId);
		const stub = env.TIC_TAC_TOE.get(id);
		return await stub.fetch(request);
	},
};

