import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	publishCoreSubagentName,
	SUBAGENT_NAME_LABEL,
} from "../../pi-extension/subagents/core-display-name.ts";
import { socketPath } from "../socket-path.ts";

async function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "piha-display-name-"));
	const path = socketPath(dir, "core.sock");
	const sockets = new Set<Socket>();
	const calls: {
		method: string;
		params: { terminal: string; labels: Record<string, string> };
	}[] = [];
	const state = { wrongAddress: false, fail: false, silent: false };
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const end = buffer.indexOf("\n");
				if (end < 0) return;
				const request = JSON.parse(buffer.slice(0, end));
				buffer = buffer.slice(end + 1);
				if (request.method === "hello") {
					socket.write(
						JSON.stringify({
							jsonrpc: "2.0",
							id: request.id,
							result: {
								generation: 1,
								framed: false,
								core: { id: "display-name-test" },
								methods: [
									"terminal.run",
									"terminal.get",
									"terminal.list",
									"terminal.keys",
									"terminal.kill",
									"terminal.rm",
									"terminal.read",
									"terminal.label",
								],
							},
						}) + "\n",
					);
					continue;
				}
				calls.push(request);
				if (state.silent) continue;
				if (state.fail) {
					socket.destroy();
					continue;
				}
				socket.write(
					JSON.stringify({
						jsonrpc: "2.0",
						id: request.id,
						result: {
							address: state.wrongAddress ? "t99" : request.params.terminal,
							argv: ["pi"],
							cwd: dir,
							created_ms: 1,
							state: "live",
							keep: false,
							rm: false,
							labels: request.params.labels,
						},
					}) + "\n",
				);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	});
	const env = {
		PI_SUBAGENT_ID: "child-id",
		PI_SUBAGENT_NAME: "mailbox-api-2",
		HC_TERMINAL_ID: "t2",
		HC_TERMINAL_SOCKET: path,
	};
	return { env, calls, state };
}

test("Core child publishes only its own display label, preserving arbitrary task names", async (t) => {
	const f = await fixture(t);
	const name = "Mailbox UI / review: α 'quoted'";
	assert.equal(
		await publishCoreSubagentName({ ...f.env, PI_SUBAGENT_NAME: name }),
		true,
	);
	assert.deepEqual(f.calls, [
		{
			jsonrpc: "2.0",
			id: 2,
			method: "terminal.label",
			params: { terminal: "t2", labels: { [SUBAGENT_NAME_LABEL]: name } },
		},
	]);
});

test("duplicate display names on separate child terminals do not reserve native names", async (t) => {
	const f = await fixture(t);
	await publishCoreSubagentName(f.env);
	await publishCoreSubagentName({ ...f.env, HC_TERMINAL_ID: "t3" });
	assert.deepEqual(
		f.calls.map((call) => call.params.terminal),
		["t2", "t3"],
	);
	assert.ok(
		f.calls.every(
			(call) => call.params.labels[SUBAGENT_NAME_LABEL] === "mailbox-api-2",
		),
	);
});

test("normal Pi, missing identity, blank names, invalid addresses and legacy contexts never mutate Core", async (t) => {
	const f = await fixture(t);
	for (const overrides of [
		{ PI_SUBAGENT_ID: "" },
		{ PI_SUBAGENT_NAME: "" },
		{ PI_SUBAGENT_NAME: "  " },
		{ HC_TERMINAL_ID: "remote/t2" },
		{ HC_TERMINAL_ID: "" },
		{ HC_TERMINAL_SOCKET: "" },
		{ HERDR_ENV: "1" },
	])
		assert.equal(
			await publishCoreSubagentName({ ...f.env, ...overrides }),
			false,
		);
	assert.deepEqual(f.calls, []);
});

test("Core socket fallback works for a resumed child name", async (t) => {
	const f = await fixture(t);
	await publishCoreSubagentName({
		...f.env,
		HC_TERMINAL_SOCKET: "",
		HC_SOCKET: f.env.HC_TERMINAL_SOCKET,
		PI_SUBAGENT_NAME: "mailbox-api-resumed",
	});
	assert.equal(
		f.calls[0].params.labels[SUBAGENT_NAME_LABEL],
		"mailbox-api-resumed",
	);
});

test("wrong terminal replies and disconnected metadata writes reject without retry or lifecycle calls", async (t) => {
	const f = await fixture(t);
	f.state.wrongAddress = true;
	await assert.rejects(publishCoreSubagentName(f.env), /different terminal/);
	f.state.wrongAddress = false;
	f.state.fail = true;
	await assert.rejects(
		publishCoreSubagentName(f.env),
		/disconnected|unavailable/,
	);
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["terminal.label", "terminal.label"],
	);
});

test("an unresponsive Core cannot hold a display update indefinitely", async (t) => {
	const f = await fixture(t);
	f.state.silent = true;
	const start = performance.now();
	await assert.rejects(publishCoreSubagentName(f.env), /deadline/);
	assert.ok(performance.now() - start < 5000);
	assert.equal(f.calls.length, 1);
});
