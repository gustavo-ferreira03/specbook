import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareAgentInvocation } from '../src/agent.ts';
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
    assert.equal(names.length, 12);
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
    } finally { await restarted.close(); }
    console.log(JSON.stringify({ mcpTools: names, credentialRedaction: true, pathTraversalRejected: true, symlinkRejected: true, threeRunLimit: true, budgetPersistedAfterRestart: true }));

    let capturedResolve;
    let expectedAgent;
    let captured = new Promise((resolve) => { capturedResolve = resolve; });
    server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        let parsed;
        try { parsed = JSON.parse(body); } catch { response.writeHead(404).end(); return; }
        if (!Array.isArray(parsed.tools)) { response.writeHead(400).end('The probe requires an explicit model-visible tool inventory'); return; }
        const flattenTools = (tools, namespace = '') => tools.flatMap((tool) => tool.type === 'namespace'
            ? flattenTools(tool.tools, namespace + tool.name + '__')
            : [namespace + (tool.name ?? tool.type)]);
        capturedResolve(flattenTools(parsed.tools).sort());
        if (expectedAgent === 'claude') {
            response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Probe completed' } }));
            return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const item = { id: 'msg_probe', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Probe completed.', annotations: [] }] };
        const result = { id: 'resp_probe', object: 'response', status: 'completed', output: [item] };
        const events = [
            { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
            { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
            { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
            { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Probe completed.' },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: result },
        ];
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${server.address().port}`;
    for (const agent of ['codex', 'claude']) {
        expectedAgent = agent;
        captured = new Promise((resolve) => { capturedResolve = resolve; });
        const agentSession = path.join(root, agent);
        await fs.mkdir(agentSession, { mode: 0o700 });
        await fs.writeFile(path.join(agentSession, 'state.json'), JSON.stringify(emptyAgentState()), { mode: 0o600 });
        let invocation;
        const previousKey = process.env[agent === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'];
        const keyName = agent === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
        process.env[keyName] = 'probe';
        try { invocation = await prepareAgentInvocation(agent, workspace, agentSession, 'Use only Specbook MCP tools.'); }
        catch (error) {
            if (error.code === 'ENOENT') { console.log(JSON.stringify({ agent, skipped: 'not installed' })); continue; }
            throw error;
        } finally {
            if (previousKey === undefined) delete process.env[keyName];
            else process.env[keyName] = previousKey;
        }
        if (agent === 'codex') {
            invocation.args.splice(invocation.args.length - 1, 0,
                '-c', 'model_provider="specbook_probe"',
                '-c', `model_providers.specbook_probe={name="Probe",base_url=${JSON.stringify(address)},wire_api="responses",env_key="SPECBOOK_PROBE_API_KEY"}`,
                '-c', 'features.enable_request_compression=false');
            invocation.env.SPECBOOK_PROBE_API_KEY = 'probe';
        } else {
            invocation.env.ANTHROPIC_API_KEY = 'probe';
            invocation.env.ANTHROPIC_BASE_URL = address;
        }
        const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        let errorOutput = '';
        child.stdout.on('data', (chunk) => { errorOutput = (errorOutput + chunk).slice(-5000); });
        child.stderr.on('data', (chunk) => { errorOutput = (errorOutput + chunk).slice(-3000); });
        child.stdin.on('error', () => {});
        child.stdin.end('Report probe completed.');
        const closed = new Promise((resolve) => child.once('close', resolve));
        let timer;
        try {
            const exposed = await Promise.race([captured, closed.then(() => { throw new Error(`${agent} exited before its request: ${errorOutput}`); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${agent} request timed out: ${errorOutput}`)), 45_000); })]);
            const resourceWrappers = agent === 'codex' ? ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource'] : [];
            const expected = [...names.map((name) => `mcp__specbook__${name}`), ...resourceWrappers].sort();
            assert.deepEqual(exposed, expected);
            console.log(JSON.stringify({ agent, modelVisibleTools: exposed, nativeCommandAndFileToolsDisabled: true, inertMcpResourceWrappers: resourceWrappers }));
        } finally {
            clearTimeout(timer);
            try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM'); } catch {}
            await closed;
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
