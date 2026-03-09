import { readFileSync, writeFileSync } from 'fs';

const content = readFileSync('C:/code/grove/src/index.ts');

const loopPos = content.indexOf(Buffer.from('for (const agent of toMerge)'));
const donePos = content.indexOf(Buffer.from('Done.'));
const startByte = loopPos - 4;
const endByte = donePos + 'Done.\");'.length;

console.log('loopPos:', loopPos, 'donePos:', donePos, 'startByte:', startByte, 'endByte:', endByte);

const CRLF = '\r\n';
const T1 = '\t\t\t\t';
const T2 = '\t\t\t\t\t';
const T3 = '\t\t\t\t\t\t';
const T4 = '\t\t\t\t\t\t\t';
const T5 = '\t\t\t\t\t\t\t\t';
const T6 = '\t\t\t\t\t\t\t\t\t';

const lines = [
	T1 + 'for (const agent of toMerge) {',
	T2 + 'if (opts.dryRun) {',
	T3 + 'await dryRunMerge(agent.branch);',
	T2 + '} else {',
	T3 + 'await doMerge(agent.branch, agent.name, agent.taskId, agent.parentName);',
	T2 + '}',
	T1 + '}',
	'',
	T1 + 'if (!opts.dryRun) {',
	T2 + '// Post-merge typecheck',
	T2 + 'console.log("\\n--- Post-merge validation ---");',
	T2 + 'console.log("Running typecheck (tsc --noEmit)...");',
	T2 + 'const { passed, output } = await runTypecheck();',
	T2 + 'if (passed) {',
	T3 + 'console.log("  Typecheck: PASSED");',
	T2 + '} else {',
	T3 + 'console.log("  Typecheck: FAILED");',
	T3 + 'if (output) {',
	T4 + 'const lines = output.split("\\n");',
	T4 + 'for (const line of lines.slice(0, 20)) {',
	T5 + 'console.log(`    ${line}`);',
	T4 + '}',
	T4 + 'if (lines.length > 20) {',
	T5 + 'console.log(`    ... (${lines.length - 20} more lines)`);',
	T4 + '}',
	T3 + '}',
	T2 + '}',
	'',
	T2 + '// Spawn reviewer if requested',
	T2 + 'if (opts.review) {',
	T3 + 'if (!passed) {',
	T4 + 'console.log("\\n  Skipping integration review: typecheck failed. Fix errors first.");',
	T3 + '} else {',
	T4 + 'console.log("\\n  Spawning integration reviewer...");',
	T4 + 'const reviewTaskId = `integration-review-${Date.now()}`;',
	T4 + 'const mergedSummary = toMerge',
	T5 + '.map((a) => `- ${a.branch} (${a.name})`)',
	T5 + '.join("\\n");',
	T4 + 'const taskDescription =',
	T5 + '`Integration review for branches merged into ${canonicalBranch}.\\n\\nMerged branches:\\n${mergedSummary}\\n\\nRun: git log --oneline ${canonicalBranch}~${toMerge.length}..${canonicalBranch} to see what was merged.\\n\\nCheck for: 1) Duplicate implementations, 2) Conflicting patterns, 3) Missing cross-feature wiring, 4) Logical regressions. Report PASS or FAIL with specific findings.`;',
	T4 + 'createTask({ taskId: reviewTaskId, title: "Integration review after merge --all", description: taskDescription });',
	T4 + 'const reviewerName = `integration-reviewer-${Date.now()}`;',
	T4 + 'try {',
	T5 + 'const result = await spawnAgent({',
	T6 + 'name: reviewerName,',
	T6 + 'capability: "reviewer",',
	T6 + 'taskId: reviewTaskId,',
	T6 + 'taskDescription,',
	T6 + 'baseBranch: canonicalBranch,',
	T5 + '});',
	T5 + 'console.log(`  Reviewer spawned: ${result.name} (PID ${result.pid})`);',
	T5 + 'console.log("  Check results with: grove mail check orchestrator");',
	T4 + '} catch (err) {',
	T4 + '  console.error(`  Failed to spawn reviewer: ${err}`);',
	T4 + '}',
	T3 + '}',
	T2 + '}',
	T1 + '}',
	'',
	T1 + 'console.log("\\nDone.");',
];

const newSection = lines.join(CRLF);

const newContent = Buffer.concat([
	content.slice(0, startByte),
	Buffer.from(newSection),
	content.slice(endByte),
]);

writeFileSync('C:/code/grove/src/index.ts', newContent);
console.log('Written successfully, size:', newContent.length, '(was:', content.length, ')');
