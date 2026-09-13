#!/usr/bin/env node
// 网关屏蔽：node sw-gateway/block.mjs <链上名字或容器地址> ["原因"]  → 追加到 blocklist.txt，然后 build + deploy。**这是真操作，会立刻发布**。
// 去掉：node sw-gateway/block.mjs --remove <名字或地址>
import fs from 'node:fs'; import path from 'node:path'; import { execSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)); const file = path.join(here, 'blocklist.txt');
const args = process.argv.slice(2); const remove = args[0] === '--remove'; const target = (remove ? args[1] : args[0] || '').trim().toLowerCase(); const reason = remove ? '' : (args[1] || '');
if (!/^(0x[0-9a-f]{40}|[1-9][0-9]*\.(0|[1-9][0-9]*)\.tape)$/.test(target)) { console.error('用法：node sw-gateway/block.mjs <4246.0.tape | 0x容器地址> ["原因"]  或  --remove <同上>'); process.exit(1); }
let lines = fs.readFileSync(file, 'utf8').split('\n');
if (remove) lines = lines.filter((l) => l.trim().toLowerCase() !== target && !l.startsWith('# ' + target + ' '));
else if (!lines.some((l) => l.trim().toLowerCase() === target)) lines.push(`# ${target} · ${new Date().toISOString().slice(0, 10)}${reason ? ' · ' + reason : ''}`, target);
fs.writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'));
console.log((remove ? '已移出名单：' : '已加入名单：') + target);
execSync('npm run build:gateway && npx wrangler deploy', { cwd: path.resolve(here, '..'), stdio: 'inherit' });
console.log('已发布，10 分钟内全网生效');
