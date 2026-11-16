import { createChildExtension } from "@nubl/maestro/pi/child";
import { renderChildWidget } from "./child-widget.ts";
import { publishCoreSubagentName } from "./core-display-name.ts";

export default createChildExtension((ctx, identity) => {
	// Both fresh and resumed children already receive PI_SUBAGENT_NAME.
	// Publishing display metadata must not delay or fail their task startup.
	void publishCoreSubagentName().catch(() => {
		ctx.ui.notify(
			"Could not publish the subagent display name to Herdr Core.",
			"warning",
		);
	});
	renderChildWidget(ctx, identity);
});
