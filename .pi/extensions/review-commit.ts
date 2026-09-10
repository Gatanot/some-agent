import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_COMMIT_MESSAGE = "chore: checkpoint before commit review";
const MAX_STATUS_LENGTH = 12_000;

function formatCommandFailure(command: string, stderr: string): string {
	const detail = stderr.trim();
	return detail ? `${command} failed: ${detail}` : `${command} failed`;
}

export default function reviewCommitExtension(pi: ExtensionAPI) {
	pi.registerCommand("review-commit", {
		description: "Commit current changes, then review the resulting commit",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const repoCheck = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
			if (repoCheck.code !== 0) {
				ctx.ui.notify("/review-commit requires a Git repository", "error");
				return;
			}

			const status = await pi.exec("git", ["status", "--short"], { cwd: ctx.cwd });
			if (status.code !== 0) {
				ctx.ui.notify(formatCommandFailure("git status", status.stderr), "error");
				return;
			}

			if (status.stdout.trim()) {
				if (!ctx.hasUI) {
					ctx.ui.notify("/review-commit will not commit changes without interactive confirmation", "error");
					return;
				}

				const statusText = status.stdout.trim().slice(0, MAX_STATUS_LENGTH);
				const confirmed = await ctx.ui.confirm(
					"Commit changes before review?",
					`The following changes will be staged with git add -A and committed:\n\n${statusText}`,
				);
				if (!confirmed) {
					ctx.ui.notify("Commit cancelled", "info");
					return;
				}

				const currentStatus = await pi.exec("git", ["status", "--short"], { cwd: ctx.cwd });
				if (currentStatus.code !== 0 || currentStatus.stdout.trim() !== status.stdout.trim()) {
					ctx.ui.notify("Working tree changed while waiting for confirmation; no commit was created", "error");
					return;
				}

				const add = await pi.exec("git", ["add", "-A"], { cwd: ctx.cwd });
				if (add.code !== 0) {
					ctx.ui.notify(formatCommandFailure("git add -A", add.stderr), "error");
					return;
				}

				const commitMessage = args.trim() || DEFAULT_COMMIT_MESSAGE;
				const commit = await pi.exec("git", ["commit", "-m", commitMessage], { cwd: ctx.cwd });
				if (commit.code !== 0) {
					ctx.ui.notify(formatCommandFailure("git commit", commit.stderr), "error");
					return;
				}
			}

			const reviewedCommit = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd });
			if (reviewedCommit.code !== 0 || !reviewedCommit.stdout.trim()) {
				ctx.ui.notify("Could not resolve the commit to review", "error");
				return;
			}

			const commit = reviewedCommit.stdout.trim();
			const reviewPrompt = `Review Git commit ${commit} in the current repository.

Use read-only commands only. Inspect the commit metadata and diff with:
- git show --stat --oneline ${commit}
- git diff-tree --root --no-commit-id -p ${commit}

Review the implementation for correctness, regressions, security issues, error handling gaps, and missing tests. Read relevant surrounding files and repository instructions before deciding. Report findings first, ordered by severity, with file and line references, a concrete example or short trace, impact, and the smallest appropriate fix. Do not modify files, create another commit, or review unrelated uncommitted changes. If the commit has no actionable findings, say so explicitly and list residual risks.`;

			if (status.stdout.trim()) {
				ctx.ui.notify(`Committed ${commit.slice(0, 12)}; starting review`, "info");
			}
			pi.sendUserMessage(reviewPrompt);
		},
	});
}
