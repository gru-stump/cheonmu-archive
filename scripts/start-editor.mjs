import { spawn } from 'node:child_process';
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const children = [
  spawn(command, ['tsx', 'editor/server.ts'], { stdio: 'inherit' }),
  spawn(command, ['vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort', '--open', '/editor/'], { stdio: 'inherit' }),
];
const stop = (signal) => children.forEach((child) => child.kill(signal));
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
