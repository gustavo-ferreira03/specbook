import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareAgentInvocation, executeAgent } from '../src/agent.ts';
import { emptyAgentState } from '../src/mcp.ts';
import { addProfile } from '../src/credentials.ts';
import { initWorkspace, newSpec } from '../src/workspace.ts';

// Run with pnpm --filter specbook exec tsx scripts/check-agent-wiring.mjs.
// Model requests go to this script's loopback stub; no paid agent request is made.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'specbook-wiring-'));
const previousSpecbookHome = process.env.SPECBOOK_HOME;
const previousLauncher = process.argv[1];
process.env.SPECBOOK_HOME = path.join(root, 'credentials');
process.argv[1] = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const app = path.join(root, 'app');
const workspace = path.join(app, '.specbook');
const session = path.join(root, 'session');
await fs.mkdir(app);
await fs.mkdir(session, { mode: 0o700 });
await initWorkspace(app, 'http://127.0.0.1:45879');
await newSpec(workspace, 'Probe', 'Probe');
const selectedPath = 'specs/probe/probe';
const state = emptyAgentState();
state.attempts[selectedPath] = 2;
await fs.writeFile(path.join(session, 'state.json'), JSON.stringify(state), { mode: 0o600 });
const sentinel = 'SpecbookCredentialSentinel9472';
await addProfile('probe', { password: sentinel });
await fs.writeFile(path.join(workspace, selectedPath, 'spec.ts'), `import { test, expect } from "specbook";
test("Probe", async ({ page, step, secret }) => {
    await step("Open the app", async () => {
        await page.goto("/");
        await page.getByRole("textbox").fill(secret("missing", "password"));
        await expect(page.locator("body")).toBeVisible();
    });
});
// ${sentinel}
`);
const transport = new StdioClientTransport({ command: process.execPath, args: [...process.execArgv, process.argv[1], '--mcp', workspace, session], env: { ...process.env }, stderr: 'pipe' });
const client = new Client({ name: 'specbook-wiring-check', version: '1.0.0' });
let server;
try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.equal(names.length, 17);
    for (const name of ['ask_question', 'propose_specs', 'request_credentials', 'report_done', 'report_failed']) {
        assert.equal(listed.tools.find((tool) => tool.name === name)?.inputSchema.type, 'object');
    }
    const resultText = (result) => result.content.map((item) => item.type === 'text' ? item.text : '').join('');
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    assert.equal(resultText(await call('credentials_list')).includes(sentinel), false);
    const read = resultText(await call('spec_read', { path: `${selectedPath}/spec.ts` }));
    assert.equal(read.includes(sentinel), false);
    assert.equal(read.includes('[REDACTED]'), true);
    assert.equal((await call('spec_write', { path: '../app.ts', content: 'bad' })).isError, true);
    assert.equal((await call('spec_write', { path: `${selectedPath}/spec.ts`, content: sentinel })).isError, true);
    const lastRun = await call('run_spec', { path: selectedPath });
    assert.equal(lastRun.isError, true);
    assert.match(resultText(lastRun), /not configured/);
    const rejectedRun = await call('run_spec', { path: selectedPath });
    assert.equal(rejectedRun.isError, true);
    assert.match(resultText(rejectedRun), /three-run limit/);
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(workspace, 'specs/probe/escape'), 'dir');
    assert.equal((await call('spec_write', { path: 'specs/probe/escape/spec.ts', content: 'bad' })).isError, true);
    assert.deepEqual(await fs.readdir(outside), []);
    await fs.unlink(path.join(workspace, 'specs/probe/escape'));
    await assert.rejects(client.listResources());
    await assert.rejects(client.listResourceTemplates());
    await assert.rejects(client.readResource({ uri: 'file:///etc/passwd' }));
    await client.close();
    const restarted = new Client({ name: 'specbook-restart-check', version: '1.0.0' });
    try {
        await restarted.connect(new StdioClientTransport({ command: process.execPath, args: [...process.execArgv, process.argv[1], '--mcp', workspace, session], env: { ...process.env }, stderr: 'pipe' }));
        const retry = await restarted.callTool({ name: 'run_spec', arguments: { path: selectedPath } });
        assert.equal(retry.isError, true);
        assert.match(resultText(retry), /three-run limit/);
        const resumedCall = (name, args = {}) => restarted.callTool({ name, arguments: args });
        assert.equal((await resumedCall('request_credentials', { message: 'Need a login', profile: 'missing', fields: ['password'] })).isError, true);
        await resumedCall('credentials_list');
        assert.equal((await resumedCall('request_credentials', { message: 'Need a login', profile: 'probe', fields: ['password'] })).isError, true);
        assert.equal((await resumedCall('ask_question', { message: sentinel })).isError, true);
        const source = (await fs.readFile(path.join(workspace, selectedPath, 'spec.ts'), 'utf8')).replace(`// ${sentinel}`, '');
        for (let index = 0; index < 2; index++) assert.equal((await resumedCall('spec_write', { path: `${selectedPath}/spec.ts`, content: source })).isError, undefined);
        const saved = JSON.parse(await fs.readFile(path.join(session, 'state.json'), 'utf8'));
        assert.deepEqual(saved.writes, [`${selectedPath}/spec.ts`]);
        assert.deepEqual(saved.writeEvents, [`${selectedPath}/spec.ts`, `${selectedPath}/spec.ts`]);
        assert.equal((await resumedCall('propose_specs', { message: 'Pick coverage', proposals: [{ title: 'Login', why: 'Check sign in', feature: 'Account' }, { title: 'Cart', why: 'Check cart contents', feature: 'Shopping' }] })).isError, undefined);
        const outcome = JSON.parse(await fs.readFile(path.join(session, 'outcome.json'), 'utf8'));
        assert.equal(outcome.status, 'waiting_for_selection');
        assert.deepEqual(outcome.proposals.map((proposal) => proposal.number), [1, 2]);
        assert.equal((await resumedCall('report_done', { message: 'Cannot end twice' })).isError, true);
        if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(session, 'outcome.json'))).mode & 0o777, 0o600);
    } finally { await restarted.close(); }
    const completed = new Client({ name: 'specbook-completed-check', version: '1.0.0' });
    try {
        await completed.connect(new StdioClientTransport({ command: process.execPath, args: [...process.execArgv, process.argv[1], '--mcp', workspace, session], env: { ...process.env }, stderr: 'pipe' }));
        assert.equal((await completed.callTool({ name: 'credentials_list', arguments: {} })).isError, true);
    } finally { await completed.close(); }
    const selectionSession = path.join(root, 'selection');
    await fs.mkdir(selectionSession, { mode: 0o700 });
    await fs.writeFile(path.join(selectionSession, 'state.json'), JSON.stringify({ ...emptyAgentState(), attempts: { [selectedPath]: 3 }, proposalRuns: { 1: selectedPath } }), { mode: 0o600 });
    await fs.writeFile(path.join(selectionSession, 'turn.json'), JSON.stringify({ id: randomUUID(), selected: [{ number: 1, title: 'Login', why: 'Check sign in', feature: 'Account' }, { number: 2, title: 'Cart', why: 'Check cart', feature: 'Shopping' }] }), { mode: 0o600 });
    const selectionClient = new Client({ name: 'specbook-selection-check', version: '1.0.0' });
    try {
        await selectionClient.connect(new StdioClientTransport({ command: process.execPath, args: [...process.execArgv, process.argv[1], '--mcp', workspace, selectionSession], env: { ...process.env }, stderr: 'pipe' }));
        for (const proposalNumber of [undefined, 3]) {
            const result = await selectionClient.callTool({ name: 'run_spec', arguments: { path: selectedPath, ...(proposalNumber ? { proposalNumber } : {}) } });
            assert.equal(result.isError, true);
            assert.match(resultText(result), /Pass a proposalNumber/);
        }
        const combined = await selectionClient.callTool({ name: 'run_spec', arguments: { path: selectedPath, proposalNumber: 2 } });
        assert.equal(combined.isError, true);
        assert.match(resultText(combined), /distinct Spec/);
        const accepted = await selectionClient.callTool({ name: 'run_spec', arguments: { path: selectedPath, proposalNumber: 1 } });
        assert.equal(accepted.isError, true);
        assert.match(resultText(accepted), /three-run limit/);
        await fs.writeFile(path.join(selectionSession, 'turn.json'), JSON.stringify({ id: randomUUID() }), { mode: 0o600 });
        const stale = await selectionClient.callTool({ name: 'spec_write', arguments: { path: 'specs/probe/probe/spec.ts', content: 'stale turn' } });
        assert.equal(stale.isError, true);
        assert.match(resultText(stale), /turn was replaced/);
        assert.equal((await fs.readFile(path.join(workspace, selectedPath, 'spec.ts'), 'utf8')).includes('stale turn'), false);
    } finally { await selectionClient.close(); }
    for (const [tool, args, expectedStatus] of [
        ['ask_question', { message: 'Which behavior should be checked?' }, 'waiting_for_reply'],
        ['request_credentials', { message: 'Need a login', profile: 'missing', fields: ['username', 'password'] }, 'needs_credentials'],
        ['report_done', { message: 'Request finished' }, 'done'],
        ['report_failed', { message: 'Could not complete; fix the login and retry', error: 'Login unavailable' }, 'failed'],
    ]) {
        const outcomeSession = path.join(root, tool);
        await fs.mkdir(outcomeSession, { mode: 0o700 });
        await fs.writeFile(path.join(outcomeSession, 'state.json'), JSON.stringify(emptyAgentState()), { mode: 0o600 });
        const outcomeClient = new Client({ name: 'specbook-outcome-check', version: '1.0.0' });
        try {
            await outcomeClient.connect(new StdioClientTransport({ command: process.execPath, args: [...process.execArgv, process.argv[1], '--mcp', workspace, outcomeSession], env: { ...process.env }, stderr: 'pipe' }));
            if (tool === 'request_credentials') await outcomeClient.callTool({ name: 'credentials_list', arguments: {} });
            assert.equal((await outcomeClient.callTool({ name: tool, arguments: args })).isError, undefined);
            const outcome = JSON.parse(await fs.readFile(path.join(outcomeSession, 'outcome.json'), 'utf8'));
            assert.equal(outcome.status, expectedStatus);
            if (tool === 'request_credentials') {
                assert.equal(outcome.pendingAction.command, 'specbook credentials add missing');
                assert.match(outcome.message, /Profile: missing/);
                assert.match(outcome.message, /Fields: username, password/);
                assert.match(outcome.message, /specbook credentials add missing/);
            }
        } finally { await outcomeClient.close(); }
    }
    console.log(JSON.stringify({ mcpTools: names, credentialRedaction: true, pathTraversalRejected: true, symlinkRejected: true, threeRunLimit: true, budgetPersistedAfterRestart: true, typedOutcomes: true, terminalGateAfterRestart: true, writeEventsPreserved: true, selectedProposalMappingEnforced: true, staleTurnToolsRejected: true }));

    let expectedAgent;
    let modelRequest;
    let sequence = 0;
    const marker = 'SpecbookSessionProbeMarker9472';
    server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        let parsed;
        try { parsed = JSON.parse(body); } catch { response.writeHead(404).end(); return; }
        if (!Array.isArray(parsed.tools)) { response.writeHead(400).end('The probe requires an explicit model-visible tool inventory'); return; }
        const flattenTools = (tools, namespace = '') => tools.flatMap((tool) => tool.type === 'namespace'
            ? flattenTools(tool.tools, namespace + tool.name + '__')
            : [namespace + (tool.name ?? tool.type)]);
        modelRequest = { body: parsed, tools: flattenTools(parsed.tools).sort() };
        if (expectedAgent === 'claude') {
            const message = { id: `msg_${++sequence}`, type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } };
            const events = [
                ['message_start', { type: 'message_start', message }],
                ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
                ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: marker } }],
                ['content_block_stop', { type: 'content_block_stop', index: 0 }],
                ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
                ['message_stop', { type: 'message_stop' }],
            ];
            response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(events.map(([name, event]) => `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
            return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const item = { id: `msg_${++sequence}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: marker, annotations: [] }] };
        const result = { id: `resp_${sequence}`, object: 'response', status: 'completed', output: [item] };
        const events = [
            { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
            { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
            { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
            { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: marker },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: result },
        ];
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${server.address().port}`;
    for (const agent of ['codex', 'claude']) {
        expectedAgent = agent;
        const agentSession = path.join(root, agent);
        await fs.mkdir(agentSession, { mode: 0o700 });
        await fs.writeFile(path.join(agentSession, 'state.json'), JSON.stringify(emptyAgentState()), { mode: 0o600 });
        let sessionId;
        for (let turn = 0; turn < 2; turn++) {
            modelRequest = undefined;
            let invocation;
            const previousKey = process.env[agent === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'];
            const keyName = agent === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
            process.env[keyName] = 'probe';
            try { invocation = await prepareAgentInvocation(agent, workspace, agentSession, 'Use only Specbook MCP tools.', undefined, sessionId); }
            catch (error) {
                if (error.code === 'ENOENT') { console.log(JSON.stringify({ agent, skipped: 'not installed' })); break; }
                throw error;
            } finally {
                if (previousKey === undefined) delete process.env[keyName];
                else process.env[keyName] = previousKey;
            }
            if (agent === 'codex') {
                const position = invocation.args.includes('resume') ? invocation.args.indexOf('resume') : invocation.args.length - 1;
                invocation.args.splice(position, 0,
                    '-c', 'model_provider="specbook_probe"',
                    '-c', `model_providers.specbook_probe={name="Probe",base_url=${JSON.stringify(address)},wire_api="responses",env_key="SPECBOOK_PROBE_API_KEY"}`,
                    '-c', 'features.enable_request_compression=false');
                invocation.env.SPECBOOK_PROBE_API_KEY = 'probe';
            } else {
                invocation.env.ANTHROPIC_API_KEY = 'probe';
                invocation.env.ANTHROPIC_BASE_URL = address;
            }
            const cancellation = new AbortController();
            const timer = setTimeout(() => cancellation.abort(new Error(`${agent} probe timed out`)), 45_000);
            let persistedId;
            try {
                const result = await executeAgent(invocation, turn ? 'What marker did you just say?' : 'Say a marker.', cancellation.signal, async (id) => {
                    await fs.writeFile(path.join(agentSession, 'persisted-session-id'), id, { mode: 0o600 });
                    persistedId = id;
                });
                assert.equal(result.code, 0, result.errors);
                assert.ok(result.sessionId, `${agent} did not return a session id`);
                assert.equal(persistedId, result.sessionId);
                if (sessionId) assert.equal(result.sessionId, sessionId);
                else sessionId = result.sessionId;
                assert.ok(modelRequest, `${agent} did not make a model request`);
                if (turn) assert.ok(JSON.stringify(modelRequest.body).includes(marker), `${agent} resume lost its previous turn`);
                const exposed = modelRequest.tools;
                const resourceWrappers = agent === 'codex' ? ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource'] : [];
                const expected = [...names.map((name) => `mcp__specbook__${name}`), ...resourceWrappers].sort();
                assert.deepEqual(exposed, expected);
                console.log(JSON.stringify({ agent, turn: turn ? 'resume' : 'first', sessionId, modelVisibleTools: exposed, nativeCommandAndFileToolsDisabled: true, inertMcpResourceWrappers: resourceWrappers, historyRetained: !!turn, sessionIdPersisted: true }));
            } finally {
                clearTimeout(timer);
            }
        }
    }
} finally {
    await client.close();
    await new Promise((resolve) => server ? server.close(resolve) : resolve());
    await fs.rm(root, { recursive: true, force: true });
    if (previousSpecbookHome === undefined) delete process.env.SPECBOOK_HOME;
    else process.env.SPECBOOK_HOME = previousSpecbookHome;
    process.argv[1] = previousLauncher;
}
