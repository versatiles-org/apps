/**
 * Script execution, server polling, and cleanup.
 */

import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { PORT } from './modify.js';

const SCRIPT_TIMEOUT = 30 * 60 * 1000; // 30 minutes (cargo/source builds are slow)

const POLL_INTERVAL = 2000;

// The server's data is already on disk by the time we poll, so this only covers
// process startup.
const SERVER_READY_TIMEOUT = 60 * 1000;

// The docker_nginx container downloads the frontend and converts a bounding box
// out of osm/satellite/elevation before the backend starts listening, so its
// budget is dominated by download speed. Observed ~74s on a healthy runner and
// >127s on a slow one — keep enough headroom that ordinary variance passes.
const BACKEND_READY_TIMEOUT = 6 * 60 * 1000;

// nginx only has to proxy to an already-healthy backend.
const NGINX_READY_TIMEOUT = 30 * 1000;

export function createWorkDir(): string {
	const workDir = join(
		tmpdir(),
		`versatiles-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(workDir, { recursive: true });
	return workDir;
}

export function writeScript(workDir: string, code: string, osKey: string): string {
	if (osKey === 'windows') {
		const scriptPath = join(workDir, 'run.ps1');
		writeFileSync(scriptPath, code + '\n');
		return scriptPath;
	} else {
		const scriptPath = join(workDir, 'run.sh');
		const header = [
			'#!/usr/bin/env bash',
			'set -euo pipefail',
			'_SMOKE_DIR="$(cd "$(dirname "$0")" && pwd)"',
			''
		].join('\n');
		writeFileSync(scriptPath, header + code + '\n');
		return scriptPath;
	}
}

export function runScript(scriptPath: string, workDir: string, osKey: string): void {
	const cmd = osKey === 'windows' ? 'pwsh' : 'bash';
	const args =
		osKey === 'windows' ? ['-ExecutionPolicy', 'Bypass', '-File', scriptPath] : [scriptPath];

	const result = spawnSync(cmd, args, {
		cwd: workDir,
		stdio: 'inherit',
		timeout: SCRIPT_TIMEOUT
	});

	if (result.error) {
		throw new Error(`Script execution failed: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`Script exited with code ${result.status}`);
	}
}

// --- Server Polling ---

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `check` until it reports readiness or `timeout` elapses.
 *
 * `check` returns a status message once ready, and null (or throws) while not.
 * Elapsed time is logged on every attempt so a future timeout shows how far off
 * the budget was rather than just an attempt count.
 */
async function pollUntilReady(
	what: string,
	timeout: number,
	check: () => Promise<string | null>
): Promise<void> {
	const start = Date.now();
	for (let attempt = 1; ; attempt++) {
		let status: string | null;
		try {
			status = await check();
		} catch {
			status = null;
		}

		const elapsed = Math.round((Date.now() - start) / 1000);
		if (status !== null) {
			console.log(`    Attempt ${attempt} (${elapsed}s): ${status}`);
			return;
		}

		if (Date.now() - start >= timeout) {
			throw new Error(
				`${what} did not become ready within ${timeout / 1000}s (${attempt} attempts)`
			);
		}
		console.log(`    Attempt ${attempt} (${elapsed}s): not ready — retrying...`);
		await sleep(POLL_INTERVAL);
	}
}

export async function waitForServer(methodKey: string, workDir: string): Promise<void> {
	if (methodKey === 'docker_nginx') {
		await waitForDockerNginx();
	} else if (methodKey === 'docker') {
		await waitForDocker();
	} else {
		await waitForProcess(workDir);
	}
}

async function waitForProcess(workDir: string): Promise<void> {
	const pidFile = join(workDir, 'server.pid');
	const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
	console.log(`    Server PID: ${pid}`);

	console.log(`=== Health check: polling http://localhost:${PORT}/status ===`);
	await pollUntilReady('Server', SERVER_READY_TIMEOUT, statusEndpointCheck);
}

async function waitForDocker(): Promise<void> {
	await sleep(2000);
	verifyContainerRunning();

	console.log(`=== Health check: polling http://localhost:${PORT}/status ===`);
	await pollUntilReady('Server', SERVER_READY_TIMEOUT, statusEndpointCheck);
}

async function statusEndpointCheck(): Promise<string | null> {
	const res = await fetch(`http://localhost:${PORT}/status`);
	return res.ok ? `HTTP ${res.status} — OK` : null;
}

async function waitForDockerNginx(): Promise<void> {
	await sleep(2000);
	verifyContainerRunning();

	// Poll backend directly via docker exec to avoid nginx caching 502
	console.log('=== Health check: polling backend via docker exec ===');
	await pollUntilReady('Backend', BACKEND_READY_TIMEOUT, async () => {
		execSync('docker exec versatiles curl -sf http://127.0.0.1:8080/status', {
			stdio: 'pipe'
		});
		return 'backend OK';
	});

	// Verify nginx is accepting connections. Not fatal — the backend is already
	// healthy, and the test itself will fail if nginx never comes up.
	console.log(`    Checking nginx on port ${PORT}...`);
	await sleep(1000);
	try {
		await pollUntilReady('nginx', NGINX_READY_TIMEOUT, async () => {
			const res = await fetch(`http://localhost:${PORT}/`);
			return `nginx responding: HTTP ${res.status}`;
		});
	} catch (error) {
		console.log(`    ${error instanceof Error ? error.message : String(error)}`);
	}
}

function verifyContainerRunning(): void {
	const result = execSync('docker ps --filter "name=versatiles" --format "{{.Names}}"', {
		encoding: 'utf-8'
	}).trim();
	if (!result.includes('versatiles')) {
		console.log('Docker logs:');
		try {
			execSync('docker logs versatiles', { stdio: 'inherit' });
		} catch {
			/* empty */
		}
		throw new Error('Docker container "versatiles" is not running');
	}
	console.log('    Docker container "versatiles" is running');
}

// --- Cleanup ---

export function cleanup(methodKey: string, workDir: string): void {
	console.log('\n=== Cleaning up ===');

	// Stop server
	if (methodKey === 'docker' || methodKey === 'docker_nginx') {
		try {
			execSync('docker rm -f versatiles', { stdio: 'pipe' });
		} catch {
			/* empty */
		}
	} else {
		try {
			const pidFile = join(workDir, 'server.pid');
			const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
			process.kill(pid);
		} catch {
			/* empty */
		}
	}

	// Remove work directory
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch {
		// Docker may create root-owned files
		try {
			execSync(`docker run --rm -v "${workDir}":/cleanup alpine rm -rf /cleanup`, {
				stdio: 'pipe'
			});
		} catch {
			/* empty */
		}
		try {
			rmSync(workDir, { recursive: true, force: true });
		} catch {
			/* empty */
		}
	}
}
