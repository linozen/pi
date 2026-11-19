---
description: Run the project's applicable checks and report what remains unverified
argument-hint: "[scope or acceptance criteria]"
---
Verify ${@:-the current change}. Read the relevant changes and project instructions. Find the documented verification workflow in the nearest README, test scripts, task runner, or CI configuration. Use those commands rather than inventing a parallel workflow.

1. Identify the affected behavior and what would demonstrate it works.
2. Start with the smallest applicable local checks. Run broader integration or end-to-end checks when they cover behavior the narrower checks cannot. Use existing disposable test environments where appropriate; do not use real credentials or the host Docker socket as a substitute.
3. Do not edit source or tests to make checks pass. Do not deploy or run state-changing checks on remote or shared targets without explicit approval of each exact target and command, including anything run through a Herdr pane. If a step is blocked, give the operator the command and prerequisites rather than improvising access.
4. Report the working directory or target, exact command, and outcome for each check. Separate passed, failed, and not run. State what remains unverified; a narrower passing check does not stand in for a blocked end-to-end check.
