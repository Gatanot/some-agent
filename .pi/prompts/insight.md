---
description: Audit code quality, duplication, and unnecessary complexity
argument-hint: "[scope or focus]"
---
Audit the code quality of the current repository.

Requested scope or focus: ${ARGUMENTS:-recent changes and the code paths they affect}

Start by reading the repository instructions and identifying the relevant changes and surrounding implementation. This is a review task: do not modify files unless I explicitly ask for fixes after the review.

Look for concrete, consequential problems, including:

- Duplicate implementations or logic that should use an existing local abstraction
- Abstractions that add indirection without removing meaningful complexity or duplication
- Premature generalization, speculative extensibility, and unnecessary configuration
- Functions, types, state, dependencies, or branches that are unused or redundant
- Responsibilities placed in the wrong module or across unclear ownership boundaries
- Complex control flow, hidden coupling, or state transitions that make correctness hard to verify
- Inconsistent error handling, validation, naming, or established repository conventions
- Tests that duplicate implementation details while missing important behavior

Do not recommend abstraction merely because two small blocks look similar. Distinguish required simplification from optional stylistic preference. Account for intentional compatibility, performance, security, and framework constraints before calling something over-engineered.

Report findings first, ordered by severity. For every finding, include a file and line reference, a concrete example or short execution trace, the impact, and the smallest appropriate solution. Separate issues introduced by recent changes from pre-existing issues. If there are no actionable findings, say so explicitly and list any residual risks or areas you could not verify.
