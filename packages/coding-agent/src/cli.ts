#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";

setupCli();

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "web") {
	const webEnv: NodeJS.ProcessEnv = {
		...process.env,
		PI_WEB_ASSETS: resolve(import.meta.dirname, "../web-ui"),
		PI_WEB_MODE: process.env.PI_WEB_MODE ?? "production",
	};
	const webArgs = cliArgs.slice(1);
	for (let index = 0; index < webArgs.length; index++) {
		const argument = webArgs[index];
		if (argument === "--port" && webArgs[index + 1]) webEnv.PI_WEB_PORT = webArgs[++index];
		else if (argument === "--cwd" && webArgs[index + 1]) webEnv.PI_WEB_CWD = resolve(webArgs[++index]);
		else if (argument === "--help" || argument === "-h") {
			console.log("Usage: orrery web [--port <port>] [--cwd <directory>]");
			process.exit(0);
		} else if (argument !== undefined) {
			console.error(`Unknown web option: ${argument}`);
			process.exitCode = 1;
			process.exit();
		}
	}
	const webServer = spawn(process.execPath, [resolve(import.meta.dirname, "../web/server.js")], {
		stdio: "inherit",
		env: webEnv,
	});
	webServer.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exitCode = code ?? 1;
	});
} else {
	main(cliArgs);
}
