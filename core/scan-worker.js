import { parentPort } from 'node:worker_threads';
import { scanState } from './index.js';
try { parentPort.postMessage({ value: scanState() }); }
catch (error) { parentPort.postMessage({ error: error.message }); }
