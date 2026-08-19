import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 18291;
const baseUrl = `http://127.0.0.1:${port}`;
let serverProcess;

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for tracing UI')), 5_000);
    const onData = data => {
      if (!data.toString().includes(`localhost:${port}`)) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', code => {
      if (code !== null) {
        clearTimeout(timeout);
        reject(new Error(`tracing UI exited before startup: ${code}`));
      }
    });
  });
}

describe('optional Basic Auth', () => {
  before(async () => {
    serverProcess = spawn(process.execPath, ['server.js'], {
      env: {
        ...process.env,
        PORT: String(port),
        TRACING_UI_AUTH_USERNAME: 'praxis',
        TRACING_UI_AUTH_PASSWORD: 'test-password',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(serverProcess);
  });

  after(() => serverProcess?.kill('SIGTERM'));

  it('rejects anonymous and invalid credentials', async () => {
    const anonymous = await fetch(`${baseUrl}/`);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('www-authenticate'), 'Basic realm="Praxis Tracing"');

    const invalid = await fetch(`${baseUrl}/`, {
      headers: { authorization: basicAuth('praxis', 'wrong-password') },
    });
    assert.equal(invalid.status, 401);
  });

  it('allows valid credentials without exposing the password', async () => {
    const response = await fetch(`${baseUrl}/`, {
      headers: { authorization: basicAuth('praxis', 'test-password') },
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes('<!doctype html>') || body.includes('<!DOCTYPE html>'));
    assert.ok(!body.includes('test-password'));
  });
});
