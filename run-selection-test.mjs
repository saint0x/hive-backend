import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Start main server on port 3000
console.log('Starting main server on port 3000...');
const mainServer = spawn('node', [join(__dirname, 'server.mjs')], {
    stdio: ['inherit', 'pipe', 'pipe']
});

mainServer.stdout.on('data', (data) => {
    console.log('[Main Server]:', data.toString());
});

mainServer.stderr.on('data', (data) => {
    console.error('[Main Server Error]:', data.toString());
});

// Start test server on port 3001
console.log('Starting test server on port 3001...');
const testServer = spawn('node', [join(__dirname, 'test-server.mjs')], {
    stdio: ['inherit', 'pipe', 'pipe']
});

testServer.stdout.on('data', (data) => {
    console.log('[Test Server]:', data.toString());
});

testServer.stderr.on('data', (data) => {
    console.error('[Test Server Error]:', data.toString());
});

// Wait for servers to start
await new Promise(resolve => setTimeout(resolve, 2000));

// Run selection tests
console.log('Running selection tests...');
const testProcess = spawn('node', [join(__dirname, 'test-selections.mjs')], {
    stdio: ['inherit', 'pipe', 'pipe']
});

testProcess.stdout.on('data', (data) => {
    console.log('[Test]:', data.toString());
});

testProcess.stderr.on('data', (data) => {
    console.error('[Test Error]:', data.toString());
});

// Handle cleanup
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    mainServer.kill();
    testServer.kill();
    testProcess.kill();
    process.exit();
});

// Exit after tests complete (5 iterations * 2 seconds per iteration + buffer)
setTimeout(() => {
    console.log('\nTests completed, shutting down...');
    mainServer.kill();
    testServer.kill();
    testProcess.kill();
    process.exit();
}, 15000);
