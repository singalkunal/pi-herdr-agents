/** Real parent/child Pi, production child wrapper, private Core, no paid models. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { isRecord, isString } from "@nubl/maestro/core/config/type-guards";
import { CoreLab, findLabBinary } from "./herdr-core-lab.ts";
import {
	captureCoreEvidence,
	coreResults,
	prepareCorePi,
	startCoreParent,
	waitForCoreSession,
} from "./core-parent.ts";
import { resetProviderRequests } from "./fake-provider.ts";

const core = process.env.HERDR_CORE_BIN ?? findLabBinary("herdr-core");
const pi = process.env.PI_BIN ?? findLabBinary("pi");

test("Core fresh and resumed children publish assigned names without changing terminal identity", {
	skip: !core || !pi ? "herdr-core and pi are required" : false,
	timeout: 120_000,
}, async (t) => {
	resetProviderRequests();
	const lab = new CoreLab(core, pi);
	const evidence = mkdtempSync(join("/tmp", "piha-core-label-evidence-"));
	t.diagnostic(`Core display-name evidence: ${evidence}`);
	const gates = [join(lab.root, "fresh-gate"), join(lab.root, "resume-gate")];
	t.after(async () => {
		for (const gate of gates) writeFileSync(gate, "release\n");
		try {
			await captureCoreEvidence(lab, evidence);
		} finally {
			await lab.stop();
			lab.remove();
		}
	});
	const project = prepareCorePi(lab);
	await lab.start();
	const task = (stage: string, gate: string) =>
		`INTEGRATION_CORE_DISPLAY_NAME\nRun this bash command: echo 'START_${stage}' > '${gate}.started'; while [ ! -f '${gate}' ]; do sleep 0.1; done; echo 'DONE_${stage}'\nThen report completion.`;
	const parent = await startCoreParent(
		lab,
		pi,
		project,
		"parent",
		[
			'Call subagent once with name: "mailbox-api-2".',
			'agent: "test-echo".',
			"fork: false.",
			`task: ${JSON.stringify(task("FRESH_LABEL", gates[0]))}.`,
		].join("\n"),
	);
	let sessionFile = "";
	let freshAddress = "";
	for (const [index, name] of [
		"mailbox-api-2",
		"Mailbox UI / resumed α",
	].entries()) {
		if (index) {
			await lab.call("terminal.send", {
				terminal: parent.terminal,
				text: `Call the subagent_resume tool with sessionPath: ${JSON.stringify(sessionFile)}, name: ${JSON.stringify(name)}, message: ${JSON.stringify(task("RESUMED_LABEL", gates[index]))}.`,
				force: true,
				wait: false,
			});
		}
		const deadline = performance.now() + 30_000;
		for (;;) {
			const listing = await lab.call("terminal.list", { all: true });
			assert.ok(Array.isArray(listing.terminals));
			const child = listing.terminals.find(
				(value) => isRecord(value) && value.parent === parent.terminal,
			);
			if (isRecord(child) && isString(child.address)) {
				const record = await lab.call("terminal.get", {
					terminal: child.address,
				});
				if (
					isRecord(record.labels) &&
					record.labels["pi.subagent.name"] === name &&
					existsSync(`${gates[index]}.started`)
				) {
					assert.equal(record.parent, parent.terminal);
					assert.equal(record.state, "live");
					assert.equal(
						record.name,
						null,
						"display names do not reserve native names",
					);
					assert.equal(record.keep, false);
					assert.equal(record.rm, false);
					if (index) assert.notEqual(child.address, freshAddress);
					else freshAddress = child.address;
					writeFileSync(
						join(evidence, `${index ? "resumed" : "fresh"}-terminal.json`),
						JSON.stringify(record, null, 2),
					);
					break;
				}
			}
			assert.ok(
				performance.now() < deadline,
				`Missing ${name} label: ${JSON.stringify(listing)}`,
			);
			await delay(50);
		}
		const parentRecord = await lab.call("terminal.get", {
			terminal: parent.terminal,
		});
		assert.ok(isRecord(parentRecord.labels));
		assert.equal(parentRecord.labels["pi.subagent.name"], undefined);
		writeFileSync(gates[index], "finish\n");
		const entries = await waitForCoreSession(
			parent,
			(rows) => coreResults(rows).length === index + 1,
		);
		const result = coreResults(entries)[index];
		assert.ok(isRecord(result.details));
		assert.equal(result.details.errorMessage, undefined);
		assert.ok(isString(result.details.sessionFile));
		if (index) assert.equal(result.details.sessionFile, sessionFile);
		else sessionFile = result.details.sessionFile;
	}
});
