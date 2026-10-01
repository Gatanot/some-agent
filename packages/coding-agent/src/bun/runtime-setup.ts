import { bedrockProviderModule } from "@gatanot/orrery-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@gatanot/orrery-ai/bun-oauth";
import { setBedrockProviderModule } from "@gatanot/orrery-ai/compat";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
