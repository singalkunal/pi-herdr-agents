import {
	HerdrCoreClient,
	parseTerminal,
	terminalAddress,
} from "../../maestro/surfaces/herdr/herdr-core-protocol.ts";

export const SUBAGENT_NAME_LABEL = "pi.subagent.name";

/** Optional display metadata, never a terminal name or an ownership marker. */
export async function publishCoreSubagentName(
	env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
	const name = env.PI_SUBAGENT_NAME;
	const terminal = env.HC_TERMINAL_ID;
	const socket = env.HC_TERMINAL_SOCKET || env.HC_SOCKET;
	// Legacy shells may inherit HC_* from a Core-backed parent. Never label
	// that parent's terminal, nor a normal Pi session without child identity.
	if (
		env.HERDR_ENV === "1" ||
		!env.PI_SUBAGENT_ID ||
		!name?.trim() ||
		!terminalAddress(terminal) ||
		!socket
	)
		return false;
	const result = await new HerdrCoreClient(socket, 1500).call(
		"terminal.label",
		{ terminal, labels: { [SUBAGENT_NAME_LABEL]: name } },
		parseTerminal,
	);
	if (result.address !== terminal)
		throw new Error("Herdr Core display label returned a different terminal");
	return true;
}
