import * as bundledPiAgentCore from "@gatanot/orrery-agent-core";
import * as bundledPiAiCompat from "@gatanot/orrery-ai/compat";
import * as bundledPiAiOauth from "@gatanot/orrery-ai/oauth";
import * as bundledPiAiProviders from "@gatanot/orrery-ai/providers/all";
import * as bundledPiTui from "@gatanot/orrery-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @gatanot/orrery.
import * as bundledPiCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@gatanot/orrery-agent-core": bundledPiAgentCore,
	"@gatanot/orrery-tui": bundledPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@gatanot/orrery-ai": bundledPiAiCompat,
	"@gatanot/orrery-ai/compat": bundledPiAiCompat,
	"@gatanot/orrery-ai/oauth": bundledPiAiOauth,
	"@gatanot/orrery-ai/providers/all": bundledPiAiProviders,
	"@earendil-works/pi-agent-core": bundledPiAgentCore,
	"@earendil-works/pi-tui": bundledPiTui,
	"@earendil-works/pi-ai": bundledPiAiCompat,
	"@earendil-works/pi-ai/compat": bundledPiAiCompat,
	"@earendil-works/pi-ai/oauth": bundledPiAiOauth,
	"@earendil-works/pi-ai/providers/all": bundledPiAiProviders,
	"@earendil-works/pi-coding-agent": bundledPiCodingAgent,
	"@gatanot/orrery": bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": bundledPiAgentCore,
	"@mariozechner/pi-tui": bundledPiTui,
	"@mariozechner/pi-ai": bundledPiAiCompat,
	"@mariozechner/pi-ai/compat": bundledPiAiCompat,
	"@mariozechner/pi-ai/oauth": bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
};
