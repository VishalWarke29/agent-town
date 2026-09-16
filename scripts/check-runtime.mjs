import Database from 'better-sqlite3';
import { version } from 'react';

const db = new Database(':memory:');
db.prepare('SELECT 1').get();
db.close();
if (!version.startsWith('19.2.')) throw new Error('The locked React 19.2 release is required by the 3D renderer.');
console.log(`Runtime ready: Node ${process.versions.node}, React ${version}, SQLite loaded.`);
